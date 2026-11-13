#!/usr/bin/env node
/**
 * Slipstream load test.
 *
 *   npm run loadtest -- --clients 200 --sources 50 --hz 50 --duration 30
 *
 * Spins up:
 *   - K headless dashboards on /live (half spectators on the 2 Hz feed, half
 *     engineers subscribed to race + timing + their team's two car rooms)
 *   - N extra data sources on /ingest, each streaming schema-valid frames at H Hz
 *     in 100 ms batches (these go through validation, rate limiting, dedupe and
 *     storage, but are not part of the race)
 * and reports client-observed latency percentiles, message rates and the
 * server's own pipeline metrics. Results are written to loadtest/results/.
 */
import { io } from 'socket.io-client';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS, carsOfTeam } from '@slipstream/shared';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL = (args.url || process.env.LOADTEST_URL || 'http://localhost:4000').replace(/\/$/, '');
const CLIENTS = Number(args.clients ?? 100);
const SOURCES = Number(args.sources ?? 0);
const HZ = Number(args.hz ?? 20);
const DURATION = Number(args.duration ?? 30);
const SECRET = args.secret || process.env.INGEST_SECRET || 'change-me-ingest-secret';
const NAME = args.name || `c${CLIENTS}-s${SOURCES}x${HZ}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (id) => `${id}.${createHmac('sha256', SECRET).update(id).digest('hex').slice(0, 32)}`;

function pct(arr, p) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

async function login(username) {
  const r = await fetch(`${URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'slipstream' }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}

const metrics = async () => (await fetch(`${URL}/api/metrics`)).json();

async function main() {
  console.log(`Slipstream load test → ${URL}`);
  console.log(`  ${CLIENTS} dashboards, ${SOURCES} extra sources × ${HZ} Hz (${SOURCES * HZ} ev/s extra), ${DURATION} s\n`);
  const tokens = {};
  for (const t of TEAMS) tokens[t.id] = await login(t.id);

  const stats = { connected: 0, race: 0, car: 0, carFrames: 0, timing: 0, bytes: 0, raceLat: [], carLat: [], errors: 0 };
  const sockets = [];
  let measuring = false;

  // ---- dashboards ----
  for (let i = 0; i < CLIENTS; i++) {
    const engineer = i % 2 === 1;
    const team = TEAMS[i % TEAMS.length];
    const s = io(`${URL}/live`, { auth: engineer ? { token: tokens[team.id] } : {}, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('connect', () => {
      stats.connected++;
      const rooms = ['race', 'timing'];
      if (engineer) rooms.push(`team:${team.id}`, ...carsOfTeam(team.id).map((c) => `car:${c.id}`));
      s.emit('subscribe', { rooms });
    });
    s.on('connect_error', () => stats.errors++);
    s.on('race', (f) => {
      if (!measuring) return;
      stats.race++;
      stats.raceLat.push(Date.now() - f.t);
      stats.bytes += 30 + f.f.length * 22;
    });
    s.on('car', (m) => {
      if (!measuring) return;
      stats.car++;
      stats.carFrames += m.f.length;
      const now = Date.now();
      for (const f of m.f) stats.carLat.push(now - f.ts);
    });
    s.on('timing', () => { if (measuring) stats.timing++; });
    sockets.push(s);
    if (i % 25 === 24) await sleep(50);
  }

  // ---- extra data sources ----
  const src = { sent: 0, accepted: 0, limited: 0, rejected: 0 };
  const timers = [];
  // unique source ids per run: real sources never restart their sequence under the same id
  const runTag = Math.random().toString(36).slice(2, 6).toUpperCase();
  for (let i = 0; i < SOURCES; i++) {
    const id = `X${runTag}-${String(i + 1).padStart(4, '0')}`;
    const s = io(`${URL}/ingest`, { auth: { apiKey: keyFor(id) }, transports: ['websocket'], forceNew: true });
    let seq = 0;
    const perBatch = Math.max(1, Math.round(HZ / 10));
    timers.push(setInterval(() => {
      if (!s.connected) return;
      const now = Date.now();
      const batch = [];
      for (let k = 0; k < perBatch; k++) {
        seq++;
        batch.push({
          carId: id, seq, ts: now, lap: 1, d: (seq * 4) % 5000, v: 250, thr: 1, brk: 0, g: 7, rpm: 11000, drs: 0, ers: 50, fuel: 40,
          tc: 'M', ta: 3, tw: 10, tt: new Array(12).fill(95), tp: [21.5, 21.5, 20.8, 20.8], bt: [500, 500, 420, 420], et: 104, ot: 115, st: 'RUN'
        });
      }
      for (let k = 0; k < batch.length; k += 50) {
        const chunk = batch.slice(k, k + 50);
        src.sent += chunk.length;
        s.emit('telemetry', chunk, (ack) => {
          if (!ack) return;
          src.accepted += ack.accepted; src.limited += ack.limited; src.rejected += ack.rejected;
        });
      }
    }, 100));
    sockets.push(s);
  }

  await sleep(3000); // warm up
  const before = await metrics();
  measuring = true;
  const t0 = Date.now();
  const server = [];
  for (let s = 0; s < DURATION; s++) {
    await sleep(1000);
    const m = await metrics();
    server.push({ ingest: m.rates.received, accepted: m.rates.accepted, limited: m.rates.limited, bc: m.rates.bcMessages, kb: Math.round(m.rates.bcBytes / 1024), lag: m.history.at(-1)?.loopLag, rss: m.memoryMB, buf: m.gauges.dbBuffer, slow: m.gauges.slowClients });
    process.stdout.write(`\r  t+${String(s + 1).padStart(3)}s  ingest ${String(m.rates.received).padStart(5)} ev/s · broadcast ${String(m.rates.bcMessages).padStart(6)} msg/s · loop lag p99 ${m.history.at(-1)?.loopLag} ms · db queue ${m.gauges.dbBuffer}   `);
  }
  measuring = false;
  const elapsed = (Date.now() - t0) / 1000;
  const after = await metrics();
  timers.forEach(clearInterval);
  sockets.forEach((s) => s.close());

  const windowS = (after.t - before.t) / 1000;
  const avg = (k) => Math.round(server.reduce((a, b) => a + (b[k] || 0), 0) / server.length);
  const max = (k) => Math.max(...server.map((b) => b[k] || 0));
  const result = {
    name: NAME, at: new Date().toISOString(), url: URL,
    config: { clients: CLIENTS, sources: SOURCES, hz: HZ, durationS: DURATION },
    clients: {
      connected: stats.connected, errors: stats.errors,
      raceFramesPerClientPerS: Math.round((stats.race / Math.max(1, stats.connected) / elapsed) * 10) / 10,
      carFramesReceivedPerS: Math.round(stats.carFrames / elapsed),
      raceLatencyMs: { p50: pct(stats.raceLat, 50), p95: pct(stats.raceLat, 95), p99: pct(stats.raceLat, 99) },
      carE2eLatencyMs: { p50: pct(stats.carLat, 50), p95: pct(stats.carLat, 95), p99: pct(stats.carLat, 99) }
    },
    server: {
      windowS: Math.round(windowS * 10) / 10,
      sustainedAcceptedPerS: Math.round((after.totals.accepted - before.totals.accepted) / windowS),
      sustainedReceivedPerS: Math.round((after.totals.received - before.totals.received) / windowS),
      sustainedDbWritesPerS: Math.round((after.totals.dbWritten - before.totals.dbWritten) / windowS),
      ingestAvgPerS: avg('ingest'), ingestPeakPerS: max('ingest'), acceptedAvgPerS: avg('accepted'), limitedAvgPerS: avg('limited'),
      broadcastAvgMsgPerS: avg('bc'), broadcastAvgKBPerS: avg('kb'), loopLagP99MaxMs: max('lag'), rssMaxMB: max('rss'), dbQueueMax: max('buf'),
      backPressuredClientsMax: max('slow'),
      eventsAccepted: after.totals.accepted - before.totals.accepted,
      duplicatesDropped: after.totals.duplicates - before.totals.duplicates,
      dbWritten: after.totals.dbWritten - before.totals.dbWritten,
      dbShed: after.totals.dbDropped - before.totals.dbDropped,
      procLatencyMs: { p50: after.latency.procP50, p95: after.latency.procP95, p99: after.latency.procP99 }
    },
    stressSources: src
  };

  console.log('\n\n' + JSON.stringify(result, null, 2));
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${NAME}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nsaved ${path.relative(process.cwd(), file)}`);
  console.log(`\n| ${NAME} | ${CLIENTS} | ${SOURCES ? `${SOURCES} × ${HZ} Hz` : '–'} | ${result.server.sustainedReceivedPerS} (peak ${result.server.ingestPeakPerS}) | ${result.server.broadcastAvgMsgPerS} | ${result.clients.raceLatencyMs.p50} / ${result.clients.raceLatencyMs.p95} / ${result.clients.raceLatencyMs.p99} | ${result.clients.carE2eLatencyMs.p50} / ${result.clients.carE2eLatencyMs.p95} | ${result.server.loopLagP99MaxMs} | ${result.server.limitedAvgPerS} | ${result.server.dbShed} |`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
