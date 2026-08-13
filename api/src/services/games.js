import { query } from '../db.js';

export async function listGames(season, week) {
  const { rows } = await query(
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

export async function listWeeks(season) {
  const { rows } = await query(
    `SELECT week,
            COUNT(*)::INT AS game_count,
            COUNT(*) FILTER (WHERE status = 'FINAL')::INT AS final_count,
            MIN(kickoff_time) AS first_kickoff,
            (MIN(kickoff_time) <= CURRENT_TIMESTAMP) AS started
       FROM games
      WHERE season = $1
      GROUP BY week
      ORDER BY week`,
    [season],
  );
  return rows;
}

export async function listSeasons() {
  const { rows } = await query(
    'SELECT DISTINCT season FROM games ORDER BY season DESC',
  );
  return rows.map((r) => r.season);
}

// The week users are currently picking: the earliest week that still has a game
// left to kick off, falling back to the last week of the season once it is over.
export async function getCurrentWeek(season) {
  const { rows } = await query(
    `SELECT COALESCE(
              (SELECT MIN(week) FROM games
                WHERE season = $1 AND kickoff_time > CURRENT_TIMESTAMP),
              (SELECT MAX(week) FROM games WHERE season = $1)
            )::INT AS week`,
    [season],
  );
  return rows[0]?.week ?? null;
}
