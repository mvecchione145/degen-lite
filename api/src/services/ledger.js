import { query } from '../db.js';

// Balance is the sum of a member's ledger entries — never a stored column — so
// balance, bet history, and standings cannot drift apart.
//
// All money arithmetic stays in SQL as exact NUMERIC. Values are converted to
// JS numbers only on the way out, for display.

// The whole-unit floor beneath every pool setting. A pool's minimum bet may be
// raised above it, never below, and switching the pool minimum off leaves this
// in force rather than allowing 0.01 wagers.
export const ABSOLUTE_MIN_STAKE = 1;

export const effectiveMinimum = (pool) =>
  Math.max(Number(pool.min_bet ?? 0), ABSOLUTE_MIN_STAKE);

export async function getBalance(poolId, userId, client = null) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    `SELECT COALESCE(SUM(amount), 0)::NUMERIC AS balance
       FROM ledger_entries WHERE pool_id = $1 AND user_id = $2`,
    [poolId, userId],
  );
  return Number(rows[0].balance);
}

export async function getBalanceSummary(pool, userId) {
  const { rows } = await query(
    `SELECT
        COALESCE((SELECT SUM(amount) FROM ledger_entries
                   WHERE pool_id = $1 AND user_id = $2), 0)::NUMERIC AS balance,
        COALESCE((SELECT SUM(stake) FROM bets
                   WHERE pool_id = $1 AND user_id = $2
                     AND status = 'PENDING'), 0)::NUMERIC AS at_risk,
        COALESCE((SELECT SUM(amount) FROM ledger_entries
                   WHERE pool_id = $1 AND user_id = $2
                     AND entry_type IN ('OPENING', 'STIPEND', 'REBUY')), 0)::NUMERIC
          AS total_credited,
        (SELECT rebuys_used FROM pool_members
          WHERE pool_id = $1 AND user_id = $2) AS rebuys_used,
        (SELECT is_eliminated FROM pool_members
          WHERE pool_id = $1 AND user_id = $2) AS is_eliminated`,
    [pool.id, userId],
  );

  const row = rows[0];
  const balance = Number(row.balance);
  const atRisk = Number(row.at_risk);
  const credited = Number(row.total_credited);

  return {
    balance,
    at_risk: atRisk,
    total_credited: credited,
    // What the member has actually made: everything credited to them is backed
    // out, so a rebuy never reads as profit.
    net_profit: Number((balance + atRisk - credited).toFixed(2)),
    minimum_bet: effectiveMinimum(pool),
    max_bet_per_game: pool.max_bet_per_game === null ? null : Number(pool.max_bet_per_game),
    rebuys_used: row.rebuys_used ?? 0,
    rebuy_limit: pool.rebuy_limit,
    bust_policy: pool.bust_policy,
    is_eliminated: row.is_eliminated ?? false,
    // Bust needs both conditions: a member sitting at zero with live bets is
    // not out yet.
    is_bust: balance < effectiveMinimum(pool) && atRisk === 0,
  };
}

export async function creditOpeningBalance(poolId, userId, amount, client) {
  await client.query(
    `INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount)
     VALUES ($1, $2, 'OPENING', $3)`,
    [poolId, userId, amount],
  );
}

export async function listLedger(poolId, userId, limit = 100) {
  const { rows } = await query(
    `SELECT id, bet_id, entry_type, amount::NUMERIC, season, week, created_at
       FROM ledger_entries
      WHERE pool_id = $1 AND user_id = $2
      ORDER BY created_at DESC, id
      LIMIT $3`,
    [poolId, userId, limit],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}
