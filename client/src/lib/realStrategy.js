/**
 * A race strategist on real timing. Real public data has no tyre temperatures or
 * fuel loads, so everything here is estimated from the session itself: pit loss
 * from the stops already made, degradation from each driver's lap times on the
 * current set, tyre life from finished stints, and where a car would rejoin from
 * the live gaps. Only what has happened up to the replay clock is used.
 *
 * Shared by the Strategy page, the team watcher (alerts) and the mock call log.
 */
export const COMP = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
export const COMP_NAME = { S: 'Soft', M: 'Medium', H: 'Hard', I: 'Intermediate', W: 'Wet' };
const DRY = new Set(['S', 'M', 'H']);
// typical stint lengths, used until this session has finished stints of its own on a compound
export const LIFE_FALLBACK = { S: 20, M: 30, H: 40, I: 28, W: 35 };
export const FUEL_S_PER_LAP = 0.06; // a lap's worth of fuel burnt makes the car about this much faster
export const SC_FACTOR = { SC: 0.55, VSC: 0.65 };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** least-squares slope of y on x */
function slope(pts) {
  if (pts.length < 4) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : null;
}

/** session-wide model at clock t: pit loss, tyre life, reference pace (the slow part, recomputed every ~2 s) */
export function sessionModel(data, t, live) {
  const laps = data.laps.filter((l) => l.t <= t);
  const byDriver = new Map();
  for (const l of laps) { let a = byDriver.get(l.n); if (!a) byDriver.set(l.n, a = []); a.push(l); }
  for (const a of byDriver.values()) a.sort((x, y) => x.lap - y.lap);
  const pits = data.pits.filter((p) => p.t <= t);
  const pitLaps = new Set(pits.map((p) => `${p.n}:${p.lap}`));
  const best = Math.min(...laps.filter((l) => !l.pitOut).map((l) => l.time), Infinity);
  const clean = (l) => !l.pitOut && !pitLaps.has(`${l.n}:${l.lap}`) && l.time < best * 1.07;

  // reference green-flag pace per driver: median of the last 5 clean laps
  const ref = new Map();
  for (const [n, a] of byDriver) { const c = a.filter(clean).slice(-5).map((l) => l.time); if (c.length) ref.set(n, median(c)); }
  const fieldRef = median([...ref.values()]) || 90;

  // pit loss: in-lap + out-lap minus two green laps, over every stop made so far
  const losses = [];
  for (const p of pits) {
    const a = byDriver.get(p.n) || [];
    const inLap = a.find((l) => l.lap === p.lap), outLap = a.find((l) => l.lap === p.lap + 1);
    const r = ref.get(p.n);
    if (inLap && outLap && r) { const loss = inLap.time + outLap.time - 2 * r; if (loss > 8 && loss < 45) losses.push(loss); }
  }
  const pitLoss = median(losses) ?? 22;
  // pit-lane time: ignore stops that sat in the lane under a red flag
  const laneTime = median(pits.map((p) => p.duration).filter((d) => d && d < 45));

  // tyre life per compound from stints that have finished
  const curLap = new Map([...byDriver].map(([n, a]) => [n, a.at(-1).lap]));
  const lengths = {};
  for (const s of data.stints) {
    const done = curLap.get(s.n) || 0;
    if (s.to != null && s.to < done) { const c = COMP[s.compound]; if (c) (lengths[c] ||= []).push(s.to - (s.from ?? 1) + 1 + (s.age || 0)); }
  }
  const life = {};
  for (const c of Object.keys(LIFE_FALLBACK)) {
    const L = lengths[c] || [];
    // stints usually end by choice before the tyre is finished, so use the upper quartile
    const q = L.slice().sort((x, y) => x - y)[Math.floor(L.length * 0.75)];
    life[c] = L.length >= 2 ? { laps: q, from: L.length } : { laps: LIFE_FALLBACK[c], from: 0 };
  }

  const totalLaps = live ? null : Math.max(0, ...data.laps.map((l) => l.lap));
  const lapEnd = new Map(laps.map((l) => [`${l.n}:${l.lap}`, l.t]));
  return { lapEnd, byDriver, ref, fieldRef, pitLoss, losses, laneTime, life, totalLaps, curLap, clean, pits };
}

/** the field with numeric gaps, and a plan (call, tyres, rejoin, undercut) for every car */
export function plansFor({ meta, state, rows, data, model }) {
  const isRace = /Race|Sprint/.test(meta.type || meta.name);
  const drivers = new Map((meta.drivers || []).map((d) => [d.n, d]));
  const flag = state.flag || 'GREEN';
  const rain = !!state.weather?.rain;
  const leaderLap = Math.max(0, ...rows.map((r) => r.lap || 0));
  const remaining = model.totalLaps ? Math.max(0, model.totalLaps - leaderLap) : null;
  // under a red flag teams may change tyres in the pit lane at no cost
  const lossNow = flag === 'RED' ? 0 : model.pitLoss * (SC_FACTOR[flag] || 1);

  // numeric gap to the leader for everyone (lapped cars: laps × reference lap). When the
  // timing feed has no gaps (e.g. under a safety car, or just after a seek), fall back to
  // the gap at the line: when each car finished its last lap versus the leader on that lap.
  const leader = rows.find((r) => r.pos === 1);
  const gapOf = (r) => {
    if (r.pos === 1) return 0;
    if (typeof r.gap === 'number') return r.gap;
    const m = /(\d+)\s*LAP/i.exec(String(r.gap || ''));
    if (m) return Number(m[1]) * (model.ref.get(r.n) || model.fieldRef);
    const L = model.curLap.get(r.n), tn = model.lapEnd.get(`${r.n}:${L}`), tl = leader && model.lapEnd.get(`${leader.n}:${L}`);
    return tn && tl ? Math.max(0, (tn - tl) / 1000) : null;
  };
  const field0 = rows.filter((r) => r.pos < 99).map((r) => ({ ...r, g: gapOf(r) }));
  const field = field0.map((r, i) => ({ ...r, int: typeof r.int === 'number' || i === 0 || r.g == null || field0[i - 1].g == null ? r.int : Math.max(0, r.g - field0[i - 1].g) }));

  const plan = (r) => {
    const a = model.byDriver.get(r.n) || [];
    const c = r.tc, age = r.ta ?? 0;
    const stint = (data.stints || []).filter((s) => s.n === r.n && (s.from ?? 1) <= (r.lap || 1));
    const cur = stint.at(-1);
    const stintLaps = cur ? a.filter((l) => l.lap >= (cur.from ?? 1) && model.clean(l)) : [];
    const raw = slope(stintLaps.map((l) => [l.lap, l.time]));
    const deg = raw == null ? null : raw + FUEL_S_PER_LAP;
    const L = model.life[c]?.laps ?? 30;
    const usedDry = new Set(stint.map((s) => COMP[s.compound]).filter((x) => DRY.has(x)));
    const wetRace = stint.some((s) => !DRY.has(COMP[s.compound]));
    const needStop = isRace && !wetRace && usedDry.size < 2 && remaining != null && remaining > 0;

    // where would they rejoin if they boxed this lap?
    let rejoin = null;
    if (r.g != null) {
      const ng = r.g + lossNow;
      const others = field.filter((o) => o.n !== r.n && o.g != null).sort((x, y) => x.g - y.g);
      const ahead = others.filter((o) => o.g <= ng).at(-1), behind = others.find((o) => o.g > ng);
      rejoin = { pos: others.filter((o) => o.g <= ng).length + 1, ahead, behind, gapAhead: ahead ? ng - ahead.g : null, gapBehind: behind ? behind.g - ng : null };
    }
    const freshGain = Math.min(3, Math.max(0.6, (deg ?? 0.08) * age));
    const behindCar = field.find((o) => o.pos === r.pos + 1);
    const aheadCar = field.find((o) => o.pos === r.pos - 1);
    const intBehind = behindCar && typeof behindCar.int === 'number' ? behindCar.int : null;
    const intAhead = typeof r.int === 'number' ? r.int : null;
    const undercutThreat = intBehind != null && intBehind < freshGain + 0.8 && (behindCar.ta ?? 0) >= 6;
    const undercutChance = intAhead != null && r.pos > 1 && intAhead < freshGain + 0.5 && age >= 6;

    // a compound to fit: intermediates in rain, otherwise the softest that reaches the flag
    // (a different dry compound if the rule still requires one)
    const fit = rain ? 'I' : (() => {
      const left = remaining ?? 25;
      const opts = ['S', 'M', 'H'].filter((x) => !(needStop && usedDry.size === 1 && usedDry.has(x)));
      return opts.find((x) => model.life[x].laps >= left) || opts.at(-1) || 'H';
    })();

    let call, tone, kind = 'stay';
    if (!isRace) { call = 'Practice or qualifying: tyre data only'; tone = 'mu'; kind = 'none'; }
    else if (flag === 'RED') { call = rain && DRY.has(c) ? 'Red flag: fit intermediates for free' : 'Red flag: free tyre change in the pit lane'; tone = 'amber'; kind = 'box'; }
    else if (rain && DRY.has(c)) { call = 'Box for intermediates: rain on track'; tone = 'red'; kind = 'box'; }
    else if (!rain && !DRY.has(c) && c && state.weather && !wetRace) { call = 'Watch the crossover to slicks'; tone = 'amber'; }
    else if (remaining != null && remaining <= 1) { call = 'Stay out to the flag'; tone = 'green'; }
    else if (SC_FACTOR[flag] && age >= L * 0.35 && (needStop || age + (remaining ?? 0) > L)) { call = `Box now: cheap stop under ${flag}`; tone = 'red'; kind = 'box'; }
    else if (age >= L * 0.95 && (remaining == null || age + remaining > L * 1.05)) { call = 'Box this lap: tyres at the end of their life'; tone = 'red'; kind = 'box'; }
    else if (undercutThreat && age >= L * 0.6) { call = `Cover the undercut from ${drivers.get(behindCar.n)?.code}`; tone = 'amber'; kind = 'box'; }
    else if (undercutChance && age >= L * 0.6 && rejoin?.gapAhead > 1.5) { call = `Undercut ${drivers.get(aheadCar?.n)?.code}: box now`; tone = 'amber'; kind = 'box'; }
    else if (remaining != null && !needStop && age + remaining <= L * 1.1) { call = 'Stay out: the tyres reach the flag'; tone = 'green'; }
    else { const k = Math.max(1, Math.round(L * 0.8 - age)); call = `Stay out: window opens in ~${k} lap${k === 1 ? '' : 's'}`; tone = 'green'; }
    return { n: r.n, c, age, L, deg, rejoin, needStop, undercutThreat, undercutChance, freshGain, call, tone, kind, fit, behindCar, aheadCar, stintLaps: stintLaps.length };
  };

  const plans = new Map(field.map((r) => [r.n, plan(r)]));
  return { isRace, drivers, flag, rain, leaderLap, remaining, lossNow, field, plans };
}
