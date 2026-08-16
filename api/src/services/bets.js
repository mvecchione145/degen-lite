import { query, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFoundError } from '../http.js';
import { cacheDel, leaderboardKey } from '../cache.js';
import { requireCommissioner, requireMembership } from './pools.js';
import { getCurrentWeek, weekIsOpen } from './games.js';
import { effectiveMinimum, getBalanceSummary } from './ledger.js';
import { MARKETS, STANDARD_PRICE, describeSelection, lineFor } from './lines.js';

function assertWagerPool(pool) {
  if (pool.pool_type !== 'SPREAD_SHARKS') {
    throw badRequest('This pool does not take wagers');
  }
}

// Resolves the league a request is asking for against the pool's set. Absent
// means the anchor league, which is what a single-league pool always gets.
export function assertPoolLeague(pool, league) {
  if (league == null) return pool.leagues[0];
  if (!pool.leagues.includes(league)) {
    throw badRequest(
      `This pool does not play ${league} (it plays ${pool.leagues.join(', ')})`,
    );
  }
  return league;
}

function assertOpen(pool) {
  if (pool.ends_at && new Date(pool.ends_at) <= new Date()) {
    throw badRequest('This pool has reached its end date and takes no new bets');
  }
}

async function loadGame(client, gameId, pool) {
  const { rows } = await client.query(
    `SELECT id, league, season, week, home_team, away_team, kickoff_time,
            spread, total, home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games WHERE id = $1`,
    [gameId],
  );
  const game = rows[0];
  if (!game) throw notFoundError('No such game');
  if (game.season !== pool.season) {
    throw badRequest("That game is not in this pool's season");
  }
  // Checked here rather than left to the board query: the board is only where
  // games are offered, and a game id posted directly would otherwise let a
  // pool take a wager on a league it does not play.
  if (!pool.leagues.includes(game.league)) {
    throw badRequest(
      `That game is not in this pool's leagues (${pool.leagues.join(', ')})`,
    );
  }
  return game;
}

// Betting runs one week at a time. A game two or three weeks out either has no
// line at all or carries whatever number was last written to it, and neither is
// a real price — SharpAPI prices the near slate, so a far-future game keeps a
// stale or seeded figure that nobody would actually lay. Rather than let a
// member take a number the book is not offering, the board is shut until the
// week comes round.
//
// "Comes round" is getCurrentWeek: the earliest week with a game still to kick
// off. So week N+1 opens the moment the last week-N game starts, which is about
// when the books post it.
async function assertWeekOpen(client, game, pool) {
  const currentWeek = await getCurrentWeek(game.league, pool.season, client);
  if (!weekIsOpen(game.week, currentWeek)) {
    throw badRequest(
      `Week ${game.week} is not open for betting yet — lines are only posted `
      + `for week ${currentWeek}. It opens once week ${currentWeek} is under way.`,
    );
  }
}

export async function placeBet({ poolId, userId, gameId, market, selection, stake }) {
  if (!MARKETS[market]?.selections.includes(selection)) {
    throw badRequest(`${selection} is not a valid selection for a ${market} bet`);
  }

  const placed = await withTransaction(async (client) => {
    // Serialise this member's placements in this pool. Without it, two
    // simultaneous bets can both read the same balance and together overdraw
    // it — each looks affordable on its own.
    await client.query(
      'SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2 FOR UPDATE',
      [poolId, userId],
    );

    const { pool, membership } = await requireMembership(poolId, userId, client);
    assertWagerPool(pool);
    assertOpen(pool);

    if (membership.isWithdrawn) {
      throw forbidden('You have been removed from this pool and cannot place wagers');
    }
    if (membership.isEliminated) {
      throw forbidden('You have been eliminated from this pool');
    }

    const game = await loadGame(client, gameId, pool);
    if (game.locked || game.status !== 'SCHEDULED') {
      throw badRequest(
        `${game.away_team} @ ${game.home_team} has already kicked off and is closed`,
      );
    }
    await assertWeekOpen(client, game, pool);

    const line = lineFor(game, market);
    if (line === null || line === undefined) {
      throw badRequest(`No ${market.toLowerCase()} is posted for this game`);
    }

    const minimum = effectiveMinimum(pool);
    const stakeText = stake.toFixed(2);

    // Every comparison happens in exact NUMERIC, not JS floating point.
    //
    // The cap is the most a member may have riding on one selection — one side
    // of one market on one game, "New England -3.5". So it sums what they
    // already hold on that exact selection rather than looking at this stake
    // alone: splitting a wager into five pieces must not buy five times the
    // limit. Backing a different side, a different market, or a different game
    // each gets its own allowance.
    //
    // VOID bets are excluded because a voided stake is refunded — it is no
    // longer at risk and must not consume the allowance.
    const { rows: [check] } = await client.query(
      `WITH bal AS (
          SELECT COALESCE(SUM(amount), 0) AS balance
            FROM ledger_entries WHERE pool_id = $1 AND user_id = $2
       ), exposure AS (
          SELECT COALESCE(SUM(stake), 0) AS staked
            FROM bets
           WHERE pool_id = $1 AND user_id = $2 AND game_id = $3
             AND market = $4 AND selection = $5
             AND status <> 'VOID'
       )
       SELECT bal.balance, exposure.staked,
              bal.balance >= $6::NUMERIC AS can_afford,
              ($7::NUMERIC IS NULL
               OR exposure.staked + $6::NUMERIC <= $7::NUMERIC) AS within_cap,
              $6::NUMERIC >= $8::NUMERIC AS meets_minimum
         FROM bal, exposure`,
      [poolId, userId, gameId, market, selection, stakeText, pool.max_bet, minimum],
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
      const cap = Number(pool.max_bet);
      const staked = Number(check.staked);
      throw badRequest(
        staked > 0
          ? `This pool caps one selection at ${cap.toFixed(2)}. You already have `
            + `${staked.toFixed(2)} on this one, so ${(cap - staked).toFixed(2)} is left.`
          : `This pool caps one selection at ${cap.toFixed(2)}`,
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

// A pool may play more than one league, but a board never mixes them: their
// week numbers describe different weekends (college week 2 is a week earlier
// than NFL week 2), so the caller picks a league and gets that league's week.
export async function getBoard({ poolId, userId, league, week }) {
  const { pool, membership } = await requireMembership(poolId, userId);
  assertWagerPool(pool);
  const boardLeague = assertPoolLeague(pool, league);

  const { rows: games } = await query(
    `SELECT id, league, season, week, home_team, away_team, kickoff_time,
            spread, total, home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games
      WHERE league = $1 AND season = $2 AND week = $3
      ORDER BY kickoff_time, id`,
    [boardLeague, pool.season, week],
  );

  // Mirrors assertWeekOpen so the buttons are already dead when a member
  // browses ahead, rather than the API rejecting the bet after they have picked
  // a side and typed a stake.
  const currentWeek = await getCurrentWeek(boardLeague, pool.season);
  const weekOpen = weekIsOpen(week, currentWeek);

  const { rows: myBets } = await query(
    `SELECT b.*, b.stake::NUMERIC AS stake, b.net::NUMERIC AS net
       FROM bets b
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1 AND b.user_id = $2
        AND g.league = $3 AND g.season = $4 AND g.week = $5
      ORDER BY b.placed_at`,
    [poolId, userId, boardLeague, pool.season, week],
  );

  // Other members' bets are revealed once a game kicks off and they can no
  // longer be acted on.
  const { rows: revealed } = await query(
    `SELECT b.game_id, b.market, b.selection, b.line, b.stake::NUMERIC AS stake,
            b.status, b.net::NUMERIC AS net, u.username
       FROM bets b
       JOIN users u ON u.id = b.user_id
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1
        AND g.league = $2 AND g.season = $3 AND g.week = $4
        AND g.kickoff_time <= CURRENT_TIMESTAMP
        AND b.user_id <> $5
      ORDER BY u.username`,
    [poolId, boardLeague, pool.season, week, userId],
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


  return {
    pool,
    membership,
    league: boardLeague,
    week,
    price: STANDARD_PRICE,
    balance: await getBalanceSummary(pool, userId),
    pool_ended: Boolean(pool.ends_at && new Date(pool.ends_at) <= new Date()),
    current_week: currentWeek,
    week_open: weekOpen,
    games: games.map((game) => {
      const mine = betsByGame.get(game.id) ?? [];
      const exposure = mine
        .filter((b) => b.status !== 'VOID')
        .reduce((sum, b) => sum + Number(b.stake), 0);
      return {
        ...game,
        my_bets: mine,
        other_bets: revealedByGame.get(game.id) ?? [],
        // What this member already has riding on the fixture. Context only —
        // the cap applies per bet, so this does not limit the next one.
        exposure: Number(exposure.toFixed(2)),
      };
    }),
  };
}

/* --------------------------------------------------------- pool-wide history */

// Who may see whose bet. This mirrors the board exactly (see getBoard): another
// member's wager is revealed once its game kicks off and it can no longer be
// acted on, and your own are always yours to see. Listing everyone's pending
// bets in a history tab would hand members the pool's picks before they place
// their own, which is the one thing the board is careful never to do.
const VISIBLE_TO_MEMBER = `(b.user_id = $2 OR g.kickoff_time <= CURRENT_TIMESTAMP)`;

// A page of every bet in the pool, newest first. Paginated because a full
// season across a dozen members runs to thousands of rows, and none of the
// callers want them all at once.
// Builds the WHERE for a history query. Every filter is optional and every
// value is a bound parameter — the only thing interpolated is a parameter
// index. Shared by the page and the count so a filtered pager stays honest.
export function historyWhere(poolId, userId, f) {
  const params = [poolId, userId];
  const clauses = ['b.pool_id = $1', VISIBLE_TO_MEMBER];

  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace('$n', `$${params.length}`));
  };

  if (f.user_id) add('b.user_id = $n', f.user_id);
  if (f.league) add('g.league = $n', f.league);
  if (f.week != null) add('g.week = $n', f.week);
  if (f.status) add('b.status = $n', f.status);
  if (f.market) add('b.market = $n', f.market);

  // Which date the range applies to. `placed` is when the wager was struck,
  // `kickoff` is when the game was played — "bets from last weekend" almost
  // always means the second, so it is the default. The table labels whichever
  // one is filtered, because filtering on one while showing the other makes
  // correct results look wrong.
  const dateColumn = f.date_field === 'placed' ? 'b.placed_at' : 'g.kickoff_time';

  // Half-open: `to` is the start of the day after the one the member picked,
  // computed in their timezone by the client. Comparing < rather than <= is
  // what makes the last day inclusive without dropping games late in it.
  if (f.from) add(`${dateColumn} >= $n`, f.from);
  if (f.to) add(`${dateColumn} < $n`, f.to);

  return { where: clauses.join('\n          AND '), params };
}

export async function listPoolBets({
  poolId, userId, limit = 25, offset = 0, filters = {},
}) {
  const { pool } = await requireMembership(poolId, userId);
  assertWagerPool(pool);

  if (filters.league) assertPoolLeague(pool, filters.league);

  const { where, params } = historyWhere(poolId, userId, filters);

  // Counted separately rather than with a window function: an offset past the
  // end returns no rows, and a count carried on the rows would then report a
  // total of zero and strand the pager on an empty page.
  const [page, totals] = await Promise.all([
    query(
      `SELECT b.id, b.user_id, u.username, b.game_id, b.market, b.selection,
              b.line, b.price, b.stake::NUMERIC AS stake, b.status,
              b.net::NUMERIC AS net, b.placed_at, b.settled_at,
              g.league, g.week, g.home_team, g.away_team, g.kickoff_time,
              g.home_score, g.away_score, g.status AS game_status
         FROM bets b
         JOIN games g ON g.id = b.game_id
         JOIN users u ON u.id = b.user_id
        WHERE ${where}
        -- id breaks ties so a page boundary can't drop or repeat a bet when
        -- several land in the same transaction.
        ORDER BY b.placed_at DESC, b.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(
      `SELECT COUNT(*)::INT AS total,
              COALESCE(SUM(b.stake), 0)::NUMERIC AS staked,
              COALESCE(SUM(b.net) FILTER (WHERE b.net IS NOT NULL), 0)::NUMERIC AS net
         FROM bets b
         JOIN games g ON g.id = b.game_id
        WHERE ${where}`,
      params,
    ),
  ]);

  const bets = page.rows.map((bet) => ({
    ...bet,
    stake: Number(bet.stake),
    net: bet.net === null ? null : Number(bet.net),
    is_mine: bet.user_id === userId,
    description: describeSelection(
      { ...bet, spread: bet.line, total: bet.line }, bet.market, bet.selection,
    ),
  }));

  const { total, staked, net } = totals.rows[0];

  return {
    pool,
    bets,
    filters,
    page: {
      limit,
      offset,
      total,
      has_more: offset + bets.length < total,
    },
    // Across every bet matching the filters, not just the page on screen.
    summary: { total, staked: Number(staked), net: Number(net) },
  };
}

export async function listBets({ poolId, userId, status = null, limit = 200 }) {
  const { pool } = await requireMembership(poolId, userId);
  assertWagerPool(pool);

  // Rows and totals are fetched separately so the totals cover every matching
  // bet rather than the LIMITed page, and so the sums happen in exact NUMERIC
  // instead of accumulating in binary floating point on the way out.
  const [page, totals] = await Promise.all([
    query(
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
    ),
    query(
      `SELECT COUNT(*)::INT AS total,
              COUNT(*) FILTER (WHERE status = 'PENDING')::INT AS pending,
              COUNT(*) FILTER (WHERE status = 'WON')::INT     AS won,
              COUNT(*) FILTER (WHERE status = 'LOST')::INT    AS lost,
              COUNT(*) FILTER (WHERE status = 'PUSH')::INT    AS pushed,
              COUNT(*) FILTER (WHERE status = 'VOID')::INT    AS voided,
              COALESCE(SUM(stake), 0)::NUMERIC                AS staked,
              COALESCE(SUM(net) FILTER (WHERE net IS NOT NULL), 0)::NUMERIC AS net
         FROM bets
        WHERE pool_id = $1 AND user_id = $2
          AND ($3::TEXT IS NULL OR status = $3)`,
      [poolId, userId, status],
    ),
  ]);
  const { rows } = page;

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

  const counts = totals.rows[0];

  return {
    pool,
    bets,
    summary: {
      ...counts,
      staked: Number(counts.staked),
      net: Number(counts.net),
    },
  };
}

// Every live wager in the pool, for the commissioner to act on.
//
// The reveal rule hides which side a member took until their game kicks off,
// and the commissioner is a competitor like anyone else — so this deliberately
// does not lift it. Before kickoff they see who staked what on which fixture,
// which is everything a complaint is ever about, and not the selection or the
// line, which is the only part that would hand them an edge. After kickoff the
// bet is public anyway and the full detail comes through.
export async function listPendingForCommissioner({ poolId, actorId }) {
  await requireCommissioner(poolId, actorId);

  const { rows } = await query(
    `SELECT b.id, b.market, b.stake::NUMERIC AS stake, b.placed_at,
            u.username, g.home_team, g.away_team, g.kickoff_time,
            (g.kickoff_time <= CURRENT_TIMESTAMP) AS revealed,
            CASE WHEN g.kickoff_time <= CURRENT_TIMESTAMP
                 THEN b.selection END AS selection,
            CASE WHEN g.kickoff_time <= CURRENT_TIMESTAMP
                 THEN b.line END AS line
       FROM bets b
       JOIN users u ON u.id = b.user_id
       JOIN games g ON g.id = b.game_id
      WHERE b.pool_id = $1 AND b.status = 'PENDING'
      ORDER BY g.kickoff_time, u.username`,
    [poolId],
  );

  return rows.map((row) => ({ ...row, stake: Number(row.stake) }));
}

// Commissioner voids a single wager: stake returned, no result recorded.
//
// Deliberately limited to PENDING bets. A graded bet stays graded — reversing a
// payout would mean every settled result is provisional until the commissioner
// says otherwise, and the ledger's whole value is that it reconciles by
// construction. The refund reuses the same VOID/REFUND shape an abandoned game
// produces, so a commissioner void and a cancelled fixture are indistinguishable
// to settlement and to the balance arithmetic.
export async function voidBet({ poolId, actorId, betId, reason }) {
  const result = await withTransaction(async (client) => {
    const { pool } = await requireCommissioner(poolId, actorId, client);
    assertWagerPool(pool);

    // Same lock placeBet takes, against the bet's owner rather than the actor:
    // without it a void can race a placement or a rebuy on the same balance.
    const { rows: [owner] } = await client.query(
      `SELECT user_id FROM bets WHERE id = $1 AND pool_id = $2`,
      [betId, poolId],
    );
    if (!owner) throw notFoundError('No such bet in this pool');
    await client.query(
      'SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2 FOR UPDATE',
      [poolId, owner.user_id],
    );

    const { rows } = await client.query(
      `UPDATE bets
          SET status = 'VOID', net = 0, settled_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND pool_id = $2 AND status = 'PENDING'
        RETURNING id, user_id, stake::NUMERIC AS stake, market, selection, line, game_id`,
      [betId, poolId],
    );

    if (rows.length === 0) {
      const { rows: [current] } = await client.query(
        'SELECT status FROM bets WHERE id = $1 AND pool_id = $2',
        [betId, poolId],
      );
      throw badRequest(
        current.status === 'VOID'
          ? 'That wager has already been voided'
          : `That wager has already settled as ${current.status} and cannot be voided`,
      );
    }

    const bet = rows[0];
    await client.query(
      `INSERT INTO ledger_entries (pool_id, user_id, bet_id, entry_type, amount)
       VALUES ($1, $2, $3, 'REFUND', $4::NUMERIC)`,
      [poolId, bet.user_id, bet.id, bet.stake],
    );

    const { rows: [event] } = await client.query(
      `INSERT INTO pool_events (pool_id, actor_id, kind, target_user_id, bet_id, reason)
       VALUES ($1, $2, 'BET_VOIDED', $3, $4, $5)
       RETURNING *`,
      [poolId, actorId, bet.user_id, bet.id, reason ?? null],
    );

    return { bet_id: bet.id, refunded: Number(bet.stake), event };
  });

  await cacheDel(leaderboardKey(poolId));
  return result;
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
