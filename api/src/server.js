import { createApp } from './app.js';
import { config } from './config.js';
import { closeDatabase, waitForDatabase } from './db.js';
import { closeCache, initCache } from './cache.js';

async function main() {
  await waitForDatabase();
  console.log('[api] database ready');

  await initCache();

  const server = createApp().listen(config.port, () => {
    console.log(`[api] listening on :${config.port} (${config.env})`);
    if (config.devTools) console.log('[api] dev tools enabled at /api/admin');
  });

  const shutdown = async (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close(async () => {
      await closeCache();
      await closeDatabase();
      process.exit(0);
    });
    // Do not hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
