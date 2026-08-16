# Playing a season in minutes

`mock-espn/` is a stand-in for ESPN's scoreboard that compresses a season into
minutes, so the parts of this app that only happen over months — kickoff locks,
settlement, payouts, weekly stipends, busts, a leaderboard that moves — can be
watched end to end while you have the tab open.

It speaks the same endpoint and returns the same payload shape the real
ingester already parses, so **nothing in the app knows the difference**. The
same URL building, the same `toGameRow` mapping, the same upsert, the same
locking, the same settlement. A mock the app had to be modified to accept would
not be testing much.

## Running one

```bash
export ESPN_BASE=http://mock-espn:3001/apis/site/v2/sports
export MOCK_WEEK_SECONDS=60      # a "week" lasts a minute -> 18 weeks in 18
export INGEST_CRON="* * * * *"   # the default 10 minutes would miss whole weeks
export INGEST_LEAGUES=NFL

./scripts/reset-db.sh -y                              # start from nothing
docker compose --profile mock up -d --build mock-espn
./scripts/compose.sh up -d
```

The mock is behind a compose profile, so it never starts by accident. Unset
`ESPN_BASE` and restart to go back to the real feed.

Check where the season is up to:

```bash
curl -s localhost:3001/status
{ "season_start": "...", "week_seconds": 60, "current_week": 3,
  "seconds_until_first_kickoff": 0 }
```

## The clock

| Variable | Default | |
| --- | --- | --- |
| `MOCK_WEEK_SECONDS` | 300 | How long a week lasts. 18 weeks × 300s ≈ 90 minutes |
| `MOCK_GAME_SECONDS` | week/5 | How long a game stays `IN_PROGRESS` before going final |
| `MOCK_LEAD_SECONDS` | one week | Delay before week 1 kicks off, so the opening slate is bettable at startup |
| `MOCK_SEASON_START` | boot + lead | Pin to an ISO timestamp to replay the same season |

There is no internal clock. Every response is computed from the wall clock
against a fixed season start, so restarting the container does not lose the
season's position — and two requests a millisecond apart cannot disagree.

Kickoffs within a week are staggered across its first half, so the board always
has a mix of open and locked fixtures. That mix is the point: a board where
everything locks at once never exercises the lock.

**Set `INGEST_CRON` to every minute.** The default ten minutes was chosen for a
real season where nothing changes between ticks; against a one-minute week it
would skip entire weeks of transitions.

## What it generates

- **NFL**: 32 teams, 16 games a week, 18 weeks.
- **College**: 18 teams, 9 games a week, 16 weeks plus a postseason filed the
  way ESPN files it — everything in `seasontype=3, week=1`.
- Team names and abbreviations are real, and deliberately include `TA&M`,
  `M-OH` and `W&M` — the three that broke `homeSpread()` once. A mock season is
  the cheapest place to keep that regression honest.

Everything derived — pairings, lines, scores — comes from a hash of the game's
identity, so **the same season replays identically**. A bug that shows up at
week 12 can be reproduced by restarting with the same `MOCK_SEASON_START`.

### Results track the market

Scores are built *from* the line rather than drawn independently: the final
lands near the spread, and the combined score lands near the total, with enough
noise to make the bet a bet. Measured across a full season:

| | Home covers | Over |
| --- | --- | --- |
| NFL, 288 games | 53% | 57% |
| College, 144 games | 56% | 46% |

The first version drew scores at random, which meant favourites almost never
covered — every spread bet on a favourite lost, and settlement looked broken
when it was working perfectly. Lines are always half-points, so **nothing ever
pushes**; to exercise the push path, set a whole-number line by hand.

## What a run proves

A complete run exercises the whole chain, and the arithmetic can be checked
against the ledger. From an actual run — eight bets, four each way:

```
 market | selection | line  | score | status |   net
 SPREAD | HOME      | -11.5 | 22-24 | LOST   | -500.00
 SPREAD | AWAY      |  -9.5 | 28-26 | WON    |  454.55
 TOTAL  | OVER      |  39.5 | 20-26 | WON    |  454.55
 TOTAL  | UNDER     |  49.5 | 38-18 | LOST   | -500.00
 ...
 balance 49818.20
```

`454.55` is 500 × 100/110 at −110, and 50,000 − (4 × 500) + (4 × 454.55) =
49,818.20. If those do not reconcile, settlement is wrong.

Worth driving deliberately in a compressed season:

- a **TOPUP** pool, to watch weekly stipends land on the right week
- an **ELIMINATE** pool with a small balance, to watch a member bust
- the **leaderboard** moving between weeks
- **both leagues at once**, to confirm the boards stay separate

## Limits

- **No `VOID` path.** Nothing here abandons a game; use
  `POST /api/admin/abandon` for that.
- **Odds do not move.** A game's line is fixed for its whole life, so this does
  not exercise line movement or the SharpAPI join at all — that path is only
  reachable against the real feed with a key.
- **Not a load test.** One process, no delay, no failures. If you want to see
  the ingester handle a bad response, that is a different fixture.
