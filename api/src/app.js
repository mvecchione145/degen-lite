import express from 'express';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './http.js';
import authRoutes from './routes/auth.js';
import poolRoutes from './routes/pools.js';
import gameRoutes from './routes/games.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', true);
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
