# College Football (NCAAF) Support

Status: **implemented.** A pool can be created against either league, and the
two run side by side in one database.

Enable the second feed with `INGEST_LEAGUES=NFL,NCAAF` (default `NFL`), then
pick the league when creating a pool. Measured on a live stack: NFL 272 games
across 18 weeks, NCAAF 946 games across 17.

Every number and defect below was checked against the live ESPN endpoints on
2026-08-14, and the SharpAPI findings against a live free-tier key on
2026-08-15. Three things the scope got wrong are corrected in
[What the live key changed](#what-the-live-key-changed).

## Summary

Getting the fixtures was never the obstacle: ESPN's college scoreboard carries
the same payload shape as the NFL one, pregame spreads and totals included, so
a college pool is playable on ESPN alone. (SharpAPI turned out not to price the
league on this key at all — see below.)

The obstacle was that **this codebase had no league dimension.** `games` was
keyed on `(season, week)` and every read filtered on those two columns alone, so
ingesting a second league into the same table did not produce two boards. It
produced one board with 115 games on it, and it corrupted the weekly stipend for
existing NFL pools. The league column was the bulk of the work; pointing the
ingester at a different URL was the trivial part.

## What the live key changed

The scope was written from SharpAPI's marketing and documentation pages. A live
free-tier key contradicts them on three points, all of which shaped the build.

**1. The league slug is lowercase, and the wrong case fails silently.**
The docs show `league=NCAAF`. The API's own `/leagues` endpoint returns
`{"id":"ncaaf","display_name":"NCAAF","event_count":579}`. An uppercase
parameter returns **HTTP 200 with zero rows** — no error, no warning. A feed
that returns nothing looks exactly like a feed with nothing to say.

**2. The free tier does not price college, whatever the marketing says.**
`/odds?league=ncaaf` returns zero rows for every market, with and without a
market filter, while `/odds?league=nfl` returns rows on the same key in the same
minute. `/account` reports `tier: free`, `features: [odds, schedule]`. The
sportsbook pages advertise NCAAF on the free tier; the key does not deliver it.

**3. The `ncaaf` event feed is not clean.** `/events?league=ncaaf` returns
entries like `POR Fire @ SEA Storm` (a basketball game), `USC college football
game @ San Jose St.`, and prop-shaped rows such as `NDSU28 North Dakota St. wins
by over 27.5 points`. Even with odds access, that feed would need filtering
before it could be trusted to name a fixture.

**Consequence, and how it is wired:** `NCAAF.sharpPricing` is `false` in
`api/src/leagues.js`, so the odds job skips the league and says so rather than
logging a misleading zero. College lines come from ESPN, which prices 98 of 99
week-1 games. Flipping the flag to `true` is the only change needed if the key
is ever upgraded — the join is built and the slug is correct.

**Also worth knowing:** SharpAPI names college teams *without* the nickname
(`"North Carolina"`, `"TCU"`) where ESPN sends `"North Carolina Tar Heels"`.
The scope assumed a normalised exact match would carry the join as it does for
the NFL; it would have matched almost nothing. `pairKeys()` now strips the
trailing nickname for leagues where the fallback is disabled.

Sources: [sharpapi.io/odds/ncaaf](https://sharpapi.io/odds/ncaaf),
[docs.sharpapi.io](https://docs.sharpapi.io/en), and the live key.

## What was verified

### ESPN carries CFB odds, so SharpAPI stays optional

Measured against `site.api.espn.com/.../football/college-football/scoreboard`:

| Slate | Events | With odds |
| --- | --- | --- |
| 2026 regular week 1 | 99 | 98 |
| 2025 regular week 1 (completed) | 96 | 0 |

The `details` string is the same `"TCU -7.5"` shape the NFL feed uses, with
`overUnder` alongside it, so `homeSpread()` and `toGameRow()` already parse it.
ESPN strips odds from completed games, which is why the 2025 slate shows none —
that is expected, not a gap.

**Consequence:** a CFB pool is playable on ESPN alone. SharpAPI improves the
lines but is not required to have markets, exactly as with the NFL.

### `groups=80` is mandatory

The default scoreboard returns only ranked matchups:

```
?dates=2025&seasontype=2&week=1              →  23 events   (Top 25 only)
?dates=2025&seasontype=2&week=1&groups=80    →  96 events   (all FBS)
```

Without `groups=80` the board silently shows a fifth of the slate. `limit=300`
made no difference at this size but is cheap insurance — 99 events is already
near the default page size.

### The postseason collides with week 1

The entire college postseason lives in **one** ESPN week:

```
seasontype=3, week=1  →  46 events, 2025-12-14 → 2026-01-20  (bowls + CFP)
seasontype=3, week≥2  →  0 events
```

`ingestSeason()` writes `week` straight from its loop variable, so ingesting the
postseason as-is would file 46 bowl games as **week 1** and interleave them with
September's week 1 on the same board. The NFL does not have this problem: its
postseason spans `seasontype=3` weeks 1–5 and the existing loop never touches
`seasontype=3` at all.

Regular season length also differs — CFB runs weeks 1–16, and the tail is thin
(week 15 = 9 games, week 16 = 1 game, Army–Navy). The `weeks = 18` default in
`ingestSeason()` would spend two requests on empty weeks.

### There is no Week 0 to handle

ESPN folds the late-August "Week 0" games into week 1: the 2025 week 1 payload
spans **2025-08-23 → 2025-09-02**. No special casing needed. (This corrects an
assumption made earlier in scoping — the schedule quirk exists in the sport but
not in ESPN's week numbering.)

### `homeSpread()` silently dropped lines for `&` teams — **fixed**

`api/src/services/ingest.js:20` matches the favourite's abbreviation as
`[A-Z]{2,4}`. Three CFB abbreviations do not match:

| Team | Abbreviation |
| --- | --- |
| Texas A&M Aggies | `TA&M` |
| Miami (OH) RedHawks | `M-OH` |
| William & Mary Tribe | `W&M` |

Checked against the real 2026 odds strings, first five weeks: **2 of 115** games
fail the regex, both Texas A&M (`'TA&M -39.5'`, `'TA&M -14.5'`). The function
returns `0` on a failed match, so a 39.5-point favourite is posted as a pick'em
and members bet a fabricated line. Silent and wrong — the worst failure shape
available.

This was latent in the NFL path too — no NFL abbreviation contains `&` or `-`,
so it never fired there.

**Fixed ahead of the rest of this scope:** the class is now
`[A-Z0-9&.'-]{2,6}`. Checked against 141 real odds strings (2025 CFB regular
season and postseason, 2026 weeks 1–3, NFL 2025–26): 0 failures, and the NFL
strings parse identically to before. `EVEN`/`PK` still fall through to `0`,
which is the right answer for a pick'em.

### Nickname fallback is unusable in CFB

`pairKeys()` (`ingest.js:113`) joins ESPN games to SharpAPI lines on a
normalised full name, falling back to the **last word** of the name. Across the
2025 FBS season, 230 distinct teams appear, and that fallback collides hard:

| Nickname | Teams sharing it |
| --- | --- |
| Bulldogs | 10 |
| Wildcats | 9 |
| Tigers | 9 |
| Bears | 8 |
| Eagles | 7 |

The `KICKOFF_TOLERANCE_MS` guard (±2 days) does not save this: on a Saturday
with 60 kickoffs, two different Bulldogs games inside the same window is routine.
A wrong match writes another game's spread onto the board — again silent.

"Miami Hurricanes" vs "Miami (OH) RedHawks" is the canonical trap, but the
nickname buckets above are the systemic one. **The nickname fallback must be
disabled for CFB.**

## What was built

| Piece | Where |
| --- | --- |
| League registry — schedule shape, ESPN params, matching rules, per-league SharpAPI flag | `api/src/leagues.js` (new) |
| `league` column on `games` and `pools`, `(league, season, week)` index | `db/init/01-schema.sql` |
| League-aware ESPN ingest, postseason remap, per-league walk | `api/src/services/ingest.js` |
| League filter on every board, week, season and pick query | `games.js`, `bets.js`, `picks.js` |
| League-scoped stipend week | `settlement.js` |
| Cross-league bet rejected at placement | `bets.js` `loadGame()` |
| League on pool creation, badge on every pool | `routes/pools.js`, `web/public/app.js` |
| `INGEST_LEAGUES` for api and worker | `docker-compose.yml` |
| Registry tests | `api/test/leagues.test.js` |

Verified on a live stack: NFL 272/18 weeks and NCAAF 946/17 weeks ingested side
by side; NCAAF week 1 holds 99 games and week 17 holds the 44 bowl fixtures;
each pool's board returns only its own league; a bet posted against another
league's game id is refused; and with the leagues deliberately on different
weeks (college pushed to week 2, NFL on week 1) each top-up pool drew its
stipend for its own league's week.

One thing the scope did not list and the build added: `placeBet` validated the
game's *season* but not its league, so a game id posted straight to the API
would have let an NFL pool take a wager on a college game. `loadGame()` now
checks both.

## Required changes

### Phase 1 — league dimension (the load-bearing change) — **done**

`games` had no league column, and neither did `pools`. Until they did, a second
league could not coexist with the first.

1. **Schema** (`db/init/01-schema.sql`): add
   `league VARCHAR(10) NOT NULL DEFAULT 'NFL' CHECK (league IN ('NFL','NCAAF'))`
   to `games` and to `pools`. Replace `games_season_week_idx` with
   `(league, season, week)`. The `DEFAULT 'NFL'` keeps existing rows correct.
   Note this project ships schema as `db/init/*.sql` run once on an empty
   volume — there is no migration runner, so an existing database needs either
   a hand-run `ALTER TABLE` or `docker compose down -v`.
2. **Every games query takes a league.** These all filter `season`/`week` only
   and would otherwise mix leagues:
   - `api/src/services/games.js` — `listGames`, `listWeeks`, `listSeasons`,
     `getCurrentWeek` (all four)
   - `api/src/services/bets.js:147` — `getBoard`, plus its two sibling bet
     queries at `:160` and `:173`
   - `api/src/services/picks.js:15`, `:31` — legacy pick modes
   - `api/src/routes/admin.js:50` — the force-settle helper
3. **Stipends** (`api/src/services/settlement.js:69`). `grantStipends` derives
   the current week from `MIN(week) … WHERE season = p.season` with no league
   filter. With both leagues loaded, a Thursday-night CFB game would set the
   "current week" for an NFL top-up pool and grant the wrong week's stipend —
   and the partial unique index makes that wrong grant permanent for that week.
   This is the sharpest correctness bug in the mixed-table state.
4. **Pool creation** carries the league: `createSchema` in
   `api/src/routes/pools.js:79`, `createPool`, and a league selector in the
   creation form (`web/public/app.js:~240`).

Phase 1 alone is worth doing even if CFB never ships — items 3 and the missing
index are pre-existing weaknesses.

### Phase 2 — CFB ingestion — **done**

In `api/src/services/ingest.js`. The week list moved into the league registry:
a caller no longer passes `{ weeks }`, the league says what its season is.

1. Parameterise the scoreboard URL by league instead of the module constant at
   `:11`; append `groups=80&limit=300` for CFB only (`groups` is meaningless to
   the NFL endpoint).
2. ~~Fix the `homeSpread()` regex~~ — **done**, see above.
3. Teach `ingestSeason()` a per-league shape: CFB is `seasontype=2` weeks 1–16
   plus `seasontype=3` week 1, with the postseason **remapped to week 17** so it
   does not collide. Today the signature is `{ weeks = 18 }`, which encodes the
   NFL's shape as a default.
4. Stamp `league` on every upserted row and add it to the conflict-update path.
5. `seededGamesPresent()` (`:199`) must scope its check by league, or a seeded
   NFL demo season will block CFB ingestion for the same year.

Worth noting: at 99 games/week versus 16, the per-week `INSERT` loop in
`upsertGames()` becomes ~1,600 round trips per full-season ingest. It will work;
it is a candidate for a multi-row insert if the ingest cron gets tight.

### Phase 3 — SharpAPI join hardening — **done, but dormant**

Built and unit-covered, but it does not run: the free tier returns no college
odds (see above), so `sharpPricing: false` skips the league entirely.

1. **Drop the nickname fallback for CFB.** Exact normalised name only, and let
   unmatched games keep their ESPN line rather than risk a wrong one. Watch
   `result.unmatched` — that counter becomes the health metric for this feed.
2. **Alias table.** Expect ESPN and SharpAPI to disagree on parenthetical and
   ampersand names (`Miami (OH)`, `Texas A&M`, `Ole Miss` vs `Mississippi`,
   `UConn` vs `Connecticut`). A small curated map keyed on the ESPN name is the
   honest fix; matching on ESPN team ids is not available because SharpAPI does
   not carry them.
3. **Tighten the kickoff window** from ±2 days to ±12 hours. The wide tolerance
   exists to absorb timezone drift on a 16-game slate; on a 60-game Saturday it
   is what turns a nickname collision into a wrong line.
4. **Pagination is moot for now (was the open risk).** With no college odds on
   this key there is nothing to paginate. The bound below still applies the day
   the key is upgraded, and `feed.truncated` is surfaced in the worker log line
   so it cannot pass unnoticed.

   Original note: `fetchAll` caps at
   `maxPages = 8 × 200 rows`, and the offset path stops at `MAX_OFFSET = 500`
   (~700 rows) when SharpAPI returns no cursor. NCAAF returns roughly 5× the NFL
   row count per market before alternate lines are counted, and `/odds` returns
   the whole league's upcoming slate rather than one week. If the response
   includes alternates, truncation is likely — `feed.truncated` already surfaces
   it. **Measure this with a live key before sizing the fix.**

Rate limiting should hold: 2 markets × up to 8 pages = 16 requests, spaced 5s
apart by `throttle()` = ~80s per refresh, inside the `*/5 * * * *` odds cron.
Running both leagues doubles that to ~160s — still inside the window, but the
throttle is per-process and shared, so the margin narrows.

### Phase 4 — surface — **partly done**

- ~~League selector on pool creation, and a league badge on the pool header.~~
  Done.
- The board renders 99 games in one flat list. The NFL's 16 fit; a CFB Saturday
  does not. Grouping by kickoff window (or filtering to ranked/conference games)
  is a UX question worth settling before launch, not after.
- `currentNflSeason()` (`config.js:18`) rolls the season over in March. That
  happens to be correct for CFB as well, so it can stay — but the name becomes a
  lie. Rename to `currentFootballSeason()`.

## Decisions taken

1. **Both at once.** ~~One league at a time, or both?~~ A single `LEAGUE` env var that
   switches the whole stack is roughly half the work — no per-pool league, no
   mixed-table hazards, phase 1 shrinks to a config change. Running both
   simultaneously is what forces the full schema change. Built the full version:
   the stipend bug and the missing index justified it on their own, and a
   config-only switch would have had to be undone later. `INGEST_LEAGUES`
   controls which feeds run; the schema supports both regardless.
2. **FBS only.** `groups=80` is FBS; FCS would drag in most of the 230-team
   name-collision surface for games nobody is pricing.
3. **The postseason is ingested as week 17 — still open as a product question.**
   44 bowl games spanning mid-December to January on a single board is strange,
   and nothing stops a pool from running it. Capping college pools at week 16
   remains a reasonable v1 call; it would be a change in the week list, not the
   schema.

## Test plan

- ~~`homeSpread()` unit cases~~ — done: `api/test/ingest.test.js`, run with
  `npm test` from `api/`. Covers the punctuated college abbreviations, the NFL
  strings as a regression guard, and the unparseable inputs that must fall
  through to `0`.
- ~~Registry week shapes~~ — done: `api/test/leagues.test.js` pins the 18-week
  NFL walk, the 16+postseason college walk, the week-17 remap, `groups=80`, the
  disabled nickname fallback, and the lowercase SharpAPI slugs.
- ~~Ingest both leagues into a clean volume~~ — done on a live stack:
  NFL 272 games/18 weeks, NCAAF 946/17. College week 1 = 99 games, week 17 = 44
  bowl fixtures, all `league = 'NCAAF'`.
- ~~Board scoping and stipends~~ — done: an NFL pool returns 16 games and a
  college pool 99 for the same week, each only its own league. With college
  pushed to week 2 and the NFL on week 1, each top-up pool drew a stipend for
  its own league's week.
- ~~Cross-league bet~~ — done: posting a college game id to an NFL pool returns
  `That game is not in this pool's league (NFL)`.
- **Still untested: the SharpAPI college join.** It cannot run — the key returns
  no college odds. `pairKeys()`'s nickname-stripping is covered by reasoning and
  the ESPN/Sharp name shapes observed, not by a live match.

## Files touched

| File | Change |
| --- | --- |
| `db/init/01-schema.sql` | `league` on `games` + `pools`, index |
| `api/src/config.js` | league config, rename `currentNflSeason` |
| `api/src/services/ingest.js` | league-aware URL, regex fix, postseason mapping, alias table |
| `api/src/services/games.js` | league filter on all four queries |
| `api/src/services/bets.js` | league filter in `getBoard` and bet queries |
| `api/src/services/settlement.js` | league filter in `grantStipends` |
| `api/src/services/picks.js` | league filter (legacy modes) |
| `api/src/routes/pools.js` | league on create, board, weeks |
| `api/src/routes/admin.js` | league on ingest/odds/settle helpers |
| `web/public/app.js` | league selector, badge, board grouping |
| `docker-compose.yml` | `LEAGUE` / `SHARP_LEAGUE` wiring for api + worker |
| `docs/data-sources.md` | document the second league |
