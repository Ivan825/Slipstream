/**
 * Simulator runner: one Socket.IO connection per car (each car is an
 * independent data source with its own API key and sequence counter) plus one
 * controller connection that receives session state and commands.
 *
 * Frames are produced at SIM_HZ and flushed in small batches every 100 ms.
 * Optional fault injection duplicates frames or delivers them out of order so
 * the server's dedupe/reorder logic is exercised during demos.
 */
import { io } from 'socket.io-client';
import { createHmac } from 'node:crypto';
import { NS, EV } from '@slipstream/shared';
import { RaceSim } from './model.js';

export function apiKeyFor(sourceId, secret) {
  return `${sourceId}.${createHmac('sha256', secret).update(sourceId).digest('hex').slice(0, 32)}`;
}

export function startSimulator(opts = {}) {
  const url = (opts.url || process.env.INGEST_URL || 'http://localhost:4000').replace(/\/$/, '');
  const secret = opts.secret || process.env.INGEST_SECRET || 'change-me-ingest-secret';
  const carCount = Number(opts.cars || process.env.SIM_CARS || 20);
  let hz = Number(opts.hz || process.env.SIM_HZ || 20);
  const dupRate = Number(opts.dupRate ?? process.env.SIM_DUP_RATE ?? 0.004);
  const oooRate = Number(opts.oooRate ?? process.env.SIM_OOO_RATE ?? 0.004);
  const log = opts.log || ((...a) => console.log('[sim]', ...a));

  const sim = new RaceSim({ carCount, totalLaps: Number(process.env.RACE_LAPS || 36), seed: Date.now() % 100000 });
  const stats = { sent: 0, acked: 0, rejected: 0, limited: 0, dupInjected: 0, oooInjected: 0 };

  const controller = io(url + NS.INGEST, { auth: { apiKey: apiKeyFor('sim', secret), role: 'controller' }, transports: ['websocket'] });
  controller.on('connect', () => log(`controller connected to ${url}`));
  controller.on('connect_error', (e) => log('controller connect error:', e.message));
  controller.on(EV.SIM_STATE, (s) => {
    if (s.totalLaps) sim.totalLaps = s.totalLaps;
    sim.setSession(s);
    if (s.hz && s.hz !== hz) setRate(s.hz);
  });
  controller.on(EV.SIM_COMMAND, (cmd) => {
    if (cmd.type === 'rate') return setRate(cmd.hz);
    if (cmd.type === 'burst') return burst(cmd.hz || 100, cmd.seconds || 10);
    sim.command(cmd);
    if (cmd.type !== 'pit') log('command', cmd.type, cmd.carId || '');
  });

  const sockets = new Map();
  for (const car of sim.cars) {
    const s = io(url + NS.INGEST, { auth: { apiKey: apiKeyFor(car.id, secret) }, transports: ['websocket'] });
    s.on('connect_error', (e) => log(`${car.id} connect error:`, e.message));
    s.held = [];
    sockets.set(car.id, s);
  }

  // physics loop
  let stepTimer = null;
  function setRate(newHz) {
    hz = Math.max(1, Math.min(200, Number(newHz) || 20));
    if (stepTimer) clearInterval(stepTimer);
    let last = performance.now();
    stepTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      sim.step(dt);
    }, 1000 / hz);
    log(`stream rate ${hz} Hz per car`);
  }
  let burstTimer = null;
  function burst(burstHz, seconds) {
    const prev = hz;
    setRate(burstHz);
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => setRate(prev), seconds * 1000);
  }
  setRate(hz);

  // transport loop: flush each car's outbox every 100 ms
  const flushTimer = setInterval(() => {
    for (const car of sim.cars) {
      const s = sockets.get(car.id);
      let frames = sim.drain(car);
      if (s.held.length) { frames = s.held.concat(frames); s.held = []; }
      if (!frames.length || !s.connected) continue;
      if (frames.length > 1 && Math.random() < oooRate * frames.length) {
        // deliver one frame late (next batch) or swap two frames
        const i = Math.floor(Math.random() * (frames.length - 1));
        if (Math.random() < 0.5) s.held.push(...frames.splice(i, 1));
        else [frames[i], frames[i + 1]] = [frames[i + 1], frames[i]];
        stats.oooInjected++;
      }
      if (Math.random() < dupRate * frames.length) {
        frames.push({ ...frames[Math.floor(Math.random() * frames.length)] });
        stats.dupInjected++;
      }
      // chunk big batches (bursts) to stay under the server payload limit
      for (let i = 0; i < frames.length; i += 50) {
        const chunk = frames.slice(i, i + 50);
        stats.sent += chunk.length;
        s.timeout(5000).emit(EV.TELEMETRY, chunk, (err, ack) => {
          if (err || !ack) return;
          stats.acked += ack.accepted || 0;
          stats.rejected += ack.rejected || 0;
          stats.limited += ack.limited || 0;
        });
      }
    }
  }, 100);

  const statsTimer = opts.quiet ? null : setInterval(() => {
    log(`sent=${stats.sent} accepted=${stats.acked} rejected=${stats.rejected} limited=${stats.limited} dupInjected=${stats.dupInjected} oooInjected=${stats.oooInjected} session=${sim.session.status}`);
  }, 15000);

  return {
    sim,
    stats,
    stop() {
      clearInterval(stepTimer); clearInterval(flushTimer); clearTimeout(burstTimer);
      if (statsTimer) clearInterval(statsTimer);
      controller.close();
      for (const s of sockets.values()) s.close();
    }
  };
}
