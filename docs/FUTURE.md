# Planned work

Three features that are wanted but not built. Each entry says what it is, how
it would fit the code as it stands today, and what has to be decided before
anyone starts. Nothing here is committed to a release.

Ordered by how much of the system each one disturbs, cheapest first.

---

## 1. Gate pool creation behind a per-user permission

**What.** `POST /pools` is open to every authenticated account today
(`api/src/routes/pools.js`), so anyone who registers can create unlimited
pools. The default should be that they cannot, with the permission granted
deliberately, one username at a time, by whoever runs the instance.

### Shape

A boolean on the account is enough. There is no role model in this codebase and
inventing one for a single permission would be the larger change:

```sql
ALTER TABLE users
  ADD COLUMN can_create_pools BOOLEAN NOT NULL DEFAULT FALSE;
```

The route checks it and returns 403 with a message that names the fix, rather
than a bare "forbidden" that leaves the member guessing.

The flag has to reach the client too, or the create form sits there and fails
on submit. `/auth/me` already returns the account through `publicUser()`
(`api/src/routes/auth.js:23`) — adding the field there is the whole change, and
`renderPools()` hides the create card when it is false.

### The grant script

`scripts/grant-pool-creation.sh <username> [--revoke]`, alongside the other
operational scripts:

```bash
./scripts/grant-pool-creation.sh alice
./scripts/grant-pool-creation.sh alice --revoke
./scripts/grant-pool-creation.sh --list
```

It should run the `UPDATE` through `docker compose exec -T db psql` the way
`reset-db.sh` does, and:

- **report when the username matched nothing**, rather than exiting 0 on a
  typo — `UPDATE ... WHERE username = 'alcie'` succeeds and changes nothing,
  which is the failure mode most likely to waste an afternoon
- be idempotent, so re-granting is harmless
- print the resulting state, not just "ok"
- match usernames exactly and case-sensitively, since that is how the unique
  index works

### The bootstrap trap

With `DEFAULT FALSE`, a freshly seeded database has **nobody** who can create a
pool, including `admin`. `db/init/03-seed.sql` must grant it in the same
statement that creates the account, or a clean install is a dead end until
someone runs SQL by hand. Worth an explicit test.

### Open questions

- **Should the flag also gate joining?** Assumed no: invite codes already
  control who gets into a pool, and gating joins would make the grant script
  a bottleneck on every new member.
- **What happens to pools someone already created if the grant is revoked?**
  Assumed nothing — revoking stops new pools, it does not touch existing ones
  or transfer commissioner rights.
- **Is a per-user cap wanted as well** (create up to N pools)? A count is a
  different feature from a boolean; not planned.

### Cost

Small — one column, one route check, one field on `/auth/me`, one card hidden
in the UI, one script. The schema change is the only awkward part: this project
has no migration runner, so an existing database needs a hand-run `ALTER TABLE`
and a fresh one needs `scripts/reset-db.sh`.

---

## 2. Show a member's placing in the pool view

**What.** The pool view has a Leaderboard tab, but nothing tells you where you
stand until you open it. Surface the placing — "3rd of 8" — in the pool header
next to the balance, so it is visible from the board.

### Shape

The number already exists. `getLeaderboard(pool)` returns `standings` with a
`rank` on every row (`api/src/services/leaderboard.js`), cached in Redis for
`LEADERBOARD_TTL_SECONDS` (30) and invalidated whenever a bet is placed or
settled. Reading it for one member is a cache hit in the ordinary case.

`GET /pools/:poolId` already assembles the pool header's data and returns
`balance` for wager pools; a `standing: { rank, of, net_profit }` alongside it
is the natural home. The UI change is in `balanceStrip()` in
`web/public/app.js`.

### Details that will bite

- **Ties share a rank.** `rankInPlace()` keys on `balance:net_profit`, so two
  members level on both are both 3rd and there is no 4th. "3rd of 8" is still
  truthful; "3/8" invites the reader to do arithmetic that does not hold.
- **Eliminated members still have a rank.** Showing "8th of 8" next to a bust
  badge is honest but bleak; consider suppressing it, or showing the week they
  went out instead.
- **A one-member pool always reads "1st of 1"**, which is noise. Hide it below
  two members.
- **Legacy pick pools rank differently** (`pickStandings`), so the field must
  either be computed for them too or omitted rather than defaulted to 1st.
- **The leaderboard cache is per pool, not per member.** Fetching it inside the
  pool-detail request is fine at this size, but it makes the pool header depend
  on Redis being up. `getLeaderboard` recomputes from Postgres on a miss, so
  this degrades rather than breaks.

### Open question — which reading of "placing"?

This is written as *showing your standing* outside the Leaderboard tab. It
could equally have meant **placing a bet from the leaderboard**, which is a
different and larger feature: the leaderboard has no game context, so it would
need a game picker, and the reveal rule that hides other members' pending bets
would need thinking about. Settle this before starting.

### Cost

Small, if it is the first reading. One field on an existing response, one line
in the header, plus the edge cases above.

---

## 3. Filter the bet history

**What.** The History tab lists every visible bet in the pool, newest first,
25 at a time. On a full season across a dozen members that is thousands of
rows and no way to answer "what did Dave do last Saturday". It needs filters:
member, league, date or date range, and probably status and market.

### Shape

`listPoolBets()` in `api/src/services/bets.js` already takes `limit`/`offset`
and counts matching rows in a separate query, so filters slot into a shared
`WHERE` fragment used by both — the count stays correct per filter, which is
what keeps the pager honest.

Suggested parameters on `GET /pools/:poolId/history`:

| Filter | Notes |
| --- | --- |
| `user_id` | By id, not username — usernames are mutable in principle and the join is already there |
| `league` | `NFL` / `NCAAF`; only meaningful in a pool that plays both |
| `week` | Within a league. Ambiguous without one, since the leagues number weeks differently |
| `status` | `PENDING` / `WON` / `LOST` / `PUSH` / `VOID` |
| `market` | `SPREAD` / `TOTAL` |
| `from`, `to` | A date range — see below |
| `settled` | Convenience for "everything graded" |

### Which date?

`placed_at` (when the bet was struck) and `kickoff_time` (when the game was
played) answer different questions, and the obvious phrasing — "bets from last
weekend" — means the second one. The table currently shows `placed_at`.

Support both with an explicit `date_field=placed|kickoff`, defaulting to
`kickoff`, and label the column so the filter and the display agree. Silently
filtering on one while showing the other produces results that look wrong.

Ranges should be inclusive of whole days in the **member's** timezone, not
UTC — a Sunday-night game is Monday in UTC, and a filter that drops it will be
reported as a bug.

### Interaction with the reveal rule

`VISIBLE_TO_MEMBER` hides other members' bets until their game kicks off. Filter
to a member and a future date and the result is legitimately empty, which looks
like a broken filter. The empty state should say so — "bets on games that have
not kicked off are private until then" — rather than "no results".

### Indexing

The history query orders by `placed_at DESC` filtered on `pool_id`, and there
is no index for it: `bets_pool_user_game_idx` is `(pool_id, user_id, game_id)`.
At a few thousand rows Postgres will sort in memory and nobody will notice, but
add it with the filters rather than after:

```sql
CREATE INDEX bets_pool_placed_idx ON bets (pool_id, placed_at DESC);
```

Filters on league, week and kickoff live on `games`, which is already joined.

### UI

A filter bar above the table. `state.history` in `web/public/app.js` already
carries `{ poolId, offset }` and is the place for the filter values.

**Reset `offset` to 0 whenever a filter changes.** Otherwise narrowing from 200
matches to 12 while sitting on page 4 lands on an empty page that looks like a
bug. Member and league belong in selects rather than free text — both are
closed sets, and the member list is already fetched for the pool header.

### Cost

Medium, and the largest of the three. The query changes are mechanical; the
date semantics and the empty states are where the work actually is.

---

## Not planned

Recorded so the same questions are not re-litigated:

- **Merging both leagues onto one board.** A pool can play both, but the board
  shows one league at a time — their week numbers describe different weekends.
  See `docs/NCAAF.md`.
- **Editing or cancelling a placed bet.** A wager is final; the ledger is
  append-only by design.
- **Public pool browsing.** Removed deliberately — every pool is invite-only.
