import http from 'node:http';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { config } from './config.js';
import { log } from './lib/log.js';
import { Hub } from './core/hub.js';
import { createApp } from './app.js';
import { attachIngest } from './ingest/namespace.js';
import { attachLive } from './live/namespace.js';
import { Broadcaster } from './live/broadcaster.js';
import { ensureDemoUsers } from './auth.js';
import { Telemetry, Lap, Alert, Session, Command, User } from './models/index.js';

async function main() {
  if (config.env === 'production' && (config.jwtSecret.startsWith('change-me') || config.ingestSecret.startsWith('change-me'))) {
    log.warn('JWT_SECRET / INGEST_SECRET are still the defaults. Set real secrets in production.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { maxPoolSize: 20 });
  await Promise.all([Telemetry, Lap, Alert, Session, Command, User].map((m) => m.syncIndexes().catch((e) => log.warn(`index sync ${m.modelName}:`, e.message))));
  log.info('connected to MongoDB');
  await ensureDemoUsers();

  const hub = new Hub();
  const app = createApp(hub);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.clientOrigins },
    maxHttpBufferSize: config.maxPayloadBytes,
    perMessageDeflate: { threshold: 1024 },
    pingInterval: 10000,
    pingTimeout: 8000
  });

  attachIngest(io, hub);
  const broadcaster = new Broadcaster(io, hub);
  const liveNsp = attachLive(io, hub, broadcaster);
  broadcaster.attach(liveNsp);
  hub.start();

  server.listen(config.port, () => log.info(`Slipstream server on http://localhost:${config.port}`));

  let sim = null;
  if (config.embedSimulator) {
    const { startSimulator } = await import('@slipstream/simulator');
    sim = startSimulator({ url: `http://127.0.0.1:${config.port}`, secret: config.ingestSecret, log: (...a) => log.info('[sim]', ...a) });
  }

  const shutdown = async (sig) => {
    log.info(`${sig}: shutting down`);
    sim?.stop();
    broadcaster.stop();
    io.close();
    await hub.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('fatal:', e);
  process.exit(1);
});
