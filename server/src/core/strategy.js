import {
  COMPOUNDS, DRY, PIT_LOSS, predictLapTime, FUEL_PER_LAP_KG, CAR_BY_ID, getTrack, formatLapTime
} from '@slipstream/shared';

const DEFAULT_RESIDUAL = 5.0;   // car dynamics + traffic not covered by the tyre model, learned online
const OUT_LAP_PENALTY = 1.2;    // cold tyres on the out-lap
const MAX_LOOKAHEAD = 26;

/**
 * Live race-strategy engine.
 *
 * For a car it enumerates every no-stop, one-stop and two-stop plan over the
 * remaining laps (compound x stop lap), predicts each plan's remaining race time
 * with the same tyre/weather model the cars obey (calibrated online from the
 * car's real lap times), prices pit stops by track status, integrates the
 * weather forecast lap by lap, and projects every competitor to estimate
 * finishing position. It then explains the best options in plain language and
 * surfaces tactical insights (undercut, cover, safety car, rain, cliff, fuel).
 */
export class StrategyEngine {
  constructor({ race, weather, getSession }) {
    this.race = race;
    this.weather = weather;
    this.getSession = getSession;
    this.track = getTrack();
    this.residual = new Map();
    this.scheduled = new Map();   // carId -> { lap, compound, by }
    this.latest = new Map();      // carId -> last computed result
  }

  reset() {
    this.scheduled.clear();
    this.latest.clear();
  }

  /** learn the car's model residual from a completed, representative lap */
  learn(lap, fuelKg) {
    // lap 1 includes the standing start; in/out laps include the pit lane
    if (!lap.valid || lap.lap <= 1 || lap.wetness > 0.08 || lap.pitIn || lap.pitOut) return;
    const meta = CAR_BY_ID[lap.carId];
    if (!meta) return;
    const predicted = predictLapTime({ base: 91, compound: lap.compound, age: lap.tyreAge, wetness: lap.wetness, fuelKg, driverPace: meta.pace });
    const r = lap.timeMs / 1000 - predicted;
    if (r < -3 || r > 15) return;
    const prev = this.residual.get(lap.carId);
    this.residual.set(lap.carId, prev ? { mean: prev.mean * 0.65 + r * 0.35, n: prev.n + 1 } : { mean: r, n: 1 });
  }

  /** per-car residual, shrunk toward the field average until the car has a few laps of evidence */
  residualFor(carId) {
    const all = [...this.residual.values()];
    const field = all.length ? all.reduce((a, b) => a + b.mean, 0) / all.length : DEFAULT_RESIDUAL;
    const own = this.residual.get(carId);
    if (!own) return field;
    const w = own.n / (own.n + 3);
    return w * own.mean + (1 - w) * field;
  }

  /* ------------------------------------------------------------------ */

  /** Snapshot of the race used by one strategy computation (cached per call). */
  buildContext(scenario = {}) {
    const session = this.getSession();
    const order = this.race.order();
    const leader = order[0];
    const L = this.track.L;
    const lapSec = 91 + this.residualFor(leader?.id);
    const cars = order.map((c, i) => {
      const g = this.race.gapInfo(c, leader, order[i - 1]);
      const used = new Set(c.stints.map((s) => s.compound));
      used.add(c.frame.tc);
      return {
        id: c.id, team: c.team, pace: c.meta.pace, pos: i + 1,
        gap: (g.gap ?? 0) + g.lapsDown * lapSec, int: g.int, lapsDown: g.lapsDown,
        lap: Math.max(1, c.lap), frac: c.d / L, d: c.d,
        compound: c.frame.tc, age: c.frame.ta, fuel: c.frame.fuel, used, stops: c.stops,
        status: c.frame.st, psi: c.frame.tp, finished: c.finished, residual: this.residualFor(c.id)
      };
    });
    const leaderLap = cars[0]?.lap ?? 1;
    const totalLaps = session.totalLaps;
    const horizon = Math.max(1, Math.min(totalLaps - leaderLap + 2, 60));

    // predicted track wetness at the middle of each future lap (shared by every car)
    const now = Date.now();
    let override = null;
    if (scenario.rain) {
      const start = now + (scenario.rain.inLaps ?? 3) * lapSec * 1000;
      override = { rain: { start, end: start + (scenario.rain.durationLaps ?? 5) * lapSec * 1000, intensity: scenario.rain.intensity ?? 0.6 } };
    }
    if (scenario.noRain) override = { ...(override || {}), noRain: true };
    const times = Array.from({ length: horizon + 1 }, (_, j) => now + (j + 0.5) * lapSec * 1000);
    const wet = this.weather.predictWetness(times, override);

    // neutralised laps (pit loss discount)
    const neutral = new Map();
    if (session.trackStatus === 'SC' || session.trackStatus === 'VSC') { neutral.set(0, session.trackStatus); neutral.set(1, session.trackStatus); }
    if (scenario.safetyCar) {
      const from = scenario.safetyCar.inLaps ?? 1;
      for (let k = from; k < from + (scenario.safetyCar.laps ?? 3); k++) neutral.set(k, scenario.safetyCar.type || 'SC');
    }
    return {
      session, cars, byId: new Map(cars.map((c) => [c.id, c])), lapSec, totalLaps, wet, neutral,
      degMultiplier: scenario.degMultiplier ?? 1,
      rivalPit: scenario.rivalPit || null,
      wetRisk: Math.max(...wet) > 0.18 || this.weather.wetness > 0.12
    };
  }

  lapTime(car, compound, age, wetness, fuel, ctx) {
    return predictLapTime({ base: 91 + car.residual, compound, age, wetness, fuelKg: Math.max(0, fuel), driverPace: car.pace, degMultiplier: ctx.degMultiplier });
  }

  pitLossAt(k, ctx) {
    const s = ctx.neutral.get(k);
    return s ? PIT_LOSS[s] : PIT_LOSS.GREEN;
  }

  /** Remaining race time (s) for a plan. stops: [{k, compound}], k = pit at end of lap offset k (0 = this lap). */
  simulate(car, stops, ctx) {
    const R = Math.max(0, ctx.totalLaps - car.lap);
    let comp = car.compound, age = car.age, fuel = car.fuel, time = 0;
    const used = new Set(car.used);
    let anyWet = COMPOUNDS[comp].wet;
    time += (1 - car.frac) * this.lapTime(car, comp, age, ctx.wet[0], fuel, ctx);
    fuel -= FUEL_PER_LAP_KG * (1 - car.frac);
    let worstOverCliff = 0;
    for (let j = 1; j <= R; j++) {
      const stop = stops.find((s) => s.k === j - 1);
      if (stop) {
        time += this.pitLossAt(j - 1, ctx) + OUT_LAP_PENALTY;
        comp = stop.compound; age = 0; used.add(comp);
        if (COMPOUNDS[comp].wet) anyWet = true;
      }
      time += this.lapTime(car, comp, age, ctx.wet[Math.min(j, ctx.wet.length - 1)], fuel, ctx);
      fuel -= FUEL_PER_LAP_KG;
      age += 1;
      worstOverCliff = Math.max(worstOverCliff, age - COMPOUNDS[comp].cliff);
    }
    const dryCompounds = [...used].filter((c) => !COMPOUNDS[c].wet).length;
    const valid = anyWet || dryCompounds >= 2 || R === 0;
    return { time, valid, worstOverCliff, fuelLeft: fuel };
  }

  candidatePlans(car, ctx, { exhaustive = true } = {}) {
    const R = Math.max(0, ctx.totalLaps - car.lap);
    const plans = [[]];
    if (R < 1 || car.finished) return plans;
    const kMin = car.status === 'PIT' || car.d > this.track.pit.entry - 40 ? 1 : 0;
    const kMax = Math.min(R - 1, MAX_LOOKAHEAD);
    const comps = ctx.wetRisk ? ['S', 'M', 'H', 'I', 'W'] : DRY;
    const step = exhaustive ? 1 : 2;
    for (let k = kMin; k <= kMax; k += step) for (const c of comps) plans.push([{ k, compound: c }]);
    if (exhaustive && R > 6) {
      const comps2 = ctx.wetRisk ? comps : DRY;
      for (let k1 = kMin; k1 <= Math.min(kMax, 16); k1++) {
        for (const c1 of comps2) {
          for (let k2 = k1 + 3; k2 <= Math.min(R - 2, k1 + 30); k2 += ctx.wetRisk ? 1 : 2) {
            for (const c2 of comps2) plans.push([{ k: k1, compound: c1 }, { k: k2, compound: c2 }]);
          }
        }
      }
    }
    return plans;
  }

  bestPlanTime(car, ctx) {
    let best = Infinity;
    for (const stops of this.candidatePlans(car, ctx, { exhaustive: false })) {
      const r = this.simulate(car, stops, ctx);
      if (r.valid && r.time < best) best = r.time;
    }
    return best;
  }

  /** projected remaining time for every car (competitors use a cheaper search) */
  projectField(ctx, exceptId) {
    const proj = new Map();
    for (const c of ctx.cars) {
      if (c.id === exceptId || c.finished) continue;
      let t;
      if (ctx.rivalPit && ctx.rivalPit.carId === c.id) {
        t = this.simulate(c, [{ k: ctx.rivalPit.inLaps ?? 0, compound: ctx.rivalPit.compound || 'H' }], ctx).time;
      } else {
        t = this.bestPlanTime(c, ctx);
      }
      proj.set(c.id, c.gap + t);
    }
    return proj;
  }

  positionFor(finishTime, proj) {
    let p = 1;
    for (const t of proj.values()) if (t < finishTime) p++;
    return p;
  }

  rejoinInfo(car, k, ctx) {
    // approximate: field order at the moment we rejoin, assuming gaps hold
    const loss = this.pitLossAt(k, ctx) + OUT_LAP_PENALTY * 0.5;
    const ours = car.gap + loss;
    const others = ctx.cars.filter((c) => c.id !== car.id && c.status !== 'PIT');
    const ahead = others.filter((c) => c.gap < ours).sort((a, b) => b.gap - a.gap);
    const behind = others.filter((c) => c.gap >= ours).sort((a, b) => a.gap - b.gap);
    return {
      position: ahead.length + 1,
      ahead: ahead[0] ? { id: ahead[0].id, gap: round(ours - ahead[0].gap, 1) } : null,
      behind: behind[0] ? { id: behind[0].id, gap: round(behind[0].gap - ours, 1) } : null,
      traffic: !!(ahead[0] && ours - ahead[0].gap < 1.5)
    };
  }

  describe(car, stops, ctx) {
    const lapOf = (k) => car.lap + k;
    if (!stops.length) return { title: 'Stay out to the flag', short: 'No stop' };
    const first = stops[0];
    const when = first.k === 0 ? 'Box this lap' : first.k === 1 ? 'Box next lap' : `Box in ${first.k} laps`;
    let title = `${when} → ${COMPOUNDS[first.compound].name}`;
    if (stops[1]) title += `, then ${COMPOUNDS[stops[1].compound].name} on lap ${lapOf(stops[1].k)}`;
    const short = stops.map((s) => `L${lapOf(s.k)} ${s.compound}`).join(' · ');
    return { title, short };
  }

  stints(car, stops, ctx) {
    const out = [];
    let from = car.lap, comp = car.compound;
    for (const s of stops) {
      out.push({ compound: comp, from, to: car.lap + s.k });
      from = car.lap + s.k + 1;
      comp = s.compound;
    }
    out.push({ compound: comp, from, to: ctx.totalLaps });
    return out;
  }

  /* ------------------------------------------------------------------ */

  compute(carId, scenario = {}) {
    const raceCar = this.race.cars.get(carId);
    if (!raceCar?.frame) return null;
    const ctx = this.buildContext(scenario);
    const car = ctx.byId.get(carId);
    if (!car) return null;
    const R = Math.max(0, ctx.totalLaps - car.lap);

    const evaluated = [];
    for (const stops of this.candidatePlans(car, ctx)) {
      const r = this.simulate(car, stops, ctx);
      if (r.valid) evaluated.push({ stops, ...r });
    }
    evaluated.sort((a, b) => a.time - b.time);

    // damage overrides everything: a puncture or a slow car must box now
    const damaged = car.status === 'SLOW' || car.psi.some((p) => p < 15);
    const proj = this.projectField(ctx, carId);
    const picks = [];
    const add = (plan, kind) => {
      if (!plan) return;
      const key = JSON.stringify(plan.stops);
      if (picks.some((p) => p.key === key)) return;
      picks.push({ ...plan, kind, key });
    };
    const kMin = this.candidatePlans(car, ctx).find((p) => p.length)?.[0]?.k ?? 0;
    const firstK = (p) => (p.stops.length ? p.stops[0].k : Infinity);
    const usesWet = (p) => p.stops.some((s) => COMPOUNDS[s.compound].wet);

    if (damaged) add(evaluated.find((p) => firstK(p) === kMin), 'damage');
    add(evaluated[0], 'optimal');
    add(evaluated.find((p) => firstK(p) === kMin), 'now');
    add(evaluated.find((p) => firstK(p) >= Math.max(3, (picks[0] ? firstK(picks[0]) : 0) + 3)), 'extend');
    if (ctx.wetRisk) add(evaluated.find((p) => usesWet(p) !== usesWet(evaluated[0] || { stops: [] })), 'weather');
    add(evaluated.find((p) => p.stops[0]?.compound === 'S' && !picks.some((x) => x.stops[0]?.compound === 'S')), 'aggressive');

    const bestTime = picks[0]?.time ?? 0;
    const options = picks.slice(0, 4).map((p, i) => {
      const finish = car.gap + p.time;
      const position = this.positionFor(finish, proj);
      const d = this.describe(car, p.stops, ctx);
      const first = p.stops[0];
      const rejoin = first ? this.rejoinInfo(car, first.k, ctx) : null;
      const reasons = [];
      if (i === 0 && picks[1]) reasons.push(`Fastest plan: ${round(picks[1].time - p.time, 1)} s quicker than the next best option`);
      if (i > 0) reasons.push(`${round(p.time - bestTime, 1)} s slower than the recommended plan`);
      if (first && ctx.neutral.get(first.k)) reasons.push(`Pit loss only ${PIT_LOSS[ctx.neutral.get(first.k)]} s under ${ctx.neutral.get(first.k)} (normally ${PIT_LOSS.GREEN} s)`);
      const lastStint = p.stops.length ? p.stops[p.stops.length - 1] : null;
      const lastComp = lastStint ? lastStint.compound : car.compound;
      const lastLen = lastStint ? R - lastStint.k : car.age + R;
      if (!COMPOUNDS[lastComp].wet) {
        if (lastLen <= COMPOUNDS[lastComp].cliff) reasons.push(`${COMPOUNDS[lastComp].name}s last the final ${lastLen} laps inside their ~${COMPOUNDS[lastComp].cliff}-lap life`);
        else reasons.push(`Final stint of ${lastLen} laps runs past the ${COMPOUNDS[lastComp].name.toLowerCase()} cliff (~${COMPOUNDS[lastComp].cliff} laps)`);
      }
      if (usesWet(p)) {
        const wk = p.stops.find((s) => COMPOUNDS[s.compound].wet);
        reasons.push(`Switches to ${COMPOUNDS[wk.compound].name}s on lap ${car.lap + wk.k} as forecast wetness reaches ${round(ctx.wet[Math.min(wk.k + 1, ctx.wet.length - 1)], 2)}`);
      } else if (ctx.wetRisk && Math.max(...ctx.wet) > 0.3) {
        reasons.push('Bets on slicks surviving the forecast rain');
      }
      if (rejoin) reasons.push(`Rejoins around P${rejoin.position}${rejoin.ahead ? `, ${rejoin.ahead.gap} s behind ${rejoin.ahead.id}` : ''}${rejoin.traffic ? ' (traffic)' : ' in clean air'}`);
      if (!p.stops.length) reasons.push('Avoids the pit loss entirely');
      const risk = (p.worstOverCliff > 2 || rejoin?.traffic) ? 'high' : (p.worstOverCliff > 0 || (ctx.wetRisk && !usesWet(p) && Math.max(...ctx.wet) > 0.3)) ? 'medium' : 'low';
      const confidence = Math.max(0.35, Math.min(0.95, 0.92 - (ctx.wetRisk ? 0.18 : 0) - Math.min(0.2, R * 0.004) - (p.worstOverCliff > 0 ? 0.1 : 0)));
      const urgency = first ? (first.k === 0 ? 'now' : first.k <= 2 ? 'soon' : 'later') : 'none';
      return {
        id: `${p.kind}-${p.key.length}-${i}`,
        kind: p.kind, recommended: i === 0, title: d.title, short: d.short,
        stops: p.stops.map((s) => ({ lap: car.lap + s.k, k: s.k, compound: s.compound })),
        stints: this.stints(car, p.stops, ctx),
        raceTime: round(p.time, 1), delta: round(p.time - bestTime, 1), position, risk,
        confidence: round(confidence, 2), urgency, reasons, rejoin
      };
    });

    const insights = this.insights(car, ctx, raceCar, damaged);
    const deg = this.lapTime(car, car.compound, car.age + 1, ctx.wet[1] ?? 0, car.fuel, ctx) - this.lapTime(car, car.compound, car.age, ctx.wet[1] ?? 0, car.fuel, ctx);
    const result = {
      carId, generatedAt: Date.now(), scenario: Object.keys(scenario).length ? scenario : null,
      lap: car.lap, totalLaps: ctx.totalLaps, remaining: R, position: car.pos,
      tyre: { compound: car.compound, age: car.age, cliff: COMPOUNDS[car.compound].cliff, degPerLap: round(deg, 3) },
      fuel: { kg: round(car.fuel, 1), margin: round(car.fuel - (R + 1 - car.frac) * FUEL_PER_LAP_KG, 1) },
      weather: { wetnessNow: round(this.weather.wetness, 2), forecast: ctx.wet.slice(0, 10).map((w) => round(w, 2)) },
      trackStatus: ctx.session.trackStatus,
      predictedLap: formatLapTime(this.lapTime(car, car.compound, car.age, ctx.wet[0], car.fuel, ctx)),
      model: { residual: round(car.residual, 2), plansEvaluated: evaluated.length },
      scheduled: this.scheduled.get(carId) || null,
      options, insights
    };
    if (!scenario || !Object.keys(scenario).length) this.latest.set(carId, result);
    return result;
  }

  insights(car, ctx, raceCar, damaged) {
    const out = [];
    const R = Math.max(0, ctx.totalLaps - car.lap);
    const ahead = ctx.cars[car.pos - 2];
    const behind = ctx.cars[car.pos];
    const freshBest = ctx.wetRisk && this.weather.wetness > 0.3 ? 'I' : (R <= COMPOUNDS.M.cliff ? 'M' : 'H');

    if (damaged) out.push({ level: 'threat', title: 'Damage detected: box now', detail: 'Tyre pressure loss or a slow car. Every lap on track costs 20+ s and risks the car.' });
    if (ctx.session.trackStatus === 'SC' || ctx.session.trackStatus === 'VSC') {
      out.push({ level: 'opportunity', title: `${ctx.session.trackStatus}: cheap pit stop`, detail: `Pit loss is ~${PIT_LOSS[ctx.session.trackStatus]} s instead of ${PIT_LOSS.GREEN} s while the field is neutralised.` });
    }
    const cliff = COMPOUNDS[car.compound].cliff;
    if (!COMPOUNDS[car.compound].wet && car.age >= cliff - 2) {
      out.push({ level: 'threat', title: car.age > cliff ? 'Past the tyre cliff' : 'Approaching the tyre cliff', detail: `${COMPOUNDS[car.compound].name}s are ${car.age} laps old (cliff ~${cliff}). Lap time loss grows every lap from here.` });
    }
    if (ahead && car.int != null && car.int < 3.2 && !ahead.lapsDown && ahead.status === 'RUN') {
      const theirs = this.lapTime(ahead, ahead.compound, ahead.age + 1, ctx.wet[1], ahead.fuel, ctx) + this.lapTime(ahead, ahead.compound, ahead.age + 2, ctx.wet[2], ahead.fuel, ctx);
      const ours = this.lapTime(car, freshBest, 0, ctx.wet[1], car.fuel, ctx) + this.lapTime(car, freshBest, 1, ctx.wet[2], car.fuel, ctx) + OUT_LAP_PENALTY;
      const gain = theirs - ours;
      if (gain > car.int) out.push({ level: 'opportunity', title: `Undercut on ${ahead.id}`, detail: `Fresh ${COMPOUNDS[freshBest].name}s gain ~${round(gain, 1)} s over two laps against ${ahead.id}'s ${ahead.age}-lap ${COMPOUNDS[ahead.compound].name.toLowerCase()}s. The gap is ${round(car.int, 1)} s.` });
      if (car.int < 1.0) out.push({ level: 'info', title: `DRS range on ${ahead.id}`, detail: `${round(car.int, 2)} s behind. Attack in the DRS zones.` });
    }
    if (behind && behind.int != null && behind.int < 3.2 && behind.status === 'RUN') {
      const ours = this.lapTime(car, car.compound, car.age + 1, ctx.wet[1], car.fuel, ctx) + this.lapTime(car, car.compound, car.age + 2, ctx.wet[2], car.fuel, ctx);
      const theirs = this.lapTime(behind, freshBest, 0, ctx.wet[1], behind.fuel, ctx) + this.lapTime(behind, freshBest, 1, ctx.wet[2], behind.fuel, ctx) + OUT_LAP_PENALTY;
      const threat = ours - theirs;
      if (threat > behind.int) out.push({ level: 'threat', title: `Undercut threat from ${behind.id}`, detail: `${behind.id} is ${round(behind.int, 1)} s behind. If they box now, fresh tyres gain ~${round(threat, 1)} s. Cover by boxing on the same lap.` });
      if (behind.int < 1.0) out.push({ level: 'threat', title: `${behind.id} in DRS range`, detail: `${round(behind.int, 2)} s behind. Defend into the DRS zones.` });
    }
    const rainIdx = ctx.wet.findIndex((w) => w > 0.3);
    if (rainIdx >= 0 && this.weather.wetness < 0.3) {
      out.push({ level: 'info', title: `Rain crossover in ~${rainIdx} lap${rainIdx === 1 ? '' : 's'}`, detail: `Track wetness forecast to pass 0.30 around lap ${car.lap + rainIdx}. Intermediates beat slicks above ~0.25.` });
    } else if (this.weather.wetness > 0.25 && Math.min(...ctx.wet.slice(2)) < 0.18) {
      const dryIdx = ctx.wet.findIndex((w, i) => i > 0 && w < 0.18);
      out.push({ level: 'info', title: 'Track drying', detail: `Forecast back below slick crossover in ~${dryIdx} laps (lap ${car.lap + dryIdx}).` });
    }
    const margin = car.fuel - (R + 1 - car.frac) * FUEL_PER_LAP_KG;
    if (margin < 1.0) out.push({ level: 'threat', title: 'Fuel tight', detail: `Projected ${round(margin, 1)} kg at the flag. Lift and coast ~${Math.max(50, Math.round(-margin * 120 + 60))} m per lap.` });
    const sched = this.scheduled.get(car.id);
    if (sched) out.push({ level: 'info', title: `Pit call scheduled: lap ${sched.lap}`, detail: `${COMPOUNDS[sched.compound].name}s, called by ${sched.by}.` });
    return out;
  }

  /** schedule or immediately issue a pit call. Returns { immediate, lap, compound } */
  schedule(carId, { lap, compound, by }) {
    const car = this.race.cars.get(carId);
    if (!car?.frame) throw new Error('car not on track');
    if (!COMPOUNDS[compound]) throw new Error('bad compound');
    const now = !lap || lap <= car.lap;
    if (now) {
      this.scheduled.delete(carId);
      return { immediate: true, lap: car.lap, compound };
    }
    this.scheduled.set(carId, { lap, compound, by });
    return { immediate: false, lap, compound };
  }

  cancel(carId) {
    return this.scheduled.delete(carId);
  }

  /** called when a car starts a new lap; returns a due pit call, if any */
  due(carId, lap) {
    const s = this.scheduled.get(carId);
    if (s && lap >= s.lap) {
      this.scheduled.delete(carId);
      return s;
    }
    return null;
  }
}

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
