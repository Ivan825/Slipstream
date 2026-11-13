import { ReplaySession, ReplayFrame, ReplayEvent } from '../models/index.js';
import { log } from '../lib/log.js';

const COMPOUND = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

/**
 * Replays a real session imported from OpenF1 on one shared clock, like a live
 * broadcast: every viewer in the `replay` room sees the same moment.
 *   replay:frame   5 Hz   [n, x, y, km/h, gear, throttle, brake, drs, rpm] per car (interpolated)
 *   replay:timing  2 Hz   standings from position, interval, lap, stint and pit events
 *   replay:events  as they happen: race control messages, laps, pit stops, weather
 */
export class ReplayEngine {
  constructor({ emit, hasViewers }) {
    this.emit = emit;
    this.hasViewers = hasViewers;
    this.meta = null;
    this.playing = true;
    this.speed = 1;
    this.loop = true;
    this.timers = [];
  }

  async load(key) {
    const meta = key ? await ReplaySession.findOne({ key: Number(key) }).lean() : await ReplaySession.findOne().sort({ importedAt: -1 }).lean();
    if (!meta) return null;
    const frames = await ReplayFrame.find({ s: meta.key }, { _id: 0, s: 0 }).sort({ t: 1 }).lean();
    const events = await ReplayEvent.find({ s: meta.key }, { _id: 0, s: 0 }).sort({ t: 1 }).lean();
    const byCar = new Map();
    for (const f of frames) {
      let c = byCar.get(f.n);
      if (!c) { c = []; byCar.set(f.n, c); }
      c.push({ t: +f.t, x: f.x, y: f.y, v: f.v, g: f.g, thr: f.thr, brk: f.brk, drs: f.drs, rpm: f.rpm });
    }
    this.meta = meta;
    this.cars = byCar;
    this.events = events.map((e) => ({ ...e, t: +e.t }));
    this.from = +meta.from;
    this.to = +meta.to;
    this.seek(this.from);
    log.info(`replay: loaded ${meta.name} (${frames.length} frames, ${events.length} events)`);
    return meta;
  }

  start() {
    let last = Date.now();
    this.timers.push(setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      if (!this.meta) return;
      if (this.playing) this.advance(dt * this.speed);
      if (this.hasViewers()) this.emit('replay:frame', this.frame());
    }, 200));
    this.timers.push(setInterval(() => {
      if (this.meta && this.hasViewers()) this.emit('replay:timing', { t: this.t, rows: this.standings(), flag: this.st.flag, bestLap: this.st.bestLap, weather: this.st.weather, playing: this.playing, speed: this.speed });
    }, 500));
  }

  stop() { this.timers.forEach(clearInterval); }

  /* ---------------- clock ---------------- */

  resetState() {
    this.st = { pos: new Map(), gap: new Map(), int: new Map(), lap: new Map(), last: new Map(), best: new Map(), pits: new Map(), sectors: new Map(), weather: null, rc: [], flag: 'GREEN', bestLap: null };
    this.ei = 0;
  }

  apply(e, collect) {
    const s = this.st, d = e.data;
    switch (e.type) {
      case 'position': s.pos.set(d.n, d.pos); break;
      case 'interval': s.gap.set(d.n, d.gap); s.int.set(d.n, d.int); break;
      case 'lapstart': s.lap.set(d.n, d.lap); break;
      case 'lap':
        s.last.set(d.n, d.time);
        s.sectors.set(d.n, d.s);
        if (!d.pitOut && (!s.best.get(d.n) || d.time < s.best.get(d.n))) s.best.set(d.n, d.time);
        if (!d.pitOut && (!s.bestLap || d.time < s.bestLap.time)) { s.bestLap = { n: d.n, time: d.time, lap: d.lap }; collect?.push({ ...e, fastest: true }); }
        break;
      case 'pit': s.pits.set(d.n, (s.pits.get(d.n) || 0) + 1); collect?.push(e); break;
      case 'weather': s.weather = d; collect?.push(e); break;
      case 'rc':
        s.rc.push({ t: e.t, ...d });
        if (s.rc.length > 40) s.rc.shift();
        if (d.flag && (d.scope === 'Track' || d.category === 'SafetyCar' || !d.scope)) s.flag = d.flag === 'CLEAR' ? 'GREEN' : d.flag;
        if (d.category === 'SafetyCar') s.flag = /DEPLOYED/i.test(d.message) ? (/VIRTUAL/i.test(d.message) ? 'VSC' : 'SC') : /ENDING|IN THIS LAP/i.test(d.message) ? s.flag : 'GREEN';
        collect?.push(e);
        break;
      default: break;
    }
  }

  seek(t) {
    this.t = Math.max(this.from, Math.min(this.to, t));
    this.resetState();
    while (this.ei < this.events.length && this.events[this.ei].t <= this.t) this.apply(this.events[this.ei++]);
  }

  advance(ms) {
    let next = this.t + ms;
    if (next > this.to) {
      if (!this.loop) { this.t = this.to; this.playing = false; return; }
      this.seek(this.from);
      this.emit('replay:state', this.state());
      return;
    }
    this.t = next;
    const fresh = [];
    while (this.ei < this.events.length && this.events[this.ei].t <= this.t) this.apply(this.events[this.ei++], fresh);
    if (fresh.length && this.hasViewers()) this.emit('replay:events', fresh.map((e) => ({ t: e.t, type: e.type, fastest: e.fastest, ...e.data })));
  }

  /* ---------------- output ---------------- */

  carAt(arr, t) {
    let lo = 0, hi = arr.length - 1;
    if (!arr.length || t < arr[0].t) return null;
    if (t >= arr[hi].t) return arr[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m; else hi = m; }
    const a = arr[lo], b = arr[hi];
    const f = (t - a.t) / ((b.t - a.t) || 1);
    return { ...a, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, v: a.v + (b.v - a.v) * f };
  }

  frame() {
    const cars = [];
    for (const [n, arr] of this.cars) {
      const f = this.carAt(arr, this.t);
      if (f) cars.push([n, Math.round(f.x), Math.round(f.y), Math.round(f.v), f.g, f.thr, f.brk, f.drs, f.rpm]);
    }
    return { t: this.t, cars };
  }

  compoundOf(n, lap) {
    const s = this.meta.stints.find((x) => x.n === n && lap >= (x.from ?? 0) && lap <= (x.to ?? 999));
    return s ? { c: COMPOUND[s.compound] || s.compound?.[0] || '?', age: (s.age || 0) + Math.max(0, lap - s.from) } : null;
  }

  standings() {
    const s = this.st;
    return this.meta.drivers
      .map((d) => {
        const lap = s.lap.get(d.n) || 0;
        const tyre = this.compoundOf(d.n, Math.max(1, lap));
        return { n: d.n, pos: s.pos.get(d.n) ?? 99, gap: s.gap.get(d.n) ?? null, int: s.int.get(d.n) ?? null, lap, last: s.last.get(d.n) ?? null, best: s.best.get(d.n) ?? null, sectors: s.sectors.get(d.n) || null, pits: s.pits.get(d.n) || 0, tc: tyre?.c || null, ta: tyre?.age ?? null };
      })
      .sort((a, b) => a.pos - b.pos);
  }

  state() {
    if (!this.meta) return { loaded: false };
    return { loaded: true, key: this.meta.key, t: this.t, from: this.from, to: this.to, playing: this.playing, speed: this.speed, flag: this.st.flag, weather: this.st.weather, bestLap: this.st.bestLap };
  }

  snapshot() {
    if (!this.meta) return { state: { loaded: false } };
    const { drivers, track, name, circuit, country, year, type, frames, events, key } = this.meta;
    return { meta: { key, name, circuit, country, year, type, drivers, track, frames, events }, state: this.state(), rows: this.standings(), rc: this.st.rc.slice(-20), frame: this.frame() };
  }

  control({ action, t, speed }) {
    if (!this.meta) throw new Error('no replay loaded');
    if (action === 'play') this.playing = true;
    if (action === 'pause') this.playing = false;
    if (action === 'seek') this.seek(this.from + Math.max(0, Number(t) || 0));
    if (action === 'speed') this.speed = Math.max(0.25, Math.min(16, Number(speed) || 1));
    if (action === 'restart') { this.seek(this.from); this.playing = true; }
    this.emit('replay:state', this.state());
    return this.state();
  }
}
