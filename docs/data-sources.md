# External Sports Data & API Strategy

To operate without high API costs, the system uses two distinct types of data
feeds behind a cached ingestion strategy. Application code never calls a provider
directly on a user request — scheduled jobs ingest into the database and cache,
and requests read from there.

> **Lines are load-bearing.** Under Spread Sharks a game without a spread and a
> total has no markets to offer, so the odds feed is not a nicety on top of the
> schedule — it is what makes a game playable. Nothing is generated locally: the
> application has no fixtures until ESPN supplies them and no markets until they
> are priced. Every bet copies its line and price at placement, which is what
> lets the provider change without disturbing settled history.

## Odds & Schedule Providers

Used for pregame lines, totals, and season schedules. These change slowly and are
polled infrequently.

| Provider | Free tier | Notes |
| --- | --- | --- |
| **SharpAPI** | 12 requests/minute, 2 books, 60-second delay | **Wired up.** Supplies spreads and totals |
| **The Odds API** | 500 requests/month | Alternate for pregame lines and schedules |
| **OddsPapi** | 250 requests/month | Covers 350+ global sportsbooks |

### SharpAPI (implemented)

> **Name collision worth knowing about.** The odds provider is
> **sharpapi.io**. There is an unrelated product at **sharpapi.com** — an
> AI workflow API for e-commerce and HR — with a near-identical name and
> overlapping documentation domains. They are different companies. Searching for
> "SharpAPI docs" lands on either one.

Base URL `https://api.sharpapi.io/api/v1`, authenticated with an `X-API-Key`
header. Confirmed against a live free-tier key:

| Capability | Free tier |
| --- | --- |
| Features | `odds`, `schedule` — **no scores** |
| Rate limit | 12 requests/minute |
| Sportsbooks | 2 (DraftKings, FanDuel) |
| Delay | 60 seconds |
| Page size | 200 rows maximum (larger values are clamped, with a warning) |

Endpoints used:

| Endpoint | Purpose |
| --- | --- |
| `GET /odds?league=&market=` | Current lines. Markets are `point_spread` and `total_points` |
| `GET /account` | Confirms the key and reports tier limits |

### Two leagues

The stack ingests the NFL and college football (NCAAF). Everything that differs
between them — ESPN path, the `groups=80` FBS filter, season length, how the
postseason is filed, and whether SharpAPI prices the league — lives in
`api/src/leagues.js`. `INGEST_LEAGUES` (default `NFL`) selects which feeds the
worker runs; each league is a full walk of ESPN's scoreboard per tick.

Every game and every pool carries a `league`, and every board, week list and
stipend calculation is scoped by it. Weeks only mean something within a league.

**SharpAPI does not price NCAAF on the free tier.** `/odds?league=ncaaf` returns
zero rows for every market while `nfl` returns rows on the same key in the same
minute, so college lines come from ESPN alone (98 of 99 week-1 games are priced).
`NCAAF.sharpPricing` is `false` in `api/src/leagues.js`, so the odds job skips
the league and says so rather than logging a misleading zero. Flipping it is the
only change needed if the key is ever upgraded — the join is built and dormant.

Two traps in that finding, both silent:

- **The league slug is lowercase.** The published docs show `league=NCAAF`; the
  API's own `/leagues` endpoint returns `{"id":"ncaaf"}`. An uppercase parameter
  returns **HTTP 200 with zero rows** — no error, no warning. A feed returning
  nothing looks exactly like a feed with nothing to say.
- **The `ncaaf` event feed is not clean.** `/events?league=ncaaf` returns a
  basketball game (`POR Fire @ SEA Storm`) and prop-shaped rows (`NDSU28 North
  Dakota St. wins by over 27.5 points`). Even with odds access it would need
  filtering before it could be trusted to name a fixture.

#### Matching college names

SharpAPI names college teams *without* the nickname (`"North Carolina"`) where
ESPN sends `"North Carolina Tar Heels"`, so the normalised exact match that
carries the NFL join would match almost nothing. `pairKeys()` strips the trailing
nickname for leagues where the fallback is disabled.

The **last-word nickname fallback is disabled for college entirely.** Across the
2025 FBS season 230 distinct teams appear and the fallback collides hard — 10
Bulldogs, 9 Wildcats, 9 Tigers, 8 Bears, 7 Eagles. The ±2-day kickoff tolerance
does not save it: on a Saturday with 60 kickoffs, two different Bulldogs games
inside the same window is routine, and a wrong match writes another game's spread
onto the board. "Miami Hurricanes" vs "Miami (OH) RedHawks" is the memorable
trap; the nickname buckets are the systemic one.

A small curated alias table keyed on the ESPN name covers the spellings the two
feeds genuinely disagree on (`Ole Miss`/`Mississippi`, `UConn`/`Connecticut`,
`Texas A&M`). Matching on ESPN team ids is not available — SharpAPI does not
carry them.

**SharpAPI cannot be the schedule of record.** Its events carry no scores and no
week number, only a start time. Settlement needs final scores, and pools are
organised by week, so:

- **ESPN** stays authoritative for season, week, status, and final scores.
- **SharpAPI** prices the games ESPN already provided.

When a SharpAPI key is configured it owns the line columns outright, and the
ESPN ingester stops updating `spread` and `total` on existing rows. Without that
the two feeds overwrite each other on alternating cron ticks and a game's spread
visibly flaps.

#### Mapping to our schema

Three details in the response are easy to get wrong:

- **The line is relative to the selection, not the home team.** An away row
  quoting `+3.5` is a home line of `-3.5`. `games.spread` is always the home
  line, so away rows are negated.
- **`is_main_line` is unreliable** — the API returns `false` on rows that are
  plainly the main line. Filtering strictly on it returns nothing. It is used as
  a preference, falling back to the line the book quotes most often.
- **Offset pagination stops at 500.** `limit` is capped at 200 and an `offset`
  above 500 is rejected outright, with the error directing you to the opaque
  `next_cursor`. A full NFL slate runs past that, so the walk follows the cursor.
  It is the better instrument regardless: on a live feed rows shift between
  pages, and a numeric offset would skip or repeat them. A truncated walk is
  reported rather than swallowed, since it would otherwise look like a matching
  failure rather than missing data.

Games are matched to events on normalised team names plus a kickoff within two
days. The date check matters: the same fixture recurs across a season, so names
alone are ambiguous.

## Scores & Settlement Providers

Used for live and final scores that drive pick settlement.

| Provider | Free tier | Notes |
| --- | --- | --- |
| **ESPN public endpoints** | Unmetered public REST, no API key | Free real-time score updates |
| **TheSportsDB** | Community database | Schedules and metadata |
| **API-Football / API-Sports** | 100 requests/day | Soccer, NBA, NFL, MLB |

Example ESPN endpoint:

```
https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
```

These are public but undocumented endpoints. They carry no availability guarantee,
so the design should tolerate a provider going away — hence keeping TheSportsDB
and API-Sports as alternates for the same data.

ESPN's scoreboard also carries an odds block, from which the ingester takes the
spread (normalised to the home team's line) and `overUnder` as the total. That
makes it a usable stopgap for lines as well as scores, though a dedicated
sportsbook odds feed is the intended source. It is not merely a stopgap for
college, where it is the only line source (above). The `details` string is the
same `"TCU -7.5"` shape in both leagues. ESPN strips odds from *completed* games,
so a finished slate showing none is expected rather than a gap.

### ESPN's college scoreboard differs from its NFL one

Three differences, each measured against the live endpoints, and each of which
fails quietly rather than loudly if missed:

- **`groups=80` is mandatory.** The default scoreboard returns only ranked
  matchups — 23 events for 2025 week 1 against 96 with the parameter. Without it
  the board silently shows a fifth of the slate. `limit=300` is cheap insurance
  at 99 events a week.
- **The entire postseason lives in one week.** `seasontype=3, week=1` holds 46
  events spanning 2025-12-14 → 2026-01-20, and weeks 2+ hold none. Written
  straight from the loop variable those bowl games would file as week 1 and
  interleave with September's. They are remapped to week 17. The NFL has no such
  problem: its postseason spans `seasontype=3` weeks 1–5 and the loop never
  touches it.
- **Regular-season length differs**, and the tail is thin — college runs weeks
  1–16, with week 15 at 9 games and week 16 a single fixture, Army–Navy. The
  per-league week list lives in `api/src/leagues.js` rather than defaulting to
  the NFL's 18.

There is **no Week 0 to handle**: ESPN folds the late-August games into week 1,
whose 2025 payload spans 2025-08-23 → 2025-09-02. The schedule quirk exists in
the sport but not in ESPN's week numbering.

### Void detection

A wager is voided when its game never officially concludes under its league's
rules. That determination comes from the feed — a game reported as cancelled,
postponed indefinitely, or abandoned — and the bar differs per sport, so it is a
per-sport rule rather than one global one. A cancellation cannot be summoned on
demand, so the MVP exposes an admin action to mark a game abandoned, purely so
the void path stays exercisable.

## Ingestion Strategy

The core cost control is that polling frequency is decoupled from user traffic. A
Sunday-morning spike of users checking scores produces zero additional upstream
API calls.

- **Schedules** — the full regular season is pulled from ESPN on startup and
  refreshed every ten minutes. 18 requests per pass, and ESPN's endpoints are
  unmetered. Preseason and postseason are not ingested.
- **Odds, spreads, and totals** — polled on a schedule leading up to kickoff, then
  frozen. Once a game locks, its line no longer needs refreshing, and wagers
  already placed carry their own copy regardless.
- **Scores** — polled frequently only while games are in progress. Outside a game
  window there is nothing to poll, which keeps daily request counts low even on
  a 100/day tier.
- **Settlement** — once a game reaches `FINAL`, it is never polled again.

Jobs are driven by AWS EventBridge schedules; results land in PostgreSQL, with
hot read paths (live odds, leaderboards) served from Redis. See
[Architecture](architecture.md).

## Caching

Upstream responses are cached in Redis, which runs with append-only persistence
on a named Docker volume. That persistence is not incidental: on a 12
requests/minute allowance, a cache that emptied on every restart would spend the
budget re-fetching lines it already had.

| Cache | TTL | Key |
| --- | --- | --- |
| SharpAPI responses | 90s (`SHARP_CACHE_TTL_SECONDS`) | `sharp:v1:<path>?<query>` |
| Leaderboards | 30s | `lb:<pool_id>` |

The TTL is set just above the free tier's own 60-second delay — polling faster
than the data updates returns the same numbers at the cost of rate limit. Each
pagination page is cached independently.

Requests are additionally spaced in-process to stay under the per-minute
allowance, so a burst cannot trip a 429.

## Budget Implications

The free tiers are workable because request volume scales with *games*, not with
*users*. A season's schedule, lines, and scores cost the same number of upstream
calls whether the platform has 10 users or 100,000. Growth pressure lands on
compute and database (see [Cost Estimates](cost-estimates.md)), not on data.

One NFL line refresh costs about 8 requests — two markets, roughly four cursor
pages each — so the default five-minute cadence uses on the order of 96 requests
an hour against an allowance of 720. Requests are spaced in-process to stay
under the per-minute ceiling, so a refresh takes tens of seconds rather than
firing as a burst.
