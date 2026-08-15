import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFoundError } from '../http.js';
import { requireAuth } from '../auth.js';
import { config, currentFootballSeason } from '../config.js';
import { DEFAULT_LEAGUE, LEAGUE_IDS } from '../leagues.js';
import {
  createPool,
  joinPoolByCode,
  listMembers,
  listPoolsForUser,
  requireMembership,
} from '../services/pools.js';
import { getLeaderboard } from '../services/leaderboard.js';
import { getWeekView, submitPicks } from '../services/picks.js';
import {
  assertPoolLeague, getBoard, listBets, listPoolBets, placeBet, rebuy,
} from '../services/bets.js';
import { getBalanceSummary, listLedger } from '../services/ledger.js';
import { getCurrentWeek, listSeasons, listWeeks } from '../services/games.js';

const router = Router();
router.use(requireAuth);

// Every :poolId lands in a UUID column. Without this a non-UUID path segment
// reaches Postgres and fails the cast, turning a wrong URL into a 500.
router.param('poolId', (req, res, next, value) => {
  if (!z.string().uuid().safeParse(value).success) {
    next(notFoundError('Pool not found'));
    return;
  }
  next();
});

// Money carries at most two decimal places everywhere in the system.
const twoDecimals = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const money = (min) => z.number().min(min).max(1_000_000_000)
  .refine(twoDecimals, 'At most two decimal places');

const LEGACY_TYPES = ['PICKEM', 'CONFIDENCE', 'SURVIVOR'];

const createSchema = z.object({
  name: z.string().trim().min(3).max(100),
  pool_type: z.enum(['SPREAD_SHARKS', ...LEGACY_TYPES]).optional().default('SPREAD_SHARKS'),
  use_spreads: z.boolean().optional().default(false),
  // The leagues a pool plays. Fixed for its life: every board, week list and
  // stipend is scoped by them. Boards never merge two leagues' weeks — the
  // board is requested one league at a time.
  leagues: z.array(z.enum(LEAGUE_IDS)).min(1).max(LEAGUE_IDS.length)
    .optional().default([DEFAULT_LEAGUE])
    // Deduplicated, and ordered so the first entry is a stable anchor: it is
    // the league whose week drives weekly stipends.
    .transform((ls) => LEAGUE_IDS.filter((id) => ls.includes(id))),
  season: z.coerce.number().int().min(1900).max(2200).optional(),

  // Wager settings. A null limit means no limit.
  starting_balance: money(1).optional().default(20000),
  // The ceiling on a single wager. Null means no ceiling.
  max_bet: money(1).nullish().default(5500),
  min_bet: money(1).nullish().default(null),
  bust_policy: z.enum(['ELIMINATE', 'TOPUP', 'REBUY']).optional().default('ELIMINATE'),
  stipend_amount: money(1).nullish().default(null),
  rebuy_limit: z.number().int().min(0).max(100).nullish().default(null),
  ends_at: z.string().datetime().nullish().default(null),
});

const joinSchema = z.object({
  invite_code: z.string().trim().min(4).max(10),
});

const betSchema = z.object({
  game_id: z.string().min(1).max(100),
  market: z.enum(['SPREAD', 'TOTAL']),
  selection: z.enum(['HOME', 'AWAY', 'OVER', 'UNDER']),
  stake: money(1),
});

const picksSchema = z.object({
  week: z.coerce.number().int().min(1).max(30),
  picks: z.array(z.object({
    game_id: z.string().min(1).max(100),
    selected_team: z.string().min(1).max(50),
    confidence_rank: z.number().int().min(1).max(30).nullish(),
    tiebreaker_points: z.number().int().min(0).max(200).nullish(),
  })).min(1).max(40),
});

const weekParam = z.coerce.number().int().min(1).max(30);

// Page size is capped so a member cannot ask for the whole season in one
// request. Offset pagination is enough here: bets are only ever appended, so a
// page boundary shifts by however many were placed while the table was open.
const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json({ pools: await listPoolsForUser(req.user.id) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);

  if (LEGACY_TYPES.includes(body.pool_type) && !config.legacyPoolModes) {
    throw badRequest(
      `${body.pool_type} pools are no longer offered. `
      + 'Set LEGACY_POOL_MODES=true to re-enable the pick-based modes.',
    );
  }

  // Fall back to the current season rather than failing: a pool can legitimately
  // be created before the worker has finished pulling the schedule.
  const seasons = await listSeasons(body.leagues[0]);
  const season = body.season ?? seasons[0] ?? currentFootballSeason();

  if (body.pool_type === 'SURVIVOR' && body.use_spreads) {
    throw badRequest('Survivor pools are always straight up');
  }
  if (body.bust_policy === 'TOPUP' && body.stipend_amount == null) {
    throw badRequest('A weekly top-up pool needs a stipend amount');
  }
  if (body.min_bet != null && body.max_bet != null
      && body.min_bet > body.max_bet) {
    throw badRequest('The minimum bet cannot exceed the maximum bet');
  }
  if (body.ends_at && new Date(body.ends_at) <= new Date()) {
    throw badRequest('The end date must be in the future');
  }

  const pool = await createPool({
    commissionerId: req.user.id,
    name: body.name,
    poolType: body.pool_type,
    useSpreads: body.use_spreads,
    leagues: body.leagues,
    season,
    startingBalance: body.starting_balance,
    maxBet: body.max_bet,
    minBet: body.min_bet,
    bustPolicy: body.bust_policy,
    stipendAmount: body.stipend_amount,
    // A rebuy pool needs a limit; one per season unless told otherwise.
    rebuyLimit: body.bust_policy === 'REBUY' ? (body.rebuy_limit ?? 1) : body.rebuy_limit,
    endsAt: body.ends_at,
  });

  res.status(201).json({ pool });
}));

router.post('/join', asyncHandler(async (req, res) => {
  const { invite_code: inviteCode } = joinSchema.parse(req.body);
  res.json({ pool: await joinPoolByCode(req.user.id, inviteCode) });
}));

router.get('/:poolId', asyncHandler(async (req, res) => {
  const { pool, membership } = await requireMembership(req.params.poolId, req.user.id);
  res.json({
    pool,
    membership,
    is_member: Boolean(membership),
    is_commissioner: pool.commissioner_id === req.user.id,
    members: await listMembers(pool.id),
    // Per league, because a pool can play more than one and their weeks are
    // different weekends. The anchor league's values are repeated at the top
    // level so a single-league client needs no changes.
    current_week: await getCurrentWeek(pool.leagues[0], pool.season),
    weeks: await listWeeks(pool.leagues[0], pool.season),
    by_league: Object.fromEntries(await Promise.all(pool.leagues.map(
      async (league) => [league, {
        current_week: await getCurrentWeek(league, pool.season),
        weeks: await listWeeks(league, pool.season),
      }],
    ))),
    balance: membership && pool.pool_type === 'SPREAD_SHARKS'
      ? await getBalanceSummary(pool, req.user.id)
      : null,
  });
}));

router.get('/:poolId/leaderboard', asyncHandler(async (req, res) => {
  const { pool } = await requireMembership(req.params.poolId, req.user.id);
  res.json(await getLeaderboard(pool));
}));

/* ------------------------------------------------------------ Spread Sharks */

router.get('/:poolId/board', asyncHandler(async (req, res) => {
  const { pool } = await requireMembership(req.params.poolId, req.user.id);
  const league = assertPoolLeague(
    pool,
    z.enum(LEAGUE_IDS).optional().parse(req.query.league || undefined) ?? null,
  );
  const week = req.query.week
    ? weekParam.parse(req.query.week)
    : await getCurrentWeek(league, pool.season);
  res.json(await getBoard({
    poolId: pool.id, userId: req.user.id, league, week,
  }));
}));

router.post('/:poolId/bets', asyncHandler(async (req, res) => {
  const body = betSchema.parse(req.body);
  const bet = await placeBet({
    poolId: req.params.poolId,
    userId: req.user.id,
    gameId: body.game_id,
    market: body.market,
    selection: body.selection,
    stake: body.stake,
  });
  res.status(201).json({ bet });
}));

router.get('/:poolId/bets', asyncHandler(async (req, res) => {
  const status = z.enum(['PENDING', 'WON', 'LOST', 'PUSH', 'VOID'])
    .optional().parse(req.query.status || undefined);
  res.json(await listBets({
    poolId: req.params.poolId,
    userId: req.user.id,
    status: status ?? null,
  }));
}));

// Every member's bets, paginated. Bets on games that have not kicked off stay
// private to the member who placed them — see listPoolBets.
router.get('/:poolId/history', asyncHandler(async (req, res) => {
  const { limit, offset } = historySchema.parse(req.query);
  res.json(await listPoolBets({
    poolId: req.params.poolId,
    userId: req.user.id,
    limit,
    offset,
  }));
}));

router.get('/:poolId/balance', asyncHandler(async (req, res) => {
  const { pool } = await requireMembership(req.params.poolId, req.user.id);
  res.json(await getBalanceSummary(pool, req.user.id));
}));

router.get('/:poolId/ledger', asyncHandler(async (req, res) => {
  await requireMembership(req.params.poolId, req.user.id);
  res.json({ entries: await listLedger(req.params.poolId, req.user.id) });
}));

router.post('/:poolId/rebuy', asyncHandler(async (req, res) => {
  res.json(await rebuy({ poolId: req.params.poolId, userId: req.user.id }));
}));

/* ------------------------------------------------------- Legacy pick modes */

router.get('/:poolId/week/:week', asyncHandler(async (req, res) => {
  const week = weekParam.parse(req.params.week);
  res.json(await getWeekView({
    poolId: req.params.poolId,
    userId: req.user.id,
    week,
  }));
}));

router.get('/:poolId/picks', asyncHandler(async (req, res) => {
  const { pool } = await requireMembership(req.params.poolId, req.user.id);
  const week = req.query.week
    ? weekParam.parse(req.query.week)
    : await getCurrentWeek(pool.leagues[0], pool.season);
  res.json(await getWeekView({
    poolId: req.params.poolId,
    userId: req.user.id,
    week,
  }));
}));

router.post('/:poolId/picks', asyncHandler(async (req, res) => {
  const body = picksSchema.parse(req.body);
  const saved = await submitPicks({
    poolId: req.params.poolId,
    userId: req.user.id,
    week: body.week,
    submissions: body.picks,
  });
  res.status(201).json({ saved: saved.length, picks: saved });
}));

export default router;
