# Product Overview

## Core Concept

LeaguePicks hosts private and public sports pools for season-long competition
using abstract, non-monetary balances. There is no house, no bookmaker margin
taken by the platform, and no real-money wagering: a pool is a group of people
competing against each other over a full season.

The platform's active game mode is **Spread Sharks**. Each member holds a balance
inside a pool and stakes it on individual games — against the spread or on the
total — at posted odds that include the vig. Standing is measured by balance.

The platform's job is to remove the manual work that normally falls on whoever
runs the pool:

- Load and maintain the season schedule, with a line and a total on every game
- Present each week's board and accept wagers
- Lock each game automatically at its own kickoff
- Fetch final scores and settle wagers without manual entry
- Keep balances, bet history, and live standings in step

## Terminology

| Term | Meaning |
| --- | --- |
| **Pool** | A league: a named group with one rule set, joined via invite code |
| **Commissioner** | The user who created the pool and owns its configuration |
| **Member** | A user who has joined a pool |
| **Balance** | A member's abstract points inside one pool — per member, per pool |
| **Board** | The week's games with their available markets and prices |
| **Market** | Spread or total |
| **Line** | The number a wager is graded against, captured at placement |
| **Price** | The odds, in American format — −110 throughout |
| **Stake** | The balance risked on one wager |
| **At risk** | Total stake on wagers that have not yet settled |
| **Lock** | The moment a game's kickoff passes and it stops taking wagers |
| **Settlement** | Grading wagers and crediting payouts once a game is final |
| **Push** | A wager landing exactly on the number — stake returned |
| **Void** | A game that never officially concluded — every stake returned |
| **Bust** | Balance too low to place the minimum wager, with nothing pending |

## Pool Configuration

A pool is defined by options set at creation:

- **Starting balance** — credited to every member on joining
- **Max bet per game** — a cap on total stake across all wagers on one game,
  switchable off entirely
- **Minimum bet** — optional, and never below the 1.00 whole-unit floor
- **Bust policy** — eliminate, weekly top-up, or rebuy
- **End date** — optional; without one the pool runs open-ended
- **Invite code** — a short unique code used to join a private pool

Full detail in [Game Modes](game-modes.md).

## Season Lifecycle

1. **Preseason** — commissioner creates the pool, sets its rules, shares the
   invite code; members join and are credited their starting balance.
2. **Weekly cycle** — the week's games are published with a spread, a total, and
   a price on each side. Members place wagers. Each game locks at its own
   kickoff, and everyone's bets on it become visible at that moment.
3. **Settlement** — as games go final, scores are ingested and wagers are graded.
   Balances, bet history, and standings update together.
4. **Season end** — at the configured end date, once the last outstanding wager
   has settled, standings freeze and the highest balance wins.

## Design Constraints

- **Non-monetary.** Balances are abstract. There is no purchase, no cash-out, and
  no transfer between members. This is what keeps the product clear of regulated
  wagering while still supporting sportsbook affiliate revenue
  (see [Monetization](monetization.md)). The product adopts sportsbook
  *mechanics* — stakes, vig, payouts — without being one.
- **A pool is not a closed economy.** With no house and no peer-to-peer matching,
  payouts are credited from nowhere and lost stakes go nowhere, so total balance
  across a pool is not conserved. A balance is a score expressed in
  currency-like units.
- **Spiky traffic.** Load concentrates into the hour before the first Sunday
  kickoff, then goes near-idle mid-week. The infrastructure is sized around this
  shape (see [Architecture](architecture.md)).
- **Cheap data.** Lines, totals, and scores are sourced through free tiers and
  public endpoints with aggressive caching (see [Data Sources](data-sources.md)).
- **Real data only.** No fixtures, lines, or results are generated locally. The
  schedule comes from ESPN and the markets from SharpAPI, so a game exists only
  once a feed has reported it and is playable only once it has been priced.
