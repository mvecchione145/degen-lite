import { withTransaction, query } from '../db.js';
import { badRequest, forbidden } from '../http.js';
import { cacheDel, leaderboardKey } from '../cache.js';
import { requireMembership } from './pools.js';

// Rules the schema cannot express live here: the kickoff lock, unique
// confidence ranks within a week, one survivor pick per week, and no reusing a
// survivor team. See docs/mvp.md.

async function loadWeekGames(client, season, week) {
  const { rows } = await client.query(
    `SELECT id, season, week, home_team, away_team, kickoff_time, spread,
            home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games
      WHERE season = $1 AND week = $2
      ORDER BY kickoff_time, id`,
    [season, week],
  );
  return rows;
}

async function loadUserPicks(client, poolId, userId, season, week = null) {
  const { rows } = await client.query(
    `SELECT p.id, p.game_id, p.selected_team, p.confidence_rank,
            p.tiebreaker_points, p.is_correct, p.settled_at,
            g.week, g.kickoff_time, g.home_team, g.away_team,
            (g.kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM picks p
       JOIN games g ON g.id = p.game_id
      WHERE p.pool_id = $1 AND p.user_id = $2 AND g.season = $3
        AND ($4::INT IS NULL OR g.week = $4)
      ORDER BY g.kickoff_time, g.id`,
    [poolId, userId, season, week],
  );
  return rows;
}

function assertPickPool(pool) {
  if (pool.pool_type === 'SPREAD_SHARKS') {
    throw badRequest('This pool takes wagers, not picks — use the board instead');
  }
}

export async function getWeekView({ poolId, userId, week }) {
  const { pool, membership } = await requireMembership(poolId, userId);
  assertPickPool(pool);
  const client = { query };

  const games = await loadWeekGames(client, pool.season, week);
  const myPicks = await loadUserPicks(client, poolId, userId, pool.season, week);
  const myPicksByGame = new Map(myPicks.map((p) => [p.game_id, p]));

  // Other members' picks are only revealed once a game has kicked off.
  const { rows: revealed } = await query(
    `SELECT p.game_id, p.selected_team, p.confidence_rank, p.is_correct,
            u.username
       FROM picks p
       JOIN users u ON u.id = p.user_id
       JOIN games g ON g.id = p.game_id
      WHERE p.pool_id = $1 AND g.season = $2 AND g.week = $3
        AND g.kickoff_time <= CURRENT_TIMESTAMP
        AND p.user_id <> $4
      ORDER BY u.username`,
    [poolId, pool.season, week, userId],
  );

  const revealedByGame = new Map();
  for (const row of revealed) {
    if (!revealedByGame.has(row.game_id)) revealedByGame.set(row.game_id, []);
    revealedByGame.get(row.game_id).push(row);
  }

  let usedTeams = [];
  if (pool.pool_type === 'SURVIVOR') {
    const allPicks = await loadUserPicks(client, poolId, userId, pool.season);
    usedTeams = allPicks
      .filter((p) => p.week !== week)
      .map((p) => ({ team: p.selected_team, week: p.week }));
  }

  return {
    pool,
    membership,
    week,
    games: games.map((game) => ({
      ...game,
      my_pick: myPicksByGame.get(game.id) ?? null,
      other_picks: revealedByGame.get(game.id) ?? [],
    })),
    used_teams: usedTeams,
  };
}

function validateCommon(submissions, gamesById) {
  const seen = new Set();

  for (const sub of submissions) {
    const game = gamesById.get(sub.game_id);
    if (!game) {
      throw badRequest(`Game ${sub.game_id} is not part of this week`);
    }
    if (seen.has(sub.game_id)) {
      throw badRequest(`Duplicate pick submitted for game ${sub.game_id}`);
    }
    seen.add(sub.game_id);

    if (sub.selected_team !== game.home_team && sub.selected_team !== game.away_team) {
      throw badRequest(
        `"${sub.selected_team}" is not playing in ${game.away_team} @ ${game.home_team}`,
      );
    }
    if (game.locked) {
      throw badRequest(
        `${game.away_team} @ ${game.home_team} has already kicked off and is locked`,
      );
    }
  }
}

function validateConfidence(submissions, existingPicks, gameCount) {
  const submittedGames = new Set(submissions.map((s) => s.game_id));

  for (const sub of submissions) {
    if (sub.confidence_rank == null) {
      throw badRequest('Every pick in a confidence pool needs a confidence rank');
    }
    if (!Number.isInteger(sub.confidence_rank)
      || sub.confidence_rank < 1
      || sub.confidence_rank > gameCount) {
      throw badRequest(`Confidence ranks must be between 1 and ${gameCount}`);
    }
  }

  // Ranks must be unique across the whole week, including picks already saved
  // for games this submission does not touch.
  const byRank = new Map();
  const retained = existingPicks.filter((p) => !submittedGames.has(p.game_id));

  for (const pick of [...retained, ...submissions]) {
    const rank = pick.confidence_rank;
    if (rank == null) continue;
    if (byRank.has(rank)) {
      throw badRequest(`Confidence rank ${rank} is used more than once this week`);
    }
    byRank.set(rank, pick.game_id);
  }
}

function validateSurvivor({ submissions, existingThisWeek, allPicks, week, membership }) {
  if (membership.isEliminated) {
    throw forbidden('You have been eliminated from this pool');
  }
  if (submissions.length !== 1) {
    throw badRequest('Survivor pools take exactly one pick per week');
  }
  if (submissions[0].confidence_rank != null) {
    throw badRequest('Survivor pools do not use confidence ranks');
  }

  const locked = existingThisWeek.find((p) => p.locked);
  if (locked) {
    throw badRequest('Your pick for this week is already locked');
  }

  const used = allPicks.find(
    (p) => p.week !== week && p.selected_team === submissions[0].selected_team,
  );
  if (used) {
    throw badRequest(`You already used ${used.selected_team} in week ${used.week}`);
  }
}

export async function submitPicks({ poolId, userId, week, submissions }) {
  if (submissions.length === 0) throw badRequest('No picks submitted');

  const saved = await withTransaction(async (client) => {
    const { pool, membership } = await requireMembership(poolId, userId, client);
    assertPickPool(pool);

    const games = await loadWeekGames(client, pool.season, week);
    if (games.length === 0) {
      throw badRequest(`Week ${week} has no games in season ${pool.season}`);
    }
    const gamesById = new Map(games.map((g) => [g.id, g]));

    validateCommon(submissions, gamesById);

    const existingThisWeek = await loadUserPicks(client, poolId, userId, pool.season, week);

    if (pool.pool_type === 'CONFIDENCE') {
      validateConfidence(submissions, existingThisWeek, games.length);
    } else if (pool.pool_type === 'SURVIVOR') {
      const allPicks = await loadUserPicks(client, poolId, userId, pool.season);
      validateSurvivor({ submissions, existingThisWeek, allPicks, week, membership });

      // A survivor pick replaces the week's pick rather than adding to it.
      const stale = existingThisWeek
        .filter((p) => p.game_id !== submissions[0].game_id)
        .map((p) => p.game_id);
      if (stale.length > 0) {
        await client.query(
          `DELETE FROM picks
            WHERE pool_id = $1 AND user_id = $2 AND game_id = ANY($3::VARCHAR[])
              AND settled_at IS NULL`,
          [poolId, userId, stale],
        );
      }
    } else if (submissions.some((s) => s.confidence_rank != null)) {
      throw badRequest('Confidence ranks only apply to confidence pools');
    }

    const rows = [];
    for (const sub of submissions) {
      const { rows: upserted } = await client.query(
        `INSERT INTO picks (pool_id, user_id, game_id, selected_team,
                            confidence_rank, tiebreaker_points)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pool_id, user_id, game_id) DO UPDATE
            SET selected_team = EXCLUDED.selected_team,
                confidence_rank = EXCLUDED.confidence_rank,
                tiebreaker_points = COALESCE(EXCLUDED.tiebreaker_points,
                                             picks.tiebreaker_points),
                updated_at = CURRENT_TIMESTAMP
          WHERE picks.settled_at IS NULL
         RETURNING *`,
        [poolId, userId, sub.game_id, sub.selected_team,
          sub.confidence_rank ?? null, sub.tiebreaker_points ?? null],
      );
      if (upserted[0]) rows.push(upserted[0]);
    }

    return rows;
  });

  await cacheDel(leaderboardKey(poolId));
  return saved;
}
