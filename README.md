# LeaguePicks

A season-long sports pool platform built around **Spread Sharks**: friends join a
pool, each hold an abstract balance, and stake it on game spreads and totals at
posted odds. Standing is measured by balance. No real money is involved — there
is no buy-in, no cash-out, and no house.

This repository holds the planning specification in [`docs/`](docs/) and a
working MVP that runs locally on Docker Compose.

## Quickstart

```bash
docker compose up -d --build
open http://localhost:8080
```

Sign in with any demo account — **alice**, **bob**, **carol**, or **dave** —
password `password123`.

The database seeds itself on first boot with a 5-week season positioned relative
to the moment you start it:

| Weeks | State |
| --- | --- |
| 1–2 | Played and settled, so balances and standings have real history immediately |
| 3 | Kicks off in ~2 days — open for wagering |
| 4–5 | Further out |

The demo pool **Spread Sharks** (invite code `SHARKS01`) has all four members
with settled bets behind them. One pool of each legacy mode is also seeded —
`SUNDAY01`, `OFFICE01`, `SURVIVE1` — and remains playable.

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
docker compose down -v && docker compose up -d   # the test needs a fresh season
node scripts/smoke-test.mjs
```

111 checks covering auth, placement rules, the per-game cap, settlement
arithmetic to the cent, voids, bust policies, and leaderboard caching.

To see the full loop without waiting for real kickoffs, open a pool and click
**Simulate results** (or `POST /api/admin/simulate`). It finalizes the current
week, settles every wager, applies bust policies, and busts the leaderboard
cache.

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

The seed only runs when the volume is empty, so `down -v` is how you get a fresh
demo season.

## Legacy game modes

Pick'em, Confidence, and Survivor are no longer offered when creating a pool, but
they remain in the codebase and existing pools keep working. To offer them again:

```bash
LEGACY_POOL_MODES=true docker compose up -d api web
```

## Live odds from SharpAPI

Lines are synthetic by default so the demo needs no network access or API key.
Real spreads and totals come from [SharpAPI](https://sharpapi.io), with the key
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
`docker compose` and the stack still starts on synthetic lines.

Once running, the worker refreshes lines every five minutes. To trigger one
immediately, or to check what the key is entitled to:

```bash
curl -X POST -H "authorization: Bearer $TOKEN" localhost:3000/api/admin/odds
curl -H "authorization: Bearer $TOKEN" localhost:3000/api/admin/odds/account
```

**SharpAPI supplies lines, not scores** — its free tier has no score data and no
week numbers, so ESPN remains the source for the schedule and final results.
Enable that separately:

```bash
INGEST_ENABLED=true INGEST_SEASON=2026 ./scripts/compose.sh up -d worker
```

ESPN ingestion refuses to run on a volume that still holds the seeded demo
season, since real and synthetic fixtures would collide on the same week
numbers. Start from `docker compose down -v` for live data. Ingested games are
namespaced with an `espn:` id prefix.

See [docs/data-sources.md](docs/data-sources.md) for the full provider split.

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
