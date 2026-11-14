import { ReplayChannel } from '../openf1/replay.js';
import { ForkSim } from './sim.js';
import { Mock, ForkEvent } from '../models/index.js';
import { log } from '../lib/log.js';

const STEP = 0.1; // s of race time per physics step
const SAVE_MS = 8000;
// events the dashboards are sent as they happen (intervals and positions reach them in the 2 Hz timing)
const SENT = new Set(['lap', 'pit', 'stint', 'overtake', 'rc', 'weather']);
const META_KEYS = ['key', 'name', 'year', 'circuit', 'country', 'location', 'type', 'from', 'to', 'drivers', 'track', 'info', 'totalLaps'];

/**
 * A takeover's channel: looks like any replay channel to the dashboards (same
 * room, same frame / timing / events messages, same analysis endpoint), but from
 * the fork on its timing is made by a ForkSim the crew drives with its calls.
 *
 * The real events up to the fork and every simulated event are written to
 * MongoDB in batches with the sim's saved state, so a takeover can be closed and
 * reopened (or survive a restart) exactly where it was. It only runs forward:
 * play, pause and speed, no seeking.
 */
export class ForkChannel extends ReplayChannel {
  constructor({ doc, emit, viewers }) {
    super({ key: doc.key, mock: { id: doc._id, startAt: doc.fork.t0, team: doc.team, crew: doc.crew }, emit, viewers });
    this.doc = doc;
    this.loop = false;
    this.playing = false;
    this.buffering = false;
    this.pending = [];
    this.savedAt = 0;
  }

  /**
   * New takeover: `base` is an open channel of the real session, `at` where each car was at the fork.
   * Reopened takeover: everything comes back from MongoDB.
   */
  async init({ base = null, at = null } = {}) {
    const f = this.doc.fork;
    if (base) {
      const meta = base.meta;
      this.meta = { ...Object.fromEntries(META_KEYS.map((k) => [k, meta[k]])), name: this.doc.name, stints: meta.stints, complete: false };
      const past = base.events.filter((e) => e.t <= f.t0 && e.type !== 'interval');
      this.sim = ForkSim.create({ meta: this.meta, events: base.events, at, t0: f.t0, team: this.doc.team, seed: f.seed });
      this.events = past.slice();
      // the fork stands on its own from here: keep what it needs from the real session
      f.meta = Object.fromEntries(META_KEYS.map((k) => [k, this.meta[k]]));
      await ForkEvent.collection.insertMany(past.map((e) => ({ f: this.doc._id, t: new Date(e.t), type: e.type, data: e.data, at: new Date() })), { ordered: false }).catch((e) => log.warn('takeover history save:', e.message));
      await Mock.updateOne({ _id: this.doc._id }, { 'fork.meta': f.meta });
    } else {
      this.meta = { ...f.meta, complete: false };
      const snap = this.doc.sim;
      // events stored after the last save are made again by the sim: drop them so nothing is doubled
      await ForkEvent.deleteMany({ f: this.doc._id, t: { $gt: new Date(snap.t) } });
      const evs = await ForkEvent.find({ f: this.doc._id }, { _id: 0, f: 0, at: 0 }).sort({ t: 1 }).lean();
      this.events = evs.map((e) => ({ t: +e.t, type: e.type, data: e.data }));
      this.sim = ForkSim.restore(this.meta, snap);
    }
    this.meta.stints = this.sim.stints;
    this.meta.totalLaps = this.sim.totalLaps;
    this.from = +this.meta.from;
    this.to = this.sim.t;
    this.intervals = [];
    this.seek(this.sim.t);
    this.start();
    if (base) await this.persist();
    return this;
  }

  ensure() {} // no car-data chunks: the sim makes the frames

  start() {
    let last = Date.now();
    this.timers.push(setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      const watching = this.viewers(this.room());
      if (watching > 0) this.lastViewerAt = now;
      if (this.playing && !this.sim.ended) this.run(Math.min(dt, 1000) / 1000 * this.speed);
      if (watching) this.emit('replay:frame', this.frame());
      if (now - this.savedAt > SAVE_MS && (this.pending.length || this.dirty)) this.persist();
    }, 200));
    this.timers.push(setInterval(() => {
      if (this.viewers(this.room())) this.emit('replay:timing', { ...this.state(), rows: this.standings() });
    }, 500));
  }

  run(secs) {
    let left = secs;
    while (left > 1e-6) { const d = Math.min(STEP, left); this.sim.step(d); left -= d; }
    this.t = this.sim.t;
    this.to = this.t;
    this.dirty = true;
    const fresh = [], out = [];
    for (const e of this.sim.drain()) {
      if (e.type === 'interval') { this.apply(e); continue; }
      this.events.push(e);
      this.pending.push(e);
      this.apply(e, fresh);
      if (SENT.has(e.type)) out.push(e);
    }
    this.ei = this.events.length;
    if (out.length && this.viewers(this.room())) {
      const fastest = new Set(fresh.filter((e) => e.fastest).map((e) => e.data));
      const posOf = new Map(this.standings().map((r) => [r.n, r.pos]));
      this.emit('replay:events', { events: out.map((e) => ({ t: e.t, type: e.type, fastest: fastest.has(e.data) || undefined, ...e.data, ...(e.type === 'lap' ? { pos: posOf.get(e.data.n) } : {}) })) });
    }
    if (this.sim.ended && !this.endedSent) {
      this.endedSent = true;
      this.playing = false;
      this.emit('replay:state', this.state());
      this.persist();
      log.info(`takeover finished: ${this.meta.name} (${this.ch()})`);
    }
  }

  /** write new events and the sim's state together, so a reopened takeover picks up exactly here */
  async persist() {
    const evs = this.pending.splice(0);
    const snap = JSON.parse(JSON.stringify(this.sim.toJSON()));
    this.savedAt = Date.now();
    this.dirty = false;
    try {
      if (evs.length) await ForkEvent.collection.insertMany(evs.map((e) => ({ f: this.doc._id, t: new Date(e.t), type: e.type, data: e.data, at: new Date() })), { ordered: false });
      const result = this.sim.ended ? this.sim.cars.filter((c) => c.finished || c.retired).sort((a, b) => (a.retired - b.retired) || (a.finishPos ?? 99) - (b.finishPos ?? 99)).map((c) => ({ n: c.n, pos: c.retired ? null : c.finishPos, retired: c.retired, stops: c.stops })) : undefined;
      await Mock.updateOne({ _id: this.doc._id }, { t: this.t, sim: snap, updatedAt: new Date(), ...(result ? { result, ended: true } : {}) });
    } catch (e) {
      this.pending.unshift(...evs);
      log.warn(`takeover save ${this.ch()}:`, e.message);
    }
  }

  frame() { return { t: this.t, cars: this.sim.frame() }; }

  state() {
    return { ...super.state(), live: false, feed: 'takeover', flag: this.st.flag, fork: this.sim.status() };
  }

  snapshot() {
    const s = super.snapshot();
    const f = this.doc.fork;
    s.meta.fork = { t0: f.t0, lap0: f.lap0, source: f.source, realKey: this.doc.key };
    s.meta.totalLaps = this.sim.totalLaps;
    return s;
  }

  control({ action, speed }) {
    if (action === 'seek' || action === 'restart') throw new Error('a takeover only runs forward: start a new one to go back');
    if (action === 'play' && this.sim.ended) throw new Error('this takeover has finished');
    if (action === 'play') this.playing = true;
    if (action === 'pause') { this.playing = false; this.persist(); }
    if (action === 'speed') this.speed = Math.max(0.25, Math.min(16, Number(speed) || 1));
    this.emit('replay:state', this.state());
    return this.state();
  }

  /** a call from the crew or race control; applied on the next step */
  command(cmd) {
    const ok = this.sim.command(cmd);
    if (ok) {
      // a command can emit events (race control messages, a free tyre change under a red): send them now, even when paused
      this.run(0);
      this.emit('replay:state', this.state());
    }
    return ok;
  }

  stop() {
    super.stop();
    if (this.pending.length || this.dirty) this.persist();
  }
}
