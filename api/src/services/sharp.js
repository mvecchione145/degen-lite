import { config, sharpEnabled } from '../config.js';
import { withCache } from '../cache.js';

// SharpAPI (https://sharpapi.io) — real-time odds aggregation. Supplies the
// spread and total for each game.
//
// Not to be confused with sharpapi.com, an unrelated AI workflow API with a
// near-identical name.
//
// What the free tier actually gives us, confirmed against a live key:
//   features            odds + schedule, but NO scores
//   rate limit          12 requests/minute
//   books               2 (draftkings, fanduel)
//   delay               60 seconds
//
// Because there are no scores and no week numbers, SharpAPI cannot be the
// schedule of record. ESPN stays authoritative for season, week, status, and
// final scores; SharpAPI only prices the games ESPN already gave us. See
// docs/data-sources.md.

const SPREAD_MARKET = 'point_spread';
const TOTAL_MARKET = 'total_points';

/* ------------------------------------------------------------ rate limiting */

// One worker process, one queue: requests are simply spaced out far enough to
// stay under the per-minute allowance.
let nextSlot = 0;

async function throttle() {
  const spacingMs = Math.ceil(60_000 / Math.max(1, config.sharp.requestsPerMinute));
  const now = Date.now();
  const runAt = Math.max(now, nextSlot);
  nextSlot = runAt + spacingMs;
  if (runAt > now) {
    await new Promise((resolve) => setTimeout(resolve, runAt - now));
  }
}

/* -------------------------------------------------------------- http client */

class SharpError extends Error {}

async function request(path, params = {}) {
  if (!sharpEnabled()) throw new SharpError('SHARP_API_KEY is not set');

  const url = new URL(`${config.sharp.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  // Cache on the full request, so pagination pages are cached independently.
  const cacheKey = `sharp:v1:${path}?${url.searchParams.toString()}`;

  const { value, cached } = await withCache(
    cacheKey,
    config.sharp.cacheTtlSeconds,
    async () => {
      await throttle();
      const response = await fetch(url, {
        headers: {
          'X-API-Key': config.sharp.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        // Include the upstream message: SharpAPI explains itself in the body,
        // and a bare status code is not enough to act on.
        const detail = await response.text().catch(() => '');
        let message = detail.slice(0, 300);
        try {
          message = JSON.parse(detail).error?.message ?? message;
        } catch {
          /* not JSON — keep the raw snippet */
        }
        if (response.status === 429) {
          throw new SharpError(`rate limited by SharpAPI: ${message}`);
        }
        if (response.status === 401 || response.status === 403) {
          throw new SharpError(`SharpAPI rejected the key (${response.status}): ${message}`);
        }
        throw new SharpError(
          `SharpAPI responded ${response.status} for ${path}?${url.searchParams} — ${message}`,
        );
      }

      const body = await response.json();
      if (body.error) {
        throw new SharpError(body.error.message || 'SharpAPI returned an error');
      }
      return body;
    },
  );

  return { body: value, cached };
}

// Upstream caps `limit` at 200 and refuses an `offset` above 500, directing
// deeper pagination to the opaque cursor. The cursor is the better instrument
// anyway: it is stable while rows shift between pages on a live feed, where a
// numeric offset would skip or repeat rows.
const MAX_OFFSET = 500;

async function fetchAll(path, params, { pageSize = 200, maxPages = 8 } = {}) {
  const rows = [];
  let cursor = null;
  let offset = 0;
  let cachedPages = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const pageParams = cursor
      ? { ...params, limit: pageSize, cursor }
      : { ...params, limit: pageSize, offset };

    const { body, cached } = await request(path, pageParams);
    if (cached) cachedPages += 1;
    rows.push(...(body.data ?? []));

    if (!body.pagination?.has_more) break;

    cursor = body.pagination.next_cursor ?? null;
    if (!cursor) {
      offset = body.pagination.next_offset ?? offset + pageSize;
      if (offset > MAX_OFFSET) {
        truncated = true;
        break;
      }
    }
    if (page === maxPages - 1) truncated = true;
  }

  return { rows, cachedPages, truncated };
}

/* ----------------------------------------------------------------- mapping */

// Prefer the earliest book in SHARP_BOOKS that priced this game, so a line does
// not flap between books from one refresh to the next.
function preferredBook(rows) {
  for (const book of config.sharp.books) {
    if (rows.some((r) => r.sportsbook === book)) return book;
  }
  return rows[0]?.sportsbook ?? null;
}

// `is_main_line` is unreliable — SharpAPI returns false on rows that are plainly
// the main line — so it is used as a preference, not a filter. Failing that,
// take the line the book quotes most often, which is the main one.
function chooseLine(rows) {
  const active = rows.filter((r) => r.is_active !== false && r.line !== null);
  if (active.length === 0) return null;

  const main = active.filter((r) => r.is_main_line);
  const pool = main.length > 0 ? main : active;

  const counts = new Map();
  for (const row of pool) {
    counts.set(row.line, (counts.get(row.line) ?? 0) + 1);
  }

  let best = null;
  let bestCount = -1;
  for (const [line, count] of counts) {
    if (count > bestCount) {
      best = line;
      bestCount = count;
    }
  }
  return best;
}

function groupByEvent(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }
  return byEvent;
}

// SharpAPI quotes a spread against whichever side the row describes, so an away
// row of +3.5 is a home line of -3.5. games.spread is always the home line.
function homeSpreadFrom(rows, book) {
  const booked = rows.filter((r) => r.sportsbook === book);

  const homeRows = booked.filter((r) => (r.team_side ?? r.selection_type) === 'home');
  const homeLine = chooseLine(homeRows);
  if (homeLine !== null) return homeLine;

  const awayRows = booked.filter((r) => (r.team_side ?? r.selection_type) === 'away');
  const awayLine = chooseLine(awayRows);
  return awayLine === null ? null : -awayLine;
}

function totalFrom(rows, book) {
  const overRows = rows.filter(
    (r) => r.sportsbook === book && (r.selection_type ?? '').toLowerCase() === 'over',
  );
  const over = chooseLine(overRows);
  if (over !== null) return over;

  const underRows = rows.filter(
    (r) => r.sportsbook === book && (r.selection_type ?? '').toLowerCase() === 'under',
  );
  return chooseLine(underRows);
}

/* ------------------------------------------------------------------- public */

// Fetches current main lines for a league, keyed by SharpAPI event id.
export async function fetchLines(league = config.sharp.league) {
  const [spreads, totals] = await Promise.all([
    fetchAll('/odds', { league, market: SPREAD_MARKET }),
    fetchAll('/odds', { league, market: TOTAL_MARKET }),
  ]);

  const spreadsByEvent = groupByEvent(spreads.rows);
  const totalsByEvent = groupByEvent(totals.rows);

  const lines = new Map();
  for (const eventId of new Set([...spreadsByEvent.keys(), ...totalsByEvent.keys()])) {
    const spreadRows = spreadsByEvent.get(eventId) ?? [];
    const totalRows = totalsByEvent.get(eventId) ?? [];
    const sample = spreadRows[0] ?? totalRows[0];

    const spread = spreadRows.length
      ? homeSpreadFrom(spreadRows, preferredBook(spreadRows)) : null;
    const total = totalRows.length
      ? totalFrom(totalRows, preferredBook(totalRows)) : null;

    if (spread === null && total === null) continue;

    lines.set(eventId, {
      event_id: eventId,
      home_team: sample.home_team,
      away_team: sample.away_team,
      start_time: sample.event_start_time,
      spread,
      total,
      book: preferredBook(spreadRows.length ? spreadRows : totalRows),
    });
  }

  return {
    league,
    lines,
    fetched: spreads.rows.length + totals.rows.length,
    served_from_cache: spreads.cachedPages + totals.cachedPages,
    // Surfaced rather than swallowed: a truncated walk means some games simply
    // never got a line, which would otherwise look like a matching failure.
    truncated: spreads.truncated || totals.truncated,
  };
}

// Confirms the key works and reports what the tier allows.
export async function fetchAccount() {
  const { body } = await request('/account');
  return body.data;
}
