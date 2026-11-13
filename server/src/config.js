const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/slipstream',
  jwtSecret: process.env.JWT_SECRET || 'change-me-jwt-secret',
  jwtTtl: process.env.JWT_TTL || '12h',
  ingestSecret: process.env.INGEST_SECRET || 'change-me-ingest-secret',
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
  embedSimulator: bool(process.env.EMBED_SIMULATOR, false),
  serveClient: bool(process.env.SERVE_CLIENT, false),
  autoStart: bool(process.env.AUTO_START, true),
  autoRestartSec: num(process.env.AUTO_RESTART_SEC, 90),
  autoStartType: process.env.AUTO_START_TYPE || 'race',
  practiceMinutes: num(process.env.PRACTICE_MINUTES, 15),
  qualiScale: num(process.env.QUALI_SCALE, 1),
  randomWeather: bool(process.env.RANDOM_WEATHER, true),
  demoDirector: bool(process.env.DEMO_DIRECTOR, false),
  replaySession: num(process.env.REPLAY_SESSION, 9636),
  replayAutoImport: bool(process.env.REPLAY_AUTO_IMPORT, false),
  replayMinutes: num(process.env.REPLAY_MINUTES, 15),
  raceLaps: num(process.env.RACE_LAPS, 36),
  telemetryTtlMin: num(process.env.TELEMETRY_TTL_MIN, 30),

  // real-time pipeline tuning
  broadcastHz: num(process.env.BROADCAST_HZ, 10),
  timingHz: 2,
  publicHz: 2,
  batchMs: num(process.env.DB_BATCH_MS, 500),
  batchMax: num(process.env.DB_BATCH_MAX, 2000),
  writeBufferMax: num(process.env.DB_BUFFER_MAX, 60000),
  reorderWindowMs: num(process.env.REORDER_WINDOW_MS, 100),
  maxFramesPerBatch: 50,
  maxPayloadBytes: 128 * 1024,
  bucket: { capacity: num(process.env.INGEST_BURST, 300), refillPerSec: num(process.env.INGEST_RATE, 150) },
  hotCacheFrames: 1200, // ~60 s per car at 20 Hz kept in memory
  slowClientBuffer: num(process.env.SLOW_CLIENT_BUFFER, 40),
  strategyEverySec: 3
};
