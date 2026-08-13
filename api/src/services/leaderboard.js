import { query } from '../db.js';
import { cacheGet, cacheSet, leaderboardKey } from '../cache.js';
import { config } from '../config.js';

// Spread Sharks standings are ranked on balance, with stake at risk shown
// separately. Total credited is shown too: under the top-up and rebuy policies a
// member can be handed balance they did not win, and without that column someone
// who rebought three times would outrank someone who never did on the same
// results.
async function wagerStandings(pool) {
  const { rows } = await query(
    `SELECT u.id AS user_id,
            u.username,
            pm.is_eliminated,
            pm.eliminated_week,
            pm.rebuys_used,
            COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id),
                     0)::NUMERIC AS balance,
            COALESCE((SELECT SUM(stake) FROM bets b
                       WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                         AND b.status = 'PENDING'), 0)::NUMERIC AS at_risk,
            COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id
                         AND le.entry_type IN ('OPENING', 'STIPEND', 'REBUY')),
                     0)::NUMERIC AS total_credited,
            (SELECT COUNT(*) FROM bets b
              WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                AND b.status = 'WON')::INT AS wins,
            (SELECT COUNT(*) FROM bets b
              WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                AND b.status = 'LOST')::INT AS losses,
            (SELECT COUNT(*) FROM bets b
              WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                AND b.status = 'PUSH')::INT AS pushes,
            (SELECT COUNT(*) FROM bets b
              WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                AND b.status = 'VOID')::INT AS voids,
            (SELECT COUNT(*) FROM bets b
              WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
                AND b.status = 'PENDING')::INT AS pending
       FROM pool_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.pool_id = $1`,
    [pool.id],
  );

  const standings = rows.map((row) => {
    const balance = Number(row.balance);
    const atRisk = Number(row.at_risk);
    const credited = Number(row.total_credited);
    return {
      ...row,
      balance,
      at_risk: atRisk,
      total_credited: credited,
      net_profit: Number((balance + atRisk - credited).toFixed(2)),
    };
  });

  standings.sort((a, b) => {
    if (b.balance !== a.balance) return b.balance - a.balance;
    if (b.net_profit !== a.net_profit) return b.net_profit - a.net_profit;
    return a.username.localeCompare(b.username);
  });

  rankInPlace(standings, (row) => `${row.balance}:${row.net_profit}`);
  return standings;
}

// Legacy pick-based scoring:
//   PICKEM      1 point per correct pick
//   CONFIDENCE  the pick's assigned rank per correct pick
//   SURVIVOR    no score; standings are survival, ordered by weeks survived
async function pickStandings(pool) {
  const { rows } = await query(
    `SELECT u.id AS user_id,
            u.username,
            pm.is_eliminated,
            pm.eliminated_week,
            COUNT(p.id)::INT AS picks_made,
            COUNT(*) FILTER (WHERE p.is_correct IS TRUE)::INT AS wins,
            COUNT(*) FILTER (WHERE p.is_correct IS FALSE)::INT AS losses,
            COUNT(*) FILTER (
              WHERE p.settled_at IS NOT NULL AND p.is_correct IS NULL
            )::INT AS pushes,
            COALESCE(SUM(
              CASE WHEN p.is_correct IS TRUE THEN
                CASE WHEN $2 = 'CONFIDENCE'
                     THEN COALESCE(p.confidence_rank, 0) ELSE 1 END
              ELSE 0 END
            ), 0)::INT AS points
       FROM pool_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN picks p ON p.pool_id = pm.pool_id AND p.user_id = pm.user_id
      WHERE pm.pool_id = $1
      GROUP BY u.id, u.username, pm.is_eliminated, pm.eliminated_week`,
    [pool.id, pool.pool_type],
  );

  const standings = rows.sort((a, b) => {
    if (pool.pool_type === 'SURVIVOR' && a.is_eliminated !== b.is_eliminated) {
      return a.is_eliminated ? 1 : -1;
    }
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.username.localeCompare(b.username);
  });

  rankInPlace(standings, (row) => `${row.is_eliminated}:${row.points}:${row.wins}`);
  return standings;
}

// Ties share a rank, and the next rank skips accordingly.
function rankInPlace(standings, keyOf) {
  let lastKey = null;
  let lastRank = 0;
  standings.forEach((row, index) => {
    const key = keyOf(row);
    if (key !== lastKey) {
      lastRank = index + 1;
      lastKey = key;
    }
    row.rank = lastRank;
  });
}

export async function getLeaderboard(pool) {
  const key = leaderboardKey(pool.id);

  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const isWagerPool = pool.pool_type === 'SPREAD_SHARKS';
  const payload = {
    pool_id: pool.id,
    pool_type: pool.pool_type,
    ranked_by: isWagerPool ? 'balance' : 'points',
    computed_at: new Date().toISOString(),
    standings: isWagerPool ? await wagerStandings(pool) : await pickStandings(pool),
  };

  await cacheSet(key, payload, config.leaderboardTtlSeconds);
  return { ...payload, cached: false };
}
