import { EV, ROOMS, encodeRaceRow, CARS } from '@slipstream/shared';
import { config } from '../config.js';

const TIMING_FIELDS = ['pos', 'lap', 'gap', 'int', 'down', 'last', 'best', 'fl', 'sf', 'tc', 'ta', 'stops', 'st', 'drs'];

/**
 * Broadcast loop.
 *  - 10 Hz: compact race frame to `race` (volatile: a slow client drops frames instead of queueing them)
 *  - 10 Hz: per-car batches of every 20 Hz frame to `car:<id>`, only for rooms with members
 *  - 2 Hz:  race frame to `race:2hz`; timing tower diffs (changed fields only) to `timing`
 *  - 1 Hz:  metrics; back-pressure check (slow sockets are moved to the 2 Hz feed)
 *  - every 3 s: strategy for cars whose team room has members
 */
export class Broadcaster {
  constructor(io, hub) {
    this.hub = hub;
    this.io = io;
    this.nsp = null;
    this.tick = 0;
    this.lastTiming = new Map();
    this.timers = [];
  }

  attach(nsp) {
    this.nsp = nsp;
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    every(1000 / config.broadcastHz, () => this.fast());
    every(1000 / config.timingHz, () => this.timing());
    every(1000, () => { this.metrics(); this.backpressure(); });
    every(config.strategyEverySec * 1000, () => this.strategy());
  }

  stop() { this.timers.forEach(clearInterval); }

  roomSize(room) { return this.nsp.adapter.rooms.get(room)?.size || 0; }

  emit(room, ev, payload, { volatile = false, except = null } = {}) {
    const n = this.roomSize(room);
    if (!n) return 0;
    let op = this.nsp.to(room);
    if (except) op = op.except(except);
    if (volatile) op = op.volatile;
    op.emit(ev, payload);
    const bytes = JSON.stringify(payload).length;
    this.hub.metrics.inc('bcMessages', n);
    this.hub.metrics.inc('bcBytes', bytes * n);
    return n;
  }

  fast() {
    this.tick++;
    const hub = this.hub;
    const now = Date.now();
    const rows = [];
    for (const c of hub.race.cars.values()) {
      if (!c.frame) continue;
      rows.push(encodeRaceRow(c.index, c.lap, c.d, c.v, c.finished ? 'RUN' : c.status));
    }
    if (rows.length) {
      const frame = { t: now, s: this.tick, f: rows };
      this.emit(ROOMS.RACE, EV.RACE, frame, { volatile: true });
      if (this.tick % Math.round(config.broadcastHz / config.publicHz) === 0) this.emit(ROOMS.RACE_2HZ, EV.RACE, frame, { volatile: true });
    }
    // per-car full telemetry, batched
    for (const c of hub.race.cars.values()) {
      if (!c.pending.length) continue;
      const frames = c.pending;
      c.pending = [];
      const room = ROOMS.car(c.id);
      const last = frames[frames.length - 1];
      c.lastBroadcastSeq = last.seq;
      if (!this.roomSize(room)) continue;
      for (const f of frames) {
        hub.metrics.procLatency.add(now - (f.receivedAt || now));
        hub.metrics.e2eLatency.add(Math.max(0, now - f.ts));
      }
      const clean = frames.map(({ receivedAt, ...f }) => f);
      this.emit(room, EV.CAR, { c: c.id, t: now, f: clean }, { except: 'degraded' });
    }
  }

  timingSnapshot() {
    return { t: Date.now(), full: true, rows: this.hub.race.timingRows(), fastest: this.hub.race.fastest, bestSectors: this.hub.race.bestSectors };
  }

  timing() {
    if (!this.roomSize(ROOMS.TIMING)) return;
    const rows = this.hub.race.timingRows();
    const full = this.tick % (config.broadcastHz * 10) < config.broadcastHz / config.timingHz; // full snapshot every ~10 s
    const out = [];
    for (const r of rows) {
      const prev = this.lastTiming.get(r.c);
      if (full || !prev) { out.push(r); this.lastTiming.set(r.c, r); continue; }
      const diff = { c: r.c };
      let changed = false;
      for (const k of TIMING_FIELDS) if (prev[k] !== r[k]) { diff[k] = r[k]; changed = true; }
      if (changed) out.push(diff);
      this.lastTiming.set(r.c, r);
    }
    if (out.length || full) this.emit(ROOMS.TIMING, EV.TIMING, { t: Date.now(), full, rows: out, fastest: this.hub.race.fastest });
  }

  metrics() {
    if (!this.roomSize(ROOMS.METRICS)) return;
    const snap = this.hub.metrics.snapshot();
    snap.rejections = Object.fromEntries(this.hub.rejections);
    snap.sequencer = this.hub.sequencer.counters;
    this.emit(ROOMS.METRICS, EV.METRICS, snap);
  }

  /** Move sockets whose outgoing buffer is backing up to the 2 Hz feed; restore when they recover. */
  backpressure() {
    let slow = 0;
    for (const s of this.nsp.sockets.values()) {
      const buffered = s.conn?.writeBuffer?.length ?? 0;
      if (!s.data.degraded && buffered > config.slowClientBuffer) {
        s.data.degraded = true;
        s.data.okSince = null;
        s.join('degraded');
        if (s.rooms.has(ROOMS.RACE)) { s.leave(ROOMS.RACE); s.join(ROOMS.RACE_2HZ); s.data.wasFull = true; }
        this.hub.metrics.inc('bcDropped');
      } else if (s.data.degraded) {
        if (buffered === 0) {
          s.data.okSince ??= Date.now();
          if (Date.now() - s.data.okSince > 5000) {
            s.data.degraded = false;
            s.leave('degraded');
            if (s.data.wasFull && s.data.user.role !== 'viewer') { s.leave(ROOMS.RACE_2HZ); s.join(ROOMS.RACE); }
          }
        } else s.data.okSince = null;
      }
      if (s.data.degraded) slow++;
    }
    this.hub.metrics.g.slowClients = slow;
  }

  /**
   * Strategy is only computed for cars somebody is watching (their team room or
   * their car room has members), and the computations are staggered one per
   * event-loop turn so a heavy search never stalls the live broadcast.
   */
  strategy() {
    const hub = this.hub;
    if (hub.session.status !== 'running') return;
    const queue = CARS.filter((car) => hub.race.cars.get(car.id)?.frame && (this.roomSize(ROOMS.team(car.team)) || this.roomSize(ROOMS.car(car.id))));
    const next = () => {
      const car = queue.shift();
      if (!car) return;
      try {
        const res = hub.strategy.compute(car.id);
        if (res) { hub.metrics.inc('strategyRuns'); hub.emit('strategy', res); }
      } catch (e) {
        // never let a strategy bug take down the broadcast loop
        console.error('strategy failed for', car.id, e);
      }
      setImmediate(next);
    };
    setImmediate(next);
  }
}
