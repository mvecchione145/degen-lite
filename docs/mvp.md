# MVP Implementation

What is actually built and running, how it maps onto the planned AWS
architecture, and where it knowingly departs from the specification.

Run it with `docker compose up -d --build`; see the [root README](../README.md)
for the quickstart.

## What works

Every fixture, line, and score is real: the schedule comes from ESPN and the
spreads and totals from SharpAPI. The database bootstraps four accounts and one
empty pool, and generates no sports data at all.

- **Accounts** — register, sign in, JWT-authenticated requests
- **Pools** — create a Spread Sharks pool with its full settings, private or
  public, join by invite code, browse public pools
- **Balances** — an append-only ledger per member per pool, with available
  balance and stake at risk tracked separately
- **Board** — each week's games with a spread, a total, and a −110 price per side
- **Wagering** — placement with the kickoff lock, the whole-unit floor, balance
  sufficiency, and the aggregate per-game cap all enforced
- **Settlement** — automatic grading once games go final, covering wins, losses,
  pushes, and voids for abandoned games
- **Bust policies** — elimination, weekly top-up, and rebuy
- **Leaderboards** — ranked on balance, with stake at risk, net profit, and total
  credited, Redis-cached
- **Bet history** — every wager with the line and price as struck, and running P&L
- **Reveal** — other members' bets stay hidden until a game kicks off
- **Legacy modes** — Pick'em, Confidence, and Survivor pools remain fully
  playable behind a flag

## Stack

| Layer | Local | Planned AWS equivalent |
| --- | --- | --- |
| Client | Vanilla JS SPA on nginx | S3 + CloudFront |
| Reverse proxy | nginx `/api` → api:3000 | Application Load Balancer |
| API | Node 22 + Express (ESM, no build step) | ECS Fargate service |
| Scheduled jobs | `worker` container running node-cron | EventBridge → Fargate tasks |
| Database | PostgreSQL 16 | Aurora Serverless v2 |
| Cache | Redis 7 | ElastiCache for Redis |

The `worker` runs the same image as `api` with a different entrypoint, mirroring
the "one task definition per job" shape in [architecture.md](architecture.md).
The client is served same-origin behind nginx, so CORS never enters the picture.

Redis is a pure accelerator: every cache operation degrades to a miss if Redis is
down, and the API keeps serving from Postgres.

## Layout

```
api/src/
  server.js        API entrypoint          worker.js    scheduled jobs entrypoint
  app.js           route wiring            config.js    env configuration
  db.js            pg pool + transactions  cache.js     redis, fail-soft
  auth.js          hashing, JWT, guard     http.js      errors + async wrapper
  routes/          auth, pools, games, admin
  services/
    bets.js        placement, board, history, rebuy
    ledger.js      balances derived from the entry log
    lines.js       pricing and presentation of a line
    sharp.js       SharpAPI client: rate limiting, caching, line mapping
    settlement.js  grading, voids, stipends, bust, legacy picks
    leaderboard.js balance and legacy standings
    pools.js       creation, joining, membership guards
    picks.js       legacy pick validation
    games.js       schedule queries
    ingest.js      ESPN schedule/scores, and applying SharpAPI lines to games
db/init/           01-schema, 02-functions, 03-seed  (run once, on an empty volume;
                   03-seed creates accounts and one pool — no sports data)
web/public/        index.html, app.js, styles.css
scripts/           compose.sh (op-wrapped docker compose), smoke-test.mjs
```

## Money handling

Every monetary column is `NUMERIC(14,2)` and **all arithmetic happens in SQL**.
JS never computes a stored figure — it converts values to numbers only for
display, and the one client-side payout calculation is a preview that the server
recomputes authoritatively.

This matters at placement. Balance sufficiency and the per-game cap are compared
in exact NUMERIC inside the database:

```sql
SELECT bal.balance >= $4::NUMERIC                      AS can_afford,
       ($5::NUMERIC IS NULL
        OR exposure.staked + $4::NUMERIC <= $5::NUMERIC) AS within_cap
```

Doing those comparisons in JS floating point would eventually let a stake through
that the ledger could not cover.

### Grading

`grade_bet()` and `bet_profit()` in `db/init/02-functions.sql` are the single
source of truth for grading. Profit at −110 is
`stake × 100 / 110` rounded to the cent — Postgres `ROUND` on NUMERIC rounds half
away from zero, which is the rule the story specifies.

### Concurrency

Placement opens by locking the member's `pool_members` row:

```sql
SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2 FOR UPDATE
```

Without it, two simultaneous wagers both read the same balance and exposure and
together breach the cap or overdraw the account. The check and the insert have to
be in one transaction, and that transaction has to be serialised per member.

### Idempotency

Settlement runs every minute, so every step keys off a state it clears itself:

| Step | Guard |
| --- | --- |
| Grading wagers | `bets.status = 'PENDING'` |
| Voiding wagers | `bets.status = 'PENDING'` on a `VOID` game |
| Weekly stipends | A partial unique index on `(pool_id, user_id, season, week)` |
| Bust elimination | `pool_members.is_eliminated = FALSE` |
| Legacy picks | `picks.settled_at IS NULL` |

Bust is evaluated **after** payouts and stipends land, so a member whose winnings
arrived in the same cycle is not eliminated by mistake.

## Rules enforced in the application

The schema cannot express these, so they live in `api/src/services/bets.js`:

- **Kickoff lock** — a wager is rejected once its game's `kickoff_time` has passed
- **Balance sufficiency** — a stake may not exceed available balance
- **Per-game cap** — aggregate stake across all wagers on one game, checked in
  the placing transaction
- **Minimum bet** — the pool's minimum, never below the schema's 1.00 floor
- **Two decimal places** — stakes with finer precision are rejected at the edge
- **Market/selection agreement** — `OVER` on a spread market is rejected
- **Elimination** — a bust member in an elimination pool cannot wager
- **End date** — no new wagers once it passes
- **Rebuy eligibility** — bust, under the pool's limit, nothing pending
- **Mode boundaries** — a wager pool refuses picks, a legacy pool refuses wagers

Each has a corresponding assertion in `scripts/smoke-test.mjs`.

## API reference

All routes are under `/api`. Everything except `/health` and the two auth entry
points requires `Authorization: Bearer <token>`.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/register` | `{username, email, password}` → `{token, user}` |
| `POST` | `/auth/login` | `{login, password}` — `login` is a username or email |
| `GET` | `/auth/me` | The authenticated user |

### Pools

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/pools` | Pools the caller belongs to, with balances |
| `GET` | `/pools/public` | Public pools the caller has not joined |
| `POST` | `/pools` | Name plus any pool setting; defaults to Spread Sharks |
| `POST` | `/pools/join` | `{invite_code}` — idempotent, credits an opening balance once |
| `GET` | `/pools/:id` | Pool, members, weeks, current week, balance |
| `GET` | `/pools/:id/leaderboard` | Standings; `cached` says whether Redis served it |

### Wagering

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/pools/:id/board?week=` | The week's markets, the caller's bets, exposure, and remaining allowance |
| `POST` | `/pools/:id/bets` | `{game_id, market, selection, stake}` |
| `GET` | `/pools/:id/bets?status=` | Bet history with a summary |
| `GET` | `/pools/:id/balance` | Available, at risk, credited, net, bust state |
| `GET` | `/pools/:id/ledger` | Raw ledger entries |
| `POST` | `/pools/:id/rebuy` | Where the pool's bust policy allows it |

There is deliberately **no route to cancel or edit a bet**.

### Games

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/games/seasons` | Seasons with loaded games |
| `GET` | `/games/weeks?season=` | Weeks with game counts and completion state |
| `GET` | `/games?season=&week=` | A week's slate; defaults to the current week |

### Legacy pick modes

`GET /pools/:id/week/:week`, `GET /pools/:id/picks`, `POST /pools/:id/picks` —
unchanged, and rejected on a Spread Sharks pool.

### Admin — requires `DEV_TOOLS=true`

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/admin/settle` | Run settlement immediately |
| `POST` | `/admin/simulate` | `{season?, week?, home_score?, away_score?}` — finalize a week, then settle |
| `POST` | `/admin/abandon` | `{game_id}` — mark a game as never having concluded, voiding its bets |
| `POST` | `/admin/odds` | `{league?}` — pull current lines from SharpAPI onto unstarted games |
| `GET` | `/admin/odds/account` | What the configured key is entitled to (never reveals the key) |
| `POST` | `/admin/ingest` | `{season?, force?}` — pull from ESPN, then settle. 409s if the season holds locally-created fixtures |
| `POST` | `/admin/flush-cache` | Drop every cached leaderboard |

`/admin/simulate` writes results onto real fixtures, so the full place → lock →
settle → leaderboard loop is demoable in seconds instead of waiting weeks for
kickoff. Passing explicit scores makes settlement deterministic, which is what
lets the smoke test assert exact push and payout outcomes. `/admin/abandon`
exists because real void detection needs a feed reporting a cancellation, which
cannot be summoned on demand.

Both fabricate results on real games, so `DEV_TOOLS=false` — which removes the
whole router — matters more here than it did against generated fixtures.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_TOOLS` | `true` | Exposes `/api/admin/*` |
| `LEGACY_POOL_MODES` | `false` | Offers Pick'em / Confidence / Survivor at creation |
| `LEADERBOARD_TTL_SECONDS` | `30` | Leaderboard cache lifetime |
| `INGEST_ENABLED` | `false` | Pull the real NFL schedule and scores from ESPN |
| `SHARP_API_KEY` | — | SharpAPI key; injected from 1Password, never stored |
| `SHARP_CACHE_TTL_SECONDS` | `90` | Odds cache lifetime |
| `SETTLEMENT_CRON` | `*/1 * * * *` | Worker settlement schedule |
| `ODDS_CRON` | `*/5 * * * *` | Worker line-refresh schedule |

Full list in [`.env.example`](../.env.example).

## Secrets

`SHARP_API_KEY` is resolved from 1Password at run time rather than stored:

```bash
./scripts/compose.sh up -d      # op run --env-file=.env.op -- docker compose
```

[`.env.op`](../.env.op) holds the reference `op://Private/Sharp API/password` —
a pointer, not a credential, so it is safe to commit. `op run` injects the
resolved value into docker compose's environment, where compose interpolates it
into the `api` and `worker` services. Nothing lands on disk, and `op run`
conceals the value in child-process output (`compose config` prints
`<concealed by 1Password>`).

The wrapper degrades rather than failing: with no `op` binary, or no signed-in
account, it falls back to plain `docker compose` — the stack still runs on the
real ESPN schedule and ESPN's own lines, just without SharpAPI pricing.

## Odds and caching

SharpAPI supplies spreads and totals; ESPN supplies the schedule and scores.
The split is forced by the data — SharpAPI's free tier has no scores and no week
numbers. When a SharpAPI key is present it owns the line columns, and the ESPN
ingester stops updating them, or the two feeds overwrite each other on
alternating cron ticks.

Redis runs with append-only persistence on a named volume (`redisdata`). On a 12
requests/minute allowance, a cache that emptied on every restart would spend the
budget re-fetching lines it already had. Each pagination page is cached
independently under `sharp:v1:<path>?<query>` for 90 seconds — just above the
free tier's own 60-second data delay, since polling faster returns the same
numbers at the cost of rate limit. Requests are additionally spaced in-process to
stay under the per-minute allowance.

A full NFL refresh costs 4 requests (two markets, two pages each).

## Deviations from the specification

The original schema in [database-schema.md](database-schema.md) has been extended
rather than replaced. Because the legacy modes were hidden rather than removed,
**this work was additive**: no table was dropped and no column changed meaning.

| Change | Why |
| --- | --- |
| `users.password_hash` | The spec has no authentication storage at all |
| `pools.season` | Pools were not season-scoped, so there was no way to resolve which slate a pool plays |
| `pools.is_public` | Public pools are described in the product but absent from the schema |
| `pools.*` wager settings | Starting balance, caps, bust policy, and end date all come from the Spread Sharks story |
| `games.total` | The spec has a spread but no over/under, and the total is half the product |
| `games.status = 'VOID'` | A game that never officially concluded needs a terminal state distinct from `FINAL` |
| `bets`, `ledger_entries` | Entirely new — the spec had no concept of a stake or a balance |
| `pool_members.rebuys_used`, `eliminated_week` | Needed by the bust policies and the standings display |
| `picks.settled_at` | Separates "not yet graded" from "graded as a push" |
| `CHECK` constraints throughout | The spec documents allowed values in comments only |
| `NOT NULL` on foreign keys, `ON DELETE CASCADE` on pool-scoped rows | The spec's columns were nullable, which permits orphaned rows |
| Indexes | None were specified; these back every hot query |
| `grade_bet()`, `bet_profit()`, `grade_pick()` | Keeps settlement and seeding from drifting apart |

Behavioural notes:

- **NFL only.** `games` has no sport column. The void rule is written per-sport so
  other leagues drop in cleanly, but only the NFL is wired up.
- **No sports data is generated.** Fixtures, weeks, and scores come from ESPN;
  spreads and totals from SharpAPI. The bootstrap SQL creates four accounts and
  one empty pool and nothing else.
- **Preseason is not ingested.** ESPN is queried for the regular season only, so
  between February and September the board holds only future fixtures.
- **Ingestion refuses to run over locally-created fixtures.** If a season already
  holds games that did not come from a feed, ingesting would mix them on the same
  week numbers, so it returns 409 instead.
- **Every price is −110.** The payout arithmetic is written for any American
  price, so varying prices are a pricing change rather than a rewrite.
- **Survivor is single-elimination** in the legacy mode; strikes are not
  implemented.
- **`tiebreaker_points` is stored but not used for ranking** in the legacy modes.

## Not built yet

Commissioner tools (editing settings after creation, removing members, deleting a
pool), password reset and email verification, parlays or any multi-leg wager,
moneyline markets, multi-sport support, live in-play wagering, notifications, and
every monetization surface in [monetization.md](monetization.md).

Season end is enforced — no new bets past the date — but no winner is formally
declared or archived.

## Production gaps

This runs locally. Before it runs anywhere else:

- **Secrets** — `JWT_SECRET` defaults to a known development value. It must come
  from a real secret store, and `DEV_TOOLS` must be `false`. `/admin/simulate`
  and `/admin/abandon` can rewrite results and void wagers.
- **Token handling** — JWTs are stored in `localStorage` (XSS-readable) with no
  refresh or revocation path.
- **No rate limiting** — `/auth/login` and `/auth/register` are unthrottled.
- **No migration tooling** — `db/init/*.sql` runs only against an empty volume, so
  a schema change means `docker compose down -v`. This is the first gap to close.
- **No TLS** — nginx serves plain HTTP; termination is assumed upstream.
- **Testing** — `scripts/smoke-test.mjs` covers the API end to end, but there are
  no unit tests and the web client has no automated coverage.
- **Operations** — no structured logging, metrics, tracing, or backups. The
  ledger is the system of record for balances and has no backup story.

## Verification

`node scripts/smoke-test.mjs` runs **113 checks** against a live stack:

- auth and its rejection paths
- pool creation with every setting, and the legacy-mode flag
- opening balances, including that rejoining cannot mint a second credit
- the board, and that lines and prices are captured onto each bet
- placement rules: the whole-unit floor, two-decimal precision, balance
  sufficiency, the aggregate per-game cap, uncapped pools, pool minimums, the
  kickoff lock, and the absence of any cancel route
- mode boundaries in both directions
- settlement arithmetic asserted **exactly** — a push nets 0, a −110 win on 200
  nets 181.82, a loss nets −200 — plus idempotency and no double-crediting
- voids refunding stakes in full
- bust detection, rebuy limits, weekly stipends, and elimination
- ledger entries summing to the reported balance
- the live odds feed: key accepted, pagination not truncated, repeat refresh
  served from the persistent cache

The settlement assertions are exact even though the season has not been played.
`/admin/simulate` accepts a scoreline, and the test derives one from the **real**
spreads on the board: it finds a whole-number spread to land exactly on for a
push, then bets games either side of it for a guaranteed win and loss. Since one
scoreline applies to a whole week, this yields all three outcomes from a single
simulate.

It consumes three weeks, so reset first:

```bash
docker compose down -v && ./scripts/compose.sh up -d
```
