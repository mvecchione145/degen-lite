# AWS Cost Estimation

Estimated monthly cost across three user growth stages on standard multi-AZ AWS
infrastructure. Components are described in [Architecture](architecture.md).

## Cost Matrix

| AWS Service / Component | 10 Users | 1,000 Users | 100,000 Users |
| --- | ---: | ---: | ---: |
| Frontend & CDN (S3 + CloudFront) | < $1.00 | $2.00 | $35.00 |
| Networking (ALB + NAT Gateway + Route 53) | $55.00 | $65.00 | $160.00 |
| Compute (ECS Fargate tasks) | $12.00 | $25.00 | $220.00 |
| Database (Aurora Serverless v2 PostgreSQL) | $45.00 | $65.00 | $420.00 |
| Caching (ElastiCache Redis) | $0.00 | $15.00 | $85.00 |
| Logs & Operations (CloudWatch + Secrets Manager) | $5.00 | $10.00 | $40.00 |
| Data Egress / Transfer Out | < $1.00 | $5.00 | $90.00 |
| **Estimated Total / Month** | **~$118 / mo** | **~$187 / mo** | **~$1,050 / mo** |

## Reading the Matrix

Cost does not scale linearly with users, and the reason matters at both ends:

- **At 10 users**, nearly all cost is fixed baseline infrastructure that exists
  whether or not anyone uses the product.
- **From 10 → 1,000 users** (100× growth), cost rises only ~58%, because the
  fixed baseline still dominates.
- **From 1,000 → 100,000 users** (100× growth), cost rises ~5.6×, driven mostly
  by database and compute. Database alone is 40% of the 100k-user bill.

## Reducing Development-Tier Cost

The ~$118/mo at 10 users is driven by fixed AWS baseline charges:

| Fixed component | Approx. monthly |
| --- | ---: |
| NAT Gateway | ~$32 |
| Application Load Balancer | ~$18 |
| Aurora minimum 0.5 ACU | ~$43 |

This can be reduced to **under $20/month** for development by:

- Running tasks in **public subnets without a NAT Gateway**
- Substituting **RDS PostgreSQL `db.t4g.micro`** for Aurora Serverless v2

Both substitutions trade production-grade isolation and elasticity for cost, so
they belong in development and staging environments — not in the production
topology described in [Architecture](architecture.md).

## Caveats

These are planning estimates, not quotes. Actual cost depends on region, reserved
capacity or Savings Plans, real traffic distribution, retention settings on logs,
and how aggressively the caching layer offloads the database.
