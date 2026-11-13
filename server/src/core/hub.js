import { EventEmitter } from 'node:events';
import { CARS, CAR_BY_ID, TRACK_INFO, getTrack } from '@slipstream/shared';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { Telemetry, Lap, Alert, Session, Command } from '../models/index.js';
import { Metrics } from './metrics.js';
import { BatchWriter } from './batchWriter.js';
import { RaceState } from './raceState.js';
import { AnomalyEngine } from './anomaly.js';
import { StrategyEngine } from './strategy.js';
import { Weather } from './weather.js';
import { Sequencer } from '../ingest/sequencer.js';
import { TokenBuckets } from '../ingest/tokenBucket.js';
import { validateFrame } from '../ingest/validate.js';

/**
 * The hub wires the pipeline together:
 *   ingest(source, batch) -> validate -> rate limit -> sequencer -> race state -> anomaly
 *                                                   \-> batch writer -> MongoDB
 * and owns the session (status, track status, weather). It emits events that
 * the live namespace turns into Socket.IO broadcasts:
 *   'session', 'lap', 'alert', 'alert:acked', 'strategy', 'command', 'sim:command', 'sim:state'
 */
export class Hub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.track = getTrack();
    this.metrics = new Metrics();
    this.sequencer = new Sequencer({ windowMs: config.reorderWindowMs });
    this.buckets = new TokenBuckets(config.bucket);
    this.writer = new BatchWriter({
      collection: Telemetry.collection, metrics: this.metrics,
      batchMs: config.batchMs, batchMax: config.batchMax, bufferMax: config.writeBufferMax
    });
    this.weather = new Weather({ random: config.randomWeather });
    this.session = {
      sessionId: null, name: '', status: 'idle', trackStatus: 'GREEN', totalLaps: config.raceLaps,
      startedAt: null, finishedAt: null, simHz: 20, fresh: false, winner: null
    };
    this.race = new RaceState({
      onLap: (lap, car) => this.handleLap(lap, car),
      onPit: (p) => this.emit('pit', p),
      onFinish: (car, pos) => this.handleFinish(car, pos)
    });
    this.anomaly = new AnomalyEngine({ raise: (a) => this.raiseAlert(a) });
    this.strategy = new StrategyEngine({ race: this.race, weather: this.weather, getSession: () => this.session });
    this.rejections = new Map();
    this.timers = [];
  }

  start() {
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    // release frames held by the reorder buffer
    every(25, () => this.sequencer.drainAll(Date.now(), (f) => this.applyFrame(f)));
    every(1000, () => {
      this.weather.tick(1);
      this.race.wetness = this.weather.wetness;
      this.metrics.g.sources = this.sources?.size ?? 0;
      this.metrics.tick();
      this.anomaly.heartbeat([...this.race.cars.values()], this.session.status === 'running');
      this.emit('sim:state', this.simState());
    });
    every(5000, () => this.emit('session', this.publicSession()));
    if (config.autoStart) setTimeout(() => this.newSession().catch((e) => log.error(e)), 1500);
  }

  stop() {
    this.timers.forEach(clearInterval);
    return this.writer.close();
  }

  /* ---------------- ingest ---------------- */

  ingest(sourceId, batch) {
    const now = Date.now();
    const res = { accepted: 0, rejected: 0, limited: 0, duplicates: 0, late: 0 };
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > config.maxFramesPerBatch) {
      const n = Array.isArray(batch) ? batch.length : 1;
      this.metrics.inc('received', n);
      this.metrics.inc('rejected', n);
      res.rejected = n;
      res.error = 'batch must be an array of 1..' + config.maxFramesPerBatch + ' frames';
      return res;
    }
    this.metrics.inc('received', batch.length);
    const granted = this.buckets.take(sourceId, batch.length, now);
    if (granted < batch.length) {
      res.limited = batch.length - granted;
      this.metrics.inc('limited', res.limited);
    }
    const sessionId = this.session.sessionId || 'idle';
    const raceCar = !!CAR_BY_ID[sourceId];
    for (let i = 0; i < granted; i++) {
      const v = validateFrame(batch[i], sourceId, now);
      if (!v.ok) {
        res.rejected++;
        this.metrics.inc('rejected');
        this.rejections.set(v.reason, (this.rejections.get(v.reason) || 0) + 1);
        continue;
      }
      const f = v.frame;
      const kind = this.sequencer.accept(f, now);
      if (kind === 'dup') { res.duplicates++; this.metrics.inc('duplicates'); continue; }
      if (kind === 'late') { res.late++; this.metrics.inc('late'); }
      res.accepted++;
      this.metrics.inc('accepted');
      f.receivedAt = now;
      const doc = { ...f, sessionId: raceCar ? sessionId : 'stress', ts: new Date(f.ts) };
      delete doc.receivedAt;
      this.writer.push(doc);
    }
    this.metrics.c.reordered = this.sequencer.counters.reordered;
    this.metrics.c.gaps = this.sequencer.counters.gaps;
    this.sequencer.drain(sourceId, now, (f) => this.applyFrame(f));
    return res;
  }

  applyFrame(f) {
    if (this.session.status !== 'running' && this.session.status !== 'finished') return;
    const prevLap = this.race.cars.get(f.carId)?.lap;
    const car = this.race.apply(f, f.receivedAt || Date.now());
    if (!car) return;
    this.anomaly.check(car, f, { trackStatus: this.session.trackStatus });
    if (prevLap != null && f.lap > prevLap) {
      const due = this.strategy.due(car.id, f.lap);
      if (due) this.pitCall(car.id, due.compound, due.by, 'scheduled');
    }
  }

  /* ---------------- laps, alerts, finish ---------------- */

  handleLap(lap, car) {
    this.strategy.learn(lap, car.frame?.fuel ?? 0);
    Lap.updateOne({ sessionId: lap.sessionId, carId: lap.carId, lap: lap.lap }, { $set: lap }, { upsert: true })
      .catch((e) => log.warn('lap write failed', e.message));
    const { trace, ...summary } = lap;
    this.emit('lap', summary);
    if (lap.fastest) {
      Session.updateOne({ sessionId: lap.sessionId }, { $set: { fastestLap: { carId: lap.carId, lap: lap.lap, timeMs: lap.timeMs } } }).catch(() => {});
    }
  }

  async raiseAlert(a) {
    this.metrics.inc('alerts');
    const doc = { ...a, sessionId: this.session.sessionId };
    try {
      const saved = await Alert.create(doc);
      this.emit('alert', saved.toObject());
    } catch (e) {
      log.warn('alert write failed', e.message);
    }
  }

  async ackAlert(id, user) {
    const updated = await Alert.findOneAndUpdate(
      { _id: id, acknowledged: false },
      { $set: { acknowledged: true, ackBy: user.username, ackAt: new Date() } },
      { new: true }
    ).lean();
    if (updated) this.emit('alert:acked', { id: String(updated._id), carId: updated.carId, team: updated.team, ackBy: updated.ackBy, ackAt: updated.ackAt });
    return updated;
  }

  handleFinish(car, pos) {
    if (pos === 1) {
      this.session.winner = car.id;
      Session.updateOne({ sessionId: this.session.sessionId }, { $set: { winner: car.id } }).catch(() => {});
      this.emit('session', this.publicSession({ event: 'chequered', winner: car.id }));
    }
    const running = [...this.race.cars.values()].filter((c) => !c.finished && c.frame?.st !== 'DNF');
    if (!running.length || pos >= this.race.cars.size) this.finishSession();
    else if (pos === 1) setTimeout(() => this.finishSession(), 100_000);
  }

  /* ---------------- session control ---------------- */

  async newSession() {
    const now = new Date();
    const id = 'R-' + now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
    this.session = {
      ...this.session, sessionId: id, name: `${TRACK_INFO.shortName} Grand Prix`, status: 'running',
      trackStatus: 'GREEN', startedAt: now.getTime(), finishedAt: null, fresh: true, winner: null,
      totalLaps: config.raceLaps
    };
    this.race.reset(id, this.session.totalLaps);
    this.anomaly.reset();
    this.strategy.reset();
    this.weather.reset();
    await Session.create({ sessionId: id, name: this.session.name, track: TRACK_INFO.id, totalLaps: this.session.totalLaps, status: 'running', startedAt: now });
    log.info(`session ${id} started (${this.session.totalLaps} laps)`);
    this.emit('sim:command', { type: 'reset' });
    this.broadcastSession({ event: 'start' });
    this.session.fresh = false;
    return this.session;
  }

  setStatus(status) {
    if (!['running', 'paused'].includes(status)) throw new Error('bad status');
    if (this.session.status === 'finished' || this.session.status === 'idle') throw new Error('no active session');
    this.session.status = status;
    Session.updateOne({ sessionId: this.session.sessionId }, { $set: { status } }).catch(() => {});
    this.broadcastSession({ event: status === 'paused' ? 'pause' : 'resume' });
  }

  async finishSession() {
    if (this.session.status === 'finished') return;
    this.session.status = 'finished';
    this.session.finishedAt = Date.now();
    await Session.updateOne({ sessionId: this.session.sessionId }, { $set: { status: 'finished', endedAt: new Date() } }).catch(() => {});
    this.broadcastSession({ event: 'finish' });
    log.info(`session ${this.session.sessionId} finished, winner ${this.session.winner}`);
    if (config.autoRestartSec > 0) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.newSession().catch((e) => log.error(e)), config.autoRestartSec * 1000);
    }
  }

  setTrackStatus(status) {
    if (!['GREEN', 'YELLOW', 'VSC', 'SC', 'RED'].includes(status)) throw new Error('bad track status');
    this.session.trackStatus = status;
    this.race.trackStatus = status;
    this.broadcastSession({ event: 'track-status' });
  }

  broadcastSession(extra = {}) {
    this.emit('session', this.publicSession(extra));
    this.emit('sim:state', this.simState());
  }

  simState() {
    const s = this.session;
    return {
      sessionId: s.sessionId, status: s.status, trackStatus: s.trackStatus, totalLaps: s.totalLaps, fresh: s.fresh,
      wetness: this.weather.wetness, rain: this.weather.rain, airTemp: this.weather.airTemp, trackTemp: this.weather.trackTemp, hz: s.simHz
    };
  }

  publicSession(extra = {}) {
    const s = this.session;
    const leader = this.race.order()[0];
    return {
      sessionId: s.sessionId, name: s.name, status: s.status, trackStatus: s.trackStatus,
      totalLaps: s.totalLaps, lap: leader ? Math.max(1, Math.min(leader.lap, s.totalLaps)) : 0,
      startedAt: s.startedAt, finishedAt: s.finishedAt, winner: s.winner, simHz: s.simHz,
      fastest: this.race.fastest,
      weather: this.weather.snapshot(91 + this.strategy.residualFor(leader?.id)),
      serverTime: Date.now(),
      ...extra
    };
  }

  /* ---------------- commands ---------------- */

  pitCall(carId, compound, by, source = 'engineer') {
    this.emit('sim:command', { type: 'pit', carId, compound, by });
    const car = CAR_BY_ID[carId];
    const cmd = { sessionId: this.session.sessionId, type: 'pit', carId, payload: { compound, source }, by, ts: new Date() };
    Command.create(cmd).catch(() => {});
    this.emit('command', { ...cmd, team: car?.team });
  }

  simCommand(cmd, user) {
    this.emit('sim:command', cmd);
    const doc = { sessionId: this.session.sessionId, type: cmd.type, carId: cmd.carId, payload: cmd, by: user?.username, role: user?.role, ts: new Date() };
    Command.create(doc).catch(() => {});
    this.emit('command', { ...doc, team: cmd.carId ? CAR_BY_ID[cmd.carId]?.team : null });
  }

  setSimRate(hz) {
    this.session.simHz = Math.max(1, Math.min(100, Number(hz) || 20));
    this.emit('sim:command', { type: 'rate', hz: this.session.simHz });
    this.broadcastSession({ event: 'rate' });
  }

  /** frames for history merge: Mongo (cold) + in-memory hot cache, deduped by seq */
  async history(carId, { toSeq, fromSeq, sinceMs = 30_000, limit = 1200 }) {
    const q = { sessionId: this.session.sessionId, carId };
    const seqQ = {};
    if (toSeq != null) seqQ.$lte = Number(toSeq);
    if (fromSeq != null) seqQ.$gte = Number(fromSeq);
    if (Object.keys(seqQ).length) q.seq = seqQ;
    if (fromSeq == null) q.ts = { $gte: new Date(Date.now() - sinceMs) };
    const cold = await Telemetry.find(q, { _id: 0, sessionId: 0 }).sort({ seq: -1 }).limit(limit).lean();
    const bySeq = new Map();
    for (const d of cold) bySeq.set(d.seq, { ...d, ts: new Date(d.ts).getTime() });
    let fromCache = 0;
    const hot = this.race.cars.get(carId)?.hot || [];
    const minTs = Date.now() - sinceMs;
    for (const f of hot) {
      if (toSeq != null && f.seq > toSeq) continue;
      if (fromSeq != null && f.seq < fromSeq) continue;
      if (fromSeq == null && f.ts < minTs) continue;
      if (!bySeq.has(f.seq)) { const { receivedAt, ...clean } = f; bySeq.set(f.seq, clean); fromCache++; }
    }
    const frames = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-limit);
    return { frames, fromDb: cold.length, fromCache };
  }
}

export { CARS };
