import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFoundError } from '../http.js';
import { cacheDel, leaderboardKey } from '../cache.js';

// No 0/O/1/I: invite codes get read aloud and retyped.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// The first week of a season that has not finished — where a survivor member's
// liability begins when they join.
//
// Recorded once, as a number. Comparing `joined_at` against kickoff times looks
// equivalent and is not: kickoffs move, so a week already settled could change
// who was answerable for it.
async function firstUnfinishedWeek(client, league, season) {
  const { rows } = await client.query(
    `SELECT COALESCE(
              (SELECT MIN(week) FROM (
                 SELECT g.week
                   FROM games g
                  WHERE g.league = $1 AND g.season = $2
                  GROUP BY g.week
                 HAVING BOOL_OR(g.status NOT IN ('FINAL', 'VOID'))
               ) unfinished),
              (SELECT MAX(week) + 1 FROM games WHERE league = $1 AND season = $2),
              1
            )::INT AS week`,
    [league, season],
  );
  return rows[0]?.week ?? 1;
}

export async function createPool({
  commissionerId, name, poolType, useSpreads, leagues, season,
  startingBalance, maxBet, minBet, bustPolicy, stipendAmount,
  rebuyLimit, endsAt,
}) {
  return withTransaction(async (client) => {
    let pool = null;

    // Codes are random and the column is unique; retry the rare collision.
    for (let attempt = 0; attempt < 5 && !pool; attempt += 1) {
      try {
        const { rows } = await client.query(
          `INSERT INTO pools (commissioner_id, name, invite_code, pool_type,
                              use_spreads, leagues, season,
                              starting_balance, max_bet, min_bet,
                              bust_policy, stipend_amount, rebuy_limit, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [commissionerId, name, generateInviteCode(), poolType, useSpreads,
            leagues, season, startingBalance, maxBet, minBet,
            bustPolicy, stipendAmount, rebuyLimit, endsAt],
        );
        pool = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }

    if (!pool) throw conflict('Could not allocate an invite code, please retry');

    await client.query(
      'INSERT INTO pool_members (pool_id, user_id, active_from_week) VALUES ($1, $2, $3)',
      [pool.id, commissionerId, pool.pool_type === 'SURVIVOR'
        ? await firstUnfinishedWeek(client, pool.leagues[0], pool.season)
        : null],
    );
    await creditOpening(client, pool, commissionerId);

    return pool;
  });
}

// A member of a wager pool needs an opening balance the moment they join —
// including a member who joins mid-season, who starts on the same figure as
// everyone else. The leaderboard's total-credited column keeps a late entrant
// distinguishable from someone who earned their way to the same balance.
async function creditOpening(client, pool, userId) {
  if (pool.pool_type !== 'SPREAD_SHARKS') return;
  await client.query(
    `INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount)
     VALUES ($1, $2, 'OPENING', $3)`,
    [pool.id, userId, pool.starting_balance],
  );
}

export async function joinPoolByCode(userId, inviteCode) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM pools WHERE invite_code = $1',
      [inviteCode.trim().toUpperCase()],
    );
    const pool = rows[0];
    if (!pool) throw notFoundError('No pool with that invite code');

    // A removal has to stick, or the invite code undoes it. Rejoining is
    // refused rather than silently no-op'd, which would hand back a pool the
    // member still cannot bet in.
    const { rows: prior } = await client.query(
      'SELECT withdrawn_at FROM pool_members WHERE pool_id = $1 AND user_id = $2',
      [pool.id, userId],
    );
    if (prior[0]?.withdrawn_at) {
      throw forbidden('You have been removed from this pool by its commissioner');
    }

    const { rows: joined } = await client.query(
      `INSERT INTO pool_members (pool_id, user_id) VALUES ($1, $2)
       ON CONFLICT (pool_id, user_id) DO NOTHING
       RETURNING user_id`,
      [pool.id, userId],
    );

    // Only a first join opens a balance, so rejoining stays idempotent and
    // cannot be used to mint another opening credit.
    if (joined.length > 0) {
      await creditOpening(client, pool, userId);

      // Survivor holds a member answerable for every week from here on,
      // including by not picking — so somebody arriving in week 9 must not
      // inherit eight missed weeks.
      if (pool.pool_type === 'SURVIVOR') {
        await client.query(
          'UPDATE pool_members SET active_from_week = $3 WHERE pool_id = $1 AND user_id = $2',
          [pool.id, userId, await firstUnfinishedWeek(client, pool.leagues[0], pool.season)],
        );
      }
    }

    return pool;
  });
}

export async function listPoolsForUser(userId) {
  const { rows } = await query(
    `SELECT p.*, COALESCE(u.display_name, u.username) AS commissioner_username,
            pm.is_eliminated, pm.eliminated_week,
            -- Withdrawn members are excluded, because this number is read
            -- against the leaderboard: wagerStandings and pickStandings both
            -- filter on withdrawn_at, so counting everyone here put "8 members"
            -- on a pool card above a table listing 7.
            (SELECT COUNT(*)::INT FROM pool_members m
              WHERE m.pool_id = p.id AND m.withdrawn_at IS NULL) AS member_count,
            COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = p.id AND le.user_id = $1), 0)::NUMERIC AS balance
       FROM pools p
       JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = $1
       JOIN users u ON u.id = p.commissioner_id
      ORDER BY p.created_at DESC`,
    [userId],
  );
  return rows;
}

// Returns the pool plus the caller's membership, or null when the pool does not
// exist. `membership` is null for a non-member.
export async function getPoolWithMembership(poolId, userId, client = null) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    `SELECT p.*, COALESCE(u.display_name, u.username) AS commissioner_username,
            pm.user_id AS member_user_id, pm.is_eliminated, pm.eliminated_week,
            pm.withdrawn_at
       FROM pools p
       JOIN users u ON u.id = p.commissioner_id
       LEFT JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = $2
      WHERE p.id = $1`,
    [poolId, userId],
  );
  const row = rows[0];
  if (!row) return null;

  const { member_user_id: memberUserId, is_eliminated: isEliminated,
    eliminated_week: eliminatedWeek, withdrawn_at: withdrawnAt, ...pool } = row;

  return {
    pool,
    // A withdrawn member is still a membership: they keep read access to the
    // pool whose history holds their bets. What they lose is the ability to act
    // — see assertNotWithdrawn in bets.js.
    membership: memberUserId
      ? { isEliminated, eliminatedWeek, withdrawnAt, isWithdrawn: Boolean(withdrawnAt) }
      : null,
  };
}

// Commissioner-only actions. Checked against `pools.commissioner_id` on every
// call rather than trusted from the token, so it behaves the same way the pool
// creation permission does.
export async function requireCommissioner(poolId, userId, client = null) {
  const found = await requireMembership(poolId, userId, client);
  if (found.pool.commissioner_id !== userId) {
    throw forbidden('Only the commissioner can do that');
  }
  return found;
}

export async function requireMembership(poolId, userId, client = null) {
  const found = await getPoolWithMembership(poolId, userId, client);
  if (!found) throw notFoundError('Pool not found');
  if (!found.membership) throw forbidden('You are not a member of this pool');
  return found;
}

export async function listMembers(poolId) {
  const { rows } = await query(
    `SELECT u.id, COALESCE(u.display_name, u.username) AS username,
            u.username AS account_username, u.avatar_emoji,
            pm.joined_at, pm.is_eliminated, pm.eliminated_week,
            pm.rebuys_used, pm.withdrawn_at
       FROM pool_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.pool_id = $1
      ORDER BY pm.withdrawn_at NULLS FIRST, pm.joined_at, u.username`,
    [poolId],
  );
  return rows;
}

// Removes a member without deleting anything. Their bets and ledger entries
// stay — they are other members' context as much as their own — and any wager
// still pending settles normally. A commissioner who wants those stopped voids
// them separately, which keeps "remove someone" and "cancel their live bets"
// as two decisions rather than one silent one.
export async function withdrawMember({ poolId, actorId, targetUserId, reason }) {
  return withTransaction(async (client) => {
    const { pool } = await requireCommissioner(poolId, actorId, client);

    if (targetUserId === pool.commissioner_id) {
      throw badRequest(
        'The commissioner cannot be removed from their own pool. Transfer the '
        + 'pool first, or archive it.',
      );
    }

    const { rows } = await client.query(
      `UPDATE pool_members
          SET withdrawn_at = CURRENT_TIMESTAMP
        WHERE pool_id = $1 AND user_id = $2 AND withdrawn_at IS NULL
        RETURNING user_id`,
      [poolId, targetUserId],
    );
    if (rows.length === 0) {
      // Either not a member or already out. Both are "nothing to do" rather
      // than a failure the caller can act on, but they read differently.
      const { rows: existing } = await client.query(
        'SELECT withdrawn_at FROM pool_members WHERE pool_id = $1 AND user_id = $2',
        [poolId, targetUserId],
      );
      throw badRequest(existing.length === 0
        ? 'That user is not a member of this pool'
        : 'That member has already been removed');
    }

    const { rows: [event] } = await client.query(
      `INSERT INTO pool_events (pool_id, actor_id, kind, target_user_id, reason)
       VALUES ($1, $2, 'MEMBER_WITHDRAWN', $3, $4)
       RETURNING *`,
      [poolId, actorId, targetUserId, reason ?? null],
    );

    // Standings no longer include them, so the cached copy is stale.
    await cacheDel(leaderboardKey(poolId));
    return { withdrawn: targetUserId, event };
  });
}

// Puts a removed member back. Clearing `withdrawn_at` is the whole of it —
// because removal never deleted anything, there is nothing to rebuild. They
// return to the standings with exactly the balance and history they left with.
//
// Two things it deliberately does not do:
//
//   - It does not credit a second opening balance. `creditOpening` runs on a
//     first join only, and reinstating is not a join; minting another would
//     hand back a fortune to anyone removed while bust.
//   - It does not back-pay stipends for the weeks they were out. The partial
//     unique index keys on (pool, member, season, week), so those weeks simply
//     have no STIPEND row and will not gain one. They resume from the next
//     grant. Paying the gap is defensible too, but it is a product decision
//     rather than a default, so this takes the conservative reading.
//
// An elimination survives a round trip: `is_eliminated` is untouched here, and
// settlement skips withdrawn members, so a member who was bust when they left
// comes back bust.
export async function reinstateMember({ poolId, actorId, targetUserId, reason }) {
  return withTransaction(async (client) => {
    await requireCommissioner(poolId, actorId, client);

    const { rows } = await client.query(
      `UPDATE pool_members
          SET withdrawn_at = NULL
        WHERE pool_id = $1 AND user_id = $2 AND withdrawn_at IS NOT NULL
        RETURNING user_id`,
      [poolId, targetUserId],
    );
    if (rows.length === 0) {
      const { rows: existing } = await client.query(
        'SELECT withdrawn_at FROM pool_members WHERE pool_id = $1 AND user_id = $2',
        [poolId, targetUserId],
      );
      throw badRequest(existing.length === 0
        ? 'That user is not a member of this pool'
        : 'That member has not been removed');
    }

    const { rows: [event] } = await client.query(
      `INSERT INTO pool_events (pool_id, actor_id, kind, target_user_id, reason)
       VALUES ($1, $2, 'MEMBER_REINSTATED', $3, $4)
       RETURNING *`,
      [poolId, actorId, targetUserId, reason ?? null],
    );

    await cacheDel(leaderboardKey(poolId));
    return { reinstated: targetUserId, event };
  });
}

// The commissioner log: what was done to this pool, and who put money into it.
//
// Buy-ins are read out of `ledger_entries` rather than written into
// `pool_events` as they happen. They are already recorded there — duplicating
// them would give two sources for one fact and would leave every pool that
// existed before this feature with an empty history. Merging at read time makes
// the log correct retroactively.
//
// STIPEND is deliberately not included. A weekly top-up pool grants one per
// member per week, so a dozen members over a season is hundreds of rows, and
// they would bury the handful of entries a commissioner actually needs to see.
// OPENING and REBUY are the discretionary ones — someone joining, and someone
// buying back in after going bust.
// Buys an eliminated member back into a survivor pool.
//
// Deliberately a commissioner action rather than a button the member presses.
// In a wager pool a rebuy is self-serve because the ledger settles it — you are
// bust, you take a fresh balance, and the cost is visible in total credited.
// Survival has no such price: pressing a button to undo your own elimination is
// just taking the loss back. Putting it in the commissioner's hands makes it a
// decision somebody made, and the pool log records who and why.
//
// Bounded by the pool's rebuy limit and counted the same way as the wager
// version, so `rebuys_used` means one thing across both formats.
export async function rebuyMember({ poolId, actorId, targetUserId, reason }) {
  return withTransaction(async (client) => {
    const { pool } = await requireCommissioner(poolId, actorId, client);

    if (pool.bust_policy !== 'REBUY') {
      throw badRequest('This pool does not allow rebuys');
    }

    const { rows: [member] } = await client.query(
      `SELECT is_eliminated, eliminated_week, rebuys_used, withdrawn_at
         FROM pool_members
        WHERE pool_id = $1 AND user_id = $2
        FOR UPDATE`,
      [poolId, targetUserId],
    );
    if (!member) throw badRequest('That user is not a member of this pool');
    if (member.withdrawn_at) {
      throw badRequest('That member was removed from the pool. Add them back first.');
    }
    if (!member.is_eliminated) throw badRequest('That member is still alive');
    if (member.rebuys_used >= pool.rebuy_limit) {
      throw conflict(
        `That member has used all ${pool.rebuy_limit} `
        + `rebuy${pool.rebuy_limit === 1 ? '' : 's'} for this season`,
      );
    }

    // Granting a rebuy is only a counter. Standing is derived from it —
    // alive while rebuys cover losses — so settlement recomputes the flags on
    // its next pass and the two cannot drift apart. Clearing them here as well
    // just means the member does not have to wait a minute to see it.
    await client.query(
      `UPDATE pool_members
          SET rebuys_used = rebuys_used + 1,
              is_eliminated = FALSE,
              eliminated_week = NULL
        WHERE pool_id = $1 AND user_id = $2`,
      [poolId, targetUserId],
    );

    const { rows: [event] } = await client.query(
      `INSERT INTO pool_events (pool_id, actor_id, kind, target_user_id, reason)
       VALUES ($1, $2, 'MEMBER_REBOUGHT', $3, $4)
       RETURNING *`,
      [poolId, actorId, targetUserId, reason ?? null],
    );

    await cacheDel(leaderboardKey(poolId));
    return {
      rebought: targetUserId,
      rebuys_used: member.rebuys_used + 1,
      rebuy_limit: pool.rebuy_limit,
      event,
    };
  });
}

export async function listPoolEvents(poolId, limit = 50) {
  const { rows } = await query(
    `SELECT e.id, e.kind, e.reason, e.created_at,
            COALESCE(actor.display_name, actor.username) AS actor_username,
            COALESCE(target.display_name, target.username) AS target_username,
            e.bet_id, b.market, b.selection, b.line, b.stake::NUMERIC AS stake,
            g.home_team, g.away_team,
            NULL::NUMERIC AS amount
       FROM pool_events e
       JOIN users actor ON actor.id = e.actor_id
       LEFT JOIN users target ON target.id = e.target_user_id
       LEFT JOIN bets b ON b.id = e.bet_id
       LEFT JOIN games g ON g.id = b.game_id
      WHERE e.pool_id = $1

      UNION ALL

      -- A buy-in has no actor in the commissioner sense: the member did it to
      -- themselves, so target_username carries the name and actor is null.
      SELECT le.id,
             CASE le.entry_type WHEN 'OPENING' THEN 'BUY_IN' ELSE 'REBUY' END,
             NULL, le.created_at,
             NULL, COALESCE(u.display_name, u.username),
             NULL, NULL, NULL, NULL, NULL,
             NULL, NULL,
             le.amount::NUMERIC
        FROM ledger_entries le
        JOIN users u ON u.id = le.user_id
       WHERE le.pool_id = $1
         AND le.entry_type IN ('OPENING', 'REBUY')

      ORDER BY created_at DESC
      LIMIT $2`,
    [poolId, limit],
  );
  return rows.map((row) => ({
    ...row,
    stake: row.stake === null ? null : Number(row.stake),
    amount: row.amount === null ? null : Number(row.amount),
  }));
}
