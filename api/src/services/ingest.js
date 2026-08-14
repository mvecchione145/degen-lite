import { query } from '../db.js';
import { config, sharpEnabled } from '../config.js';
import { fetchLines } from './sharp.js';

// Score ingestion from ESPN's public scoreboard endpoints (docs/data-sources.md).
// Off by default: the seeded demo season is self-sufficient and needs no network.
// Ingested games are namespaced with an `espn:` id prefix so they never collide
// with seeded fixtures.

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const STATUS_BY_STATE = { pre: 'SCHEDULED', in: 'IN_PROGRESS', post: 'FINAL' };

// ESPN reports odds as a details string ("KC -3.5") plus a signed spread. Only
// the string says who is favoured, so resolve against the home abbreviation and
// normalise to our convention: spread is always the home team's line.
function homeSpread(odds, homeAbbrev) {
  if (!odds || typeof odds.details !== 'string') return 0;
  const match = odds.details.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const [, abbrev, value] = match;
  const line = Number(value);
  if (!Number.isFinite(line)) return 0;
  return abbrev === homeAbbrev ? line : -line;
}

function toGameRow(event, season, week) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away || !event.id || !event.date) return null;

  const state = competition?.status?.type?.state ?? event?.status?.type?.state;
  const status = STATUS_BY_STATE[state] ?? 'SCHEDULED';
  const parseScore = (c) => {
    const n = Number(c.score);
    return Number.isFinite(n) ? n : null;
  };

  const overUnder = Number(competition?.odds?.[0]?.overUnder);

  return {
    id: `espn:${event.id}`,
    season,
    week,
    home_team: home.team?.displayName ?? 'Home',
    away_team: away.team?.displayName ?? 'Away',
    kickoff_time: new Date(event.date).toISOString(),
    spread: homeSpread(competition?.odds?.[0], home.team?.abbreviation),
    // No posted total means the total market is simply not offered on this game.
    total: Number.isFinite(overUnder) ? overUnder : null,
    // Never overwrite real scores with nulls for a game that has not started.
    home_score: status === 'SCHEDULED' ? null : parseScore(home),
    away_score: status === 'SCHEDULED' ? null : parseScore(away),
    status,
  };
}

async function upsertGames(rows) {
  // ESPN carries odds too, but when a SharpAPI key is configured SharpAPI owns
  // the lines. Without this the two feeds overwrite each other on alternating
  // cron ticks and a game's spread visibly flaps.
  const sharpOwnsLines = sharpEnabled();

  let count = 0;
  for (const row of rows) {
    await query(
      `INSERT INTO games (id, season, week, home_team, away_team, kickoff_time,
                          spread, total, home_score, away_score, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE
          SET kickoff_time = EXCLUDED.kickoff_time,
              spread = CASE WHEN $12 THEN games.spread ELSE EXCLUDED.spread END,
              total = CASE WHEN $12 THEN games.total
                           ELSE COALESCE(EXCLUDED.total, games.total) END,
              home_score = COALESCE(EXCLUDED.home_score, games.home_score),
              away_score = COALESCE(EXCLUDED.away_score, games.away_score),
              status = EXCLUDED.status,
              updated_at = CURRENT_TIMESTAMP`,
      [row.id, row.season, row.week, row.home_team, row.away_team,
        row.kickoff_time, row.spread, row.total, row.home_score, row.away_score,
        row.status, sharpOwnsLines],
    );
    count += 1;
  }
  return count;
}

async function fetchWeek(season, week) {
  const url = `${SCOREBOARD_URL}?dates=${season}&seasontype=2&week=${week}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`ESPN responded ${response.status} for week ${week}`);
  }
  const body = await response.json();
  return (body.events ?? [])
    .map((event) => toGameRow(event, season, week))
    .filter(Boolean);
}

/* ------------------------------------------------------- SharpAPI line feed */

// Team names arrive in the same "New England Patriots" shape from both ESPN and
// SharpAPI, so a normalised exact match carries the join. The nickname fallback
// covers a relocation or rebrand naming one side differently.
const normalizeTeam = (name) => String(name ?? '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const nickname = (name) => normalizeTeam(name).split(' ').pop();

const pairKeys = (away, home) => [
  `${normalizeTeam(away)}@${normalizeTeam(home)}`,
  `${nickname(away)}@${nickname(home)}`,
];

// The same fixture recurs across a season, so a name match alone is ambiguous.
// Kickoffs must also land within a couple of days of each other.
const KICKOFF_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;

export async function applySharpLines(league = config.sharp.league) {
  if (!sharpEnabled()) {
    return { skipped: 'SHARP_API_KEY is not set', updated: 0 };
  }

  const feed = await fetchLines(league);

  const index = new Map();
  for (const line of feed.lines.values()) {
    for (const key of pairKeys(line.away_team, line.home_team)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(line);
    }
  }

  // Only games that have not kicked off: a locked game's line is frozen, and
  // bets already placed carry their own copy of the number regardless.
  const { rows: games } = await query(
    `SELECT id, home_team, away_team, kickoff_time, spread, total
       FROM games
      WHERE status = 'SCHEDULED' AND kickoff_time > CURRENT_TIMESTAMP`,
  );

  const result = {
    league,
    events_priced: feed.lines.size,
    rows_fetched: feed.fetched,
    served_from_cache: feed.served_from_cache,
    truncated: feed.truncated,
    games_considered: games.length,
    updated: 0,
    unmatched: 0,
  };

  for (const game of games) {
    const kickoff = new Date(game.kickoff_time).getTime();

    let match = null;
    for (const key of pairKeys(game.away_team, game.home_team)) {
      const candidates = index.get(key) ?? [];
      for (const candidate of candidates) {
        const delta = Math.abs(new Date(candidate.start_time).getTime() - kickoff);
        if (delta <= KICKOFF_TOLERANCE_MS) {
          match = candidate;
          break;
        }
      }
      if (match) break;
    }

    if (!match) {
      result.unmatched += 1;
      continue;
    }

    // COALESCE keeps an existing number when the feed has no line for that
    // market, rather than blanking a market members can currently bet.
    const { rowCount } = await query(
      `UPDATE games
          SET spread = COALESCE($2::NUMERIC, spread),
              total = COALESCE($3::NUMERIC, total),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND (spread IS DISTINCT FROM COALESCE($2::NUMERIC, spread)
               OR total IS DISTINCT FROM COALESCE($3::NUMERIC, total))`,
      [game.id, match.spread, match.total],
    );
    result.updated += rowCount;
  }

  return result;
}

// The demo seed and a real ESPN season both land in the same `season` with
// overlapping week numbers, so ingesting on top of seeded data produces a board
// that mixes synthetic fixtures with real ones. Refuse rather than corrupt the
// demo; a fresh volume is the intended starting point for live data.
async function seededGamesPresent(season) {
  const { rows } = await query(
    `SELECT COUNT(*)::INT AS n FROM games
      WHERE season = $1 AND id NOT LIKE 'espn:%' AND id NOT LIKE 'sharp:%'`,
    [season],
  );
  return rows[0].n > 0;
}

export async function ingestSeason(season, { weeks = 18, force = false } = {}) {
  const result = { season, games_upserted: 0, weeks_ingested: 0, errors: [] };

  if (!force && await seededGamesPresent(season)) {
    result.skipped = `Season ${season} already holds seeded demo games. `
      + 'Ingesting real fixtures on top of them would mix synthetic and real '
      + 'games on the same week. Start from a clean volume '
      + '(docker compose down -v) or pass force.';
    return result;
  }

  for (let week = 1; week <= weeks; week += 1) {
    try {
      const rows = await fetchWeek(season, week);
      result.games_upserted += await upsertGames(rows);
      result.weeks_ingested += 1;
    } catch (err) {
      // One bad week should not abort the run.
      result.errors.push(`week ${week}: ${err.message}`);
    }
  }

  return result;
}
