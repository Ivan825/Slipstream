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
import { Telemetry, Lap, Alert, Session, Command, User, PitStop, ReplayChunk, ReplayEvent, ReplaySession, Mock } from './models/index.js';
import { ReplayManager } from './openf1/replay.js';
import { importSession } from './openf1/importer.js';

async function main() {
  if (config.env === 'production' && (config.jwtSecret.startsWith('change-me') || config.ingestSecret.startsWith('change-me'))) {
    log.warn('JWT_SECRET / INGEST_SECRET are still the defaults. Set real secrets in production.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { maxPoolSize: 20 });
  await Promise.all([Telemetry, Lap, Alert, Session, Command, User, PitStop, ReplayChunk, ReplayEvent, ReplaySession, Mock].map((m) => m.syncIndexes().catch((e) => log.warn(`index sync ${m.modelName}:`, e.message))));
  log.info('connected to MongoDB');
  // real-session car data used to be one document per sample; it is now packed per chunk
  await mongoose.connection.db.dropCollection('replayframes').then(() => log.info('dropped old replayframes collection')).catch(() => {});
  // sessions left running by a previous process can never finish: close them
  const stale = await Session.updateMany({ status: { $in: ['running', 'paused'] } }, { $set: { status: 'finished', endedAt: new Date() } });
  if (stale.modifiedCount) log.info(`closed ${stale.modifiedCount} stale session(s)`);
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

  // real sessions (OpenF1): channels opened on demand, one shared clock per session
  const roomSize = (room) => liveNsp.adapter.rooms.get(room)?.size || 0;
  hub.replays = new ReplayManager({
    emit: (room, ev, payload) => {
      const n = roomSize(room);
      if (!n) return;
      (ev === 'replay:frame' ? liveNsp.to(room).volatile : liveNsp.to(room)).emit(ev, payload);
      hub.metrics.inc('bcMessages', n);
    },
    viewers: roomSize,
    // a mock session's clock is saved so the crew can pick it up again later
    saveMock: (ch) => Mock.updateOne({ _id: ch.mock.id }, { t: ch.t, updatedAt: new Date() }).catch(() => {}),
    cacheBytes: config.replayCacheMb * 1e6
  });
  if (config.replayAutoImport) {
    importSession(config.replaySession, { minutes: config.replayMinutes })
      .catch((e) => log.warn('replay pre-download failed:', e.message));
  }

  server.listen(config.port, () => log.info(`Slipstream server on http://localhost:${config.port}`));

  // free hosting tiers sleep without inbound traffic; ping our own public URL so live sessions keep running
  if (config.keepAwakeUrl) {
    const url = config.keepAwakeUrl.replace(/\/$/, '') + '/api/health';
    setInterval(() => fetch(url).catch(() => {}), 10 * 60_000).unref();
    log.info(`keep-awake ping every 10 min: ${url}`);
  }

  let sim = null;
  if (config.embedSimulator) {
    const { startSimulator } = await import('@slipstream/simulator');
    sim = startSimulator({ url: `http://127.0.0.1:${config.port}`, secret: config.ingestSecret, log: (...a) => log.info('[sim]', ...a) });
  }

  const shutdown = async (sig) => {
    log.info(`${sig}: shutting down`);
    sim?.stop();
    hub.replays?.stop();
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
