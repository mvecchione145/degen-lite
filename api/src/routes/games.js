import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http.js';
import { requireAuth } from '../auth.js';
import { getCurrentWeek, listGames, listSeasons, listWeeks } from '../services/games.js';
import { DEFAULT_LEAGUE, LEAGUE_IDS } from '../leagues.js';

const router = Router();

// Every read in services/games.js is scoped by league as well as season — a
// week number means nothing on its own. Absent, the league is the default one.
const seasonQuery = z.object({
  league: z.enum(LEAGUE_IDS).optional().default(DEFAULT_LEAGUE),
  season: z.coerce.number().int().min(1900).max(2200).optional(),
  week: z.coerce.number().int().min(1).max(30).optional(),
});

async function resolveSeason(league, requested) {
  if (requested) return requested;
  const seasons = await listSeasons(league);
  return seasons[0] ?? new Date().getFullYear();
}

router.get('/seasons', requireAuth, asyncHandler(async (req, res) => {
  res.json({ seasons: await listSeasons() });
}));

router.get('/weeks', requireAuth, asyncHandler(async (req, res) => {
  const { league, season } = seasonQuery.parse(req.query);
  const resolved = await resolveSeason(league, season);
  res.json({
    league,
    season: resolved,
    current_week: await getCurrentWeek(league, resolved),
    weeks: await listWeeks(league, resolved),
  });
}));

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { league, season, week } = seasonQuery.parse(req.query);
  const resolved = await resolveSeason(league, season);
  const resolvedWeek = week ?? (await getCurrentWeek(league, resolved));
  res.json({
    league,
    season: resolved,
    week: resolvedWeek,
    games: resolvedWeek ? await listGames(league, resolved, resolvedWeek) : [],
  });
}));

export default router;
