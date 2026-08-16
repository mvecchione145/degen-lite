# Spread Sharks — Wager-Based Pools

## Summary

Spread Sharks becomes the primary game mode, and the only one offered when
creating a pool. It replaces season-long pick counting with a play-money
sportsbook: every member holds a balance inside a pool and stakes it on
individual games at posted odds. Standing is measured by balance, not by picks
correct.

## Decisions taken

| Question | Decision |
| --- | --- |
| Odds model | Fixed **−110** on every side of every market |
| Line source | A sportsbook odds API is the target; **synthetic lines for now**, behind an interface the real feed will replace |
| Busting out | Commissioner picks the policy per pool; **elimination is the default**, and no stipend is granted by default |
| Other three modes | Kept in the codebase, hidden behind a flag at pool creation |
| Starting balance | Commissioner-configurable, default **10,000** |
| Max bet | Commissioner-configurable and switchable off entirely; caps **total stake across all bets on one game**, not each individual wager |
| Stakes | Two decimal places, with a hard floor of **1.00** — one whole unit, beneath any pool setting |
| Payouts | Rounded to the nearest **0.01** |
| Cancelling | Not allowed. A placed bet is final |
| Season end | A commissioner-configurable **end date** |
| Bet visibility | Other members' bets become visible **at kickoff** |
| Voids | A game that does not officially conclude under its league's rules voids every bet on it, stake returned |

## What this changes

| | Today | Spread Sharks |
| --- | --- | --- |
| Modes offered | Pick'em, Confidence, Survivor, Pick'em ATS | One mode |
| Unit of play | One pick per game, no stake | A wager of member-chosen size |
| Markets | Game winner (straight up or ATS) | Spread and total |
| Cost of being wrong | A missed point | Losing the staked balance |
| Standing | Points accumulated | Balance |
| Risk | None — every pick is free | Vig makes break-even ~52.4%, not 50% |

The last row is the substantive product change. Under pick'em a member has no
reason not to pick every game; under Spread Sharks, bet selection and bet sizing
are the skill, and a member who bets every game at −110 loses slowly by default.

Because the other modes are being hidden rather than removed, **this work is
additive to the schema** — no table is dropped and no column changes meaning.
That keeps the decision reversible, which is what "for now" in the source note
calls for.

> **Framing note.** [product-overview.md](../product-overview.md) makes
> non-monetary abstract points a deliberate design constraint — it's what keeps
> the product clear of regulated wagering while still supporting sportsbook
> affiliate revenue. This story keeps balances abstract but adopts sportsbook
> *mechanics*. Assumption A1 below states that balances stay purely abstract:
> no buy-in, no cash-out, no transfers. That assumption is doing real work —
> flag it if it's wrong, because everything downstream changes.

## Primary story

> As a pool member, I want to wager my pool balance on game spreads and totals
> at posted odds, so that my standing reflects both how well I pick against the
> number and how much I'm willing to risk.

## Stories and acceptance criteria

### 1. See my pools and my balance

- A signed-in member sees the pools they belong to and the pools they administer.
- Opening a pool shows **available balance** and, separately, **stake at risk**
  on bets that have not settled.
- Balance is per member per pool: one user in three pools has three balances.

### 2. See the board

- The board lists the pool's upcoming games that have not kicked off.
- Each game shows kickoff time, the spread with −110 on each side, and the total
  with −110 on over and under.
- A game leaves the board at its own kickoff, independent of the rest of the slate.

### 3. Place a wager

- A member picks a game, a market (spread or total), a side, and a stake.
- Before confirming, they see the line, the price, and the exact payout if it wins.
- The wager is rejected when: the stake exceeds available balance, it would push
  the member's **total stake on that game** past the pool's per-game cap, it
  falls below the pool's minimum bet, or the game has kicked off.
- The cap is on aggregate exposure to a game, so a member may add to a position
  across several bets — at whatever lines were posted when each was struck —
  until the cap is reached. With the cap switched off, only available balance and
  the minimum bet constrain the stake.
- **Stakes carry two decimal places and can never fall below 1.00.** That whole-unit
  floor sits beneath every pool setting: a pool's minimum bet may be raised above
  it but not below, and switching the pool minimum off leaves 1.00 in force
  rather than opening the door to 0.01 wagers.
- **The line and price are captured at placement.** Later line movement does not
  change an already-accepted bet.
- The stake leaves available balance immediately (assumption A2).

### 4. Bets are final, and lock at kickoff

- **A placed bet cannot be cancelled, edited, or cashed out.** This is deliberate
  and differs from every other pick in the product to date: pick'em selections
  can be revised right up to kickoff, a wager cannot be revised at all.
- No new bets on a game that has started. Locking is per game, matching the
  existing pick-lock behaviour.
- Because a bet is irreversible, the confirmation step in story 3 is the member's
  only chance to catch a mistake, and it must show line, price, stake, and payout
  before it is committed.

### 5. Settlement

- Once a game is final, every pending bet on it settles automatically.
- **Spread:** the selected side wins if it covers the line captured on the bet;
  exactly on the number is a push.
- **Total:** over wins above the captured total, under wins below; exactly on
  the number is a push.
- Win credits stake + profit. Loss credits nothing — the stake is already gone.
  Push returns the stake.
- **Void:** a game that does not officially conclude under the standards of its
  sporting authority — the NFL, NCAA, MLB, and so on — voids every bet on it and
  returns every stake. Each league sets its own bar for an official result, so
  this is a per-sport rule rather than one global one; in practice the trigger is
  the data feed reporting that the game was cancelled, abandoned, or never
  reached an official conclusion.
- Settlement is idempotent: re-running it must never double-credit.

### 6. Bet history

- A member sees their own bets, newest first, showing game, market, side, the
  line and price as struck, stake, status, and net result.
- Pending, won, lost, and pushed bets are distinguishable at a glance.
- Running profit and loss is visible.

### 7. Balance leaderboard

- Members are ranked by balance within the pool.
- Each row shows balance, stake at risk, and record (W–L–P).
- Ties share a rank.
- Every member's bets on a game become visible to the pool **at that game's
  kickoff**, once they can no longer be acted on. Before kickoff a member sees
  only their own.

### 7a. Season end

- A commissioner may set an **end date** on the pool. It is optional; without one
  the pool runs open-ended and never declares a winner.
- No new bets are accepted once the end date passes.
- Bets already placed still settle normally. Standings freeze — and the highest
  balance wins — only after the last outstanding bet has settled, not the instant
  the date rolls over.

### 8. Running out of balance

A member is **bust** when their available balance is below the pool's minimum
bet — or is zero, where no minimum is set — *and* they have no pending bets that
could still pay out. Checking pending bets matters: a member sitting at zero with
three bets live is not out yet.

What happens next is a pool setting, chosen by the commissioner at creation:

| Policy | Behaviour |
| --- | --- |
| **Eliminate** (default) | The member is out for the season and can place no further bets. Reuses the existing `is_eliminated` / `eliminated_week` columns. |
| **Weekly top-up** | Every member receives a fixed stipend at the start of each week, so nobody is locked out. Needs a stipend amount. |
| **Rebuy** | A bust member may reset to the starting balance, up to a configured number of times per season. |

Under top-up and rebuy, the leaderboard must show total credited alongside
balance — otherwise a member who rebought three times outranks one who never
did, on the same results.

### 9. Pool administration

- A commissioner creates a pool, gets an invite code, and sees its members.
- Settings are fixed at creation:

| Setting | Default | Notes |
| --- | --- | --- |
| Starting balance | 10,000 | Credited to every member as their opening ledger entry |
| Max bet per game | On, 500 | Caps total stake across all bets on one game. Switchable off for no limit |
| Minimum bet | Off | The hard 1.00 floor applies regardless. A commissioner may raise the minimum above it, never below |
| Bust policy | Eliminate | Or weekly top-up, or rebuy |
| Stipend amount | None | No stipend by default. Required only if the top-up policy is chosen |
| Rebuy limit | — | Required only if the rebuy policy is chosen. **Not yet specified** |
| End date | None | Optional. Without one the pool runs open-ended |

- A member joining after the pool has started receives the same starting
  balance, and the leaderboard shows total credited (see story 8) so a late
  entrant is not mistaken for someone who earned their way there.

## Odds and payout rules

Prices are American odds. Vig is expressed in the price, not taken as a separate
fee. Every market is priced −110 today, but the arithmetic below is written for
any price so that varying prices remain a pricing change rather than a rewrite.

| Price | Profit on a winning stake `S` | Example on `S = 100` |
| --- | --- | --- |
| Negative, e.g. −110 | `S × 100 / abs(price)` | 100 × 100/110 = **90.91** profit, 190.91 returned |
| Positive, e.g. +150 | `S × price / 100` | 100 × 150/100 = **150.00** profit, 250.00 returned |
| Push or void | none — stake returned | 100.00 returned |

Profit is rounded to the nearest 0.01, half away from zero. Stakes are already
exact to 0.01, so every ledger entry is exact and balances never accumulate
floating-point drift.

At −110 on both sides, a member must win **52.38%** of bets to break even
(110 ÷ 210). That margin is the entire reason bet selection matters, so it
should be surfaced in the UI, not buried.

> **A pool is not a closed economy.** There is no house and no peer-to-peer
> matching: winning credits a payout from nowhere, and losing sends the stake
> nowhere. Total balance across a pool rises and falls rather than being
> conserved, and rounding does not have to reconcile against anything. This is
> intended — a balance is a score expressed in currency-like units, not a bankroll
> — but it is worth stating plainly, because the first question anyone asks of a
> ledger is where the money comes from.

## Data model implications

Sketch only — the shape follows once the remaining questions are settled.

- **`games`** needs a `total` (over/under number) alongside the existing
  `spread`. It needs **no price columns**: while every price is −110, the price
  is a constant, not data. `status` needs a terminal state for a game that never
  officially concluded, distinct from `FINAL`, to drive voiding.
- **A `bets` table** is new: pool, user, game, market, selection, **line and
  price as struck**, stake, status (`PENDING` / `WON` / `LOST` / `PUSH` /
  `VOID`), settled timestamp. Recording the price on every bet even though it is
  always −110 today is what lets prices vary later without invalidating history.
- **Money columns** are `NUMERIC(14,2)` throughout — never floating point. Two
  decimal places is the whole precision of the system, so exact decimal
  arithmetic keeps balances reproducible.
- **Lines come from a provider interface**, not from the seed directly. Synthetic
  generation is one implementation; a sportsbook odds API is the intended
  replacement. Bet placement and settlement read the line off the *bet*, never
  off the provider, so swapping providers cannot disturb settled history.
- **`pools`** also gains an optional `ends_at`.
- **Balance** is best held as an append-only ledger rather than a mutable
  column — starting balance is the opening entry, and each stake, payout,
  stipend, and rebuy is an entry. Balance is their sum, so history, standings,
  and balance reconcile by construction instead of by discipline. A cached
  balance can sit on top.
- **`pools`** gains `starting_balance`, `max_bet_per_game`, `min_bet`,
  `bust_policy`, and the policy's parameter (stipend amount or rebuy limit).
  "Switchable off" is best encoded as a **nullable** limit — `NULL` means no
  limit — rather than a separate boolean, which would allow the meaningless
  state of a disabled toggle sitting next to a stale number.
- Enforcing the per-game cap needs the member's **current total stake on that
  game**, summed over pending and settled bets alike. That is a query over
  `bets` at placement time, and it has to be inside the same transaction as the
  insert, or two simultaneous bets can both pass the check and breach the cap.
- **`pool_members.is_eliminated` / `eliminated_week`** are reused as-is by the
  default bust policy.
- **Nothing is dropped.** `picks`, `grade_pick()`, `pool_type`, and
  `use_spreads` all stay valid and working; `pool_type` simply gains a
  `SPREAD_SHARKS` value, and the other three stop being offered at creation.

## Assumptions

Stated so they can be corrected — none of these came from the source note.

| # | Assumption |
| --- | --- |
| A1 | Balances are purely abstract: no purchase, no cash-out, no transfers between members |
| A2 | Stake is escrowed at placement, so pending bets cannot overdraw the balance |
| A3 | Single-game bets only — no parlays, teasers, or same-game combinations |
| A4 | Spread and total only — no moneyline (follows from the fixed −110 decision) |
| A5 | Bets lock per game at that game's kickoff |
| A6 | NFL only for now, on the existing seeded season — though the void rule is written per-sport so other leagues drop in cleanly |
| A7 | Every member starts with the same balance |
| A8 | Balances carry across the whole season and do not reset weekly |

## Open questions

All resolved. None were blocking, so each was taken as a stated default and is
live in the build — see [MVP Implementation](../mvp.md). Change any of them and
the implementation follows.

| Question | Taken as |
| --- | --- |
| Default max bet per game | **500** against a 10,000 balance — 20 games at full exposure |
| Default rebuy limit | **1** per season, when the rebuy policy is chosen |
| Bust under the 1.00 floor | **Strict.** Bust is available balance below the effective minimum with no pending bets; no separate "practically bust" threshold |
| Correlating synthetic totals with spreads | Totals are drawn in a plausible 41–54 range, with a few whole numbers so pushes actually occur in the demo data |
| Void detection with synthetic data | An admin action marks a game abandoned, so the void path is exercisable before a live odds feed exists |
| Minimum bet (from the settings table) | **Off by default.** The 1.00 whole-unit floor applies regardless and sets the bust threshold |
| Default stipend | **None.** A top-up pool must set one explicitly; creation is refused without it |

---

## Source

The original note this document was written from, verbatim:

> The most important "game mode" is spread sharks we can deprecate the others
> for now...
>
> the user should be able to log in and see a pool they administer or belong to
> and in the pool they can see their balance as well as have the ability to
> wager their balance on games including spread and over/under with odds
> (including vig ie -110) include a history of bets placed and a leaderboard of
> balances in the pool.
