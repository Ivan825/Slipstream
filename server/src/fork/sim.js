/**
 * Takeover: a real race, continued by simulation from any moment.
 *
 * Everything up to the fork is the real session (OpenF1). From the fork on, the
 * cars are driven by a model calibrated on that same session: every driver's own
 * pace, each compound's degradation and life, the pit loss and the pit-lane time,
 * the circuit's outline and speed profile, the weather. Rivals follow the stops
 * their teams really made (or a strategy model when the future isn't known, as in
 * a live race); the crew's own cars do only what the crew calls. Race control
 * (safety car, VSC, red flag, rain, penalties, failures) can be thrown in too.
 *
 * The output looks exactly like a real session's: car frames (x, y, speed, gear,
 * throttle, brake, DRS, rpm) and timing events (lapstart, lap, position, interval,
 * pit, stint, overtake, rc, weather). The rest of the system can't tell the
 * difference, so every pit-wall tool works on it unchanged.
 *
 * Pure and deterministic for a seed: no I/O, no timers. The channel steps it.
 */
import { wetPenalty, sameTeam } from '@slipstream/shared';

export const FUEL_S_PER_LAP = 0.06;
const NAME = { S: 'SOFT', M: 'MEDIUM', H: 'HARD', I: 'INTERMEDIATE', W: 'WET' };
const CODE = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const OFFSET = { S: -0.6, M: 0, H: 0.45, I: 0, W: 0 }; // dry-track pace against the medium
const DEG_DEFAULT = { S: 0.09, M: 0.06, H: 0.04, I: 0.06, W: 0.05 }; // s per lap of age
const LIFE_SHARE = { S: 0.32, M: 0.5, H: 0.68, I: 0.6, W: 0.7 }; // of race distance, when the session hasn't shown it
const CLIFF_K = 0.12; // s per lap² past a set's life
/** engine / energy / tyre modes the crew can ask for: lap-time delta, degradation factor, top-speed loss (km/h), lift before braking */
export const MODES = {
  push: { dt: -0.25, deg: 1.3, trap: 0, lift: false, label: 'Push' },
  standard: { dt: 0, deg: 1, trap: 0, lift: false, label: 'Standard' },
  manage: { dt: 0.35, deg: 0.65, trap: 0, lift: false, label: 'Tyre save' },
  save: { dt: 0.45, deg: 0.9, trap: 6, lift: true, label: 'Lift and coast' }
};
const LANE_Q = 0.07; // share of the lap the pit lane runs beside
const STATIONARY = 2.4; // s at the box
const MIN_GAP = 0.3; // s: closest a car can follow before it has to pass or sit behind
const DRS_GAP = 1.0;
const SC_PACE = 1.45; // safety-car lap against a racing lap
const VSC_PACE = 1.4;
const INTERVAL_MS = 4000;
const WEATHER_MS = 60_000;

/* ---------------- random numbers that survive a save ---------------- */
export class Rng {
  constructor(s) { this.s = s >>> 0; }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss() { const u = Math.max(1e-9, this.next()), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------------- the circuit ---------------- */

/**
 * The circuit from the session's outline: distance along the lap (`f`, 0..1), the
 * share of a lap's time spent up to each point at the reference speed profile
 * (`tc`), sectors, DRS zones, braking points. A car's speed anywhere is the
 * reference speed there scaled to its lap time, so its lap takes exactly that long.
 */
export function buildTrack(meta) {
  const pts = meta.track || [];
  const info = meta.info || {};
  const N = pts.length;
  if (N < 30) throw new Error('this session has no circuit outline to race on');
  const seg = new Float64Array(N);
  let D = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    seg[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    D += seg[i];
  }
  // the outline is one recorded lap: its closing gap should be tiny; cap it so a ragged end doesn't add a phantom straight
  const typical = median([...seg]) || 1;
  if (seg[N - 1] > typical * 6) { D -= seg[N - 1] - typical; seg[N - 1] = typical; }
  const L = info.length || D / 10;
  const vAt = (i) => Math.max(65, Number(info.v?.[i]) || 200) / 3.6;
  const f = new Float64Array(N + 1), tc = new Float64Array(N + 1);
  let K = 0;
  for (let i = 0; i < N; i++) {
    f[i + 1] = f[i] + seg[i] / D;
    K += (seg[i] / D) * L / vAt(i);
    tc[i + 1] = K;
  }
  for (let i = 0; i <= N; i++) tc[i] /= K;
  const secIdx = info.sectors;
  const sec = [secIdx?.[0] ? f[secIdx[0]] : 1 / 3, secIdx?.[1] ? f[secIdx[1]] : 2 / 3];
  const drs = Uint8Array.from({ length: N }, (_, i) => (info.drs?.[i] ? 1 : 0));
  const brk = Uint8Array.from({ length: N }, (_, i) => (info.brk?.[i] ? 1 : 0));
  // DRS zones: where the reference car had its flap open; otherwise the two longest flat-out runs
  let zones = runs(drs, N).filter((r) => r.len >= 4);
  if (!zones.length) {
    const vmax = Math.max(...Array.from({ length: N }, (_, i) => vAt(i)));
    const fast = Uint8Array.from({ length: N }, (_, i) => (vAt(i) > vmax * 0.9 ? 1 : 0));
    zones = runs(fast, N).sort((a, b) => b.len - a.len).slice(0, 2);
  }
  zones = zones.map((r) => ({ a: f[r.from], b: f[(r.from + r.len) % N] || 1, from: r.from, len: r.len }));
  let trap = 0;
  for (let i = 1; i < N; i++) if (vAt(i) > vAt(trap)) trap = i;
  return { pts, N, f, tc, K, L, sec, drs, brk, vAt, zones, trapF: f[trap], refTime: info.ref?.time || K };
}

function runs(flags, N) {
  const out = [];
  let origin = 0;
  while (origin < N && flags[origin]) origin++;
  if (origin === N) return [{ from: 0, len: N }];
  let start = -1;
  for (let q = 1; q <= N; q++) {
    const i = (origin + q) % N;
    if (flags[i] && start < 0) start = q;
    if ((!flags[i] || q === N) && start >= 0) { out.push({ from: (origin + start) % N, len: q - start }); start = -1; }
  }
  return out;
}

/** index of the outline point at or before lap fraction x */
function idxAt(T, x) {
  let lo = 0, hi = T.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T.f[m] <= x) lo = m; else hi = m; }
  return lo;
}
/** share of a lap's time at lap fraction x */
function timeAt(T, x) {
  const i = idxAt(T, x);
  const k = (x - T.f[i]) / ((T.f[i + 1] - T.f[i]) || 1);
  return T.tc[i] + (T.tc[i + 1] - T.tc[i]) * k;
}
/** lap fraction at a share of the lap's time */
function fracAtTime(T, u) {
  let lo = 0, hi = T.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T.tc[m] <= u) lo = m; else hi = m; }
  const k = (u - T.tc[lo]) / ((T.tc[lo + 1] - T.tc[lo]) || 1);
  return T.f[lo] + (T.f[lo + 1] - T.f[lo]) * k;
}
function xyAt(T, x) {
  const i = idxAt(T, x);
  const a = T.pts[i], b = T.pts[(i + 1) % T.N];
  const k = (x - T.f[i]) / ((T.f[i + 1] - T.f[i]) || 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
function nearestFrac(T, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < T.N; i++) { const d = (T.pts[i][0] - x) ** 2 + (T.pts[i][1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return T.f[best];
}
const inZone = (T, x) => T.zones.find((z) => (z.a <= z.b ? x >= z.a && x < z.b : x >= z.a || x < z.b));

/* ---------------- calibration from the real session ---------------- */

/**
 * Tyre model, pace and pit loss from the session's own laps. Uses every lap the
 * session has (for a finished race that includes laps after the fork: that only
 * calibrates the tyres, it doesn't tell anyone what to do).
 */
export function calibrate({ meta, events, t0, totalLaps }) {
  const laps = events.filter((e) => e.type === 'lap' && e.data.time > 0).map((e) => ({ t: e.t, ...e.data }));
  const pits = events.filter((e) => e.type === 'pit').map((e) => ({ t: e.t, ...e.data }));
  const stints = meta.stints || [];
  const stintOf = (n, lap) => stints.find((s) => s.n === n && lap >= (s.from ?? 1) && lap <= (s.to ?? 999));
  const green = laps.filter((l) => !l.pitOut).map((l) => l.time);
  const ref = pct(green, 0.2) || (meta.info?.ref?.time ?? 90);
  const inLap = new Set(pits.map((p) => `${p.n}:${p.lap}`));
  const clean = laps.filter((l) => !l.pitOut && !inLap.has(`${l.n}:${l.lap}`) && l.lap > 1 && l.time < ref * 1.06);
  const fc = (l) => l.time + FUEL_S_PER_LAP * l.lap; // fuel-corrected: add back what the burnt fuel gave

  // degradation per compound: slope of fuel-corrected laps against tyre age, per stint
  const slopes = {};
  const byStint = new Map();
  for (const l of clean) {
    const s = stintOf(l.n, l.lap);
    if (!s) continue;
    const k = `${s.n}:${s.from}`;
    if (!byStint.has(k)) byStint.set(k, { c: CODE[s.compound] || 'M', s, pts: [] });
    byStint.get(k).pts.push([(s.age || 0) + l.lap - (s.from ?? 1), fc(l)]);
  }
  for (const { c, pts } of byStint.values()) {
    if (pts.length < 6) continue;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let num = 0, den = 0;
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    if (den > 0) (slopes[c] ||= []).push(num / den);
  }
  const deg = {};
  for (const c of Object.keys(DEG_DEFAULT)) deg[c] = clamp(median(slopes[c] || []) ?? DEG_DEFAULT[c], 0.012, 0.2);
  // keep the compounds in their order: softer wears faster
  deg.M = Math.min(deg.M, deg.S); deg.H = Math.min(deg.H, deg.M);

  // life per compound: stints the teams chose to end (a later stint follows)
  const lens = {};
  for (const s of stints) {
    if (s.to == null || !stints.some((x) => x.n === s.n && x.from > s.to)) continue;
    const len = (s.age || 0) + s.to - (s.from ?? 1) + 1;
    if (len >= 4) (lens[CODE[s.compound] || 'M'] ||= []).push(len);
  }
  const life = {};
  for (const c of Object.keys(LIFE_SHARE)) {
    const fallback = LIFE_SHARE[c] * totalLaps;
    life[c] = Math.round(clamp((pct(lens[c] || [], 0.75) ?? fallback) * 1.08, fallback * 0.6, fallback * 1.7));
  }
  // and harder lasts longer (short stints on a compound are often a team's choice, not its life)
  life.M = Math.max(life.M, Math.round(life.S * 1.3)); life.H = Math.max(life.H, Math.round(life.M * 1.25));

  // pit loss: in-lap + out-lap against two green laps
  const lapOf = new Map(laps.map((l) => [`${l.n}:${l.lap}`, l]));
  const losses = [];
  for (const p of pits) {
    const a = lapOf.get(`${p.n}:${p.lap}`), b = lapOf.get(`${p.n}:${p.lap + 1}`);
    if (a && b) { const loss = a.time + b.time - 2 * ref; if (loss > 10 && loss < 40) losses.push(loss); }
  }
  const pitLoss = clamp(median(losses) ?? 22, 14, 34);

  // each driver's own pace: recent clean laps with tyres and fuel taken out
  const base = new Map();
  for (const d of meta.drivers) {
    const mine = clean.filter((l) => l.n === d.n && l.t <= t0).slice(-8);
    const pure = mine.map((l) => {
      const s = stintOf(l.n, l.lap);
      const c = CODE[s?.compound] || 'M';
      const age = (s?.age || 0) + l.lap - (s?.from ?? 1);
      return l.time - OFFSET[c] - deg[c] * age - FUEL_S_PER_LAP * (totalLaps - l.lap);
    });
    if (pure.length >= 2) base.set(d.n, median(pure));
  }
  const fieldBase = median([...base.values()]) ?? ref - FUEL_S_PER_LAP * totalLaps * 0.5;
  return { ref, deg, life, pitLoss, base, fieldBase };
}

/* ---------------- the race ---------------- */

export class ForkSim {
  /**
   * @param meta     the real session's metadata (drivers, stints, track, info, totalLaps)
   * @param events   its timing events (lap, lapstart, position, pit, rc, weather…)
   * @param at       Map n -> {x, y}: where each car was at the fork
   * @param t0       the fork time (session clock, ms)
   * @param team     the crew's team: its cars do only what the crew calls
   * @param seed     random seed
   */
  static create({ meta, events, at = new Map(), t0, team = null, seed = 1 }) {
    const sim = new ForkSim();
    const T = buildTrack(meta);
    const totalLaps = meta.totalLaps || 50;
    const past = events.filter((e) => e.t <= t0);
    const cal = calibrate({ meta, events, t0, totalLaps });
    const lastOf = (type, n) => { for (let i = past.length - 1; i >= 0; i--) { const e = past[i]; if (e.type === type && e.data.n === n) return e; } return null; };
    const lead = Math.max(0, ...past.filter((e) => e.type === 'lapstart').map((e) => e.data.lap));
    const rng = new Rng(seed);
    const cars = [];
    for (const d of meta.drivers) {
      const ls = lastOf('lapstart', d.n);
      const pos = lastOf('position', d.n)?.data.pos ?? 99;
      const xy = at.get(d.n);
      const stint = (meta.stints || []).filter((s) => s.n === d.n && (s.from ?? 1) <= Math.max(1, ls?.data.lap || 1)).sort((a, b) => b.from - a.from)[0];
      const c = CODE[stint?.compound] || 'M';
      let lap = ls?.data.lap || 1;
      const base = cal.base.get(d.n) ?? cal.fieldBase + 0.08 * Math.max(0, pos - 1);
      const T0 = base + FUEL_S_PER_LAP * (totalLaps - lap);
      // no lap started for a while (and not just lapped): the car is out
      const retired = !ls || (lead > 2 && (t0 - ls.t) / 1000 > T0 * 2.2);
      let f;
      const e = ls ? clamp((t0 - ls.t) / 1000 / T0, 0, 0.999) : 0;
      if (xy) {
        f = nearestFrac(T, xy.x, xy.y);
        // the line is where the lap count changes: trust the position, fix the lap count around it
        const u = timeAt(T, f);
        if (u - e > 0.5) lap = Math.max(1, lap - 1);
        else if (e - u > 0.5) lap += 1;
      } else f = fracAtTime(T, e);
      const pits = past.filter((p) => p.type === 'pit' && p.data.n === d.n).length;
      const used = new Set((meta.stints || []).filter((s) => s.n === d.n && (s.from ?? 1) <= lap).map((s) => CODE[s.compound]).filter(Boolean));
      const plan = (meta.stints || []).filter((s) => s.n === d.n && (s.from ?? 1) > lap).sort((a, b) => a.from - b.from).map((s) => ({ lap: s.from - 1, c: CODE[s.compound] || 'M' }));
      cars.push({
        n: d.n, code: d.code, team: d.team, ours: !!team && sameTeam(d.team, team),
        lap, f, lapStart: t0 - timeAt(T, f) * T0 * 1000, sect: [null, null], secT: [null, null],
        c, age: (stint?.age || 0) + Math.max(0, lap - (stint?.from ?? 1)), used: [...(used.size ? used : new Set([c]))], stops: pits,
        base, noise: 0, mode: 'standard', order: null, box: null, auto: false, plan, planReal: plan.length > 0,
        lane: null, pitOut: false, retired, finished: false, puncture: false, failing: 0, owed: 0, dt: false,
        drsOn: false, zoneTried: -1, vmax: 0, v: 0, pos, behind: 0
      });
    }
    Object.assign(sim, {
      v: 1, T, t: t0, t0, totalLaps, cal, rng, cars, team,
      flag: 'GREEN', sc: null, red: null, drsEnabled: lead >= 3, drsAt: null,
      chequered: false, ended: false, random: false,
      weather: { air: 25, track: 35, rain: 0, humidity: 50, wind: 1, windDir: 0, pressure: 1010 }, wet: 0, rainTarget: 0,
      nextInt: t0 + 500, nextWx: t0 + WEATHER_MS, lastPos: new Map(), leaderLap: lead, out: [],
      stints: (meta.stints || []).filter((s) => (s.from ?? 1) <= (cars.find((c) => c.n === s.n)?.lap ?? 0)).map((s) => ({ ...s }))
    });
    // close the current stints: their end is still to come
    for (const car of cars) {
      const open = sim.stints.filter((s) => s.n === car.n).sort((a, b) => b.from - a.from)[0];
      if (open) open.to = null;
    }
    const wx = [...past].reverse().find((e) => e.type === 'weather');
    if (wx) Object.assign(sim.weather, wx.data);
    if (sim.weather.rain) { sim.wet = 0.35; sim.rainTarget = 0.45; }
    // the flag at the fork
    for (const e of past) if (e.type === 'rc') sim.readFlag(e.data);
    if (sim.flag === 'SC' || sim.flag === 'VSC') sim.sc = { kind: sim.flag, since: t0, laps: 2, ending: false, startLap: lead };
    if (sim.flag === 'RED') sim.red = { since: t0 };
    for (const car of cars) if (!car.retired) sim.newLap(car, false);
    sim.order();
    return sim;
  }

  /** a saved sim, put back on its circuit */
  static restore(meta, snap) {
    const sim = Object.assign(new ForkSim(), snap);
    sim.T = buildTrack(meta);
    sim.rng = new Rng(snap.rng);
    sim.cal = { ...snap.cal, base: new Map(snap.cal.base) };
    sim.lastPos = new Map(snap.lastPos);
    sim.out = [];
    return sim;
  }

  toJSON() {
    const { T, rng, cal, lastPos, out, ...rest } = this;
    return { ...rest, rng: rng.s, cal: { ...cal, base: [...cal.base] }, lastPos: [...lastPos] };
  }

  readFlag(d) {
    const m = String(d.message || '').toUpperCase();
    if (d.category === 'SafetyCar') this.flag = /VIRTUAL/.test(m) && /DEPLOYED/.test(m) ? 'VSC' : /DEPLOYED/.test(m) ? 'SC' : /ENDING|IN THIS LAP/.test(m) ? this.flag : 'GREEN';
    else if (d.flag && (d.scope === 'Track' || !d.scope) && d.flag !== 'BLUE' && d.flag !== 'CHEQUERED') this.flag = d.flag === 'CLEAR' ? 'GREEN' : d.flag;
    if (/DRS ENABLED/.test(m)) this.drsEnabled = true;
    if (/DRS DISABLED/.test(m)) this.drsEnabled = false;
  }

  /* ---------- output ---------- */

  emit(type, data) { this.out.push({ t: Math.round(this.t), type, data }); }
  rc(message, extra = {}) {
    const d = { category: 'Other', flag: null, message, lap: this.leaderLap, n: null, scope: null, sector: null, ...extra };
    this.readFlag(d);
    this.emit('rc', d);
  }
  drain() { const o = this.out; this.out = []; return o; }

  /* ---------- pace ---------- */

  lifeOf(c) { return this.cal.life[c] ?? LIFE_SHARE[c] * this.totalLaps; }

  /** the lap time this car is running to now, before traffic and flags */
  target(car) {
    const c = car.c, M = MODES[car.mode] || MODES.standard;
    const life = this.lifeOf(c);
    const over = Math.max(0, car.age - life);
    const dirty = car.behind > 4 ? 1.12 : 1; // laps stuck in dirty air cook the tyres
    let t = car.base + OFFSET[c] + this.cal.deg[c] * car.age * M.deg * dirty + CLIFF_K * over * over
      + FUEL_S_PER_LAP * Math.max(0, this.totalLaps - car.lap) + wetPenalty(c, this.wet) + M.dt + car.noise;
    if (car.puncture) t *= 1.35;
    if (car.failing) t *= 1.25;
    return t;
  }

  newLap(car, roll = true) {
    if (roll) car.noise = this.rng.gauss() * 0.16;
    car.lapT = this.target(car);
    car.zoneTried = -1;
  }

  /* ---------- one step of the race ---------- */

  step(dt) {
    if (this.ended) return;
    const T = this.T;
    this.t += dt * 1000;
    this.updateWeather(dt);
    const running = this.cars.filter((c) => !c.retired && !c.finished);
    // flags first: under a red the cars stop; a safety car or VSC slows everyone
    const leader = this.ordered?.[0];
    for (const car of running) {
      const tgt = this.target(car);
      car.lapT = tgt;
      if (car.lane) { this.moveInLane(car, dt); continue; }
      let lapT = tgt;
      if (this.flag === 'VSC') lapT = Math.max(tgt, car.base * VSC_PACE);
      if (this.flag === 'SC') lapT = car.base * SC_PACE;
      if (this.red) lapT = Infinity;
      if (car.failing) { car.failing -= dt; if (car.failing <= 0) { this.retire(car, 'stopped on track'); continue; } }
      let v = Number.isFinite(lapT) ? (T.vAt(idxAt(T, car.f)) * T.K) / lapT : 0;
      // DRS: within a second at the zone's start, green flag, enabled
      const z = inZone(T, car.f);
      if (z && car.drsOn) v *= 1.035;
      const M = MODES[car.mode];
      if (M?.trap && v > 70) v = Math.min(v, (T.vAt(idxAt(T, T.trapF)) - M.trap / 3.6) * T.K / lapT * 1.02);
      // under a safety car the train closes up behind the leader
      if (this.flag === 'SC' && car !== leader && car.gapAhead != null) v *= car.gapAhead > 1.2 ? 1.18 : car.gapAhead < 0.6 ? 0.9 : 1;
      car.v = v;
      this.advance(car, v * dt / T.L);
    }
    this.interact(running);
    this.order();
    if (this.t >= this.nextInt) { this.intervals(); this.nextInt = this.t + INTERVAL_MS; }
    if (this.t >= this.nextWx) { this.emitWeather(); this.nextWx = this.t + WEATHER_MS; }
    if (this.sc && !this.sc.ending && this.flag === 'VSC' && this.t - this.sc.since > (this.sc.ms || 100_000)) this.endNeutral();
    if (this.sc?.vscEndAt && this.t >= this.sc.vscEndAt) { this.sc = null; this.rc('TRACK CLEAR', { category: 'Flag', flag: 'CLEAR', scope: 'Track' }); this.drsAt = this.leaderLap + 2; }
    if (this.chequered && this.cars.every((c) => c.retired || c.finished)) this.finish();
  }

  /** move a car on by a share of the lap, handling sector lines, the pit entry and the finish line */
  advance(car, df) {
    const T = this.T;
    const from = car.f;
    let to = from + df;
    // sector lines
    for (let k = 0; k < 2; k++) if (car.sect[k] == null && from < T.sec[k] && to >= T.sec[k]) car.secT[k] = this.t, car.sect[k] = true;
    // DRS detection at each zone's start: within a second of the car ahead
    for (let zi = 0; zi < T.zones.length; zi++) {
      const za = T.zones[zi].a;
      if (from < za && to >= za) car.drsOn = this.drsEnabled && this.flag === 'GREEN' && car.gapAhead != null && car.gapAhead < DRS_GAP && !this.red;
    }
    if (!inZone(T, to)) car.drsOn = false;
    if (car.vmax < car.v) car.vmax = car.v;
    // pit entry: the decision is made on the approach
    const fIn = 1 - LANE_Q / 2;
    if (from < fIn && to >= fIn && !this.chequered) {
      if (this.wantsBox(car)) { car.f = fIn; this.enterLane(car); return; }
    }
    if (to >= 1) { to -= 1; car.f = to; this.crossLine(car); return; }
    car.f = to;
  }

  crossLine(car) {
    const time = (this.t - car.lapStart) / 1000;
    const s1 = car.secT[0] ? (car.secT[0] - car.lapStart) / 1000 : null;
    const s2 = car.secT[1] && car.secT[0] ? (car.secT[1] - car.secT[0]) / 1000 : null;
    const s3 = s1 != null && s2 != null ? time - s1 - s2 : null;
    const done = car.lap;
    this.emit('lap', { n: car.n, lap: done, time: +time.toFixed(3), s: [s1, s2, s3].map((x) => (x == null ? null : +x.toFixed(3))), pitOut: car.pitOut, st: Math.round(car.vmax * 3.6) });
    car.pitOut = false;
    car.vmax = 0;
    car.lapStart = this.t;
    car.secT = [null, null]; car.sect = [null, null];
    car.age += 1;
    if (car.behind) car.behind += 1;
    // the leader crossing the line moves the race on
    const isLeader = this.ordered?.[0] === car || (this.ordered?.[0]?.lane && this.ordered?.[1] === car);
    if (done >= this.leaderLap) this.leaderLap = done + 1;
    if (this.chequered || (done >= this.totalLaps && isLeader)) {
      if (!this.chequered) { this.chequered = true; this.rc('CHEQUERED FLAG', { category: 'Flag', flag: 'CHEQUERED', scope: 'Track' }); }
      car.finished = true;
      car.v = 0;
      return;
    }
    car.lap = done + 1;
    this.emit('lapstart', { n: car.n, lap: car.lap });
    if (isLeader) this.leaderCrossed();
    this.newLap(car);
  }

  leaderCrossed() {
    if (this.sc?.kind === 'SC') {
      if (this.sc.ending) { this.sc = null; this.rc('TRACK CLEAR', { category: 'Flag', flag: 'CLEAR', scope: 'Track' }); this.drsAt = this.leaderLap + 2; }
      else if (this.leaderLap - this.sc.startLap >= this.sc.laps) this.endNeutral();
    }
    if (this.drsAt && this.leaderLap >= this.drsAt && this.flag === 'GREEN') { this.drsAt = null; if (!this.drsEnabled) this.rc('DRS ENABLED', { category: 'Drs', scope: 'Track' }); this.drsEnabled = true; }
    if (!this.drsEnabled && !this.drsAt && this.leaderLap >= 3 && this.flag === 'GREEN') { this.drsEnabled = true; this.rc('DRS ENABLED', { category: 'Drs', scope: 'Track' }); }
    if (this.random) this.randomEvents();
  }

  /* ---------- the pit lane ---------- */

  wantsBox(car) {
    if (car.dt) return true; // a drive-through to serve
    if (car.puncture && !car.ours) return true;
    if (car.box) return car.box.lap == null || car.lap >= car.box.lap;
    if (car.ours && !car.auto) return false;
    return this.aiBox(car);
  }

  /** a rival's strategist: the stops the team really made, or a model when the future isn't known or the race has changed */
  aiBox(car) {
    const left = this.totalLaps - car.lap;
    if (left < 2) return false;
    const life = this.lifeOf(car.c);
    const wetNow = this.wet > 0.38, slicks = car.c === 'S' || car.c === 'M' || car.c === 'H';
    // once the weather has turned, what the team really did no longer applies
    if (this.wet > 0.2 || !slicks) car.planReal = false;
    // weather crossover
    if (wetNow && slicks) { car.next = this.wet > 0.75 ? 'W' : 'I'; return true; }
    if (!wetNow && this.wet < 0.22 && !slicks && left > 3) { car.next = this.dryChoice(car); return true; }
    // a cheap stop under a safety car or VSC
    if ((this.flag === 'SC' || this.flag === 'VSC') && car.age > life * 0.4 && left > 6 && !car.scStopped) {
      const nextPlan = car.plan[0];
      if (!nextPlan || nextPlan.lap - car.lap < 15) {
        car.scStopped = true;
        if (nextPlan) car.plan.shift();
        car.next = this.dryChoice(car);
        return true;
      }
    }
    if (car.planReal && car.plan.length) {
      const p = car.plan[0];
      if (car.lap >= p.lap) { car.plan.shift(); car.next = p.c; return true; }
      if (car.age < life * 1.35) return false; // the real plan still holds
    }
    const needSecond = car.used.filter((c) => c === 'S' || c === 'M' || c === 'H').length < 2 && !car.used.some((c) => c === 'I' || c === 'W');
    if (car.age >= life * (0.9 + 0.1 * ((car.n * 7) % 10) / 10) && (left > 3 || needSecond)) { car.next = this.dryChoice(car); return true; }
    if (needSecond && left <= 3) { car.next = this.dryChoice(car); return true; }
    return false;
  }

  /** the dry compound that gets this car to the flag, or the one that lasts longest */
  dryChoice(car) {
    const left = this.totalLaps - car.lap;
    if (this.wet > 0.38) return this.wet > 0.75 ? 'W' : 'I';
    const dryUsed = new Set(car.used.filter((c) => 'SMH'.includes(c)));
    const opts = ['S', 'M', 'H'].filter((c) => !(dryUsed.size === 1 && dryUsed.has(c) && 'SMH'.includes(car.c) && car.c === c && !car.used.some((x) => x === 'I' || x === 'W')));
    const fits = opts.filter((c) => this.lifeOf(c) >= left);
    if (fits.length) return fits[0];
    return opts.sort((a, b) => this.lifeOf(b) - this.lifeOf(a))[0] || 'H';
  }

  enterLane(car) {
    const T = this.T;
    // the lane takes the pit loss plus what a racing car spends on the same stretch
    const racing = (1 - timeAt(T, 1 - LANE_Q / 2) + timeAt(T, LANE_Q / 2)) * (car.lapT || car.base);
    // the lane is speed-limited, so it takes as long under a safety car: what shrinks is what the others gain meanwhile
    const laneTime = this.cal.pitLoss + racing;
    const stop = car.dt ? 0 : STATIONARY + (car.owed > 0 ? car.owed : 0) + Math.max(0, this.rng.gauss() * 0.35);
    const drive = Math.max(8, laneTime - STATIONARY);
    car.lane = { speed: (LANE_Q * T.L) / drive, stop, stopped: 0, served: car.owed > 0 && !car.dt, dt: car.dt, laneTime: drive + stop };
    car.v = car.lane.speed;
  }

  moveInLane(car, dt) {
    const L = car.lane;
    const T = this.T;
    // stationary at the box, which is at the line
    if (L.atBox) {
      L.stopped += dt;
      car.v = 0;
      if (L.stopped >= L.stop) { L.atBox = false; this.changeTyres(car); }
      return;
    }
    car.v = L.speed;
    const from = car.f;
    let to = from + (L.speed * dt) / T.L;
    if (from > 0.5 && to >= 1) {
      to -= 1;
      car.f = to;
      this.crossLine(car);
      if (car.finished) { car.lane = null; return; }
      car.pitOut = true;
      if (L.stop > 0) { L.atBox = true; return; }
      if (L.dt) { car.dt = false; this.emit('pit', { n: car.n, lap: car.lap - 1, duration: +L.laneTime.toFixed(1), dt: true }); }
      return;
    }
    car.f = to;
    if (from < LANE_Q / 2 && to >= LANE_Q / 2) {
      car.lane = null; // back on track
      car.lapT = this.target(car);
    }
  }

  changeTyres(car) {
    const next = car.box?.compound || car.next || this.dryChoice(car);
    const lap = car.lap - 1;
    this.emit('pit', { n: car.n, lap, duration: +car.lane.laneTime.toFixed(1), compound: NAME[next] });
    if (car.lane.served) car.owed = 0;
    this.fitTyres(car, next, lap + 1);
    car.stops += 1;
    car.box = null;
    car.next = null;
    car.puncture = false;
  }

  fitTyres(car, c, fromLap) {
    const open = this.stints.filter((s) => s.n === car.n).sort((a, b) => b.from - a.from)[0];
    if (open) open.to = Math.max(open.from ?? 1, fromLap - 1);
    const s = { n: car.n, from: fromLap, to: null, compound: NAME[c], age: 0 };
    this.stints.push(s);
    this.emit('stint', { ...s });
    car.c = c;
    car.age = 0;
    if (!car.used.includes(c)) car.used.push(c);
  }

  /* ---------- traffic ---------- */

  /** progress in laps, on the time axis: gaps in seconds are differences of this times a lap time */
  prog(car) { return car.lap - 1 + timeAt(this.T, car.f); }

  interact(running) {
    const T = this.T;
    const live = running.filter((c) => !c.lane).sort((a, b) => this.prog(b) - this.prog(a));
    for (let i = 1; i < live.length; i++) {
      const me = live[i], ahead = live[i - 1];
      const lapT = me.lapT || 90;
      let gap = (this.prog(ahead) - this.prog(me)) * lapT;
      me.gapAhead = gap;
      if (gap >= MIN_GAP) { if (gap > 1.5) me.behind = 0; continue; }
      // caught: pass or sit behind
      const neutral = this.flag !== 'GREEN' || !!this.red;
      const blue = ahead.lap < me.lap; // a backmarker lets the leaders through
      const mate = ahead.team === me.team;
      let pass = false;
      if (!neutral) {
        if (blue) pass = true;
        else if (mate && ahead.order === 'swap') { pass = true; ahead.order = null; me.order = null; this.rc(`CAR ${ahead.n} (${ahead.code}) LETS CAR ${me.n} (${me.code}) THROUGH`, { category: 'Other' }); }
        else if (!(mate && (ahead.order === 'hold' || me.order === 'hold'))) {
          const z = inZone(T, me.f);
          const zi = z ? T.zones.indexOf(z) : -2;
          if (z && me.zoneTried !== zi) {
            me.zoneTried = zi;
            const delta = (ahead.lapT || lapT) - lapT; // positive: I'm quicker
            const p = clamp(0.08 + (delta - 0.25) * 0.55 + (me.drsOn ? 0.3 : 0) + ((ahead.c === 'H' && me.c === 'S') ? 0.05 : 0), 0.02, 0.85);
            pass = this.rng.next() < p;
          }
        }
      }
      if (pass) {
        // swap on the time axis
        const pa = this.prog(ahead), lead = 0.25 / lapT;
        this.setProg(me, pa + lead);
        this.setProg(ahead, pa - 0.05 / lapT);
        live[i - 1] = me; live[i] = ahead;
        if (!blue) this.emit('overtake', { n: me.n, o: ahead.n, pos: ahead.pos });
        me.behind = 0;
      } else {
        this.setProg(me, this.prog(ahead) - MIN_GAP / lapT);
        me.behind = Math.max(me.behind, 1);
        me.gapAhead = MIN_GAP;
      }
    }
    if (live[0]) live[0].gapAhead = null;
  }

  setProg(car, p) {
    const lap = Math.floor(p) + 1;
    if (lap !== car.lap) return; // never move a car across the line here
    car.f = clamp(fracAtTime(this.T, p - (lap - 1)), 0, 0.99999);
  }

  order() {
    const all = this.cars.filter((c) => !c.retired);
    // finished cars keep their finishing order; the rest by distance run (in the lane too)
    const done = all.filter((c) => c.finished).sort((a, b) => a.finishPos - b.finishPos);
    const racing = all.filter((c) => !c.finished).sort((a, b) => this.prog(b) - this.prog(a));
    for (const c of all) if (c.finished && c.finishPos == null) c.finishPos = (this.finishCount = (this.finishCount || 0) + 1);
    const ord = [...done.sort((a, b) => a.finishPos - b.finishPos), ...racing, ...this.cars.filter((c) => c.retired)];
    this.ordered = racing;
    ord.forEach((c, i) => {
      c.pos = i + 1;
      if (this.lastPos.get(c.n) !== c.pos) { this.lastPos.set(c.n, c.pos); this.emit('position', { n: c.n, pos: c.pos }); }
    });
  }

  intervals() {
    const racing = this.ordered || [];
    const lead = racing[0];
    if (!lead) return;
    const lt = lead.lapT || 90;
    racing.forEach((c, i) => {
      const gap = i === 0 ? 0 : (this.prog(lead) - this.prog(c)) * lt;
      const int = i === 0 ? 0 : (this.prog(racing[i - 1]) - this.prog(c)) * (c.lapT || lt);
      this.emit('interval', { n: c.n, gap: +gap.toFixed(3), int: +int.toFixed(3) });
    });
  }

  /* ---------- weather ---------- */

  updateWeather(dt) {
    const target = this.rainTarget;
    if (this.wet < target) this.wet = Math.min(target, this.wet + dt * 0.0028);
    else if (this.wet > target) this.wet = Math.max(target, this.wet - dt * (target > 0 ? 0.002 : 0.0011));
  }

  emitWeather() {
    const w = this.weather, r = this.rng;
    w.rain = this.rainTarget > 0.05 ? 1 : 0;
    w.air = +(w.air + (r.next() - 0.5) * 0.2 - (w.rain ? 0.15 : 0)).toFixed(1);
    w.track = +(w.track + (r.next() - 0.5) * 0.4 - (w.rain ? 0.8 : 0) + (!w.rain && this.wet < 0.05 ? 0.05 : 0)).toFixed(1);
    w.humidity = Math.round(clamp(w.humidity + (w.rain ? 2 : -0.3) + (r.next() - 0.5), 20, 99));
    w.wind = +clamp(w.wind + (r.next() - 0.5) * 0.4, 0, 12).toFixed(1);
    this.emit('weather', { ...w });
  }

  /* ---------- race control ---------- */

  deploy(kind) {
    if (this.chequered || this.red) return false;
    if (this.flag === 'SC' || this.flag === 'VSC') return false;
    this.sc = { kind, since: this.t, startLap: this.leaderLap, laps: 3 + Math.floor(this.rng.next() * 2), ending: false, ms: 80_000 + this.rng.next() * 60_000 };
    if (this.drsEnabled) { this.drsEnabled = false; this.rc('DRS DISABLED', { category: 'Drs', scope: 'Track' }); }
    this.rc(kind === 'SC' ? 'SAFETY CAR DEPLOYED' : 'VIRTUAL SAFETY CAR DEPLOYED', { category: 'SafetyCar', scope: 'Track' });
    for (const c of this.cars) c.scStopped = false;
    return true;
  }

  endNeutral() {
    if (!this.sc || this.sc.ending) return false;
    this.sc.ending = true;
    if (this.sc.kind === 'VSC') { this.rc('VIRTUAL SAFETY CAR ENDING', { category: 'SafetyCar', scope: 'Track' }); this.sc.vscEndAt = this.t + 12_000; }
    else this.rc('SAFETY CAR IN THIS LAP', { category: 'SafetyCar', scope: 'Track' });
    return true;
  }

  redFlag() {
    if (this.red || this.chequered) return false;
    this.red = { since: this.t };
    this.sc = null;
    this.drsEnabled = false;
    this.rc('RED FLAG', { category: 'Flag', flag: 'RED', scope: 'Track' });
    return true;
  }

  /** restart after a red: the field lines up behind the leader and goes behind the safety car */
  resume() {
    if (!this.red) return false;
    this.red = null;
    const racing = this.ordered || [];
    const lead = racing.find((c) => !c.lane);
    if (lead) {
      const p0 = this.prog(lead);
      racing.forEach((c, i) => { if (!c.lane && c !== lead) { const p = p0 - (i * 0.6) / (c.lapT || 90); if (Math.floor(p) + 1 === c.lap) this.setProg(c, p); } });
    }
    this.rc(`RACE WILL RESUME BEHIND THE SAFETY CAR`, { category: 'Other' });
    this.flag = 'GREEN';
    this.sc = { kind: 'SC', since: this.t, startLap: this.leaderLap, laps: 1, ending: false };
    this.rc('SAFETY CAR DEPLOYED', { category: 'SafetyCar', scope: 'Track' });
    return true;
  }

  rain(level) {
    this.rainTarget = level === 'heavy' ? 0.85 : level === 'light' ? 0.45 : 0;
    if (this.rainTarget) this.rc(`RISK OF RAIN FOR F1 RACE IS ${level === 'heavy' ? 90 : 70}%`, { category: 'Other' });
    else this.rc('RAIN EASING: TRACK DRYING', { category: 'Other' });
    this.emitWeather();
    this.nextWx = this.t + WEATHER_MS;
    return true;
  }

  penalty(car, kind, secs = 5, reason = 'CAUSING A COLLISION') {
    if (!car || car.retired || car.finished) return false;
    if (kind === 'drive-through') { car.dt = true; this.rc(`FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR ${car.n} (${car.code}) - ${reason}`, { category: 'Other' }); }
    else { car.owed += secs; this.rc(`FIA STEWARDS: ${secs} SECOND TIME PENALTY FOR CAR ${car.n} (${car.code}) - ${reason}`, { category: 'Other' }); }
    return true;
  }

  retire(car, why = 'retired') {
    car.retired = true;
    car.v = 0;
    car.lane = null;
    this.rc(`CAR ${car.n} (${car.code}) ${why.toUpperCase()}`, { category: 'Other', n: car.n });
  }

  randomEvents() {
    const r = this.rng;
    const racing = (this.ordered || []).filter((c) => !c.lane);
    if (this.flag === 'GREEN' && !this.red) {
      const x = r.next();
      if (x < 0.012) return this.deploy('SC');
      if (x < 0.02) return this.deploy('VSC');
    }
    for (const c of racing) {
      if (r.next() < 0.015) this.rc(`CAR ${c.n} (${c.code}) TIME ${Math.floor(c.lapT / 60)}:${(c.lapT % 60).toFixed(3).padStart(6, '0')} DELETED - TRACK LIMITS AT TURN ${1 + Math.floor(r.next() * 12)} LAP ${c.lap - 1}`, { category: 'Other', n: c.n });
      if (r.next() < 0.0015) c.puncture = true;
      if (r.next() < 0.0008 && !c.failing) c.failing = 20;
    }
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    // time penalties not served at a stop are added to the race time
    const done = this.cars.filter((c) => c.finished).sort((a, b) => a.finishPos - b.finishPos);
    const lt = done[0]?.lapT || 90;
    const res = done.map((c, i) => ({ c, t: i * 1.5 + (c.lap < this.totalLaps ? (this.totalLaps - c.lap) * lt : 0) + c.owed }));
    res.sort((a, b) => a.t - b.t).forEach(({ c }, i) => {
      if (c.owed > 0) this.rc(`CAR ${c.n} (${c.code}) ${c.owed} SECONDS ADDED TO RACE TIME`, { category: 'Other', n: c.n });
      c.finishPos = i + 1;
    });
    this.order();
  }

  /* ---------- the crew's calls ---------- */

  command(cmd) {
    const car = cmd.n != null ? this.cars.find((c) => c.n === cmd.n) : null;
    switch (cmd.type) {
      case 'box':
        if (!car || car.retired || car.finished) return false;
        if (this.red) { this.fitTyres(car, cmd.compound || this.dryChoice(car), car.lap); return true; } // free change under a red
        car.box = { compound: cmd.compound || null, lap: cmd.lap ?? null };
        return true;
      case 'cancel-box':
        if (!car || car.lane) return false;
        car.box = null;
        return true;
      case 'mode':
        if (!car || !MODES[cmd.mode]) return false;
        car.mode = cmd.mode;
        return true;
      case 'order':
        if (!car) return false;
        car.order = cmd.order === 'race' ? null : cmd.order;
        for (const m of this.cars) if (m !== car && m.team === car.team && cmd.order !== 'swap') m.order = cmd.order === 'race' ? null : cmd.order;
        return true;
      case 'auto':
        if (!car) return false;
        car.auto = !!cmd.on;
        return true;
      case 'sc': return this.deploy('SC');
      case 'vsc': return this.deploy('VSC');
      case 'end-sc': return this.endNeutral();
      case 'red': return this.redFlag();
      case 'resume': return this.resume();
      case 'rain': return this.rain(cmd.level || 'light');
      case 'dry': return this.rain(null);
      case 'penalty': return this.penalty(car, cmd.kind || 'time', cmd.secs || 5);
      case 'puncture': if (!car || car.retired) return false; car.puncture = true; return true;
      case 'failure': if (!car || car.retired) return false; car.failing = 15; return true;
      case 'random': this.random = !!cmd.on; return true;
      default: return false;
    }
  }

  /* ---------- views ---------- */

  /** one telemetry sample per car: [n, x, y, km/h, gear, throttle, brake, drs, rpm] */
  frame() {
    const T = this.T, out = [];
    for (const c of this.cars) {
      if (c.retired || (c.finished && this.t - (c.finishT ||= this.t) > 15_000)) continue;
      const [x, y] = xyAt(T, c.f);
      const kmh = Math.round(c.v * 3.6);
      const i = idxAt(T, c.f);
      const M = MODES[c.mode] || MODES.standard;
      const braking = !c.lane && T.brk[i] && kmh > 90;
      const lifting = M.lift && !braking && T.brk[(i + 2) % T.N] && !T.brk[i];
      const accel = T.vAt((i + 1) % T.N) >= T.vAt(i);
      const thr = c.lane || kmh < 5 ? (kmh ? 20 : 0) : braking || lifting ? 0 : accel ? 100 : 60;
      const gear = kmh < 5 ? 0 : Math.max(1, Math.min(8, Math.ceil(kmh / 42)));
      const rpm = kmh < 5 ? 4000 : Math.round(9000 + ((kmh % 42) / 42) * 3000);
      const drs = c.drsOn && inZone(T, c.f) ? 12 : (this.drsEnabled && c.gapAhead != null && c.gapAhead < DRS_GAP ? 8 : 0);
      out.push([c.n, Math.round(x), Math.round(y), kmh, gear, thr, braking ? 100 : 0, drs, rpm]);
    }
    return out;
  }

  /** what the crew sees of the sim beyond timing: modes, calls in hand, flags, rain */
  status() {
    return {
      flag: this.flag, sc: this.sc ? { kind: this.sc.kind, ending: this.sc.ending } : null, red: !!this.red, wet: +this.wet.toFixed(2), rain: this.rainTarget,
      random: this.random, drs: this.drsEnabled, chequered: this.chequered, ended: this.ended, leaderLap: Math.min(this.leaderLap, this.totalLaps), totalLaps: this.totalLaps,
      pitLoss: +this.cal.pitLoss.toFixed(1), life: this.cal.life, deg: Object.fromEntries(Object.entries(this.cal.deg).map(([k, v]) => [k, +v.toFixed(3)])),
      cars: this.cars.filter((c) => c.ours || c.box || c.mode !== 'standard').map((c) => ({ n: c.n, mode: c.mode, box: c.box, order: c.order, auto: c.auto, lane: !!c.lane, owed: c.owed, puncture: c.puncture, ours: c.ours }))
    };
  }
}
