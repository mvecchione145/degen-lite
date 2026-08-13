import { createClient } from 'redis';
import { config } from './config.js';

// Redis is a read-through accelerator for leaderboards and nothing more. If it
// is unavailable the API must keep serving from Postgres, so every operation
// here degrades to a miss rather than throwing.

let client = null;
let ready = false;
let loggedError = false;

export async function initCache() {
  client = createClient({ url: config.redisUrl });

  client.on('error', (err) => {
    ready = false;
    if (!loggedError) {
      loggedError = true;
      console.warn('[cache] redis unavailable, serving uncached:', err.message);
    }
  });
  client.on('ready', () => {
    ready = true;
    loggedError = false;
  });

  try {
    await client.connect();
    ready = true;
    console.log('[cache] connected to redis');
  } catch (err) {
    ready = false;
    console.warn('[cache] initial redis connect failed:', err.message);
  }
}

export async function cacheGet(key) {
  if (!ready) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  if (!ready) return;
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    /* cache writes are best-effort */
  }
}

export async function cacheDel(...keys) {
  if (!ready || keys.length === 0) return;
  try {
    await client.del(keys);
  } catch {
    /* cache invalidation is best-effort; entries expire on their TTL anyway */
  }
}

export const leaderboardKey = (poolId) => `lb:${poolId}`;

// Read-through cache. Redis is persisted to a volume, so a cached upstream
// response survives a restart — which is the difference between spending the
// SharpAPI free tier's 12 requests/minute on every `docker compose up` and not.
// Returns { value, cached }.
export async function withCache(key, ttlSeconds, produce) {
  const hit = await cacheGet(key);
  if (hit !== null) return { value: hit, cached: true };

  const value = await produce();
  await cacheSet(key, value, ttlSeconds);
  return { value, cached: false };
}

export async function closeCache() {
  if (client) await client.quit().catch(() => {});
}
