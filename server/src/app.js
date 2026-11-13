import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { config } from './config.js';
import { authOptional } from './auth.js';
import { apiRouter } from './routes/index.js';
import { log } from './lib/log.js';

export function createApp(hub) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: config.clientOrigins, credentials: false }));
  app.use(compression());
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: mongoose.connection.readyState === 1, session: hub.session.status, uptimeS: Math.round(process.uptime()) });
  });

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate limit exceeded' } });
  app.use('/api', apiLimiter, authOptional, apiRouter(hub));

  if (config.serveClient) {
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { maxAge: '1h', index: false }));
      app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
      log.info('serving client from', dist);
    } else {
      log.warn('SERVE_CLIENT=true but client/dist is missing; run `npm run build` first');
    }
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
