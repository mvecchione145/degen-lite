import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';
import { getCurrentWeek, listGames, listSeasons, listWeeks } from '../services/games.js';

const router = Router();

const seasonQuery = z.object({
  season: z.coerce.number().int().min(1900).max(2200).optional(),
  week: z.coerce.number().int().min(1).max(30).optional(),
});

async function resolveSeason(requested) {
  if (requested) return requested;
  const seasons = await listSeasons();
  return seasons[0] ?? new Date().getFullYear();
}

router.get('/seasons', requireAuth, asyncHandler(async (req, res) => {
  res.json({ seasons: await listSeasons() });
}));

router.get('/weeks', requireAuth, asyncHandler(async (req, res) => {
  const { season } = seasonQuery.parse(req.query);
  const resolved = await resolveSeason(season);
  res.json({
    season: resolved,
    current_week: await getCurrentWeek(resolved),
    weeks: await listWeeks(resolved),
  });
}));

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { season, week } = seasonQuery.parse(req.query);
  const resolved = await resolveSeason(season);
  const resolvedWeek = week ?? (await getCurrentWeek(resolved));
  res.json({
    season: resolved,
    week: resolvedWeek,
    games: resolvedWeek ? await listGames(resolved, resolvedWeek) : [],
  });
}));

export default router;
