function num(value, fallback) {
  // An unset compose variable arrives as '', and Number('') is 0 — which is
  // finite, so a naive check silently yields 0 instead of the fallback.
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

// An NFL season kicks off in September and runs into the following January, so
// anything before March still belongs to the previous year's season. The
// bootstrap SQL derives it the same way, so pools and the ingested schedule
// agree on which season they are talking about.
export function currentNflSeason(now = new Date()) {
  const year = now.getFullYear();
  return now.getMonth() >= 2 ? year : year - 1;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://leaguepicks:leaguepicks@localhost:5432/leaguepicks',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: '7d',
  leaderboardTtlSeconds: num(process.env.LEADERBOARD_TTL_SECONDS, 30),
  // Gates /api/admin/*, which can force-settle and fabricate scores.
  devTools: bool(process.env.DEV_TOOLS, true),
  // The pick-based modes (Pick'em, Confidence, Survivor) stay in the codebase
  // and existing pools keep working, but they are not offered when creating a
  // pool unless this is switched on. See docs/game-modes.md.
  legacyPoolModes: bool(process.env.LEGACY_POOL_MODES, false),
  settlementCron: process.env.SETTLEMENT_CRON || '*/1 * * * *',
  ingestCron: process.env.INGEST_CRON || '*/10 * * * *',
  // There is no synthetic fallback any more: without ingestion the app has no
  // games at all, so this is on by default.
  ingestEnabled: bool(process.env.INGEST_ENABLED, true),
  ingestSeason: num(process.env.INGEST_SEASON, currentNflSeason()),

  // SharpAPI (sharpapi.io) supplies lines. Note this is a different product
  // from sharpapi.com, which is an unrelated AI workflow API.
  sharp: {
    apiKey: process.env.SHARP_API_KEY || '',
    baseUrl: process.env.SHARP_API_BASE || 'https://api.sharpapi.io/api/v1',
    league: process.env.SHARP_LEAGUE || 'nfl',
    // Preference order when several sportsbooks price the same game. The free
    // tier serves two books.
    books: (process.env.SHARP_BOOKS || 'draftkings,fanduel')
      .split(',').map((b) => b.trim()).filter(Boolean),
    requestsPerMinute: num(process.env.SHARP_REQUESTS_PER_MINUTE, 12),
    // Free-tier data is delayed 60s, so polling faster than this buys nothing.
    cacheTtlSeconds: num(process.env.SHARP_CACHE_TTL_SECONDS, 90),
  },
  oddsCron: process.env.ODDS_CRON || '*/5 * * * *',
};

export const sharpEnabled = () => Boolean(config.sharp.apiKey);
