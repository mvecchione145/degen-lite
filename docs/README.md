# LeaguePicks Documentation

LeaguePicks is a private and public sports pool hosting platform where friends,
coworkers, or communities compete over the course of a sports season using
abstract, non-monetary balances.

The active game mode is **Spread Sharks**: each member holds a balance inside a
pool and stakes it on game spreads and totals at posted odds. The platform
maintains the schedule and its lines, locks each game at kickoff, settles wagers
from automated scores, and keeps balances and standings in step.

## Contents

| Document | What it covers |
| --- | --- |
| [MVP Implementation](mvp.md) | What's actually built and running, API reference, deviations from this spec |
| [Product Overview](product-overview.md) | Core concept, terminology, season lifecycle |
| [Game Modes](game-modes.md) | Spread Sharks rules, payouts, bust policies; the legacy pick modes |
| [Data Sources](data-sources.md) | Lines, totals, and score feeds, plus the ingestion strategy |
| [Database Schema](database-schema.md) | PostgreSQL tables, the balance ledger, and relationships |
| [Architecture](architecture.md) | AWS serverless container architecture |
| [Cost Estimates](cost-estimates.md) | Monthly AWS cost matrix at 10 / 1,000 / 100,000 users |
| [Monetization](monetization.md) | Ad revenue modeling and affiliate channels |
| [College Football](NCAAF.md) | Scope for adding NCAAF: what it costs, what breaks first |
| [Input: user story](inputs/user-story.md) | The source note behind Spread Sharks, with the decisions taken |

## Status

[MVP Implementation](mvp.md) describes the working local build in this
repository, and [Game Modes](game-modes.md), [Product Overview](product-overview.md),
and [Database Schema](database-schema.md) have been reconciled with it.

[Architecture](architecture.md), [Cost Estimates](cost-estimates.md), and
[Monetization](monetization.md) remain forward-looking plans — all figures there
are estimates, and none of that infrastructure is deployed.

[College Football](NCAAF.md) is a scoping document for work not yet started. Its
findings about the current NFL code are verified against the live feeds; its
plan is a proposal.

Original source material: [`../context.txt`](../context.txt).
