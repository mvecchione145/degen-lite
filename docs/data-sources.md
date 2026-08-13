# External Sports Data & API Strategy

To operate without high API costs, the system uses two distinct types of data
feeds behind a cached ingestion strategy. Application code never calls a provider
directly on a user request — scheduled jobs ingest into the database and cache,
and requests read from there.

> **Lines are now load-bearing.** Under Spread Sharks a game without a spread and
> a total has no markets to offer, so the odds feed is not a nicety on top of the
> schedule — it is what makes a game playable. The MVP therefore ships with
> **synthetic lines** generated alongside the demo season, read through the
> provider seam in `api/src/services/lines.js`, so nothing depends on a live feed
> until one is wired in. Every bet copies its line and price at placement, which
> is what lets the provider change without disturbing settled history.

## Odds & Schedule Providers

Used for pregame lines, totals, and season schedules. These change slowly and are
polled infrequently.

| Provider | Free tier | Notes |
| --- | --- | --- |
| **The Odds API** | 500 requests/month | Best for pregame lines and schedules |
| **SharpAPI** | 12 requests/minute (~17,280/day), 60-second delay | Ideal for frequent polling during development |
| **OddsPapi** | 250 requests/month | Covers 350+ global sportsbooks |

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
per-sport rule rather than one global one. The synthetic season has no such
concept, so the MVP exposes an admin action to mark a game abandoned purely so
the void path is exercisable before a live feed is connected.

## Ingestion Strategy

The core cost control is that polling frequency is decoupled from user traffic. A
Sunday-morning spike of users checking scores produces zero additional upstream
API calls.

- **Schedules** — ingested once per week, well ahead of the slate. Low volume,
  fits comfortably in a 500/month budget.
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

## Budget Implications

The free tiers are workable because request volume scales with *games*, not with
*users*. A season's schedule, lines, and scores cost the same number of upstream
calls whether the platform has 10 users or 100,000. Growth pressure lands on
compute and database (see [Cost Estimates](cost-estimates.md)), not on data.
