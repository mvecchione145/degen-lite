# Commissioner Controls

Scoping note for what the person running a pool can do, split by when they can do
it. Written against the build as it stands — every "today" claim below was
checked in the code, not assumed.

> **Update — two of these are now built.** A commissioner can remove a member
> and void a live wager, both recorded in a log the whole pool can read. See
> [Shipped](#shipped) at the foot of this document, and
> [mvp.md](../mvp.md#commissioner-controls) for how they behave. The rest of the
> document is unchanged scoping for the powers that do not exist.

## Summary

**Apart from the two actions noted above, the commissioner role is a
creation-time role only.** `POST /pools`
records `commissioner_id`, and after that the column does nothing except supply a
name for display and an `is_commissioner` boolean on `GET /pools/:poolId` that
the client does not currently read.

Removing a member and voiding a live wager are the only two routes that require
being the commissioner. Everything else about running a pool is still fixed at
creation:

- Every pool setting is **frozen at creation**. Nothing can be edited afterwards.
- A member's balance cannot be corrected, and a settled wager cannot be reversed.
- The invite code cannot be rotated, and cannot be revoked.
- A pool cannot be deleted, archived, or closed early.
- A member cannot leave a pool of their own accord — only be removed.
- The commissioner is auto-joined and credited an opening balance, so they are
  always also a player. There is no scorekeeper-only mode, and they cannot remove
  themselves.

Everything below is therefore still mostly a scoping exercise rather than
documentation of existing behaviour.

## What exists today

Set once, at creation, and immutable thereafter:

| Setting | Default | Notes |
| --- | --- | --- |
| `name` | — | 3–100 characters |
| `leagues` | `['NFL']` | NFL, college, or both. The first entry is the anchor league that drives stipend weeks and elimination weeks |
| `season` | Latest ingested, else current | Pools are season-scoped; a new season is a new pool |
| `starting_balance` | 20,000 | Credited to every member as their opening ledger entry, including late joiners |
| `max_bet` | 5,500 | Cap on aggregate stake on **one selection**. `null` = uncapped |
| `min_bet` | `null` | The hard 1.00 floor applies regardless; this only raises it |
| `bust_policy` | `ELIMINATE` | Or `TOPUP` or `REBUY` |
| `stipend_amount` | `null` | Required if `TOPUP`; creation is refused without it |
| `rebuy_limit` | 1 when `REBUY` | Otherwise `null` |
| `ends_at` | `null` | Optional; must be in the future. Open-ended without one |
| `invite_code` | Generated | 8 characters, unique, never rotated |

> The defaults above are the code's (`api/src/routes/pools.js`). They differ from
> the ones in [user-story.md](user-story.md), which still says 10,000 and 500 —
> that document is the older source note and has drifted.

Creating a pool is itself gated: `users.can_create_pools` must be granted per
account. That is an instance-operator power, not a commissioner one.

## Preseason

The window between creating the pool and the first kickoff of its season.

### Today

Everything in the table above, at the moment of creation, and nothing after. If a
setting is wrong the only remedy is to create a second pool and re-share the
code — losing anyone who already joined.

### What should be scopeable

Before any wager exists, **there is no settled history to protect**, so almost
everything is safely editable. This is the phase where edit support is cheap and
the argument against it is weakest.

| Power | Recommendation | Notes |
| --- | --- | --- |
| Edit any wager setting | **Yes, freely** | No bets exist, so no member has acted on the old value. Gate on "zero bets in this pool" rather than on a date — that is the real condition |
| Rename the pool | **Yes** | Cosmetic, no history implications at any phase |
| Change `leagues` | **Yes, while empty** | It rewrites which boards exist. Safe with no bets; see midseason for why it must stop after |
| Change `season` | **Yes, while empty** | Same reasoning |
| Rotate the invite code | **Yes** | The obvious first control to build: a code shared too widely is currently unfixable |
| Revoke the code entirely | **Yes** | "Closed to new members" is a distinct state from "no code" |
| Remove a member | **Yes, while they have no bets** | Clean deletion is only possible before they have a ledger. Afterwards see below |
| Set a roster cap | Worth considering | Nothing enforces a maximum member count today |
| Commissioner-does-not-play | Worth considering | Requires unpicking the auto-join and opening credit in `createPool` |

## Midseason

From the first kickoff until `ends_at`, or indefinitely if none was set.

### Today

Nothing. The pool runs itself: settlement grades bets every minute, stipends land
weekly for `TOPUP` pools, and bust members are eliminated automatically. The
commissioner is a spectator with no levers.

The one thing that *is* live is the instance-wide admin surface
(`/api/admin/*` — force-settle, mark a game abandoned, fabricate scores). That is
gated behind `DEV_TOOLS`, is off in production, and is **not** scoped to a pool
or a commissioner. It is a developer tool, not a commissioner tool.

### The constraint that shapes everything here

The ledger is append-only and every bet snapshots its own line, price, and stake
at placement. That is deliberate: it is what makes settled history reproducible
and what lets the odds provider change without disturbing graded results.

So the test for any midseason power is not "is it useful" but **"does it change
the meaning of a wager someone already placed?"** Powers that fail that test
should not be built, however convenient.

| Power | Verdict | Reasoning |
| --- | --- | --- |
| Raise or lower `max_bet` | **Safe** | Checked at placement only. Past bets keep their validity; the new cap binds future ones. Worth an audit note so members can see when it moved |
| Raise or lower `min_bet` | **Safe, with a caveat** | It also sets the bust threshold, so lowering it can un-bust someone who is already eliminated. Needs an explicit decision on whether elimination is reversed or stands |
| Extend `ends_at` | **Safe** | Purely widens the window |
| Shorten `ends_at` | **Safe** | Only blocks *new* bets. Pending wagers still settle normally — `assertOpen` guards placement, not settlement |
| Change `starting_balance` | **Avoid** | Existing members were already credited. It would only affect later joiners, quietly creating two classes of member in one pool |
| Change `bust_policy` | **Avoid** | The sharp one. `ELIMINATE`→`REBUY` implies un-eliminating people; `REBUY`→`ELIMINATE` strands members who already spent a rebuy; anything→`TOPUP` raises "are back-weeks owed?" None has an obviously right answer |
| Change `leagues` or `season` | **No** | Every board, week list, and stipend is scoped by them. Changing either orphans existing bets from the boards they were placed on |
| Adjust a member's balance | **No** | A manual ledger entry is indistinguishable from earned balance on the leaderboard. If it is ever built it needs its own `entry_type` so it is visible as an adjustment, never folded into net profit |
| Void or reverse a *settled* bet | **No — and enforced** | A graded bet stays graded. `voidBet` refuses anything that is not `PENDING`, because a per-bet override would make every result provisional |
| Remove a member mid-season | **Built** | Not by deletion — their bets and ledger entries are real history, and cascading them away would silently alter other members' standings context. Modelled as `pool_members.withdrawn_at`: history retained, excluded from standings, no new bets, no further stipend, and the invite code will not let them back in |
| Void a live wager | **Built** | `PENDING` only. Stake refunded via the same `VOID`/`REFUND` shape an abandoned game produces |
| Pause the pool | Worth considering | "No new bets until I say" has no current expression. Distinct from `ends_at`, which is permanent |
| Post an announcement | Worth considering | Purely additive, no interaction with the ledger. Cheap |

### Late joiners

A member joining in week 9 receives the full `starting_balance`, same as everyone
else. The leaderboard already shows total credited alongside balance, so a late
entrant is not mistaken for someone who earned it — but there is no commissioner
control over whether joining late is allowed at all. A "closed to new members"
switch belongs in the preseason table above and applies here too.

Worth noting as a live gap rather than a scoping question: **`joinPoolByCode`
does not check `ends_at`.** Anyone with the code can join a pool that has already
ended, and will be credited a full opening balance for a pool they can never
place a bet in. Rejoining is correctly idempotent — only a first join opens a
balance — but the ended case is simply unhandled.

## Postseason

After `ends_at`, or after the season's last game settles.

### Today

`ends_at` blocks new bets and the board reports `pool_ended`. That is the whole
of it. There is no winner declaration, no archive state, no export, and no
rollover. Settlement keeps running, which is correct — outstanding wagers on
already-kicked-off games still need grading.

A pool with no `ends_at` never formally ends. It simply runs out of games when
the season's schedule is exhausted, and its board shows the last week forever.

### What should be scopeable

| Power | Recommendation | Notes |
| --- | --- | --- |
| Declare final standings | **Yes** | Needs a definition of "final": the honest one is *`ends_at` has passed **and** no bet is still `PENDING`*, not the date alone |
| Freeze the pool | **Yes** | An explicit terminal state. Today "ended" is derived from a timestamp on every read; a stored state is clearer and lets the UI stop pretending the board is live |
| Archive / hide from the pool list | **Yes** | Otherwise a member's list accumulates every season they ever played |
| Export results | **Yes** | The ledger is the whole story and is already append-only. A CSV of entries and bets is a small piece of work with real value |
| Roll over to next season | Worth considering | Pools are season-scoped, so this means "create a new pool with the same settings and invite the same members". A clone action, not a mutation |
| Reopen a frozen pool | **Yes, but audited** | Someone will freeze early by accident |
| Delete the pool | **Avoid** | `ON DELETE CASCADE` exists on the pool-scoped tables, so a delete route would destroy every member's history irrecoverably. Archive is what people actually want when they ask for delete |

## Cross-cutting: what must stay out of reach

Worth stating plainly, because each of these is individually reasonable-sounding
and collectively destroys the property that makes the ledger trustworthy:

- **No retroactive edits to a settled bet** — line, price, stake, or result.
- **No silent balance adjustments.** If manual credits are ever needed they get
  their own visible `entry_type`, and they never count as profit.
- **No deletion of anything a member did.** Withdrawal and archival are states,
  not deletions.
- **No commissioner access to another member's pending bets.** The reveal rule
  hides them until kickoff for everyone; a commissioner exemption would make the
  commissioner unbeatable in a pool they also play in.

That last one matters more than it looks, because the commissioner is always a
player. Any information power granted to the role is granted to a competitor.

## Suggested build order

If this gets built, roughly in increasing order of cost and risk:

1. **Rotate / revoke the invite code.** Small, self-contained, fixes a real
   unfixable problem today.
2. **Edit settings while the pool has no bets.** One route, one guard —
   `NOT EXISTS (SELECT 1 FROM bets WHERE pool_id = $1)`.
3. **Archive and freeze.** Two state columns and the UI to respect them.
4. **Export.** Reads only.
5. **Member withdrawal.** Needs the standings and leaderboard queries to learn
   about the state.
6. **The safe midseason edits** (`max_bet`, `ends_at`), with an audit trail.
7. **Everything in the "Avoid"/"No" rows** — only with an explicit decision
   recorded here about what happens to existing history.

## Open questions

| Question | Needs deciding before |
| --- | --- |
| Does lowering `min_bet` un-eliminate an already-bust member, or is elimination permanent once recorded? | Any midseason `min_bet` edit |
| Should a commissioner be able to run a pool without playing in it? | The auto-join in `createPool` is unpicked |
| Is "final standings" the end date, or the end date plus zero pending bets? | Freeze / declare-winner |
| Should commissioner actions be visible to members as an audit log, or silent? | The first mutating route. Recommend visible — an unannounced rule change mid-season is the thing that breaks trust in a pool |
| Can commissionership be transferred? | Nothing depends on it today, which is exactly why it is cheap to add now |

## Shipped

Two of the powers scoped above now exist. Both are commissioner-only, checked
against `pools.commissioner_id` on the row rather than the token, and both write
a row to `pool_events` that every member of the pool can read.

| Action | Route |
| --- | --- |
| Remove a member | `POST /pools/:poolId/members/:userId/withdraw` |
| Add a removed member back | `POST /pools/:poolId/members/:userId/reinstate` |
| Void a live wager | `POST /pools/:poolId/bets/:betId/void` |
| Read the action log | `GET /pools/:poolId/events` — any member |
| List live wagers | `GET /pools/:poolId/pending` — commissioner only |

Three decisions worth recording, because each closed an open question above:

1. **Removal is reversible, and reversal is exact.** Clearing `withdrawn_at`
   restores the member with the balance and history they left with. No second
   opening credit — that would pay out anyone removed while bust — and no
   back-paid stipends for the weeks they were out. Undoing a removal is the
   commissioner's to do, not the member's: the invite code still refuses them.
2. **Removal does not cancel live wagers.** A withdrawn member's pending bets
   settle normally. Stopping them is a separate, separately-logged void, which
   keeps "remove someone" and "cancel their money" as two decisions rather than
   one silent one.
3. **The reveal rule was not lifted.** `GET /pools/:poolId/pending` gives the
   commissioner who staked what on which fixture, and withholds the selection and
   the line until kickoff exactly as the board does for everyone. This is the
   must-stay-out-of-reach item above, honoured: the commissioner is a competitor,
   and seeing a rival's side is the one thing that would turn moderation into an
   edge.
4. **The audit log is public to the pool, not to the commissioner alone.** An
   audit log only the auditor can read is not an audit log.

Still open from the questions below: transferring commissionership, which is what
"the commissioner cannot remove themselves" currently points people at without
having anywhere to send them.

Schema: `pool_members.withdrawn_at` and the `pool_events` table. There is no
migration runner, so an existing database needs
`./scripts/migrate.sh`; a fresh volume picks both up from
`db/init` directly.
