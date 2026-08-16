import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, badRequest } from '../http.js';
import { requireAuth } from '../auth.js';
import { config, sharpEnabled } from '../config.js';
import { abandonGame, runSettlement } from '../services/settlement.js';
import { applySharpLines, ingestSeason } from '../services/ingest.js';
import { fetchAccount } from '../services/sharp.js';
import { getCurrentWeek, listSeasons } from '../services/games.js';
import { DEFAULT_LEAGUE, LEAGUE_IDS } from '../leagues.js';
import { cacheDel, leaderboardKey } from '../cache.js';

// Local development conveniences. Gated behind DEV_TOOLS because
// /simulate fabricates results and /settle bypasses the worker's schedule.
const router = Router();
router.use(requireAuth);

const simulateSchema = z.object({
  league: z.enum(LEAGUE_IDS).optional().default(DEFAULT_LEAGUE),
  season: z.coerce.number().int().min(1900).max(2200).optional(),
  week: z.coerce.number().int().min(1).max(30).optional(),
  // Explicit scores make settlement deterministic, which is what lets the
  // smoke test assert exact win / loss / push outcomes and payout arithmetic.
  // Omit them for random but plausible results.
  home_score: z.coerce.number().int().min(0).max(200).optional(),
  away_score: z.coerce.number().int().min(0).max(200).optional(),
});

router.post('/settle', asyncHandler(async (req, res) => {
  res.json(await runSettlement());
}));

// Force a week to FINAL with plausible scores so settlement, leaderboards, and
// survivor eliminations can be demoed without waiting for real kickoffs.
router.post('/simulate', asyncHandler(async (req, res) => {
  const body = simulateSchema.parse(req.body ?? {});
  const season = body.season ?? (await listSeasons(body.league))[0];
  if (!season) throw badRequest('No seasons are loaded');
  const week = body.week ?? (await getCurrentWeek(body.league, season));
  if (!week) throw badRequest('No week to simulate');

  const explicit = body.home_score !== undefined && body.away_score !== undefined;

  const { rows } = await query(
    `UPDATE games
        SET home_score = COALESCE($3::INT, 13 + (floor(random() * 22))::INT),
            away_score = COALESCE($4::INT, 13 + (floor(random() * 22))::INT),
            status = 'FINAL',
            kickoff_time = LEAST(kickoff_time, CURRENT_TIMESTAMP - INTERVAL '3 hours'),
            updated_at = CURRENT_TIMESTAMP
      WHERE league = $5 AND season = $1 AND week = $2
        AND status NOT IN ('FINAL', 'VOID')
      RETURNING id`,
    [season, week, body.home_score ?? null, body.away_score ?? null, body.league],
  );

  // A random tie would push every bet and pick on that game; nudge one score
  // instead. Scoped to the games this call finalized, and skipped when the
  // caller asked for a specific scoreline.
  if (!explicit) {
    await query(
      `UPDATE games SET home_score = home_score + 3
        WHERE id = ANY($1::VARCHAR[]) AND home_score = away_score`,
      [rows.map((r) => r.id)],
    );
  }

  const settlement = await runSettlement();
  res.json({ season, week, games_finalized: rows.length, settlement });
}));

// Marks a game as never having officially concluded. Real void detection comes
// from the data feed reporting a cancellation; the synthetic season has no such
// concept, so this exists to make the void path exercisable before a live odds
// feed is wired in.
router.post('/abandon', asyncHandler(async (req, res) => {
  const { game_id: gameId } = z.object({ game_id: z.string().min(1).max(100) })
    .parse(req.body ?? {});

  const abandoned = await abandonGame(gameId);
  if (!abandoned) throw badRequest(`Game ${gameId} is unknown or already void`);

  res.json({ game_id: gameId, settlement: await runSettlement() });
}));

// Pulls current spreads and totals from SharpAPI onto every game that has not
// kicked off. Safe to call repeatedly — responses are cached in Redis, so a
// rapid second call costs no rate limit.
router.post('/odds', asyncHandler(async (req, res) => {
  if (!sharpEnabled()) {
    throw badRequest(
      'SHARP_API_KEY is not set. Start the stack with ./scripts/compose.sh to '
      + 'inject it from 1Password.',
    );
  }
  // Our league id ('NFL' / 'NCAAF'), not SharpAPI's slug — the mapping between
  // the two lives in leagues.js.
  const league = z.enum(LEAGUE_IDS).optional().default(DEFAULT_LEAGUE)
    .parse(req.body?.league || undefined);

  res.json(await applySharpLines(league));
}));

// Reports what the configured key is entitled to, without revealing the key.
router.get('/odds/account', asyncHandler(async (req, res) => {
  if (!sharpEnabled()) throw badRequest('SHARP_API_KEY is not set');
  res.json(await fetchAccount());
}));

router.post('/ingest', asyncHandler(async (req, res) => {
  const body = z.object({
    league: z.enum(LEAGUE_IDS).optional().default(DEFAULT_LEAGUE),
    season: z.coerce.number().int().min(1900).max(2200).optional(),
    force: z.boolean().optional(),
  }).parse(req.body ?? {});

  const season = body.season ?? config.ingestSeason;
  const result = await ingestSeason(season, {
    league: body.league, force: body.force ?? false,
  });
  if (result.skipped) return res.status(409).json(result);

  const settlement = await runSettlement();
  return res.json({ ...result, settlement });
}));

// Rebuild every leaderboard from scratch on the next read.
router.post('/flush-cache', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id FROM pools');
  await cacheDel(...rows.map((r) => leaderboardKey(r.id)));
  res.json({ flushed: rows.length });
}));

export default router;
