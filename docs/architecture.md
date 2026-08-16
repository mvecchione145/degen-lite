# AWS Infrastructure Architecture

The application is built on a serverless container architecture in AWS, designed
to handle heavy Sunday morning traffic spikes while scaling down during mid-week
idle periods.

## Topology

```
                    Route 53
                       │
                  CloudFront ──── S3 (static web client)
                       │
                      ALB  (public subnets)
                       │
              ECS Fargate tasks  (private subnets)
                    │       │
        Aurora Serverless v2  ElastiCache Redis  (isolated subnets)
                    ▲
              EventBridge ──► scheduled ingestion jobs
```

## Components

### Frontend & CDN

The static web client is hosted on **Amazon S3** and distributed globally via
**Amazon CloudFront**. Domain management is handled by **Amazon Route 53**.

Serving the client from CDN rather than from the application tier means a traffic
spike of users loading the app costs almost nothing in compute — only the API
calls behind it hit Fargate.

### Compute Layer

Dockerized backend APIs run on **AWS Fargate (Amazon ECS)** in private subnets
behind an **Application Load Balancer**. Scheduled background jobs — schedule
ingestion, line and total polling, score polling, wager settlement — are driven
by **AWS EventBridge**.

Fargate is the fit here because the load profile is spiky and predictable: scale
out ahead of Sunday kickoff windows, scale to a minimal task count mid-week,
without managing EC2 capacity.

### Database Layer

**Amazon Aurora Serverless v2 (PostgreSQL)** in isolated subnets, auto-scaling
from 0.5 ACUs to 16+ ACUs based on demand. The ACU floor is what makes the
low-traffic cost non-zero (see [Cost Estimates](cost-estimates.md)); the ceiling
is what absorbs the pick-submission rush before the early kickoff window.

Schema is documented in [Database Schema](database-schema.md).

### Caching Layer

**Amazon ElastiCache for Redis** stores live leaderboard calculations and public
game odds, reducing direct database reads on game days.

The two hot read paths are the ones worth caching: leaderboards are expensive to
compute and identical for every member of a pool, and lines/scores are identical
for every user of the platform. Both are read far more often than they change.

Balances are deliberately **not** cached. They are derived from an append-only
ledger and must be exact at the moment a wager is placed, so the balance and
per-selection exposure checks read from Postgres inside the placing transaction.

## Traffic Shape

The design is driven by one observation: load is not evenly distributed. It
concentrates into the hour before the first Sunday kickoff (wager placement,
which are writes) and the following few hours (score and leaderboard checks,
which are reads). Mid-week the platform is close to idle.

Wager placement is the more demanding of the two. Each placement takes a row lock
on the member's pool membership and runs its balance and cap checks inside that
transaction, so the pre-kickoff spike is a burst of short write transactions
rather than the cheap upserts a pick submission used to be.

This is why the stack pairs elastic compute and database tiers with a CDN and a
cache — the spike is absorbed at the edges, and the elastic tiers only pay for
the hours they are actually busy.
