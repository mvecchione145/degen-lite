import { query, withTransaction } from '../db.js';
import { conflict, forbidden, notFoundError } from '../http.js';

// No 0/O/1/I: invite codes get read aloud and retyped.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
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
      'INSERT INTO pool_members (pool_id, user_id) VALUES ($1, $2)',
      [pool.id, commissionerId],
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

    const { rows: joined } = await client.query(
      `INSERT INTO pool_members (pool_id, user_id) VALUES ($1, $2)
       ON CONFLICT (pool_id, user_id) DO NOTHING
       RETURNING user_id`,
      [pool.id, userId],
    );

    // Only a first join opens a balance, so rejoining stays idempotent and
    // cannot be used to mint another opening credit.
    if (joined.length > 0) await creditOpening(client, pool, userId);

    return pool;
  });
}

export async function listPoolsForUser(userId) {
  const { rows } = await query(
    `SELECT p.*, u.username AS commissioner_username,
            pm.is_eliminated, pm.eliminated_week,
            (SELECT COUNT(*)::INT FROM pool_members m WHERE m.pool_id = p.id) AS member_count,
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
    `SELECT p.*, u.username AS commissioner_username,
            pm.user_id AS member_user_id, pm.is_eliminated, pm.eliminated_week
       FROM pools p
       JOIN users u ON u.id = p.commissioner_id
       LEFT JOIN pool_members pm ON pm.pool_id = p.id AND pm.user_id = $2
      WHERE p.id = $1`,
    [poolId, userId],
  );
  const row = rows[0];
  if (!row) return null;

  const { member_user_id: memberUserId, is_eliminated: isEliminated,
    eliminated_week: eliminatedWeek, ...pool } = row;

  return {
    pool,
    membership: memberUserId
      ? { isEliminated, eliminatedWeek }
      : null,
  };
}

export async function requireMembership(poolId, userId, client = null) {
  const found = await getPoolWithMembership(poolId, userId, client);
  if (!found) throw notFoundError('Pool not found');
  if (!found.membership) throw forbidden('You are not a member of this pool');
  return found;
}

export async function listMembers(poolId) {
  const { rows } = await query(
    `SELECT u.id, u.username, pm.joined_at, pm.is_eliminated, pm.eliminated_week
       FROM pool_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.pool_id = $1
      ORDER BY pm.joined_at, u.username`,
    [poolId],
  );
  return rows;
}
