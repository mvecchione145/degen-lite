# LeaguePicks

A season-long sports pool platform built around **Spread Sharks**: friends join a
pool, each hold an abstract balance, and stake it on game spreads and totals at
posted odds. Standing is measured by balance. No real money is involved — there
is no buy-in, no cash-out, and no house.

This repository holds the planning specification in [`docs/`](docs/) and a
working MVP that runs locally on Docker Compose.

## Quickstart

```bash
./scripts/compose.sh up -d --build
open http://localhost:8080
```

Sign in with the bootstrap account — **admin** — password `password123`, or
create your own from the same screen.

**All sports data is real.** On first boot the worker pulls the current NFL
regular season from ESPN — 272 games across 18 weeks — and prices every one of
them from [SharpAPI](https://sharpapi.io). Nothing is fabricated: no invented
fixtures, no invented lines, no pre-placed bets. Give it about a minute, then
watch it land:

```bash
docker compose logs -f worker
```

The database bootstraps only what you need to sign in and look at the board:
four accounts and one open pool, **Spread Sharks** (invite code `SHARKS01`),
with every member on the starting balance and no wagers behind them.

The wrapper script injects the SharpAPI key from 1Password — see
[Live odds](#live-odds-from-sharpapi). Plain `docker compose up -d` also works;
you get the real schedule from ESPN and ESPN's own lines, just not SharpAPI's.

## How a pool works

- Every member starts on the pool's **starting balance** (10,000 by default).
- Each game offers a **spread** and a **total**, both priced at **−110**.
- A stake carries two decimal places and can never be below **1.00**.
- The line and price are captured when the bet is placed; later movement does not
  change it.
- The stake leaves your balance immediately, and **a placed bet cannot be
  cancelled or edited**.
- A game stops taking bets at its own kickoff, and everyone's bets on it become
  visible at that moment.
- Winners are paid stake + profit, pushes and voids return the stake.

At −110 on both sides you need to win 52.38% to break even, so which games you
back — and how much — is the whole game.

Full rules in [docs/game-modes.md](docs/game-modes.md).

## Verify it works

```bash
docker compose down -v && ./scripts/compose.sh up -d   # needs a fresh season
node scripts/smoke-test.mjs
```

113 checks covering auth, placement rules, the per-game cap, settlement
arithmetic to the cent, voids, bust policies, leaderboard caching, and the live
odds feed.

The season has not been played yet, so settlement is exercised by finalizing a
week with a chosen scoreline. The test derives that scoreline from the **real**
spreads on the board — picking a whole-number spread to land exactly on for a
push, and games either side of it for a win and a loss — so the outcomes are
exact rather than probabilistic. It consumes three weeks doing so, hence the
fresh database.

The same tool is available in the UI: open a pool and click **Simulate results**
(or `POST /api/admin/simulate`) to finalize the current week, settle every wager,
apply bust policies, and bust the leaderboard cache.

## Services

| Service | Port | Role |
| --- | --- | --- |
| `web` | 8080 | nginx serving the static client and proxying `/api` to the API |
| `api` | 3000 | Express API |
| `worker` | — | Scheduled settlement and optional score ingestion |
| `db` | 5433 | PostgreSQL 16 |
| `redis` | 6380 | Leaderboard cache |
| `redis-ui` | 5540 | RedisInsight — browse the cache at http://localhost:5540 |

Host ports are configurable in `.env` — see [`.env.example`](.env.example).
Postgres and Redis are mapped to non-default host ports (5433/6380) so they do
not collide with local installs.

## Common commands

```bash
docker compose logs -f api worker    # follow application logs
docker compose down                  # stop, keeping data
docker compose down -v               # stop and wipe the database
docker compose up -d --build         # rebuild after code changes
psql postgres://leaguepicks:leaguepicks@localhost:5433/leaguepicks
```

The bootstrap SQL only runs when the volume is empty, so `down -v` is how you get
a clean database — the schedule and lines are then re-pulled from the feeds.

## Legacy game modes

Pick'em, Confidence, and Survivor are no longer offered when creating a pool, but
they remain in the codebase and existing pools keep working. To offer them again:

```bash
LEGACY_POOL_MODES=true docker compose up -d api web
```

## Live odds from SharpAPI

Spreads and totals come from [SharpAPI](https://sharpapi.io), with the key
injected from 1Password at run time — it is never written to disk:

```bash
./scripts/compose.sh up -d
```

That wrapper is `op run --env-file=.env.op -- docker compose`, resolving the
reference in [`.env.op`](.env.op):

```
SHARP_API_KEY=op://Private/Sharp API/password
```

`.env.op` holds pointers only, no secret material, so it is safe to commit. If
the 1Password CLI is missing or not signed in, the wrapper falls back to plain
`docker compose`: the stack still runs on the real ESPN schedule and ESPN's own
lines, just without SharpAPI pricing.

Once running, the worker refreshes lines every five minutes. To trigger one
immediately, or to check what the key is entitled to:

```bash
curl -X POST -H "authorization: Bearer $TOKEN" localhost:3000/api/admin/odds
curl -H "authorization: Bearer $TOKEN" localhost:3000/api/admin/odds/account
```

**SharpAPI supplies lines, not scores.** Its free tier has no score data and no
week numbers, so the two feeds split the job:

| Feed | Provides | Schedule |
| --- | --- | --- |
| **ESPN** | Schedule, week numbers, status, final scores | every 10 min (`INGEST_CRON`) |
| **SharpAPI** | Spreads and totals | every 5 min (`ODDS_CRON`) |

Both are on by default. When a SharpAPI key is present it owns the line columns
outright and ESPN stops updating them — otherwise the two feeds overwrite each
other on alternating ticks and a spread visibly flaps. Ingested games carry an
`espn:` id prefix.

To pin a different season:

```bash
INGEST_SEASON=2025 ./scripts/compose.sh up -d worker
```

See [docs/data-sources.md](docs/data-sources.md) for the full provider split.

### The season may not have started

Until kickoff week arrives there are no final scores, so nothing settles and
every balance sits at its opening figure. That is correct, not a fault. Use
**Simulate results** to exercise settlement before the season is under way.

## Documentation

- [docs/mvp.md](docs/mvp.md) — what's built, API reference, and where the MVP
  deviates from the specification
- [docs/game-modes.md](docs/game-modes.md) — Spread Sharks rules in full
- [docs/README.md](docs/README.md) — the full product and infrastructure spec

## Scope

This is a local development MVP. It is not production-ready: see the
[Not built yet](docs/mvp.md#not-built-yet) and
[Production gaps](docs/mvp.md#production-gaps) sections before deploying it
anywhere.
