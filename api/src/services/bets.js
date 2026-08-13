import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFoundError } from '../http.js';
import { cacheDel, leaderboardKey } from '../cache.js';
import { requireMembership } from './pools.js';
import { effectiveMinimum, getBalanceSummary } from './ledger.js';
import { MARKETS, STANDARD_PRICE, describeSelection, lineFor } from './lines.js';

function assertWagerPool(pool) {
  if (pool.pool_type !== 'SPREAD_SHARKS') {
    throw badRequest('This pool does not take wagers');
  }
}

function assertOpen(pool) {
  if (pool.ends_at && new Date(pool.ends_at) <= new Date()) {
    throw badRequest('This pool has reached its end date and takes no new bets');
  }
}

async function loadGame(client, gameId, season) {
  const { rows } = await client.query(
    `SELECT id, season, week, home_team, away_team, kickoff_time, spread, total,
            home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games WHERE id = $1`,
    [gameId],
  );
  const game = rows[0];
  if (!game) throw notFoundError('No such game');
  if (game.season !== season) {
    throw badRequest("That game is not in this pool's season");
  }
  return game;
}

export async function placeBet({ poolId, userId, gameId, market, selection, stake }) {
  if (!MARKETS[market]?.selections.includes(selection)) {
    throw badRequest(`${selection} is not a valid selection for a ${market} bet`);
  }

  const placed = await withTransaction(async (client) => {
    // Serialise this member's placements in this pool. Without it, two
    // simultaneous bets can both read the same balance and exposure, and
    // together breach the balance or the per-game cap.
    await client.query(
      'SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2 FOR UPDATE',
      [poolId, userId],
    );

    const { pool, membership } = await requireMembership(poolId, userId, client);
    assertWagerPool(pool);
    assertOpen(pool);

    if (membership.isEliminated) {
      throw forbidden('You have been eliminated from this pool');
    }

    const game = await loadGame(client, gameId, pool.season);
    if (game.locked || game.status !== 'SCHEDULED') {
      throw badRequest(
        `${game.away_team} @ ${game.home_team} has already kicked off and is closed`,
      );
    }

    const line = lineFor(game, market);
    if (line === null || line === undefined) {
      throw badRequest(`No ${market.toLowerCase()} is posted for this game`);
    }

    const minimum = effectiveMinimum(pool);
    const stakeText = stake.toFixed(2);

    // Every comparison happens in exact NUMERIC, not JS floating point.
    const { rows: [check] } = await client.query(
      `WITH bal AS (
          SELECT COALESCE(SUM(amount), 0) AS balance
            FROM ledger_entries WHERE pool_id = $1 AND user_id = $2
       ), exposure AS (
          SELECT COALESCE(SUM(stake), 0) AS staked
            FROM bets
           WHERE pool_id = $1 AND user_id = $2 AND game_id = $3
             AND status <> 'VOID'
       )
       SELECT bal.balance, exposure.staked,
              bal.balance >= $4::NUMERIC AS can_afford,
              ($5::NUMERIC IS NULL
               OR exposure.staked + $4::NUMERIC <= $5::NUMERIC) AS within_cap,
              $4::NUMERIC >= $6::NUMERIC AS meets_minimum
         FROM bal, exposure`,
      [poolId, userId, gameId, stakeText, pool.max_bet_per_game, minimum],
    );

    if (!check.meets_minimum) {
      throw badRequest(`The minimum bet in this pool is ${minimum.toFixed(2)}`);
    }
    if (!check.can_afford) {
      throw badRequest(
        `Your balance is ${Number(check.balance).toFixed(2)}, which will not cover a stake of ${stakeText}`,
      );
    }
    if (!check.within_cap) {
      const cap = Number(pool.max_bet_per_game);
      const staked = Number(check.staked);
      throw badRequest(
        `This pool caps total stake on one game at ${cap.toFixed(2)}. `
        + `You already have ${staked.toFixed(2)} on this game, so ${(cap - staked).toFixed(2)} is left.`,
      );
    }

    const { rows: [bet] } = await client.query(
      `INSERT INTO bets (pool_id, user_id, game_id, market, selection, line, price, stake)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [poolId, userId, gameId, market, selection, line, STANDARD_PRICE, stakeText],
    );

    // The stake leaves the balance immediately.
    await client.query(
      `INSERT INTO ledger_entries (pool_id, user_id, bet_id, entry_type, amount)
       VALUES ($1, $2, $3, 'STAKE', $4::NUMERIC * -1)`,
      [poolId, userId, bet.id, stakeText],
    );

    return { bet, game, pool };
  });

  await cacheDel(leaderboardKey(poolId));

  return {
    ...placed.bet,
    description: describeSelection(placed.game, placed.bet.market, placed.bet.selection),
    game: {
      id: placed.game.id,
      week: placed.game.week,
      home_team: placed.game.home_team,
      away_team: placed.game.away_team,
      kickoff_time: placed.game.kickoff_time,
    },
  };
}

export async function getBoard({ poolId, userId, week }) {
  const { pool, membership } = await requireMembership(poolId, userId);
  assertWagerPool(pool);

  const { rows: games } = await query(
    `SELECT id, season, week, home_team, away_team, kickoff_time, spread, total,
            home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games
      WHERE season = $1 AND week = $2
      ORDER BY kickoff_time, id`,
    [pool.season, week],
  );

  const { rows: myBets } = await query(
    `SELECT b.*, b.stake::NUMERIC AS stake, b.net::NUMERIC AS net
       FROM bets b
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1 AND b.user_id = $2 AND g.season = $3 AND g.week = $4
      ORDER BY b.placed_at`,
    [poolId, userId, pool.season, week],
  );

  // Other members' bets are revealed once a game kicks off and they can no
  // longer be acted on.
  const { rows: revealed } = await query(
    `SELECT b.game_id, b.market, b.selection, b.line, b.stake::NUMERIC AS stake,
            b.status, b.net::NUMERIC AS net, u.username
       FROM bets b
       JOIN users u ON u.id = b.user_id
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1 AND g.season = $2 AND g.week = $3
        AND g.kickoff_time <= CURRENT_TIMESTAMP
        AND b.user_id <> $4
      ORDER BY u.username`,
    [poolId, pool.season, week, userId],
  );

  const betsByGame = new Map();
  for (const bet of myBets) {
    if (!betsByGame.has(bet.game_id)) betsByGame.set(bet.game_id, []);
    betsByGame.get(bet.game_id).push(bet);
  }

  const revealedByGame = new Map();
  for (const bet of revealed) {
    if (!revealedByGame.has(bet.game_id)) revealedByGame.set(bet.game_id, []);
    revealedByGame.get(bet.game_id).push(bet);
  }

  const cap = pool.max_bet_per_game === null ? null : Number(pool.max_bet_per_game);

  return {
    pool,
    membership,
    week,
    price: STANDARD_PRICE,
    balance: await getBalanceSummary(pool, userId),
    pool_ended: Boolean(pool.ends_at && new Date(pool.ends_at) <= new Date()),
    games: games.map((game) => {
      const mine = betsByGame.get(game.id) ?? [];
      const exposure = mine
        .filter((b) => b.status !== 'VOID')
        .reduce((sum, b) => sum + Number(b.stake), 0);
      return {
        ...game,
        my_bets: mine,
        other_bets: revealedByGame.get(game.id) ?? [],
        exposure: Number(exposure.toFixed(2)),
        remaining_allowance: cap === null
          ? null
          : Number(Math.max(0, cap - exposure).toFixed(2)),
      };
    }),
  };
}

export async function listBets({ poolId, userId, status = null, limit = 200 }) {
  const { pool } = await requireMembership(poolId, userId);
  assertWagerPool(pool);

  const { rows } = await query(
    `SELECT b.id, b.game_id, b.market, b.selection, b.line,
            b.price, b.stake::NUMERIC AS stake, b.status, b.net::NUMERIC AS net,
            b.placed_at, b.settled_at,
            g.week, g.home_team, g.away_team, g.kickoff_time,
            g.home_score, g.away_score, g.status AS game_status
       FROM bets b
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1 AND b.user_id = $2
        AND ($3::TEXT IS NULL OR b.status = $3)
      ORDER BY b.placed_at DESC
      LIMIT $4`,
    [poolId, userId, status, limit],
  );

  const bets = rows.map((bet) => ({
    ...bet,
    stake: Number(bet.stake),
    net: bet.net === null ? null : Number(bet.net),
    // The line as struck lives on the bet, not on the game, so a bet describes
    // itself from its own captured number rather than today's line.
    description: describeSelection(
      { ...bet, spread: bet.line, total: bet.line }, bet.market, bet.selection,
    ),
  }));

  const settled = bets.filter((b) => b.net !== null);

  return {
    pool,
    bets,
    summary: {
      total: bets.length,
      pending: bets.filter((b) => b.status === 'PENDING').length,
      won: bets.filter((b) => b.status === 'WON').length,
      lost: bets.filter((b) => b.status === 'LOST').length,
      pushed: bets.filter((b) => b.status === 'PUSH').length,
      voided: bets.filter((b) => b.status === 'VOID').length,
      staked: Number(bets.reduce((s, b) => s + b.stake, 0).toFixed(2)),
      net: Number(settled.reduce((s, b) => s + b.net, 0).toFixed(2)),
    },
  };
}

// Restores a bust member to the starting balance, where the pool allows it.
export async function rebuy({ poolId, userId }) {
  const result = await withTransaction(async (client) => {
    await client.query(
      'SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2 FOR UPDATE',
      [poolId, userId],
    );

    const { pool } = await requireMembership(poolId, userId, client);
    assertWagerPool(pool);
    assertOpen(pool);

    if (pool.bust_policy !== 'REBUY') {
      throw badRequest('This pool does not allow rebuys');
    }

    const { rows: [state] } = await client.query(
      `SELECT
          COALESCE((SELECT SUM(amount) FROM ledger_entries
                     WHERE pool_id = $1 AND user_id = $2), 0) AS balance,
          COALESCE((SELECT SUM(stake) FROM bets
                     WHERE pool_id = $1 AND user_id = $2
                       AND status = 'PENDING'), 0) AS at_risk,
          (SELECT rebuys_used FROM pool_members
            WHERE pool_id = $1 AND user_id = $2) AS rebuys_used,
          COALESCE((SELECT SUM(amount) FROM ledger_entries
                     WHERE pool_id = $1 AND user_id = $2), 0)
            < $3::NUMERIC AS below_minimum`,
      [poolId, userId, effectiveMinimum(pool)],
    );

    if (Number(state.at_risk) > 0 || !state.below_minimum) {
      throw badRequest('Rebuys are only available once you are bust');
    }
    if (state.rebuys_used >= pool.rebuy_limit) {
      throw conflict(
        `You have used all ${pool.rebuy_limit} rebuy${pool.rebuy_limit === 1 ? '' : 's'} for this season`,
      );
    }

    const { rows: [entry] } = await client.query(
      `INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount)
       VALUES ($1, $2, 'REBUY', $3::NUMERIC - $4::NUMERIC)
       RETURNING amount::NUMERIC`,
      [poolId, userId, pool.starting_balance, state.balance],
    );

    await client.query(
      `UPDATE pool_members SET rebuys_used = rebuys_used + 1,
                               is_eliminated = FALSE,
                               eliminated_week = NULL
        WHERE pool_id = $1 AND user_id = $2`,
      [poolId, userId],
    );

    return { credited: Number(entry.amount), rebuys_used: state.rebuys_used + 1 };
  });

  await cacheDel(leaderboardKey(poolId));
  return result;
}
