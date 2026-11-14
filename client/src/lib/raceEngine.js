/**
 * The race engineer's forward look on real timing, built on the strategist's
 * session model (realStrategy.js):
 *
 *   projection   every car lap by lap to the flag: its pace now, its tyre
 *                degradation and cliff, fuel burn and the stop it is likely to make
 *   battles      who catches whom, on which lap, and where on the circuit an
 *                overtake would happen (the overtaking zones), with a probability
 *                from the pace difference at that moment
 *   options      every sensible strategy for one of our cars (stay out, one stop
 *                on any lap and compound, two stops), ranked by projected race
 *                time and finishing position against the rest of the field
 *   priority     for a two-car team: which car to look after first, who stops
 *                first, whether a double stack is affordable, and team orders
 *
 * All of it is an estimate from public timing: no fuel loads, tyre temperatures
 * or the teams' own models. It is recomputed every couple of seconds.
 */
import { sessionModel, plansFor, FUEL_S_PER_LAP } from './realStrategy.js';
import { teamDrivers } from './teams.js';

const DEG_DEFAULT = { S: 0.1, M: 0.065, H: 0.045, I: 0.08, W: 0.06 };
// fresh-tyre pace relative to a medium (dry compounds)
export const COMP_OFFSET = { S: -0.45, M: 0, H: 0.35, I: 0, W: 0.9 };
const CLIFF = 0.18; // extra seconds per lap past the tyre's life: grows quadratically for 8 laps, then linearly
const STATIONARY_S = 2.6; // a typical stop at the box; the second car of a double stack waits about this
export const DRS_RANGE = 1.0;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sig = (x) => 1 / (1 + Math.exp(-x));

/** total laps: from the session, else the FIA rule (fewest laps over 305 km) when the lap length is known */
export function totalLapsOf(meta, model) {
  if (meta?.totalLaps) return { laps: meta.totalLaps, est: false };
  if (model?.totalLaps && !meta?.live) return { laps: model.totalLaps, est: false };
  if (/Race$/.test(meta?.type || '') && meta?.info?.length) return { laps: Math.ceil(305_000 / meta.info.length), est: true };
  if (/Sprint$/.test(meta?.type || '') && meta?.info?.length) return { laps: Math.ceil(100_000 / meta.info.length), est: true };
  return { laps: null, est: false };
}

/** per-car pace profile from the strategist's plan */
function profile(r, p, model) {
  const c = p.c || 'M';
  const life = model.life;
  const degOf = (x) => {
    if (x === c && p.deg != null && p.stintLaps >= 5) return clamp(p.deg, 0.01, 0.35);
    return DEG_DEFAULT[x] ?? 0.07;
  };
  const ref = model.ref.get(r.n) ?? model.fieldRef;
  // pace on a fresh medium, no extra fuel, at this moment
  const base0 = ref - degOf(c) * p.age - (COMP_OFFSET[c] || 0);
  return { n: r.n, c, age: p.age, g: r.g, pos: r.pos, base0, degOf, life: (x) => life[x]?.laps ?? 30, ref };
}

/** cumulative race time (from the leader's line now) after each of the next R laps */
export function simulate(pr, R, stops, lossFor) {
  const cum = new Float64Array(R + 1);
  const lap = new Float64Array(R + 1);
  let c = pr.c, age = pr.age, t = pr.g ?? 0, si = 0;
  cum[0] = t;
  for (let k = 1; k <= R; k++) {
    age++;
    const L = pr.life(c), over = Math.max(0, age - L);
    const cliff = over <= 8 ? CLIFF * over * over * 0.5 : CLIFF * (32 + (over - 8) * 8);
    let lt = pr.base0 + (COMP_OFFSET[c] || 0) + pr.degOf(c) * age + cliff - FUEL_S_PER_LAP * k;
    if (si < stops.length && stops[si].lap === k) { lt += lossFor(k); c = stops[si].c; age = 0; si++; }
    lap[k] = lt; t += lt; cum[k] = t;
  }
  return { cum, lap, total: t };
}

/** the stop a rival is likely to make, from its plan */
function defaultStops(pr, p, R) {
  if (R <= 1) return [];
  if (p.kind === 'box') return [{ lap: 1, c: p.fit }];
  const L = pr.life(pr.c);
  if (!p.needStop && pr.age + R <= L * 1.2) return []; // teams stretch a set further than its typical life when it saves a stop
  const lap = clamp(Math.round(L * 0.85 - pr.age), 1, Math.max(1, R - 2));
  return [{ lap, c: p.fit }];
}

/**
 * Project the whole field. Returns per-car simulations, the projected order at
 * the flag and helpers for gap lookups.
 */
export function projectField({ s, model, R }) {
  const lossFor = (k) => (k === 1 ? s.lossNow : model.pitLoss);
  const cars = new Map();
  for (const r of s.field) {
    const p = s.plans.get(r.n);
    if (!p || r.g == null) continue;
    const pr = profile(r, p, model);
    const stops = s.isRace ? defaultStops(pr, p, R) : [];
    cars.set(r.n, { r, p, pr, stops, sim: simulate(pr, R, stops, lossFor) });
  }
  const order = [...cars.values()].sort((a, b) => a.sim.total - b.sim.total);
  order.forEach((c, i) => { c.projPos = i + 1; });
  return { cars, order, R, lossFor };
}

/**
 * Battles for one of our cars against the cars around it: when the gap comes
 * into overtaking range, when the cars would swap (on track or through a stop),
 * where on the lap, and how likely an on-track pass is.
 */
export function battlesFor(n, proj, circuit, { otDelta = null } = {}) {
  const me = proj.cars.get(n);
  if (!me) return [];
  const R = proj.R;
  // harder tracks need a bigger pace advantage; DRS and long straights make it easier
  const easy = circuit?.zones?.length ? clamp(circuit.zones[0].m / 900, 0.4, 1.2) : 0.8;
  const need = otDelta ?? clamp(0.55 - 0.25 * easy - (circuit?.hasDrs ? 0.1 : 0), 0.15, 0.6);
  const out = [];
  for (const o of proj.cars.values()) {
    if (o.r.n === n || Math.abs(o.r.pos - me.r.pos) > 3) continue;
    const behind = o.r.pos > me.r.pos;
    // positive: the other car is behind us by that many seconds
    const gapAt = (k) => o.sim.cum[k] - me.sim.cum[k];
    const g0 = gapAt(0);
    let catchLap = null, swapLap = null, via = null, delta = null;
    for (let k = 1; k <= R; k++) {
      const g = gapAt(k);
      const stopMe = me.stops.some((x) => x.lap === k), stopO = o.stops.some((x) => x.lap === k);
      if (catchLap == null && Math.abs(g) <= DRS_RANGE && Math.abs(gapAt(k - 1)) > DRS_RANGE && !stopMe && !stopO) catchLap = k;
      if (Math.sign(g) !== Math.sign(gapAt(k - 1)) && gapAt(k - 1) !== 0) {
        swapLap = k;
        via = stopMe || stopO ? (stopMe ? 'our stop' : 'their stop') : 'on track';
        delta = Math.abs(me.sim.lap[k] - o.sim.lap[k]);
        break;
      }
    }
    if (catchLap == null && swapLap == null && Math.abs(g0) > DRS_RANGE) continue;
    const paceNow = (me.sim.lap[1] || 0) - (o.sim.lap[1] || 0); // >0: they are faster
    const kRef = swapLap ?? catchLap ?? 1;
    const d = delta ?? Math.abs((me.sim.lap[kRef] || 0) - (o.sim.lap[kRef] || 0));
    const prob = via && via !== 'on track' ? 0.9 : clamp(sig((d - need) / 0.12), 0.03, 0.9);
    const zone = circuit?.zones?.[0] || null;
    // what the swap means for us
    const kind = via === 'on track' ? (behind ? 'pass-us' : 'we-pass') : via === 'our stop' ? (behind ? 'lose-at-stop' : 'gain-at-stop') : via === 'their stop' ? (behind ? 'undercut' : 'gain-at-stop') : 'range';
    out.push({
      rival: o.r.n, behind, gapNow: g0, paceNow, catchLap, swapLap, via, prob, zone, alt: circuit?.zones?.[1] || null, kind,
      inRange: Math.abs(g0) <= DRS_RANGE, threat: behind && (kind === 'pass-us' || kind === 'undercut' || Math.abs(g0) <= DRS_RANGE), held: via === 'on track' && prob < 0.35,
      ourLap: me.r.lap || 0, ageDiff: (me.pr.age ?? 0) - (o.pr.age ?? 0), oc: o.pr.c, mc: me.pr.c
    });
  }
  return out.sort((a, b) => (a.swapLap ?? a.catchLap ?? 99) - (b.swapLap ?? b.catchLap ?? 99));
}

/**
 * Strategy options for one car, best first. Rivals keep their likely plans.
 */
export function optionsFor(n, proj, s) {
  const me = proj.cars.get(n);
  if (!me || !s.isRace) return [];
  const R = proj.R;
  if (R < 2) return [{ id: 'flag', title: 'Stay out to the flag', stops: [], total: me.sim.total, pos: me.projPos, delta: 0, risk: 'low', notes: [] }];
  const used = new Set((me.p.usedDry && [...me.p.usedDry]) || []);
  const rain = s.rain;
  const comps = rain ? ['I', 'W'] : ['S', 'M', 'H'];
  const others = [...proj.cars.values()].filter((c) => c.r.n !== n);
  const finals = others.map((c) => c.sim.total).sort((a, b) => a - b);
  const posOf = (total) => 1 + finals.filter((x) => x < total).length;
  const ruleOk = (stops) => !me.p.needStop || rain || stops.some((x) => !used.has(x.c) && x.c !== me.pr.c);
  const run = (stops) => simulate(me.pr, R, stops, proj.lossFor);
  const rejoinTraffic = (k, sim) => {
    if (k == null) return null;
    const t = sim.cum[k];
    let close = null;
    for (const o of others) { const d = t - o.sim.cum[k]; if (d > 0 && d < 1.5 && (!close || d < close.d)) close = { n: o.r.n, d }; }
    return close;
  };
  const cands = [];
  const add = (id, title, stops) => {
    if (!ruleOk(stops)) return;
    const sim = run(stops);
    const k = stops[0]?.lap ?? null;
    let overLife = (k ?? R) + me.pr.age > me.pr.life(me.pr.c) * 1.05;
    stops.forEach((x, i) => { const len = (stops[i + 1]?.lap ?? R) - x.lap; if (len > me.pr.life(x.c) * 1.05) overLife = true; });
    cands.push({ id, title, stops, sim, total: sim.total, pos: posOf(sim.total), traffic: rejoinTraffic(k, sim), overLife });
  };
  if (!me.p.needStop) add('none', 'No stop: run to the flag', []);
  for (const c of comps) {
    let best = null;
    for (let k = 1; k <= R - 2; k++) {
      const sim = run([{ lap: k, c }]);
      if (!ruleOk([{ lap: k, c }])) break;
      if (!best || sim.total < best.total) best = { k, total: sim.total };
    }
    if (best) add(`1-${c}-${best.k}`, best.k === 1 ? `Box now for ${c}` : `One stop: lap ${(me.r.lap || 0) + best.k} for ${c}`, [{ lap: best.k, c }]);
  }
  // box now on the best compound (the undercut), and extending five laps past the best window (the overcut)
  const bestOne = cands.filter((x) => x.stops.length === 1).sort((a, b) => a.total - b.total)[0];
  const nowC = comps.filter((c) => ruleOk([{ lap: 1, c }])).map((c) => ({ c, t: run([{ lap: 1, c }]).total })).sort((a, b) => a.t - b.t)[0]?.c;
  if (nowC && !(bestOne && bestOne.stops[0].lap === 1 && bestOne.stops[0].c === nowC)) add(`now-${nowC}`, `Box now for ${nowC} (undercut)`, [{ lap: 1, c: nowC }]);
  if (bestOne && bestOne.stops[0].lap + 5 <= R - 2) add(`ext-${bestOne.stops[0].c}`, `Extend 5 laps, then ${bestOne.stops[0].c} (overcut)`, [{ lap: bestOne.stops[0].lap + 5, c: bestOne.stops[0].c }]);
  if (R >= 16) {
    let two = [];
    for (const c1 of comps) for (const c2 of comps) {
      let best = null;
      for (let k1 = 2; k1 <= R - 10; k1 += 2) for (let k2 = k1 + 7; k2 <= R - 3; k2 += 2) {
        const st = [{ lap: k1, c: c1 }, { lap: k2, c: c2 }];
        if (!ruleOk(st)) continue;
        const sim = run(st);
        if (!best || sim.total < best.total) best = { st, total: sim.total };
      }
      if (best) two.push(best);
    }
    two.sort((a, b) => a.total - b.total).slice(0, 2).forEach((b) => add(`2-${b.st.map((x) => x.c + x.lap).join('-')}`, `Two stops: lap ${(me.r.lap || 0) + b.st[0].lap} ${b.st[0].c}, lap ${(me.r.lap || 0) + b.st[1].lap} ${b.st[1].c}`, b.st));
  }
  // the strategist's current call, so a switch is visible against it
  add('base', me.stops.length ? `Current plan: lap ${(me.r.lap || 0) + me.stops[0].lap} for ${me.stops[0].c}` : 'Current plan: no stop', me.stops);
  // rank on time with a margin for risk: a set past its life or a rejoin in traffic rarely goes to plan
  const score = (x) => x.total + (x.overLife ? 4 : 0) + (x.traffic ? 0.8 : 0);
  const seen = new Set();
  const list = cands.sort((a, b) => score(a) - score(b)).filter((x) => {
    const sig2 = x.stops.map((s2) => s2.c + s2.lap).join('|');
    if (seen.has(sig2)) { if (x.id === 'base') { const o = cands.find((y) => y.stops.map((s2) => s2.c + s2.lap).join('|') === sig2); if (o) o.isBase = true; } return false; }
    seen.add(sig2);
    if (x.id === 'base') x.isBase = true;
    return true;
  });
  const top = list.length ? Math.min(...list.map((x) => x.total)) : 0;
  const code = (m) => s.drivers.get(m)?.code || `#${m}`;
  return list.slice(0, 7).map((x, i) => ({
    ...x, letter: String.fromCharCode(65 + i), delta: x.total - top,
    risk: x.overLife ? 'high' : x.traffic ? 'medium' : 'low',
    notes: [x.traffic && `rejoins ${x.traffic.d.toFixed(1)} s behind ${code(x.traffic.n)}`, x.overLife && 'runs a set past its expected life'].filter(Boolean)
  }));
}

/**
 * For a two-car team: who to look after first and what to tell the cars.
 */
export function priorityFor(ours, proj, s, battles, options) {
  const code = (m) => s.drivers.get(m)?.code || `#${m}`;
  const cars = ours.map((d) => proj.cars.get(d.n) && { d, c: proj.cars.get(d.n), b: battles.get(d.n) || [], o: options.get(d.n) || [] }).filter(Boolean)
    .sort((a, b) => a.c.r.pos - b.c.r.pos);
  if (!cars.length) return { cars: [], calls: [] };
  const scored = cars.map((x) => {
    const soon = (b) => b.inRange || (b.swapLap != null && b.swapLap <= 8) || (b.catchLap != null && b.catchLap <= 5);
    const threats = x.b.filter((b) => b.threat && soon(b));
    const chances = x.b.filter((b) => !b.behind && (b.kind === 'we-pass' || b.inRange) && soon(b));
    const best = x.o[0], base = x.o.find((o) => o.isBase);
    const swing = best && base ? Math.max(0, base.pos - best.pos) : 0;
    const wear = x.c.pr.age / Math.max(1, x.c.pr.life(x.c.pr.c));
    const stake = threats.length * 2 + chances.length * 1.5 + swing * 2 + (wear > 0.85 ? 2 : 0) + Math.max(0, 11 - x.c.r.pos) * 0.08;
    return { ...x, threats, chances, swing, wear, stake };
  });
  const calls = [];
  const [a, b] = scored;
  const lead = scored.slice().sort((x, y) => y.stake - x.stake)[0];
  const why = (x) => [
    x.threats.length && `defending against ${x.threats.map((t) => code(t.rival)).join(', ')}`,
    x.chances.length && `attacking ${x.chances.map((t) => code(t.rival)).join(', ')}`,
    x.swing && `${x.swing} position${x.swing > 1 ? 's' : ''} to gain from a strategy change`,
    x.wear > 0.85 && 'tyres near the end of their life'
  ].filter(Boolean).join('; ') || 'in clean air';
  if (lead.stake < 1.5 && (!b || scored.every((x) => x.stake < 1.5))) calls.push({ tone: 'green', title: 'No priority call', text: `${scored.map((x) => x.d.code).join(' and ')} ${b ? 'are both' : 'is'} in clean air with nothing to gain from a change of plan.` });
  else calls.push({ tone: 'red', title: `Prioritise ${lead.d.code}`, text: why(lead) });
  if (b) {
    const other = lead === a ? b : a;
    calls.push({ tone: 'mu', title: `${other.d.code}: ${other.stake < 1 ? 'manage the gap' : 'second priority'}`, text: why(other) });
    // pit order and double stacks
    const sa = a.o[0]?.stops?.[0]?.lap, sb = b.o[0]?.stops?.[0]?.lap;
    if (sa != null && sb != null && Math.abs(sa - sb) <= 1) {
      const gap = (b.c.r.g ?? 0) - (a.c.r.g ?? 0);
      const first = b.threats.length > a.threats.length && gap > 3 ? b : a;
      const second = first === a ? b : a;
      if (gap >= 0 && gap < STATIONARY_S + 1.5) calls.push({ tone: 'amber', title: `Pit order: ${first.d.code} first, ${second.d.code} next lap`, text: `The cars are ${gap.toFixed(1)} s apart: a double stack would cost ${second.d.code} about ${(STATIONARY_S + Math.max(0, 2 - gap)).toFixed(1)} s waiting at the box.` });
      else calls.push({ tone: 'amber', title: `Double stack is on: ${first.d.code} then ${second.d.code}`, text: `${gap.toFixed(1)} s between the cars is enough to service both on the same lap.` });
    }
    // team orders: the car behind is clearly quicker and close
    const pa = a.c.sim.lap.slice(1, 6), pb = b.c.sim.lap.slice(1, 6);
    const avg = (x) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : 0);
    const faster = avg(pa) - avg(pb); // >0: b quicker
    const between = (b.c.r.g ?? 0) - (a.c.r.g ?? 0);
    if (b.c.r.pos === a.c.r.pos + 1 && between >= 0 && between < 2.5) {
      if (faster > 0.3) calls.push({ tone: 'amber', title: `Team order: swap ${a.d.code} and ${b.d.code}`, text: `${b.d.code} is projected ${faster.toFixed(2)} s/lap quicker over the next laps and ${between.toFixed(1)} s behind. Swap, and swap back if ${b.d.code} doesn't pull away.` });
      else if (a.threats.some((t) => t.rival !== b.d.n) || b.threats.length) calls.push({ tone: 'mu', title: `Hold positions: ${b.d.code} covers ${a.d.code}`, text: `${b.d.code} keeps ${between.toFixed(1)} s behind as a buffer against the cars behind.` });
      else calls.push({ tone: 'mu', title: 'Hold positions', text: `The cars are ${between.toFixed(1)} s apart on similar pace (${Math.abs(faster).toFixed(2)} s/lap). No swap.` });
    }
    // split strategies when both cars fight the same rival
    const rivals = new Set(a.b.map((x) => x.rival));
    const shared = b.b.find((x) => rivals.has(x.rival) && x.rival !== a.d.n && x.rival !== b.d.n);
    if (shared && a.o[0] && b.o[0] && a.o[0].stops[0]?.c === b.o[0].stops[0]?.c) {
      const alt = b.o.find((o) => o.stops[0] && o.stops[0].c !== a.o[0].stops[0]?.c);
      if (alt && alt.delta < 3) calls.push({ tone: 'cyan', title: `Split strategies against ${code(shared.rival)}`, text: `${b.d.code} on "${alt.title}" costs only ${alt.delta.toFixed(1)} s more and leaves ${code(shared.rival)} unable to cover both cars.` });
    }
  }
  return { cars: scored, calls };
}

/* ---------------- one shared computation per session tick ---------------- */
let memo = { k: null, v: null };

/** everything above for the current moment, shared by every panel (recomputed every two seconds of session time) */
export function raceEngine({ meta, state, rows, data, team, circuit, focus }) {
  if (!meta || !data || !rows?.length) return null;
  const tKey = Math.floor((state.t || 0) / 2000);
  const k = `${meta.ch ?? meta.key}|${tKey}|${team || ''}|${focus || ''}|${state.flag}|${!!state.weather?.rain}|${rows.length}`;
  if (memo.k === k) return memo.v;
  const model = sessionModel(data, state.t || 0, meta.live);
  const total = totalLapsOf(meta, model);
  model.totalLaps = total.laps;
  const s = plansFor({ meta, state, rows, data, model });
  for (const [n, p] of s.plans) {
    const st = (data.stints || []).filter((x) => x.n === n && (x.from ?? 1) <= (rows.find((r) => r.n === n)?.lap || 1));
    p.usedDry = new Set(st.map((x) => ({ SOFT: 'S', MEDIUM: 'M', HARD: 'H' })[x.compound]).filter(Boolean));
  }
  const R = s.remaining ?? 0;
  const proj = projectField({ s, model, R });
  const oursD = teamDrivers(meta, team).filter((d) => proj.cars.has(d.n));
  const focusN = oursD.length ? oursD.map((d) => d.n) : [focus ?? rows[0]?.n].filter((n) => proj.cars.has(n));
  const battles = new Map(focusN.map((n) => [n, battlesFor(n, proj, circuit)]));
  const options = new Map(focusN.map((n) => [n, optionsFor(n, proj, s)]));
  const priority = oursD.length ? priorityFor(oursD, proj, s, battles, options) : null;
  const v = { model, s, proj, total, focus: focusN, ours: oursD, battles, options, priority, R };
  memo = { k, v };
  return v;
}
