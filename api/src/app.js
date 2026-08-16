import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './http.js';
import authRoutes from './routes/auth.js';
import poolRoutes from './routes/pools.js';
import gameRoutes from './routes/games.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();

  // A hop count, never `true`. See config.trustProxyHops: trusting the entire
  // X-Forwarded-For chain means the client picks its own address, and the
  // per-IP rate limit becomes decorative.
  app.set('trust proxy', config.trustProxyHops);

  // The API is same-origin behind nginx, which serves the page and proxies
  // /api to it, so there is no CORS policy here on purpose — no browser ever
  // makes a cross-origin request to this service in the intended deployment.
  // Adding one would only widen what is reachable.
  //
  // Most of helmet's headers concern documents rather than JSON, but the API
  // is reachable directly and they cost nothing. Content-Security-Policy is
  // left off here and set by Caddy on the page itself (deploy/Caddyfile),
  // which is where it can be written against what the page actually loads.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      env: config.env,
      dev_tools: config.devTools,
      legacy_pool_modes: config.legacyPoolModes,
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/pools', poolRoutes);
  app.use('/api/games', gameRoutes);

  if (config.devTools) {
    app.use('/api/admin', adminRoutes);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
