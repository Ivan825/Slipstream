import { SessionSource, pruneReplayCache } from './source.js';
import { log } from '../lib/log.js';

const COMPOUND = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const LIVE_DELAY_MS = 8000;
const LIVE_REFRESH_MS = 3000;

/**
 * A channel plays one real session on one shared clock, like a broadcast:
 * everyone in room `replay:<key>` sees the same moment.
 *
 * It is fed by one of two feeds that look identical to the rest of the system:
 *   historical  any past session, released on a real-time clock (pause, seek, 1–16×)
 *   live        the current session from OpenF1's real-time API (needs a key),
 *               followed a few seconds behind real time and recorded to MongoDB
 *               as it arrives, so it is replayable afterwards
 *
 * A mock channel is a private copy of a historical session for one crew's
 * rehearsal: its own id (`m-…`), its own clock, starts paused, never loops.
 *
 * Output:
 *   replay:frame   5 Hz   [n, x, y, km/h, gear, throttle, brake, drs, rpm] per car
 *   replay:timing  2 Hz   standings + clock state
 *   replay:events  as they happen: race control, laps, pit stops, weather
 */
export class ReplayChannel {
  constructor({ key, live = false, mock = null, emit, viewers }) {
    this.key = key;
    this.live = live;
    this.mock = mock; // { id, startAt, team } for a crew's private rehearsal
    this.id = mock ? `m-${mock.id}` : null;
    this.emitRaw = emit;
    this.viewers = viewers;
    this.source = new SessionSource(key, { live });
    this.playing = true;
    this.speed = 1;
    this.loop = !live && !mock;
    this.buffering = true;
    this.loaded = new Map(); // chunk index -> { frames, intervals, at }
    this.cars = new Map();
    this.intervals = [];
    this.timers = [];
    this.lastViewerAt = Date.now();
  }

  /** channel id: the session key for shared channels, `m-…` for a mock */
  ch() { return this.id ?? String(this.meta?.key ?? this.key); }
  room() { return `replay:${this.ch()}`; }
  emit(ev, payload) { this.emitRaw(this.room(), ev, { k: this.ch(), ...payload }); }

  async init() {
    this.meta = await this.source.loadMeta();
    this.key = this.meta.key;
    this.events = this.source.events;
    this.from = +this.meta.from;
    this.to = this.live ? Date.now() : +this.meta.to;
    this.seek(this.live ? Date.now() - LIVE_DELAY_MS : this.mock?.startAt ?? this.from);
    if (this.mock) this.playing = false;
    this.start();
    return this;
  }

  start() {
    let last = Date.now();
    this.timers.push(setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      const watching = this.viewers(this.room());
      if (watching > 0) this.lastViewerAt = now;
      if (this.live) {
        this.to = now;
        this.advanceTo(now - LIVE_DELAY_MS);
      } else if (this.playing && !this.buffering) {
        this.advanceTo(this.t + dt * this.speed);
      }
      this.ensure();
      if (watching) this.emit('replay:frame', this.frame());
    }, 200));
    this.timers.push(setInterval(() => {
      if (this.viewers(this.room())) this.emit('replay:timing', { ...this.state(), rows: this.standings() });
    }, 500));
    if (this.live) this.timers.push(setInterval(() => this.pollLiveEvents(), 4000));
  }

  stop() { this.timers.forEach(clearInterval); }

  /* ---------------- feed: chunks of car data ---------------- */

  ensure() {
    const cur = this.source.chunkIndex(this.t);
    const want = this.live ? [cur - 1, cur] : [cur, cur + 1, cur + 2];
    const now = Date.now();
    for (const i of want) {
      if (i < 0 || (!this.live && i >= this.source.chunkCount())) continue;
      const have = this.loaded.get(i);
      // historical chunks are fetched once; the live chunk keeps growing, so refresh it
      if (have && !(this.live && i >= cur - 1 && now - have.at > LIVE_REFRESH_MS)) continue;
      if (this.source.inflight.has(i)) continue;
      this.source.chunk(i).then((c) => {
        this.loaded.set(i, { ...c, at: Date.now() });
        const nowCur = this.source.chunkIndex(this.t);
        for (const k of this.loaded.keys()) if (k < nowCur - 1 || k > nowCur + 3) this.loaded.delete(k);
        this.rebuild();
      }).catch((e) => log.warn(`replay ${this.key} chunk ${i}:`, e.message));
    }
    const ready = this.loaded.has(cur);
    if (this.buffering !== !ready) {
      this.buffering = !ready;
      this.emit('replay:state', this.state());
    }
  }

  rebuild() {
    const cars = new Map();
    const intervals = [];
    for (const i of [...this.loaded.keys()].sort((a, b) => a - b)) {
      const c = this.loaded.get(i);
      for (const f of c.frames) {
        let arr = cars.get(f.n);
        if (!arr) { arr = []; cars.set(f.n, arr); }
        arr.push(f);
      }
      intervals.push(...c.intervals);
    }
    this.cars = cars;
    this.intervals = intervals;
    for (const e of intervals) if (e.t <= this.t) this.apply(e);
  }

  async pollLiveEvents() {
    try {
      const fresh = await this.source.liveEvents(this.liveSince || Date.now() - 180_000);
      if (!fresh.length) return;
      this.liveSince = fresh[fresh.length - 1].t;
      const known = new Set(this.events.map((e) => `${e.type}:${e.t}:${e.data.n ?? ''}`));
      for (const e of fresh) if (!known.has(`${e.type}:${e.t}:${e.data.n ?? ''}`)) this.events.push(e);
      this.events.sort((a, b) => a.t - b.t);
      this.ei = this.events.findIndex((e) => e.t > this.t);
      if (this.ei < 0) this.ei = this.events.length;
    } catch (e) { log.warn('live poll', e.message); }
  }

  /* ---------------- clock & state ---------------- */

  resetState() {
    this.st = { pos: new Map(), gap: new Map(), int: new Map(), lap: new Map(), last: new Map(), best: new Map(), pits: new Map(), sectors: new Map(), weather: null, rc: [], flag: 'GREEN', bestLap: null };
    this.ei = 0;
  }

  apply(e, collect) {
    const s = this.st, d = e.data;
    switch (e.type) {
      case 'position': s.pos.set(d.n, d.pos); break;
      case 'interval': s.gap.set(d.n, d.gap); s.int.set(d.n, d.int); break;
      case 'lapstart': s.lap.set(d.n, Math.max(s.lap.get(d.n) || 0, d.lap)); break;
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
        if (d.category === 'SafetyCar') s.flag = /VIRTUAL/i.test(d.message) && /DEPLOYED/i.test(d.message) ? 'VSC' : /DEPLOYED/i.test(d.message) ? 'SC' : /ENDING|IN THIS LAP/i.test(d.message) ? s.flag : 'GREEN';
        else if (d.flag && (d.scope === 'Track' || !d.scope)) s.flag = d.flag === 'CLEAR' ? 'GREEN' : d.flag;
        collect?.push(e);
        break;
      default: break;
    }
  }

  seek(t) {
    this.t = Math.max(this.from, Math.min(this.to, t));
    this.resetState();
    while (this.ei < this.events.length && this.events[this.ei].t <= this.t) this.apply(this.events[this.ei++]);
    for (const e of this.intervals) if (e.t <= this.t) this.apply(e);
    this.ensure();
  }

  advanceTo(next) {
    if (!this.live && next > this.to) {
      if (!this.loop) { this.t = this.to; this.playing = false; return; }
      this.seek(this.from);
      this.emit('replay:state', this.state());
      return;
    }
    const prev = this.t;
    this.t = next;
    const fresh = [];
    while (this.ei < this.events.length && this.events[this.ei].t <= this.t) this.apply(this.events[this.ei++], fresh);
    for (const e of this.intervals) if (e.t > prev && e.t <= this.t) this.apply(e);
    if (fresh.length && this.viewers(this.room())) this.emit('replay:events', { events: fresh.map((e) => ({ t: e.t, type: e.type, fastest: e.fastest, ...e.data })) });
  }

  carAt(arr, t) {
    if (!arr?.length || t < arr[0].t - 2000) return null;
    let lo = 0, hi = arr.length - 1;
    if (t >= arr[hi].t) return t - arr[hi].t < 5000 ? arr[hi] : null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m; else hi = m; }
    const a = arr[lo], b = arr[hi];
    const f = Math.max(0, Math.min(1, (t - a.t) / ((b.t - a.t) || 1)));
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
    return this.meta.drivers.map((d) => {
      const lap = s.lap.get(d.n) || 0;
      const tyre = this.compoundOf(d.n, Math.max(1, lap));
      return { n: d.n, pos: s.pos.get(d.n) ?? 99, gap: s.gap.get(d.n) ?? null, int: s.int.get(d.n) ?? null, lap, last: s.last.get(d.n) ?? null, best: s.best.get(d.n) ?? null, sectors: s.sectors.get(d.n) || null, pits: s.pits.get(d.n) || 0, tc: tyre?.c || null, ta: tyre?.age ?? null };
    }).sort((a, b) => a.pos - b.pos || (a.best ?? 1e9) - (b.best ?? 1e9));
  }

  /** what the timing screen shows for one car right now (used to stamp a crew's calls) */
  carNow(n) {
    const row = this.standings().find((r) => r.n === n);
    return row ? { pos: row.pos, lap: row.lap, tc: row.tc, ta: row.ta, gap: row.gap, pits: row.pits } : null;
  }

  state() {
    return {
      loaded: true, key: this.meta.key, live: this.live, feed: this.live ? 'live' : 'historical', t: this.t, from: this.from, to: this.to,
      playing: this.playing, speed: this.speed, buffering: this.buffering, flag: this.st.flag, weather: this.st.weather, bestLap: this.st.bestLap
    };
  }

  snapshot() {
    const { drivers, track, name, circuit, country, year, type, key, complete } = this.meta;
    return {
      meta: { key, ch: this.ch(), name, circuit, country, year, type, drivers, track, complete, live: this.live, mock: this.mock ? { id: this.mock.id, team: this.mock.team, crew: this.mock.crew || null } : null },
      state: this.state(), rows: this.standings(), rc: this.st.rc.slice(-20).reverse(), frame: { ...this.frame(), k: this.ch() }
    };
  }

  control({ action, t, speed }) {
    if (this.live && action !== 'play') throw new Error('a live channel follows real time');
    if (action === 'play') this.playing = true;
    if (action === 'pause') this.playing = false;
    if (action === 'seek') this.seek(this.from + Math.max(0, Number(t) || 0));
    if (action === 'speed') this.speed = Math.max(0.25, Math.min(16, Number(speed) || 1));
    if (action === 'restart') { this.seek(this.mock?.startAt ?? this.from); this.playing = !this.mock; }
    this.emit('replay:state', this.state());
    this.onControl?.(this);
    return this.state();
  }
}

/**
 * Opens channels on demand (anyone can pick a session), shares one channel
 * between everyone watching the same session, gives each mock session its own
 * private channel, and closes channels nobody has watched for a few minutes.
 * A mock's clock is saved (via `saveMock`) so the crew can come back to it.
 */
export class ReplayManager {
  constructor({ emit, viewers, maxChannels = 8, idleMs = 180_000, saveMock = null, cacheBytes = 0 }) {
    this.emit = emit;
    this.viewers = viewers;
    this.maxChannels = maxChannels;
    this.idleMs = idleMs;
    this.saveMock = saveMock;
    this.cacheBytes = cacheBytes;
    this.channels = new Map();
    this.opening = new Map();
    this.timer = setInterval(() => this.reap(), 30_000);
    if (cacheBytes) {
      this.pruneTimer = setInterval(() => this.prune(), 10 * 60_000);
      setTimeout(() => this.prune(), 60_000).unref?.();
    }
  }

  prune() {
    const keep = new Set(this.distinct().map((ch) => ch.meta?.key));
    return pruneReplayCache({ maxBytes: this.cacheBytes, keep }).catch((e) => log.warn('replay cache prune:', e.message));
  }

  /** a crew's private channel for a mock session; reopened at its saved clock */
  async openMock({ id, key, startAt, t, team, crew = null }) {
    const cid = `m-${id}`;
    if (this.channels.has(cid)) return this.channels.get(cid);
    if (this.opening.has(cid)) return this.opening.get(cid);
    this.makeRoom();
    const ch = new ReplayChannel({ key: Number(key), mock: { id, startAt: t ?? startAt, team, crew }, emit: this.emit, viewers: this.viewers });
    ch.onControl = (c) => this.saveMock?.(c);
    const p = ch.init().then(() => {
      if (startAt != null) ch.mock.startAt = startAt; // restart goes back to where the mock began
      this.channels.set(cid, ch);
      log.info(`mock channel open: ${ch.meta.name} (${cid})`);
      return ch;
    }).finally(() => this.opening.delete(cid));
    this.opening.set(cid, p);
    return p;
  }

  makeRoom() {
    if (this.distinct().length >= this.maxChannels) {
      this.reap(true);
      if (this.distinct().length >= this.maxChannels) throw new Error('all replay channels are busy, try again in a few minutes');
    }
  }

  get(key) { return this.channels.get(String(key)); }

  async open(key, { live = false } = {}) {
    const id = live ? 'live' : String(key);
    if (this.channels.has(id)) return this.channels.get(id);
    if (this.opening.has(id)) return this.opening.get(id);
    this.makeRoom();
    const ch = new ReplayChannel({ key: live ? 'latest' : Number(key), live, emit: this.emit, viewers: this.viewers });
    const p = ch.init().then(() => {
      this.channels.set(id, ch);
      this.channels.set(String(ch.meta.key), ch);
      log.info(`replay channel open: ${ch.meta.name} (${live ? 'live feed' : 'historical feed'})`);
      return ch;
    }).finally(() => this.opening.delete(id));
    this.opening.set(id, p);
    return p;
  }

  distinct() { return [...new Set(this.channels.values())]; }

  reap(force = false) {
    const now = Date.now();
    for (const ch of this.distinct()) {
      const idle = now - ch.lastViewerAt;
      if (ch.mock && ch.playing) this.saveMock?.(ch);
      if (idle > this.idleMs || (force && idle > 20_000)) {
        if (ch.mock) { ch.playing = false; this.saveMock?.(ch); }
        ch.stop();
        for (const [k, v] of this.channels) if (v === ch) this.channels.delete(k);
        log.info(`replay channel closed: ${ch.meta?.name}`);
      }
    }
  }

  /** shared channels only: mock sessions are private to the crew holding the link */
  list() {
    return this.distinct().filter((ch) => !ch.mock).map((ch) => ({ key: ch.meta.key, name: ch.meta.name, live: ch.live, viewers: this.viewers(ch.room()), t: ch.t, from: ch.from, to: ch.to, playing: ch.playing, speed: ch.speed }));
  }

  stop() {
    clearInterval(this.timer); clearInterval(this.pruneTimer);
    for (const ch of this.distinct()) { if (ch.mock) this.saveMock?.(ch); ch.stop(); }
  }
}
