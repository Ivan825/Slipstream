/**
 * The race engineer's working layer on top of the race engine:
 *
 *   weather      conditions now, trends, a rain risk from the stewards' forecast and the
 *                station (humidity, pressure, cooling track), and what they mean for tyres
 *   modes        the power-unit / energy mode a car appears to be running (from its own
 *                telemetry: lift-and-coast, full-throttle share, speed-trap loss) and the
 *                mode to ask for, given the battle, the tyres and the flag
 *   targets      the lap times that make the chosen plan work: tyre management (how much
 *                slower to go so the set reaches the stop), the window to stay out of the
 *                DRS of the car behind, and the gap needed for a free stop
 *   monteCarlo   each option run a few hundred times with random safety cars, VSCs and
 *                pace noise: a distribution of finishing positions, not one number
 *   flags        what every flag, penalty, investigation and suspension means for the plan
 *   calls        what the engineer says on the radio to each driver, most urgent first
 *
 * Real timing has no power-unit, fuel or tyre-sensor data: modes, fuel and tyre
 * management are estimates and are labelled as such wherever they are shown.
 */
import { simulate, COMP_OFFSET, DRS_RANGE } from './raceEngine.js';
import { penaltyText } from './incidents.js';
import { replayTrace } from '../store/replay.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const first = (d) => (d?.last || d?.name || d?.code || '').split(' ').pop().replace(/^./, (c) => c.toUpperCase()).replace(/\B[A-Z]+/g, (w) => w.toLowerCase());
const fmt = (s) => { if (s == null || !Number.isFinite(s)) return '—'; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const say = (s) => { if (s == null || !Number.isFinite(s)) return ''; const m = Math.floor(s / 60), r = s - m * 60; return `${m} ${r.toFixed(1)}`; };

/* ---------------- weather ---------------- */
export function weatherInfo(wx = [], t, inc) {
  const list = wx.filter((w) => w.t <= t);
  const cur = list.at(-1) || null;
  if (!cur) return null;
  const at = (ms) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].t <= t - ms) return list[i]; return list[0]; };
  const a10 = at(10 * 60_000), a30 = at(30 * 60_000);
  const d = (k, b) => (cur[k] != null && b?.[k] != null ? cur[k] - b[k] : null);
  const trend = { track: d('track', a10), air: d('air', a10), humidity: d('humidity', a10), pressure: d('pressure', a30) };
  // rain risk: the stewards' forecast, nudged by what the station shows
  let risk = inc?.rainRisk?.pct ?? 10;
  const why = [];
  if (inc?.rainRisk) why.push(`stewards' forecast ${inc.rainRisk.pct}%`);
  if (cur.humidity >= 80) { risk += 15; why.push(`humidity ${Math.round(cur.humidity)}%`); }
  if (trend.humidity != null && trend.humidity > 5) { risk += 10; why.push('humidity rising'); }
  if (trend.pressure != null && trend.pressure < -1) { risk += 10; why.push('pressure falling'); }
  if (trend.track != null && trend.track < -3 && Math.abs(trend.air ?? 0) < 1.5) { risk += 8; why.push('track cooling fast (cloud)'); }
  if (cur.rain) { risk = 100; why.unshift('raining now'); }
  risk = clamp(Math.round(risk), 0, 100);
  // what it means for tyres
  const notes = [];
  if (cur.track >= 50) notes.push(`Track ${Math.round(cur.track)}°C: high thermal degradation, rears suffer on traction`);
  else if (cur.track <= 25) notes.push(`Track ${Math.round(cur.track)}°C: tyres slow to warm, graining risk on the softer compounds`);
  if (trend.track != null && Math.abs(trend.track) >= 3) notes.push(`Track temperature ${trend.track > 0 ? 'up' : 'down'} ${Math.abs(trend.track).toFixed(1)}°C in 10 min: ${trend.track > 0 ? 'degradation will rise' : 'harder compounds may struggle for temperature'}`);
  if (cur.wind >= 5) notes.push(`Wind ${cur.wind.toFixed(1)} m/s: gusts move braking points and DRS effect`);
  const compass = cur.windDir == null ? null : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(cur.windDir / 45) % 8];
  return { cur, trend, risk, why, notes, compass, series: list };
}

/* ---------------- power-unit / energy modes ---------------- */
/** the mode a car appears to be running, from its last two minutes of telemetry and its speed traps */
export function inferMode(n, data, t) {
  const tr = replayTrace.get(n) || [];
  const recent = tr.filter((p) => p.t > t - 95_000);
  let lc = 0, run = 0, full = 0, fast = 0;
  for (let i = 0; i < recent.length; i++) {
    const p = recent[i];
    if (p.v > 120) { fast++; if (p.thr >= 98) full++; }
    // lift and coast: off the throttle, off the brakes, at speed, just before a braking point
    if (p.v > 200 && p.thr < 10 && !p.brk) run++;
    else {
      if (run >= 2 && p.brk) lc++;
      run = 0;
    }
  }
  const laps = (data?.laps || []).filter((l) => l.n === n && l.t <= t && l.st);
  const lastSt = laps.at(-1)?.st ?? null;
  const bestSt = laps.length ? Math.max(...laps.map((l) => l.st)) : null;
  const trapLoss = lastSt != null && bestSt != null ? bestSt - lastSt : null;
  const fullPct = fast ? full / fast : null;
  let mode = 'Standard', tone = 'mu', why = 'normal deployment';
  if (lc >= 2) { mode = 'Lift & coast'; tone = 'amber'; why = `${lc} lifts before braking zones in the last lap: saving fuel, energy or brakes`; }
  else if (trapLoss != null && trapLoss >= 7) { mode = 'Harvest'; tone = 'cyan'; why = `speed trap ${trapLoss} km/h down on its best: recharging or a lower engine mode`; }
  else if (trapLoss != null && trapLoss <= 1 && fullPct != null && fullPct > 0.55) { mode = 'Push'; tone = 'red'; why = 'full deployment: top speed at its best'; }
  return { mode, tone, why, lc, trapLoss, fullPct, lastSt, bestSt, samples: recent.length };
}

/** the mode to ask for: battle, flag, tyre and pit context */
export function recommendMode(n, eng, tg) {
  const flag = eng.s.flag;
  const p = eng.s.plans.get(n);
  const b = eng.battles.get(n) || [];
  const me = eng.proj.cars.get(n);
  const mates = new Set(eng.ours.map((d) => d.n));
  const under = b.find((x) => x.behind && x.inRange && !mates.has(x.rival));
  const attack = b.find((x) => !x.behind && x.inRange && x.paceNow < 0 && !mates.has(x.rival));
  const mate = b.find((x) => mates.has(x.rival) && x.inRange);
  if (flag === 'RED') return { mode: 'Engine off', energy: '—', tyre: 'Blankets on', why: 'red flag: cars in the pit lane', tone: 'red' };
  if (flag === 'SC' || flag === 'VSC') return { mode: flag === 'VSC' ? 'VSC delta mode' : 'SC mode', energy: 'Harvest', tyre: 'Keep temperature (weave, brake)', why: 'stay positive to the delta, bank energy for the restart', tone: 'amber' };
  if (p?.kind === 'box' && p.tone === 'red' && flag === 'GREEN') return { mode: 'In-lap push', energy: 'Deploy all', tyre: 'Use what is left', why: 'box this lap: every tenth on the in-lap counts', tone: 'red' };
  if (me && me.pr.age <= 1) return { mode: 'Out-lap push', energy: 'Deploy', tyre: 'Bring the tyres in', why: 'fresh set: build temperature, beat the undercut', tone: 'red' };
  if (under) return { mode: 'Defend: overtake mode', energy: 'Deploy on the straights', tyre: 'Push', why: `car behind within ${Math.abs(under.gapNow).toFixed(1)} s: hold the DRS zone`, tone: 'red' };
  if (attack) return { mode: 'Attack: overtake mode', energy: `Deploy into ${attack.zone?.label || 'the main straight'}`, tyre: 'Push', why: `within ${Math.abs(attack.gapNow).toFixed(1)} s of the car ahead and quicker`, tone: 'green' };
  if (mate) return { mode: 'Hold position', energy: 'Balanced', tyre: 'Manage', why: `team-mate within ${Math.abs(mate.gapNow).toFixed(1)} s: no fighting, the pit wall will call any swap`, tone: 'mu' };
  if (tg && tg.m >= 0.15) return { mode: 'Tyre save', energy: 'Balanced', tyre: `Manage +${tg.m.toFixed(1)} s/lap`, why: `the set must last ${tg.stintLen} more laps (life ~${tg.L})`, tone: 'amber' };
  const gapA = me?.r.int, gapB = b.find((x) => x.behind)?.gapNow;
  if ((typeof gapA !== 'number' || gapA > 3) && (gapB == null || Math.abs(gapB) > 3)) return { mode: 'Standard', energy: 'Harvest when free', tyre: 'Look after them', why: 'clean air both ways: recharge and save the tyres', tone: 'mu' };
  return { mode: 'Race mode', energy: 'Balanced', tyre: 'Normal', why: 'gaps stable', tone: 'mu' };
}

/* ---------------- targets and tyre management ---------------- */
// managing the tyres by m s/lap stretches their life by about 40% per second (and costs m s per lap)
const LIFE_PER_SEC = 0.4;

export function targetsFor(n, eng) {
  const me = eng.proj.cars.get(n);
  if (!me) return null;
  const R = eng.R;
  const opt = eng.options.get(n)?.[0];
  const stops = opt?.stops ?? me.stops;
  const stintLen = Math.max(0, (stops[0]?.lap ?? R) - 0);
  const L = me.pr.life(me.pr.c), age = me.pr.age;
  const need = age + stintLen;
  const m = need > L ? clamp((need / L - 1) / LIFE_PER_SEC, 0, 1.2) : 0;
  const sim = simulate(me.pr, Math.max(1, R), stops, eng.proj.lossFor);
  const laps = [];
  for (let k = 1; k <= Math.min(5, Math.max(1, R)); k++) {
    if (stops.some((x) => x.lap === k)) { laps.push({ k, lap: (me.r.lap || 0) + k, t: null, note: 'in-lap: push to the line' }); continue; }
    laps.push({ k, lap: (me.r.lap || 0) + k, t: sim.lap[k] + (k <= stintLen ? m : 0) });
  }
  const target = laps.find((x) => x.t != null)?.t ?? null;
  // gap discipline
  const behind = eng.proj.cars.get([...eng.proj.cars.values()].find((c) => c.r.pos === me.r.pos + 1)?.r.n);
  const ahead = eng.proj.cars.get([...eng.proj.cars.values()].find((c) => c.r.pos === me.r.pos - 1)?.r.n);
  const intBehind = behind && typeof behind.r.int === 'number' ? behind.r.int : null;
  const intAhead = typeof me.r.int === 'number' ? me.r.int : null;
  const bPace = behind ? behind.sim.lap[1] : null;
  // slowest lap that keeps the car behind out of DRS for five laps
  const drsLimit = intBehind != null && bPace ? bPace + (intBehind - DRS_RANGE) / 5 : null;
  // for a free stop the car behind must be at least a pit loss back
  const freeStopShort = intBehind != null ? Math.max(0, eng.s.lossNow + (me.pen || 0) - intBehind) : null;
  const freeStopPerLap = freeStopShort != null && stintLen > 0 ? freeStopShort / stintLen : null;
  const aPace = ahead ? ahead.sim.lap[1] : null;
  const catchIn = intAhead != null && aPace && target && target < aPace ? Math.ceil(Math.max(0, intAhead - DRS_RANGE) / (aPace - target)) : null;
  const last = me.r.last ?? null;
  // a lap behind the safety car, in the pits or under a red flag says nothing about pace
  const delta = last != null && target != null && Math.abs(last - target) < 4 ? last - target : null;
  const conflict = drsLimit != null && target != null && target > drsLimit + 0.05;
  return {
    n, m, L, age, stintLen, target, laps, band: target ? [target - 0.15, target + 0.15] : null, cost: m * stintLen,
    drsLimit, conflict, freeStopShort, freeStopPerLap, catchIn, last, delta, behind: behind?.r.n, ahead: ahead?.r.n, intBehind, intAhead
  };
}

/* ---------------- Monte Carlo: safety cars, VSCs and pace noise ---------------- */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/**
 * Each of the top options run `sims` times. Per lap a safety car comes out with
 * probability `sc` (a VSC with `vsc`): under it a stop costs ~55% (VSC ~65%),
 * cars due to stop within eight laps stop then, and a safety car closes the field
 * up. Lap-time noise of 0.3 s per lap per car on top.
 */
export function monteCarlo(n, eng, { sims = 160, sc = 0.012, vsc = 0.008, seed = 1, top = 4 } = {}) {
  const R = eng.R;
  const me = eng.proj.cars.get(n);
  const opts = (eng.options.get(n) || []).slice(0, top);
  if (!me || R < 2 || !opts.length) return null;
  const r = rng(seed);
  const others = [...eng.proj.cars.values()].filter((c) => c.r.n !== n);
  const loss = eng.model.pitLoss;
  const res = opts.map(() => ({ pos: [], scHelped: 0 }));
  let scRuns = 0;
  const adapt = (stops, k) => (k == null ? stops : stops.map((x) => (x.lap >= k && x.lap <= k + 8 && x.lap !== k ? { ...x, lap: k } : x)));
  for (let i = 0; i < sims; i++) {
    let k = null, kind = null;
    for (let lap = 1; lap <= R; lap++) { const u = r(); if (u < sc) { k = lap; kind = 'SC'; break; } if (u < sc + vsc) { k = lap; kind = 'VSC'; break; } }
    if (k) scRuns++;
    const lossFor = (lap) => (lap === k ? loss * (kind === 'SC' ? 0.55 : 0.65) : lap === 1 ? eng.s.lossNow : loss);
    const run = (c, stops) => {
      const sim = simulate(c.pr, R, adapt(stops, k), lossFor);
      let total = sim.total + (c.pen || 0) + gauss(r) * 0.3 * Math.sqrt(R);
      return { atK: k ? sim.cum[k] : null, after: k ? sim.total - sim.cum[k] : null, total };
    };
    const field = others.map((c) => ({ c, ...run(c, c.stops) }));
    const mine = opts.map((o) => ({ ...run(me, o.stops), o }));
    // a safety car bunches the field behind the leader at that lap
    const close = (list) => {
      if (kind !== 'SC') return list.map((x) => x.total);
      const order = [...list].sort((a, b) => a.atK - b.atK);
      const lead = order[0].atK;
      const rank = new Map(order.map((x, j) => [x, j]));
      return list.map((x) => lead + rank.get(x) * 0.7 + x.after + (x.total - x.atK - x.after));
    };
    mine.forEach((m, j) => {
      const all = [...field, m];
      const totals = close(all);
      const myT = totals[totals.length - 1];
      const pos = 1 + totals.slice(0, -1).filter((x) => x < myT).length;
      res[j].pos.push(pos);
      if (k && pos < (m.o.pos || 99)) res[j].scHelped++;
    });
  }
  return opts.map((o, j) => {
    const p = res[j].pos.sort((a, b) => a - b);
    const P = (x) => p.filter((v) => v <= x).length / p.length;
    return {
      id: o.id, letter: o.letter, title: o.title, exp: p.reduce((a, b) => a + b, 0) / p.length, p10: p[Math.floor(p.length * 0.1)], p90: p[Math.floor(p.length * 0.9)],
      best: p[0], worst: p.at(-1), pWin: P(1), pPodium: P(3), pPoints: P(10), pAhead: P(me.r.pos), hist: hist(p), scShare: scRuns / sims
    };
  });
}
function hist(p) { const h = new Map(); for (const v of p) h.set(v, (h.get(v) || 0) + 1); return [...h].sort((a, b) => a[0] - b[0]); }

/* ---------------- flags, penalties and incidents ---------------- */
export function flagCalls(eng, drivers) {
  const out = [];
  const { s, inc } = eng;
  const code = (n) => drivers.get(n)?.code || `#${n}`;
  const ours = eng.ours.map((d) => d.n);
  const flag = s.flag;
  const opts = (n) => eng.options.get(n) || [];
  if (flag === 'SC' || flag === 'VSC') {
    for (const n of ours) {
      const list = opts(n);
      const boxNow = list.find((o) => o.stops[0]?.lap === 1);
      const stay = list.find((o) => !o.stops.length || o.stops[0].lap > 1);
      if (boxNow && stay) {
        const gain = stay.total - boxNow.total;
        out.push({ n, tone: gain > 0 ? 'red' : 'green', kind: 'sc', title: gain > 0 ? `${code(n)}: box under the ${flag} for ${boxNow.stops[0].c}` : `${code(n)}: stay out under the ${flag}`, text: `${gain > 0 ? 'Stopping now' : 'Staying out'} is worth ~${Math.abs(gain).toFixed(1)} s (stop costs ~${s.lossNow.toFixed(0)} s now vs ${eng.model.pitLoss.toFixed(0)} s green) · projected P${(gain > 0 ? boxNow : stay).pos}`, voice: gain > 0 ? `${first(drivers.get(n))}, ${flag === 'VSC' ? 'VSC' : 'safety car'}, box box, box box.` : `${first(drivers.get(n))}, stay out, stay out.` });
      }
    }
    const both = ours.filter((n) => (opts(n)[0]?.stops[0]?.lap === 1));
    if (both.length === 2) out.push({ tone: 'amber', kind: 'stack', title: `Double stack under the ${flag}: ${code(both[0])} then ${code(both[1])}`, text: 'Second car loses ~2–4 s waiting at the box; under a safety car the field is bunched, so check it doesn\'t drop behind the cars that stay out.' });
  }
  if (flag === 'RED') {
    for (const n of ours) {
      const me = eng.proj.cars.get(n);
      if (!me) continue;
      const R = eng.R;
      const fit = ['H', 'M', 'S'].filter((c) => me.pr.life(c) >= R).reverse()[0] || 'H';
      out.push({ n, tone: 'amber', kind: 'red', title: `${code(n)}: red flag, free tyre change`, text: `${R} laps left: fit ${fit}${me.p.needStop ? ' (counts as the second compound)' : ''}; the restart is from the grid order of the suspension.`, voice: `${first(drivers.get(n))}, red flag, red flag. Come to the pit lane.` });
    }
    if (inc.restart) out.push({ tone: 'cyan', kind: 'restart', title: `Restart ${inc.restart.at ? `at ${inc.restart.at}` : 'announced'}${inc.restart.standing ? ' · standing start' : inc.restart.rolling ? ' · rolling start' : ''}`, text: 'Tyres in blankets, clutch and start procedure ready, energy topped up.' });
  }
  if (inc.scEnding && flag !== 'GREEN') out.push({ tone: 'amber', kind: 'restart', title: inc.scEnding.vsc ? 'VSC ending' : 'Safety car in this lap', text: 'Tyre and brake temperatures up, energy for the restart, DRS back two laps after the restart.', voice: inc.scEnding.vsc ? 'VSC ending, VSC ending. Get ready.' : 'Safety car in this lap. Prepare for the restart.' });
  // penalties
  for (const [n, ps] of inc.penalties) {
    const txt = penaltyText(ps);
    if (!txt) continue;
    const mine = ours.includes(n);
    const me = eng.proj.cars.get(n);
    if (mine) {
      const behind = [...eng.proj.cars.values()].find((c) => c.r.pos === (me?.r.pos || 0) + 1);
      const need = ps.filter((p) => !p.served).reduce((a, p) => a + p.cost, 0);
      out.push({ n, tone: 'red', kind: 'pen', title: `${code(n)}: ${txt}`, text: `${ps.at(-1).reason || ''} · costs ~${need.toFixed(0)} s${behind && typeof behind.r.int === 'number' ? `: ${behind.r.int.toFixed(1)} s to ${code(behind.r.n)} behind, build ${Math.max(0, need - behind.r.int).toFixed(1)} s more` : ''}`, voice: `${first(drivers.get(n))}, we have a ${txt}. Push, we need a gap.` });
    } else if (me) {
      const near = ours.map((o) => eng.proj.cars.get(o)).filter((o) => o && Math.abs(o.r.pos - me.r.pos) <= 3);
      for (const o of near) out.push({ n: o.r.n, tone: 'green', kind: 'rivalpen', title: `${code(n)} has a ${txt}`, text: `${o.r.pos > me.r.pos ? `${code(o.r.n)} only needs to finish within ${ps.filter((p) => !p.served).reduce((a, p) => a + p.cost, 0).toFixed(0)} s of ${code(n)} to beat him` : `${code(o.r.n)} is ahead and gains the penalty at the flag`}.`, voice: `${first(drivers.get(o.r.n))}, ${code(n)} has a penalty.` });
    }
  }
  // investigations involving our cars
  for (const i of inc.investigations) {
    const mine = i.cars.filter((n) => ours.includes(n));
    if (!mine.length) continue;
    out.push({ n: mine[0], tone: 'amber', kind: 'inv', title: `Under investigation: ${i.cars.map(code).join(' & ')}`, text: `${i.reason || 'incident'}${i.where ? ` at ${i.where.toLowerCase()}` : ''}. Build a 5 s margin in case of a penalty.` });
  }
  // track limits
  for (const n of ours) {
    const tl = inc.trackLimits.get(n);
    if (!tl || tl.count < 2) continue;
    const corner = [...tl.corners].sort((a, b) => b[1] - a[1])[0]?.[0];
    out.push({ n, tone: tl.count >= 3 ? 'red' : 'amber', kind: 'tl', title: `${code(n)}: ${tl.count} track-limits strikes${tl.bw ? ' · black-and-white flag' : ''}`, text: `${tl.count >= 3 ? 'The next one is a 5 s penalty' : 'Third one brings the black-and-white flag'} · mostly at ${corner?.toLowerCase() || 'one corner'}.`, voice: `${first(drivers.get(n))}, careful with track limits at ${corner?.toLowerCase() || 'that corner'}.` });
  }
  // blue flags for our cars (last 40 s)
  for (const n of ours) {
    const bt = inc.blue.get(n);
    if (bt != null && eng.state.t - bt < 40_000) out.push({ n, tone: 'cyan', kind: 'blue', title: `Blue flags for ${code(n)}`, text: 'Let the leaders through without losing time: lift on a straight, not in a corner.', voice: `${first(drivers.get(n))}, blue flags, let them by.` });
  }
  // yellow sectors
  if (eng.state.yellows?.length) out.push({ tone: 'amber', kind: 'yellow', title: `Yellow in marshal sector${eng.state.yellows.length > 1 ? 's' : ''} ${eng.state.yellows.map((y) => y.sector).join(', ')}`, text: 'No overtaking, slow down; a double yellow means be prepared to stop. Laps there may be investigated.' });
  if (inc.drs && !inc.drs.on && flag === 'GREEN') out.push({ tone: 'mu', kind: 'drs', title: 'DRS disabled', text: 'Overtaking much harder: track position is worth more, the undercut is the main weapon.' });
  return out;
}

/* ---------------- what the engineer says ---------------- */
export function radioCalls(eng, { drivers, wx, flags, targets, modes }) {
  const calls = [];
  const { s } = eng;
  for (const d of eng.ours) {
    const n = d.n, name = first(d);
    const me = eng.proj.cars.get(n);
    if (!me) continue;
    const tg = targets.get(n), md = modes.get(n);
    const opt = eng.options.get(n)?.[0];
    const b = eng.battles.get(n) || [];
    const add = (prio, kind, text, voice = text) => calls.push({ n, code: d.code, color: d.color, prio, kind, text, voice });
    for (const f of flags.filter((x) => x.n === n && x.voice)) add(f.tone === 'red' ? 0 : 1, f.kind, f.title + '. ' + f.text, f.voice);
    const p = s.plans.get(n);
    if (p?.kind === 'box' && p.tone === 'red' && s.flag !== 'SC' && s.flag !== 'VSC') add(0, 'box', `Box this lap: ${p.call}. Fit ${p.fit}.`, `${name}, box box, box box. ${p.fit === 'H' ? 'Hards' : p.fit === 'M' ? 'Mediums' : p.fit === 'S' ? 'Softs' : 'Inters'}.`);
    if (opt) add(3, 'plan', `Plan ${opt.letter}: ${opt.title} (projected P${opt.pos}).`, `${name}, we're on plan ${opt.letter}. ${opt.title}.`);
    if (tg?.target) {
      const dl = tg.delta;
      add(2, 'target', `Target ${fmt(tg.target)}${tg.m >= 0.1 ? `, managing ${tg.m.toFixed(1)} a lap for the tyres` : ''}.${dl != null ? ` Last lap ${dl > 0 ? '+' : ''}${dl.toFixed(1)} to target.` : ''}${tg.conflict ? ` Car behind needs ${fmt(tg.drsLimit)} or faster to stay out of DRS.` : ''}`,
        `${name}, target ${say(tg.target)}${dl != null && Math.abs(dl) > 0.3 ? `, you're ${Math.abs(dl).toFixed(1)} ${dl > 0 ? 'off' : 'under'}` : ''}${tg.m >= 0.2 ? '. Look after the rears' : ''}.`);
    }
    if (md) add(2, 'mode', `Mode: ${md.mode}. Energy ${md.energy.toLowerCase()}, tyres ${md.tyre.toLowerCase()}: ${md.why}.`, `${name}, ${md.mode}.`);
    const mates = new Set(eng.ours.map((o) => o.n));
    const behind = b.find((x) => x.behind && Math.abs(x.gapNow) < 3 && !mates.has(x.rival));
    const ahead = b.find((x) => !x.behind && Math.abs(x.gapNow) < 3 && !mates.has(x.rival));
    if (behind) { const r = drivers.get(behind.rival); add(1, 'gapb', `Gap to ${r?.code} behind ${Math.abs(behind.gapNow).toFixed(1)}. ${behind.paceNow > 0.05 ? `He's ${behind.paceNow.toFixed(1)} a lap quicker` : "You're matching his pace"}${behind.ageDiff ? `; his tyres are ${Math.abs(behind.ageDiff)} laps ${behind.ageDiff > 0 ? 'fresher' : 'older'}` : ''}.`, `Gap behind ${Math.abs(behind.gapNow).toFixed(1)}, ${first(r)}.`); }
    if (ahead) { const r = drivers.get(ahead.rival); add(2, 'gapa', `${r?.code} ahead, ${Math.abs(ahead.gapNow).toFixed(1)}. ${ahead.paceNow < -0.05 ? `Catching ${(-ahead.paceNow).toFixed(1)} a lap` : 'Same pace'}; best place: ${ahead.zone?.label || 'main straight'}.`, `${first(r)} ahead, ${Math.abs(ahead.gapNow).toFixed(1)}.`); }
    const threat = b.find((x) => x.kind === 'pass-us' && x.swapLap != null && x.swapLap <= 4 && !mates.has(x.rival));
    if (threat) { const r = drivers.get(threat.rival); add(1, 'threat', `${r?.code} projected to attack in ${threat.swapLap} lap${threat.swapLap > 1 ? 's' : ''}, most likely ${threat.zone?.label || 'on the main straight'}.`, `${first(r)} is coming. Defend ${threat.zone?.into ? `into turn ${threat.zone.into.n}` : 'the inside'}.`); }
    if (wx && wx.risk >= 40) add(wx.risk >= 70 ? 1 : 3, 'wx', `Rain risk ${wx.risk}%: ${wx.why.join(', ')}.`, `${name}, rain risk ${wx.risk} percent. Tell us what you see.`);
  }
  return calls.sort((a, b) => a.prio - b.prio);
}

/* ---------------- the whole layer, memoised with the engine ---------------- */
const memo = new Map();
export function engineer(eng, drivers) {
  if (!eng) return null;
  if (memo.has(eng)) return memo.get(eng);
  const t = eng.state.t || 0;
  const wx = weatherInfo(eng.data.weather || [], t, eng.inc);
  const targets = new Map(eng.focus.map((n) => [n, targetsFor(n, eng)]));
  const modes = new Map(eng.focus.map((n) => [n, recommendMode(n, eng, targets.get(n))]));
  const inferred = new Map([...eng.proj.cars.keys()].map((n) => [n, inferMode(n, eng.data, t)]));
  const flags = flagCalls(eng, drivers);
  const seed = Math.floor(t / 2000);
  const mc = new Map(eng.s.isRace ? eng.focus.map((n) => [n, monteCarlo(n, eng, { seed })]) : []);
  const calls = radioCalls(eng, { drivers, wx, flags, targets, modes });
  const v = { wx, targets, modes, inferred, flags, mc, calls };
  memo.set(eng, v);
  if (memo.size > 4) memo.delete(memo.keys().next().value);
  return v;
}

export { fmt as lapFmt, COMP_OFFSET };
