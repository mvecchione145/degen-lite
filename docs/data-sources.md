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
sportsbook odds feed is the intended source.

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
