# Game Modes

**Spread Sharks** is the platform's game mode. The three pick-based modes that
preceded it — Pick'em, Confidence, and Survivor — remain in the codebase and
existing pools of those types keep working, but they are not offered when
creating a pool.

## Spread Sharks

Every member holds a **balance** inside a pool and stakes it on individual games
at posted odds. Standing is measured by balance, not by picks correct.

### Markets

Two markets are offered on every game, each priced at **−110**:

| Market | Selections | Wins when |
| --- | --- | --- |
| **Spread** | Home / Away | The selected side covers the line struck on the bet |
| **Total** | Over / Under | The combined score beats the number struck on the bet |

`games.spread` is the **home team's line**: `-3.5` means the home team is
favoured by 3.5. The home side covers when `home_score + spread > away_score`.

### Wagering rules

- A member chooses a game, a market, a side, and a stake.
- Stakes carry two decimal places and can never fall below **1.00**. That
  whole-unit floor sits beneath every pool setting: a commissioner may raise the
  minimum above it but never below, and switching the pool minimum off leaves
  1.00 in force.
- The **line and price are captured on the bet at placement**. Later line
  movement does not change an already-accepted bet.
- The stake leaves the available balance immediately, so pending bets cannot
  overdraw an account.
- A bet is **final**: it cannot be cancelled, edited, or cashed out. This differs
  deliberately from the legacy modes, where a pick could be revised right up to
  kickoff.
- A game stops accepting wagers at its own kickoff.
- Other members' bets on a game become visible at that game's kickoff, once they
  can no longer be acted on.

### Payouts

Prices are American odds; the vig is expressed in the price rather than charged
as a fee.

| Price | Profit on a winning stake `S` | On `S = 100` |
| --- | --- | --- |
| Negative, e.g. −110 | `S × 100 / abs(price)` | 90.91 profit, 190.91 returned |
| Positive, e.g. +150 | `S × price / 100` | 150.00 profit, 250.00 returned |
| Push or void | none — stake returned | 100.00 returned |

Profit is rounded to the nearest cent, half away from zero.

At −110 on both sides a member must win **52.38%** of bets to break even
(110 ÷ 210). That margin is why bet selection and bet sizing are the skill: a
member who backs every game loses slowly by default.

> A pool is not a closed economy. There is no house and no peer-to-peer
> matching — a win credits a payout from nowhere and a loss sends the stake
> nowhere. Total balance across a pool rises and falls rather than being
> conserved. That is intended: a balance is a score expressed in currency-like
> units, not a bankroll.

### Settlement

| Outcome | Result | Balance effect |
| --- | --- | --- |
| Win | `WON` | Stake + profit credited |
| Loss | `LOST` | Nothing — the stake already left at placement |
| Exactly on the number | `PUSH` | Stake returned |
| Game never officially concluded | `VOID` | Stake returned |

A **void** applies when a game does not reach an official conclusion under the
standards of its sporting authority. Each league sets its own bar, so this is a
per-sport rule; in practice the trigger is the data feed reporting the game as
cancelled or abandoned.

### Running out of balance

A member is **bust** when their available balance falls below the pool's minimum
bet *and* they hold no pending bets. Both conditions matter — a member sitting at
zero with live bets is not out yet.

What follows is a pool setting, chosen by the commissioner:

| Policy | Behaviour |
| --- | --- |
| **Eliminate** (default) | Out for the season; no further wagers accepted |
| **Weekly top-up** | A fixed stipend arrives at the start of each week, so nobody is locked out |
| **Rebuy** | A bust member may reset to the starting balance, up to a configured limit |

Under top-up and rebuy the leaderboard shows **total credited** alongside
balance. Without it, a member who rebought three times would outrank one who
never did on identical results.

### Pool settings

| Setting | Default |
| --- | --- |
| Starting balance | 20,000 |
| Max bet | 5,500 — caps *total stake on one selection*, summed across every bet on that side, and can be switched off. Backing a different side, market or game gets a fresh allowance |
| Minimum bet | Off (the 1.00 floor still applies) |
| Bust policy | Eliminate |
| Stipend amount | None — required only for the top-up policy |
| Rebuy limit | 1, when the rebuy policy is chosen |
| End date | None — the pool runs open-ended |

The per-game cap is on **aggregate exposure**, not on each individual wager, so a
member may add to a position across several bets — at whatever lines were posted
when each was struck — until the cap is reached.

### Season end

A commissioner may set an end date. No new bets are accepted after it passes, but
bets already placed still settle. Standings freeze, and the highest balance wins,
only once the last outstanding bet has settled.

---

## Legacy modes

These are retained and playable but no longer offered at pool creation. Set
`LEGACY_POOL_MODES=true` to re-enable them in the create-pool form and API.

### Pick'em

Users select the winner for every game each week, graded straight up or against
the spread (`pools.use_spreads`). One point per correct pick.

### Confidence Pool

Users pick winners for every game and assign a unique confidence rank — 1 through
16 for a 16-game week. A correct pick awards its assigned rank; ranks must be
unique within a user's week.

### Survivor / Elimination Pool

Users select exactly one team to win straight up each week. A team cannot be
reused for the rest of the season, and an incorrect pick eliminates the member.

### Legacy scoring and tiebreakers

| Mode | Points for a correct pick |
| --- | --- |
| Pick'em (straight up or ATS) | 1 |
| Confidence | The pick's `confidence_rank` |
| Survivor | None — the pick determines survival |

`picks.tiebreaker_points` stores a predicted total but is not used for ranking;
standings break ties on points, then wins, then username.
