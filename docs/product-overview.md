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
- **Max bet** — a cap on total stake on one *selection*: one side of one market
  on one game. The other side, another market, and another game each get their
  own allowance. Switchable off entirely
- **League** — the NFL, college football, or both (see [New features](#new-features))
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

## New features

Capabilities added after the first working build. All of these are shipped and
running; the implementation detail behind each lives in
[MVP Implementation](mvp.md) and [Data Sources](data-sources.md).

### College football

A pool is created against the NFL, college football, or both. The two run side by
side in one database — measured on a live stack, 272 NFL games across 18 weeks
and 946 college games across 17. `INGEST_LEAGUES` (default `NFL`) selects which
feeds the worker pulls; every extra league is another full walk of ESPN's
scoreboard per tick.

**A board never mixes the two.** Week numbers describe different weekends —
college week 2 is a week earlier than NFL week 2 — so a pool playing both shows
one league at a time and keeps each league's own numbering. Weekly stipends are
scoped the same way, per league.

Two consequences worth knowing as product decisions rather than implementation
notes:

- **College lines come from ESPN, not the odds provider.** SharpAPI's free tier
  does not price the league, so college markets are whatever ESPN publishes —
  98 of 99 week-1 games are priced. The join to SharpAPI is built and dormant; it
  needs only a tier upgrade, not new work.
- **The college postseason is filed as week 17.** ESPN puts all 44 bowl games and
  the playoff in a single week that would otherwise collide with September's week
  1. Filing them as week 17 keeps them separate, but it does put a slate spanning
  mid-December to January on one board. Capping college pools at week 16 remains
  a reasonable call and would be a change to the week list, not the schema.

### Gated pool creation

Creating a pool is a permission, not a default. Any account can register and join
by invite code, but `users.can_create_pools` must be granted deliberately — one
username at a time — by whoever runs the instance, via
`scripts/grant-pool-creation.sh`. The seed grants it to the bootstrap account so
a clean install is not a dead end.

The permission is checked against the row rather than the token, so a revoke
takes effect immediately rather than when a session expires. Revoking stops new
pools; it does not touch pools already created or move commissioner rights. The
flag reaches the client on `/auth/me`, so the create form is replaced with an
explanation rather than failing on submit.

Joining is deliberately not gated — invite codes already control who gets into a
pool, and gating joins would make the grant script a bottleneck on every new
member.

### Standing in the pool view

The pool header shows a member's placing — "2nd of 8" — beside their balance, so
it is visible from the board without opening the Leaderboard tab.

It is hidden rather than wrong in the cases where a rank would mislead: pools
with one member (where "1st of 1" is noise), eliminated members, and the legacy
pick modes, which rank on a different basis. Ties share a rank, so two members
level on both balance and net profit are both 3rd and there is no 4th — which is
why the display reads "3rd of 8" rather than "3/8".

### Bet-history filters

The History tab filters by member, league, week, status, market, and date range.
Over a full season across a dozen members the unfiltered list runs to thousands
of rows, which answers no question anyone actually has.

Two details that shape how it behaves:

- **Dates default to kickoff, not placement.** "Bets from last weekend" means
  when the game was played, not when the wager was struck. Both are available
  via `date_field`, and the column label follows the filter — showing one while
  filtering on the other produces results that look broken. Ranges are whole days
  in the member's own timezone, since a Sunday-night game is Monday in UTC.
- **An empty result can be correct.** Other members' pending bets stay hidden
  until their game kicks off, so filtering to a member and a future date is
  legitimately empty. The empty state says so rather than reporting "no results".

### Not planned

Recorded so the same questions are not re-litigated:

- **Merging both leagues onto one board.** A pool can play both, but the board
  shows one league at a time — their week numbers describe different weekends.
- **Editing or cancelling a placed bet.** A wager is final; the ledger is
  append-only by design.
- **Public pool browsing.** Removed deliberately — every pool is invite-only.
- **A per-user cap on pools created.** A count is a different feature from the
  boolean permission above.
