# Monetization & Revenue Analysis

Revenue modeling for a sports pool application with **100,000 Daily Active Users**
located primarily in North America.

## Traffic & Volume Mechanics

- **Monthly active sessions** — 100,000 DAU × 30 days = **3,000,000 sessions/month**
- **Pageviews per session** — sports users browse multiple screens per visit:
  scanning the board, placing wagers, checking bet history, watching balances and
  standings move. At an average of 4 pageviews per session, total volume is
  **12,000,000 pageviews/month**.

Pageviews per session is the leverage point in the whole model. The product's
natural usage pattern — browse the board, place a bet, check standings, check
scores — produces multiple pageviews per visit without artificial pagination,
which is what moves the model from the conservative tier into the realistic one.
A wagering loop plausibly drives more return visits per week than pick
submission did, since a member has live positions to watch rather than a single
weekly form to fill in.

## Display Ad Revenue Benchmarks

| Scenario | Ad network / strategy | Avg Page RPM | Est. Monthly Revenue | Est. Annual Revenue |
| --- | --- | --- | --- | --- |
| Conservative / Low | Standard Google AdSense (2 PV/session) | $4 – $8 | $24,000 – $48,000 | $288,000 – $576,000 |
| Realistic Baseline | Managed header bidding (Playwire / Raptive) (4 PV/session) | $15 – $25 | $180,000 – $300,000 | $2,160,000 – $3,600,000 |
| Optimized Stack | Header bidding + sticky video + direct sponsors (5+ PV/session) | $25 – $35+ | $375,000 – $525,000+ | $4,500,000 – $6,300,000+ |

The gap between the conservative and realistic tiers is roughly 7×, and it comes
from two compounding factors: moving off standard AdSense onto a managed header
bidding stack raises RPM several-fold, and each additional pageview per session
multiplies inventory.

## Additional Monetization Channels

### Sportsbook Affiliate Deals

Integrating affiliate banners and links (e.g. DraftKings, FanDuel) yields
**$100–$300 CPA** per depositing user.

This is the highest-value-per-user channel, and the Spread Sharks model fits it
more directly than pick pools did: users are already reading lines, comparing
totals, and sizing stakes, so the conversion is a change of venue rather than a
change of behaviour.

That closeness cuts both ways. Affiliate placement interacts with regulation —
availability and terms vary by state — and the platform's own
**non-monetary balance model is what keeps it outside regulated wagering**: no
buy-in, no cash-out, no transfers between members
(see [Product Overview](product-overview.md)). Marketing that blurs the line
between an abstract balance and a real one puts that distinction at risk, so
affiliate surfaces should be unmistakably a third-party sportsbook rather than an
extension of the member's pool balance.

### Sponsored Pools

Allowing local or national brands to sponsor specific pools or leagues in exchange
for logo placement and custom prize distribution. This is direct-sold inventory
rather than programmatic, so it carries higher margin but requires sales effort.

## Modeling Caveats

These are benchmark-based projections at an assumed 100,000 DAU, not observed
performance. Real RPM depends on seasonality (sports ad rates peak sharply during
the season and fall off out of season), geographic mix, fill rate, and viewability.
Revenue at this scale should also be read against the ~$1,050/mo infrastructure
cost at 100,000 users (see [Cost Estimates](cost-estimates.md)) — hosting is not
the constraint on this business model.
