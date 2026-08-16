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

// A cron job can carry more than one schedule, so every *_CRON is a list. The
// separator is `;` because a cron field already spends the comma on its own
// lists (`0,30 * * * *`). Splitting the day by the hour field is the point:
//
//   INGEST_CRON="*/10 11-23,0-1 * * *; */30 2-10 * * *"
//
// runs the regular cadence 11:00–02:00 and a reduced one 02:00–11:00. Hours are
// read in cronTimezone below, not UTC.
function crons(value, fallback) {
  const raw = value === undefined || value === '' ? fallback : value;
  return raw.split(';').map((expr) => expr.trim()).filter(Boolean);
}

// A football season kicks off in the autumn and runs into the following
// January, so anything before March still belongs to the previous year's
// season. True of both leagues we carry: the NFL runs September–February and
// college runs late August–January. The bootstrap SQL derives it the same way,
// so pools and the ingested schedule agree on which season they mean.
export function currentFootballSeason(now = new Date()) {
  const year = now.getFullYear();
  return now.getMonth() >= 2 ? year : year - 1;
}


// Development tools are off in production, full stop. DEV_TOOLS can only turn
// them on elsewhere.
//
// Two switches rather than one because they fail differently: DEV_TOOLS is a
// deliberate per-environment choice and defaults on, which is what a laptop
// wants; NODE_ENV=production is set by the deploy and is the one that must
// win. A stray DEV_TOOLS=true in a server .env — copied from a local file, or
// left over from debugging — is otherwise enough to let any logged-in member
// fabricate the scores their bets settle against.
export function resolveDevTools(env = process.env) {
  if ((env.NODE_ENV || '') === 'production') return false;
  return bool(env.DEV_TOOLS, true);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://leaguepicks:leaguepicks@localhost:5432/leaguepicks',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // How many proxies sit in front of the API. Express reads the client address
  // from the last untrusted hop of X-Forwarded-For, and rate limiting is only
  // as good as that number: trusting the whole chain lets a client invent its
  // own address and walk around the per-IP limit.
  //
  // Locally that chain is nginx alone. Under the production overlay it is
  // Caddy then nginx, so that file sets 2.
  trustProxyHops: num(process.env.TRUST_PROXY_HOPS, 1),

  auth: {
    windowMs: num(process.env.AUTH_WINDOW_MS, 15 * 60 * 1000),
    maxPerIp: num(process.env.AUTH_MAX_PER_IP, 20),
    maxPerAccount: num(process.env.AUTH_MAX_PER_ACCOUNT, 10),
  },
  leaderboardTtlSeconds: num(process.env.LEADERBOARD_TTL_SECONDS, 30),
  // Gates /api/admin/* — which can force-settle and fabricate final scores —
  // and the Simulate results button that calls it. See resolveDevTools: a
  // production build never has them, whatever DEV_TOOLS says.
  devTools: resolveDevTools(process.env),
  // The pick-based modes (Pick'em, Confidence, Survivor) stay in the codebase
  // and existing pools keep working, but they are not offered when creating a
  // pool unless this is switched on. See docs/game-modes.md.
  legacyPoolModes: bool(process.env.LEGACY_POOL_MODES, false),
  settlementCron: crons(process.env.SETTLEMENT_CRON, '*/1 * * * *'),
  ingestCron: crons(process.env.INGEST_CRON, '*/10 * * * *'),
  // Which clock the cron hour fields are read against. The container has no TZ
  // of its own, so without this every schedule would be UTC and an overnight
  // hour range would land five hours off.
  cronTimezone: process.env.CRON_TIMEZONE || 'America/New_York',
  // There is no synthetic fallback any more: without ingestion the app has no
  // games at all, so this is on by default.
  ingestEnabled: bool(process.env.INGEST_ENABLED, true),
  ingestSeason: num(process.env.INGEST_SEASON, currentFootballSeason()),
  // Where the scoreboard comes from. Overridden to point at mock-espn/, which
  // serves a compressed season for testing — see docs/mock-season.md.
  espnBase: process.env.ESPN_BASE
    || 'https://site.api.espn.com/apis/site/v2/sports',
  // Which leagues the worker pulls. Every extra league is another full walk of
  // ESPN's scoreboard on each tick, so this is opt-in rather than everything.
  ingestLeagues: (process.env.INGEST_LEAGUES || 'NFL,NCAAF')
    .split(',').map((l) => l.trim().toUpperCase()).filter(Boolean),

  // SharpAPI (sharpapi.io) supplies lines. Note this is a different product
  // from sharpapi.com, which is an unrelated AI workflow API.
  sharp: {
    apiKey: process.env.SHARP_API_KEY || '',
    baseUrl: process.env.SHARP_API_BASE || 'https://api.sharpapi.io/api/v1',
    // The per-league slug lives in leagues.js now; SHARP_LEAGUE remains only so
    // an existing compose file does not silently change behaviour.
    league: process.env.SHARP_LEAGUE || 'nfl',
    // Preference order when several sportsbooks price the same game. The free
    // tier serves two books.
    books: (process.env.SHARP_BOOKS || 'draftkings,fanduel')
      .split(',').map((b) => b.trim()).filter(Boolean),
    requestsPerMinute: num(process.env.SHARP_REQUESTS_PER_MINUTE, 12),
    // Free-tier data is delayed 60s, so polling faster than this buys nothing.
    cacheTtlSeconds: num(process.env.SHARP_CACHE_TTL_SECONDS, 90),
  },
  oddsCron: crons(process.env.ODDS_CRON, '*/5 * * * *'),
};

export const sharpEnabled = () => Boolean(config.sharp.apiKey);
