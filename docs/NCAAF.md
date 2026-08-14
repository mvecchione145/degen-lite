# College Football (NCAAF) Support — Scope

Status: **proposal, nothing implemented.** This document scopes what it would
take to run a Spread Sharks pool on college football alongside (or instead of)
the NFL.

Every number and defect below was checked against the live ESPN endpoints on
2026-08-14, not inferred. Where something could not be verified without a
SharpAPI key it is called out as **unverified**.

## Summary

Provider support is not the obstacle. SharpAPI covers NCAAF on the same free
tier we already use, and ESPN's college-football scoreboard carries the same
shape of payload — including pregame spreads and totals — as the NFL one.

The obstacle is that **this codebase has no league dimension.** `games` is keyed
on `(season, week)` and every read filters on those two columns alone, so
ingesting a second league into the same table does not produce two boards. It
produces one board with 115 games on it, and it corrupts the weekly stipend for
existing NFL pools. Adding the league column is the bulk of the work; pointing
the ingester at a different URL is the trivial part.

Rough size: **1.5–2.5 days**, most of it in phase 2 and 3.

## What was verified

### SharpAPI covers NCAAF

| | |
| --- | --- |
| League slug | `NCAAF` — `GET /api/v1/odds?league=NCAAF` |
| Free tier | Included: 12 req/min, 2 books, same as NFL |
| Markets | `point_spread` and `total_points` both offered |
| Coverage | ~800+ games/season including bowls and the CFP |

`fetchLines()` in `api/src/services/sharp.js` needs no change to fetch it — the
league is already a parameter (`config.sharp.league`, `SHARP_LEAGUE`).

Sources: [sharpapi.io/odds/ncaaf](https://sharpapi.io/odds/ncaaf),
[docs.sharpapi.io](https://docs.sharpapi.io/en).

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

## Required changes

### Phase 1 — league dimension (the load-bearing change)

`games` has no league column, and neither does `pools`. Until it does, a second
league cannot coexist with the first.

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

### Phase 2 — CFB ingestion

In `api/src/services/ingest.js`:

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

### Phase 3 — SharpAPI join hardening

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
4. **Pagination is the open risk (unverified).** `fetchAll` caps at
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

### Phase 4 — surface

- League selector on pool creation, and a league badge on the pool header.
- The board renders 99 games in one flat list. The NFL's 16 fit; a CFB Saturday
  does not. Grouping by kickoff window (or filtering to ranked/conference games)
  is a UX question worth settling before launch, not after.
- `currentNflSeason()` (`config.js:18`) rolls the season over in March. That
  happens to be correct for CFB as well, so it can stay — but the name becomes a
  lie. Rename to `currentFootballSeason()`.

## Decisions needed

1. **One league at a time, or both at once?** A single `LEAGUE` env var that
   switches the whole stack is roughly half the work — no per-pool league, no
   mixed-table hazards, phase 1 shrinks to a config change. Running both
   simultaneously is what forces the full schema change. *Recommendation: build
   phase 1 properly anyway; the stipend bug and the missing index justify it,
   and a config-only switch would have to be undone later.*
2. **FBS only, or FBS + FCS?** `groups=80` is FBS. FCS games drag in most of the
   230-team name-collision surface for games nobody is pricing.
   *Recommendation: FBS only.*
3. **Does the postseason belong in a pool at all?** Bowls spanning Dec 14 →
   Jan 20 as a single "week 17" is a strange board. It may be cleaner to end CFB
   pools at week 16 in v1.

## Test plan

- ~~`homeSpread()` unit cases~~ — done: `api/test/ingest.test.js`, run with
  `npm test` from `api/`. Covers the punctuated college abbreviations, the NFL
  strings as a regression guard, and the unparseable inputs that must fall
  through to `0`.
- Ingest 2025 CFB weeks 1, 15, 16 and postseason into a clean volume; assert
  96/9/1/46 rows land on weeks 1/15/16/17 with `league = 'NCAAF'`.
- With an NFL demo pool and a CFB pool in the same season, assert each board
  returns only its own league's games, and that a TOPUP pool grants exactly one
  stipend for its own league's current week.
- With a live SharpAPI key: run `applySharpLines('NCAAF')` and check
  `unmatched`, `truncated`, and `events_priced` against the ESPN slate size.
  Any `truncated: true` invalidates the pagination assumption above.

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
