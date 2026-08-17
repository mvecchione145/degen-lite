import { query, withTransaction } from '../db.js';
import { cacheDel, leaderboardKey } from '../cache.js';

// Settlement runs on a schedule and is idempotent throughout: every step keys
// off a state that the step itself clears, so re-running grades nothing twice
// and never double-credits a balance.

// Grades wagers on games that finished, writing the payout or refund to the
// ledger in the same statement that settles the bet.
async function settleFinishedBets(client) {
  const { rows } = await client.query(
    `WITH settled AS (
        UPDATE bets b
           SET status = grade_bet(b.market, b.selection, b.line,
                                  g.home_score, g.away_score),
               net = CASE grade_bet(b.market, b.selection, b.line,
                                    g.home_score, g.away_score)
                       WHEN 'WON'  THEN bet_profit(b.stake, b.price)
                       WHEN 'LOST' THEN -b.stake
                       ELSE 0
                     END,
               settled_at = CURRENT_TIMESTAMP
          FROM games g
         WHERE g.id = b.game_id
           AND b.status = 'PENDING'
           AND g.status = 'FINAL'
           AND g.home_score IS NOT NULL
           AND g.away_score IS NOT NULL
        RETURNING b.id, b.pool_id, b.user_id, b.stake, b.status, b.net
     ), credited AS (
        INSERT INTO ledger_entries (pool_id, user_id, bet_id, entry_type, amount)
        SELECT pool_id, user_id, id,
               CASE status WHEN 'WON' THEN 'PAYOUT' ELSE 'REFUND' END,
               stake + net
          FROM settled
         WHERE status IN ('WON', 'PUSH')
        RETURNING pool_id
     )
     SELECT pool_id, COUNT(*)::INT AS n FROM settled GROUP BY pool_id`,
  );
  return rows;
}

// A game that never officially concluded voids every bet on it and returns
// every stake.
async function voidAbandonedBets(client) {
  const { rows } = await client.query(
    `WITH voided AS (
        UPDATE bets b
           SET status = 'VOID', net = 0, settled_at = CURRENT_TIMESTAMP
          FROM games g
         WHERE g.id = b.game_id
           AND b.status = 'PENDING'
           AND g.status = 'VOID'
        RETURNING b.id, b.pool_id, b.user_id, b.stake
     ), refunded AS (
        INSERT INTO ledger_entries (pool_id, user_id, bet_id, entry_type, amount)
        SELECT pool_id, user_id, id, 'REFUND', stake FROM voided
        RETURNING pool_id
     )
     SELECT pool_id, COUNT(*)::INT AS n FROM voided GROUP BY pool_id`,
  );
  return rows;
}

// Weekly stipend for pools that run the top-up policy. The partial unique index
// on ledger_entries makes "once per member per week" a database guarantee
// rather than something this query has to remember.
async function grantStipends(client) {
  const { rows } = await client.query(
    `INSERT INTO ledger_entries (pool_id, user_id, entry_type, amount, season, week)
     SELECT p.id, pm.user_id, 'STIPEND', p.stipend_amount, p.season, cw.week
       FROM pools p
       -- A removed member draws no further stipend. Without this the weekly
       -- top-up would keep crediting someone who can no longer place a bet.
       JOIN pool_members pm ON pm.pool_id = p.id AND pm.withdrawn_at IS NULL
       -- Scoped to the pool's anchor league (leagues[1] — SQL arrays are
       -- 1-indexed): a Thursday college kickoff must not decide which week an
       -- NFL pool is on, and a pool playing both needs one stipend cadence
       -- rather than two competing ones. The partial unique index makes a
       -- stipend granted against the wrong week permanent, so this filter is
       -- what keeps the mistake from being unrecoverable.
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           (SELECT MIN(week) FROM games
             WHERE league = p.leagues[1] AND season = p.season
               AND kickoff_time > CURRENT_TIMESTAMP),
           (SELECT MAX(week) FROM games
             WHERE league = p.leagues[1] AND season = p.season)
         ) AS week
       ) cw
      WHERE p.pool_type = 'SPREAD_SHARKS'
        AND p.bust_policy = 'TOPUP'
        AND p.stipend_amount IS NOT NULL
        AND cw.week IS NOT NULL
     ON CONFLICT (pool_id, user_id, season, week)
       WHERE entry_type = 'STIPEND' DO NOTHING
     RETURNING pool_id`,
  );
  return rows;
}

// Eliminates members who are bust, in pools running the default policy. Bust
// requires both an unusable balance and no pending bets: a member sitting at
// zero with live bets is not out yet.
async function eliminateBustMembers(client) {
  const { rows } = await client.query(
    `UPDATE pool_members pm
        SET is_eliminated = TRUE,
            -- Anchor league, for the same reason as the stipend week above:
            -- unfiltered, the other league's calendar would label when a
            -- member went out.
            eliminated_week = COALESCE(
              (SELECT MIN(week) FROM games
                WHERE league = p.leagues[1] AND season = p.season
                  AND kickoff_time > CURRENT_TIMESTAMP),
              (SELECT MAX(week) FROM games
                WHERE league = p.leagues[1] AND season = p.season)
            )
       FROM pools p
      WHERE p.id = pm.pool_id
        AND p.pool_type = 'SPREAD_SHARKS'
        AND p.bust_policy = 'ELIMINATE'
        AND pm.is_eliminated = FALSE
        AND pm.withdrawn_at IS NULL
        AND COALESCE((SELECT SUM(amount) FROM ledger_entries le
                       WHERE le.pool_id = pm.pool_id AND le.user_id = pm.user_id), 0)
            < GREATEST(COALESCE(p.min_bet, 1.00), 1.00)
        AND NOT EXISTS (
          SELECT 1 FROM bets b
           WHERE b.pool_id = pm.pool_id AND b.user_id = pm.user_id
             AND b.status = 'PENDING'
        )
     RETURNING pm.pool_id`,
  );
  return rows;
}

// Legacy pick-based modes. Retained because those pools remain playable.
async function settlePicks(client) {
  const { rows: graded } = await client.query(
    `WITH settled AS (
        UPDATE picks p
           SET is_correct = grade_pick(p.selected_team, g.home_team,
                                       g.home_score, g.away_score,
                                       g.spread, po.use_spreads),
               settled_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
          FROM games g, pools po
         WHERE g.id = p.game_id
           AND po.id = p.pool_id
           AND p.settled_at IS NULL
           AND g.status = 'FINAL'
           AND g.home_score IS NOT NULL
           AND g.away_score IS NOT NULL
        RETURNING p.pool_id
     )
     SELECT pool_id, COUNT(*)::INT AS n FROM settled GROUP BY pool_id`,
  );

  // Survivor standing is derived, not recorded: a member is out when their
  // losses outnumber the rebuys they have been granted.
  //
  //     alive  <=>  rebuys_used >= losses
  //
  // Deriving it is what makes this safe to re-run every minute. An elimination
  // written once and left alone would be undone by a rebuy and then re-applied
  // on the next pass by the very pick the commissioner forgave; a rebuy that
  // only cleared a flag would be wiped the same way. Here the rebuy increments
  // a counter, this recomputes, and the two cannot disagree.
  //
  // A loss is either a wrong pick or no pick at all. Not picking has to count,
  // or sitting a week out would be strictly safer than playing it and the
  // format would be optional.
  //
  // Only weeks that have finished count, and only from the week a member
  // joined — `active_from_week`, recorded at join. Nobody is eliminated for
  // weeks that ran before they arrived, or before the pool existed.
  //
  // The floor is a stored week rather than a comparison against `joined_at`,
  // because kickoff times move. /admin/simulate rewrites them three hours into
  // the past to make a week read as played, which made every member who was
  // already in the pool look like a late arrival and excused them all.
  const { rows: eliminated } = await client.query(
    `WITH concluded AS (
        SELECT po.id AS pool_id, g.week
          FROM pools po
          JOIN games g ON g.league = po.leagues[1] AND g.season = po.season
         WHERE po.pool_type = 'SURVIVOR'
         GROUP BY po.id, g.week
        HAVING BOOL_AND(g.status IN ('FINAL', 'VOID'))
     ), losses AS (
        SELECT m.pool_id, m.user_id, c.week,
               ROW_NUMBER() OVER (PARTITION BY m.pool_id, m.user_id
                                  ORDER BY c.week) AS nth
          FROM pool_members m
          JOIN pools po ON po.id = m.pool_id AND po.pool_type = 'SURVIVOR'
          JOIN concluded c ON c.pool_id = m.pool_id
         WHERE m.withdrawn_at IS NULL
           AND c.week >= COALESCE(m.active_from_week, 1)
           AND NOT EXISTS (
             SELECT 1 FROM picks p
               JOIN games g ON g.id = p.game_id
              WHERE p.pool_id = m.pool_id AND p.user_id = m.user_id
                AND g.league = po.leagues[1] AND g.season = po.season
                AND g.week = c.week
                AND p.is_correct IS NOT FALSE
           )
     ), verdict AS (
        SELECT m.pool_id, m.user_id,
               (SELECT MIN(l.week) FROM losses l
                 WHERE l.pool_id = m.pool_id AND l.user_id = m.user_id
                   AND l.nth > m.rebuys_used) AS out_week
          FROM pool_members m
          JOIN pools po ON po.id = m.pool_id AND po.pool_type = 'SURVIVOR'
         WHERE m.withdrawn_at IS NULL
     )
     UPDATE pool_members pm
        SET is_eliminated = (v.out_week IS NOT NULL),
            eliminated_week = v.out_week
       FROM verdict v
      WHERE pm.pool_id = v.pool_id
        AND pm.user_id = v.user_id
        AND (pm.is_eliminated <> (v.out_week IS NOT NULL)
             OR pm.eliminated_week IS DISTINCT FROM v.out_week)
     RETURNING pm.pool_id`,
  );

  return { graded, eliminated };
}

export async function runSettlement() {
  const result = await withTransaction(async (client) => {
    const betRows = await settleFinishedBets(client);
    const voidRows = await voidAbandonedBets(client);
    const stipendRows = await grantStipends(client);
    // Bust is evaluated after payouts and stipends land, so a member whose
    // winnings or stipend arrived this cycle is not eliminated by mistake.
    const bustRows = await eliminateBustMembers(client);
    const picks = await settlePicks(client);

    const touched = new Set([
      ...betRows.map((r) => r.pool_id),
      ...voidRows.map((r) => r.pool_id),
      ...stipendRows.map((r) => r.pool_id),
      ...bustRows.map((r) => r.pool_id),
      ...picks.graded.map((r) => r.pool_id),
      ...picks.eliminated.map((r) => r.pool_id),
    ]);

    return {
      bets_settled: betRows.reduce((sum, r) => sum + r.n, 0),
      bets_voided: voidRows.reduce((sum, r) => sum + r.n, 0),
      stipends_granted: stipendRows.length,
      members_busted: bustRows.length,
      picks_graded: picks.graded.reduce((sum, r) => sum + r.n, 0),
      members_eliminated: picks.eliminated.length,
      pools_touched: [...touched],
    };
  });

  if (result.pools_touched.length > 0) {
    await cacheDel(...result.pools_touched.map(leaderboardKey));
  }

  return result;
}

// Marks a game as never having officially concluded, which voids every bet on
// it at the next settlement.
export async function abandonGame(gameId) {
  const { rows } = await query(
    `UPDATE games
        SET status = 'VOID', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status <> 'VOID'
      RETURNING id`,
    [gameId],
  );
  return rows.length > 0;
}
