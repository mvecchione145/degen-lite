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
| [Deploy to EC2](deploy-ec2.md) | The cheap path: one instance, docker compose, ~$17/mo. Terraform for it lives in [`terraform/`](../terraform/) |
| [Cost Estimates](cost-estimates.md) | Monthly AWS cost matrix at 10 / 1,000 / 100,000 users |
| [Monetization](monetization.md) | Ad revenue modeling and affiliate channels |
| [College Football](NCAAF.md) | Running NCAAF alongside the NFL: what was built, and what the live key changed |
| [Planned work](FUTURE.md) | Wanted but not built: gated pool creation, placing in the pool view, bet-history filters |
| [Input: user story](inputs/user-story.md) | The source note behind Spread Sharks, with the decisions taken |

## Status

[MVP Implementation](mvp.md) describes the working local build in this
repository, and [Game Modes](game-modes.md), [Product Overview](product-overview.md),
and [Database Schema](database-schema.md) have been reconciled with it.

[Architecture](architecture.md), [Cost Estimates](cost-estimates.md), and
[Monetization](monetization.md) remain forward-looking plans — all figures there
are estimates, and none of that infrastructure is deployed.

[College Football](NCAAF.md) records how the second league was built and what
the live SharpAPI key contradicted. [Planned work](FUTURE.md) is a backlog —
design sketches only, nothing in it is implemented.

Original source material: [`../context.txt`](../context.txt).
