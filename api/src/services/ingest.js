import { query } from '../db.js';
import { config, sharpEnabled } from '../config.js';
import { DEFAULT_LEAGUE, ingestWeeks, leagueOrThrow } from '../leagues.js';
import { fetchLines } from './sharp.js';

// Score ingestion from ESPN's public scoreboard endpoints (docs/data-sources.md).
// Ingested games are namespaced with an `espn:` id prefix so they never collide
// with seeded fixtures. ESPN event ids are unique across leagues, so the two
// slates share the table without colliding on the primary key.

function scoreboardUrl(league, { season, week, seasontype }) {
  const url = new URL(`${config.espnBase}/${league.espnPath}/scoreboard`);
  url.searchParams.set('dates', String(season));
  url.searchParams.set('seasontype', String(seasontype));
  url.searchParams.set('week', String(week));
  // Per-league extras: college needs groups=80 for the full FBS slate.
  for (const [key, value] of Object.entries(league.espnParams)) {
    url.searchParams.set(key, value);
  }
  return url;
}

const STATUS_BY_STATE = { pre: 'SCHEDULED', in: 'IN_PROGRESS', post: 'FINAL' };

// ESPN reports odds as a details string ("KC -3.5") plus a signed spread. Only
// the string says who is favoured, so resolve against the home abbreviation and
// normalise to our convention: spread is always the home team's line.
//
// The abbreviation class is deliberately wider than the letters the NFL uses.
// College abbreviations carry punctuation — `TA&M` (Texas A&M), `M-OH` (Miami
// (OH)), `W&M` — and a letters-only pattern fails to match them, which lands in
// the `return 0` below and posts a 39.5-point favourite as a pick'em. A wrong
// line is worse than no line, so this errs towards parsing.
// Exported for api/test/ingest.test.js — the parsing rules here are the only
// thing standing between a malformed odds string and a fabricated line.
export function homeSpread(odds, homeAbbrev) {
  if (!odds || typeof odds.details !== 'string') return 0;
  const match = odds.details.match(/^([A-Z0-9&.'-]{2,6})\s+([+-]?\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const [, abbrev, value] = match;
  const line = Number(value);
  if (!Number.isFinite(line)) return 0;
  return abbrev === homeAbbrev ? line : -line;
}

function toGameRow(event, { leagueId, season, week }) {
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
    league: leagueId,
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
      `INSERT INTO games (id, league, season, week, home_team, away_team,
                          kickoff_time, spread, total, home_score, away_score,
                          status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE
          SET week = EXCLUDED.week,
              kickoff_time = EXCLUDED.kickoff_time,
              spread = CASE WHEN $13 THEN games.spread ELSE EXCLUDED.spread END,
              total = CASE WHEN $13 THEN games.total
                           ELSE COALESCE(EXCLUDED.total, games.total) END,
              home_score = COALESCE(EXCLUDED.home_score, games.home_score),
              away_score = COALESCE(EXCLUDED.away_score, games.away_score),
              status = EXCLUDED.status,
              updated_at = CURRENT_TIMESTAMP`,
      [row.id, row.league, row.season, row.week, row.home_team, row.away_team,
        row.kickoff_time, row.spread, row.total, row.home_score, row.away_score,
        row.status, sharpOwnsLines],
    );
    count += 1;
  }
  return count;
}

// `week` is what ESPN is asked for; `storeAsWeek` is what the rows are filed
// under. They differ only for a postseason ESPN packs into a single week.
async function fetchWeek(league, season, { seasontype, week, storeAsWeek }) {
  const url = scoreboardUrl(league, { season, week, seasontype });
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(
      `ESPN responded ${response.status} for ${league.id} `
      + `seasontype ${seasontype} week ${week}`,
    );
  }
  const body = await response.json();
  return (body.events ?? [])
    .map((event) => toGameRow(event, {
      leagueId: league.id, season, week: storeAsWeek,
    }))
    .filter(Boolean);
}

/* ------------------------------------------------------- SharpAPI line feed */

// In the NFL both feeds spell a team the same way ("New England Patriots"), so
// a normalised exact match carries the join and a last-word nickname is a safe
// fallback for a rebrand.
//
// College breaks both halves of that. ESPN says "North Carolina Tar Heels"
// where SharpAPI says "North Carolina", and 230 teams share ten Bulldogs and
// nine Wildcats between them — so the nickname fallback is disabled per league
// (leagues.js) and the school name is matched on its own.
const normalizeTeam = (name) => String(name ?? '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const nickname = (name) => normalizeTeam(name).split(' ').pop();

// Spellings the two feeds genuinely disagree on, normalised on both sides.
// Keyed on the ESPN form because that is the schedule of record.
const TEAM_ALIASES = new Map([
  ['ole miss', 'mississippi'],
  ['uconn', 'connecticut'],
  ['miami oh', 'miami ohio'],
  ['nc state', 'north carolina state'],
  ['usc', 'southern california'],
  ['smu', 'southern methodist'],
  ['utsa', 'texas san antonio'],
  ['utep', 'texas el paso'],
  ['ucf', 'central florida'],
  ['fiu', 'florida international'],
  ['fau', 'florida atlantic'],
]);

const canonical = (name) => {
  const normal = normalizeTeam(name);
  return TEAM_ALIASES.get(normal) ?? normal;
};

// ESPN carries the nickname, SharpAPI usually does not, so the school-name
// prefix has to be recoverable from the long form. Nothing is stripped when the
// remainder would be empty — "Army" is the whole name, not a nickname.
function schoolName(name) {
  const words = canonical(name).split(' ');
  return words.length > 1 ? words.slice(0, -1).join(' ') : words.join(' ');
}

function pairKeys(league, away, home) {
  const keys = [`${canonical(away)}@${canonical(home)}`];
  if (league.nicknameFallback) {
    keys.push(`${nickname(away)}@${nickname(home)}`);
  } else {
    // College only: try the name with its nickname removed, which is the shape
    // SharpAPI publishes. Never the nickname on its own.
    keys.push(`${schoolName(away)}@${schoolName(home)}`);
  }
  return [...new Set(keys)];
}

export async function applySharpLines(league = DEFAULT_LEAGUE) {
  const leagueDef = leagueOrThrow(league);

  if (!sharpEnabled()) {
    return { league: leagueDef.id, skipped: 'SHARP_API_KEY is not set', updated: 0 };
  }
  if (!leagueDef.sharpPricing) {
    return {
      league: leagueDef.id,
      skipped: `SharpAPI does not price ${leagueDef.id} on this key — `
        + 'lines stay as ESPN supplied them',
      updated: 0,
    };
  }

  const feed = await fetchLines(leagueDef.sharpLeague);
  const toleranceMs = leagueDef.kickoffToleranceHours * 60 * 60 * 1000;

  const index = new Map();
  for (const line of feed.lines.values()) {
    for (const key of pairKeys(leagueDef, line.away_team, line.home_team)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(line);
    }
  }

  // Only games that have not kicked off: a locked game's line is frozen, and
  // bets already placed carry their own copy of the number regardless.
  const { rows: games } = await query(
    `SELECT id, home_team, away_team, kickoff_time, spread, total
       FROM games
      WHERE league = $1
        AND status = 'SCHEDULED' AND kickoff_time > CURRENT_TIMESTAMP`,
    [leagueDef.id],
  );

  const result = {
    league: leagueDef.id,
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
    for (const key of pairKeys(leagueDef, game.away_team, game.home_team)) {
      const candidates = index.get(key) ?? [];
      for (const candidate of candidates) {
        const delta = Math.abs(new Date(candidate.start_time).getTime() - kickoff);
        if (delta <= toleranceMs) {
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
async function seededGamesPresent(season, leagueId) {
  const { rows } = await query(
    `SELECT COUNT(*)::INT AS n FROM games
      WHERE season = $1 AND league = $2
        AND id NOT LIKE 'espn:%' AND id NOT LIKE 'sharp:%'`,
    [season, leagueId],
  );
  return rows[0].n > 0;
}

// The week list comes from the league, not from a caller-supplied count: the
// NFL is 18 regular weeks, college is 16 plus a postseason filed as week 17.
export async function ingestSeason(season, { league = DEFAULT_LEAGUE, force = false } = {}) {
  const leagueDef = leagueOrThrow(league);
  const result = {
    league: leagueDef.id, season, games_upserted: 0, weeks_ingested: 0, errors: [],
  };

  if (!force && await seededGamesPresent(season, leagueDef.id)) {
    result.skipped = `${leagueDef.id} season ${season} already holds seeded demo `
      + 'games. Ingesting real fixtures on top of them would mix synthetic and '
      + 'real games on the same week. Start from a clean volume '
      + '(scripts/reset-db.sh) or pass force.';
    return result;
  }

  for (const slate of ingestWeeks(leagueDef)) {
    try {
      const rows = await fetchWeek(leagueDef, season, slate);
      result.games_upserted += await upsertGames(rows);
      result.weeks_ingested += 1;
    } catch (err) {
      // One bad week should not abort the run.
      result.errors.push(`week ${slate.storeAsWeek}: ${err.message}`);
    }
  }

  return result;
}

// Every configured league, in order. Errors are collected per league so an
// ESPN outage on one does not cost the other its refresh.
export async function ingestConfiguredLeagues(season, options = {}) {
  const runs = [];
  for (const league of config.ingestLeagues) {
    runs.push(await ingestSeason(season, { ...options, league }));
  }
  return runs;
}
