import { query } from '../db.js';
import { DEFAULT_LEAGUE } from '../leagues.js';

// Weeks only mean something within a league — the NFL's week 1 and college's
// week 1 are different Septembers' worth of football — so every read here is
// scoped by league as well as season.

export async function listGames(league, season, week) {
  const { rows } = await query(
    `SELECT id, league, season, week, home_team, away_team,
            home_team_abbr, away_team_abbr, kickoff_time,
            spread, total, home_score, away_score, status,
            (kickoff_time <= CURRENT_TIMESTAMP) AS locked
       FROM games
      WHERE league = $1 AND season = $2 AND week = $3
      ORDER BY kickoff_time, id`,
    [league, season, week],
  );
  return rows;
}

export async function listWeeks(league, season) {
  const { rows } = await query(
    `SELECT week,
            COUNT(*)::INT AS game_count,
            COUNT(*) FILTER (WHERE status = 'FINAL')::INT AS final_count,
            MIN(kickoff_time) AS first_kickoff,
            (MIN(kickoff_time) <= CURRENT_TIMESTAMP) AS started
       FROM games
      WHERE league = $1 AND season = $2
      GROUP BY week
      ORDER BY week`,
    [league, season],
  );
  return rows;
}

export async function listSeasons(league = DEFAULT_LEAGUE) {
  const { rows } = await query(
    'SELECT DISTINCT season FROM games WHERE league = $1 ORDER BY season DESC',
    [league],
  );
  return rows.map((r) => r.season);
}

// The week users are currently picking: the earliest week that still has a game
// left to kick off, falling back to the last week of the season once it is over.
//
// Takes an optional client so a caller inside a transaction reads the same
// snapshot as the rest of its work — placeBet decides whether a week is open
// for betting from this, and must not see a week roll over mid-transaction.
export async function getCurrentWeek(league, season, client = null) {
  const run = client ? (...args) => client.query(...args) : query;
  const { rows } = await run(
    `SELECT COALESCE(
              (SELECT MIN(week) FROM games
                WHERE league = $1 AND season = $2
                  AND kickoff_time > CURRENT_TIMESTAMP),
              (SELECT MAX(week) FROM games WHERE league = $1 AND season = $2)
            )::INT AS week`,
    [league, season],
  );
  return rows[0]?.week ?? null;
}

// Whether a week may be bet. Split out because two callers ask it — placeBet
// enforces it, getBoard reports it to the UI — and a board that disagreed with
// the enforcement would offer a bet the API then refuses.
//
// A null currentWeek means the league has no games loaded at all. Nothing is
// bettable in that state anyway (every game query comes back empty), so this
// stays open rather than inventing a rule for an empty board.
export function weekIsOpen(week, currentWeek) {
  if (currentWeek == null) return true;
  return week <= currentWeek;
}
