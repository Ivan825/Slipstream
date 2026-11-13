/**
 * Race simulation model. Pure logic, no networking: the runner calls step(dt)
 * and drains telemetry frames from each car.
 *
 * Each car follows the circuit's reference speed profile, scaled by a pace
 * factor that comes from the shared tyre/weather model (compound, tyre age,
 * wetness, fuel load, driver skill). Throttle, brake, gear, RPM, tyre surface
 * temperatures (inner/middle/outer per corner), tyre pressures, brake
 * temperatures, coolant/oil temperature, fuel and ERS all emerge from that.
 */
import {
  getTrack, indexAt, inDrsZone, CARS, COMPOUNDS, DRY, degradation, wetPenalty,
  FUEL_EFFECT_PER_KG, FUEL_PER_LAP_KG, bestCompoundFor
} from '@slipstream/shared';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const GEAR_TOP = [0, 18, 28, 38, 48, 58, 68, 79, 200]; // m/s upper bound per gear index
const START_FUEL = 62;

export class RaceSim {
  constructor({ carCount = 20, totalLaps = 36, seed = 7 } = {}) {
    this.track = getTrack();
    this.rng = mulberry32(seed);
    this.totalLaps = totalLaps;
    this.carCount = Math.min(carCount, CARS.length);
    this.session = { status: 'idle', trackStatus: 'GREEN', wetness: 0, rain: 0, airTemp: 27, trackTemp: 41 };
    this.reset();
  }

  reset() {
    const { L } = this.track;
    const rnd = this.rng;
    this.time = 0;
    this.finishedLeader = false;
    // shuffle grid a little but keep faster drivers roughly at the front
    const grid = CARS.slice(0, this.carCount)
      .map((c) => ({ c, k: c.pace + (rnd() - 0.5) * 0.9 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.c);
    const prevSeq = new Map((this.cars || []).map((c) => [c.id, c.seq]));
    this.cars = grid.map((meta, pos) => {
      const compound = pos < 8 ? (rnd() < 0.6 ? 'S' : 'M') : (rnd() < 0.5 ? 'M' : 'H');
      const car = {
        id: meta.id, team: meta.team, pace: meta.pace,
        seq: prevSeq.get(meta.id) || 0, lap: 0, d: L - 30 - pos * 16, total: 0,
        v: 0, thr: 0, brk: 0, gear: 1, rpm: 4000, drs: 0, ers: 100, fuel: START_FUEL,
        compound, tyreAge: 0, extraAge: 0, used: new Set([compound]),
        tyreT: new Array(12).fill(compound === 'S' ? 82 : compound === 'M' ? 78 : 74),
        psi: [21.2, 21.2, 20.4, 20.4], brakeT: [420, 420, 380, 380], waterT: 96, oilT: 104,
        status: 'RUN', pit: null, plannedStopAge: 0, stops: 0, retired: false, finished: false,
        incident: { puncture: null, brakeFade: 0, engine: 0, overheat: 0, overheatCorner: 0 },
        outbox: [], gapAheadM: Infinity
      };
      car.plannedStopAge = this.planStop(car);
      return car;
    });
    this.updateOrder();
  }

  /** Simple AI: pit a few laps before the compound's cliff, with some variety. */
  planStop(car) {
    const c = COMPOUNDS[car.compound];
    return Math.max(5, Math.round(c.cliff - 3 - this.rng() * 4));
  }

  setSession(s) {
    const was = this.session.status;
    Object.assign(this.session, s);
    if (s.status === 'running' && (was === 'idle' || was === 'finished') && s.fresh) this.reset();
  }

  /** commands from race control / engineers */
  command(cmd) {
    const car = cmd.carId ? this.cars.find((c) => c.id === cmd.carId) : null;
    switch (cmd.type) {
      case 'pit':
        if (car && !car.pit) {
          car.pit = { phase: 'requested', compound: cmd.compound || this.nextCompound(car), source: cmd.by || 'engineer' };
        }
        break;
      case 'cancel-pit':
        if (car && car.pit?.phase === 'requested') car.pit = null;
        break;
      case 'puncture':
        if (car) car.incident.puncture = cmd.corner || CORNERS[Math.floor(this.rng() * 4)];
        break;
      case 'brake-fade':
        if (car) car.incident.brakeFade = 45;
        break;
      case 'engine':
        if (car) car.incident.engine = 50;
        break;
      case 'tyre-overheat':
        if (car) { car.incident.overheat = 40; car.incident.overheatCorner = Math.floor(this.rng() * 2); }
        break;
      case 'reset':
        this.reset();
        break;
      default:
        break;
    }
  }

  nextCompound(car) {
    const w = this.session.wetness;
    if (w > 0.3) return bestCompoundFor(w, ['I', 'W']);
    const remaining = this.totalLaps - car.lap;
    const options = DRY.filter((c) => !(car.used.size === 1 && car.used.has(c) && !COMPOUNDS[car.compound].wet));
    // prefer a compound that can reach the flag
    const viable = options.filter((c) => COMPOUNDS[c].cliff >= remaining);
    const pool = viable.length ? viable : options;
    return pool.sort((a, b) => COMPOUNDS[a].offset - COMPOUNDS[b].offset)[0] || 'M';
  }

  updateOrder() {
    const { L } = this.track;
    for (const c of this.cars) c.total = c.lap * L + c.d;
    this.order = [...this.cars].filter((c) => !c.retired).sort((a, b) => b.total - a.total);
    for (let i = 0; i < this.order.length; i++) {
      const c = this.order[i], ahead = this.order[i - 1];
      c.gapAheadM = ahead ? ahead.total - c.total : Infinity;
      c.position = i + 1;
    }
  }

  step(dt) {
    if (this.session.status !== 'running') return;
    this.time += dt;
    this.updateOrder();
    for (const car of this.cars) this.stepCar(car, dt);
  }

  stepCar(car, dt) {
    const T = this.track, s = this.session, rnd = this.rng;
    if (car.retired) return;
    const L = T.L;
    const i = indexAt(T, car.d);
    const vRef = T.vRef[i];
    const kappa = T.kappa[i];

    // ---- pace model (shared with the strategy engine) ----
    const fuelPen = car.fuel * FUEL_EFFECT_PER_KG;
    const compound = COMPOUNDS[car.compound];
    let delta = compound.offset + degradation(car.compound, car.tyreAge + car.extraAge) + wetPenalty(car.compound, s.wetness) + fuelPen + car.pace;
    if (car.incident.puncture && car.psi[CORNERS.indexOf(car.incident.puncture)] < 12) delta += 25;
    if (car.incident.brakeFade > 0) delta += 1.2;
    const paceFactor = T.referenceLapS / (T.referenceLapS + delta);
    let target = vRef * paceFactor * (1 + (rnd() - 0.5) * 0.004);

    // ---- race situation ----
    const ahead = car.gapAheadM;
    if (s.trackStatus === 'SC') {
      target = Math.min(target, car.position === 1 ? 44 : 50);
      if (ahead < 35) target *= 0.85; else if (ahead > 80 && ahead < Infinity) target = Math.min(vRef * paceFactor, target * 1.3);
    } else if (s.trackStatus === 'VSC') {
      target *= 0.68;
    } else if (s.trackStatus === 'RED') {
      target = Math.min(target, 22);
    } else if (s.trackStatus === 'YELLOW' && T.sp[i] < 0.5) {
      target *= 0.94;
    }
    const drsAllowed = s.trackStatus === 'GREEN' && s.wetness < 0.3 && car.lap > 2 && car.status === 'RUN';
    car.drs = drsAllowed && inDrsZone(T, car.d) && ahead / Math.max(car.v, 1) < 1.0 ? 1 : 0;
    if (car.drs) target *= 1.035;
    if (ahead < 45 && T.sp[i] > 0.8 && s.trackStatus === 'GREEN') target *= 1.008; // slipstream
    if (ahead < 9) target *= 0.97; // can't drive through the car ahead

    // ---- pit lane ----
    if (car.pit && car.pit.phase !== 'requested') {
      if (car.pit.phase === 'stop') {
        target = 0;
        car.pit.timer -= dt;
        if (car.pit.timer <= 0) this.changeTyres(car);
      } else {
        target = Math.min(target, T.pit.speedLimit);
      }
    }

    // ---- longitudinal dynamics ----
    const accelMax = 15 * Math.max(0.15, 1 - car.v / 95) * (s.wetness > 0.3 ? 0.75 : 1);
    let a = (target - car.v) / 0.25;
    a = Math.max(-48 * (s.wetness > 0.3 ? 0.7 : 1), Math.min(accelMax, a));
    if (car.pit?.phase === 'stop') a = -car.v / Math.max(dt, 0.01);
    const prevD = car.d;
    car.v = Math.max(0, car.v + a * dt);
    car.thr = a > 0 ? Math.min(1, 0.25 + a / accelMax * 0.75) : car.v > target * 0.995 ? 0 : 0.2;
    if (a > -2 && a <= 0) car.thr = Math.min(1, 0.35 + T.sp[i] * 0.5);
    car.brk = a < -2 ? Math.min(1, -a / 48) : 0;
    car.d += car.v * dt;

    // ---- line crossings ----
    if (car.d >= L) {
      car.d -= L;
      car.lap += 1;
      if (car.lap > 1) car.tyreAge += 1;
      if (car.status === 'OUT') car.status = 'RUN';
      if (car.lap > this.totalLaps) {
        car.finished = true;
        this.finishedLeader = true;
      }
      this.aiDecide(car);
    }
    if (car.pit) {
      if (car.pit.phase === 'requested' && this.passed(prevD, car.d, T.pit.entry)) {
        car.pit.phase = 'lane-in'; car.status = 'PIT';
      } else if (car.pit.phase === 'lane-in' && this.passed(prevD, car.d, T.pit.box)) {
        car.pit.phase = 'stop'; car.pit.timer = T.pit.stopS + rnd() * 0.6;
      } else if (car.pit.phase === 'lane-out' && this.passed(prevD, car.d, T.pit.exit)) {
        car.pit = null; car.status = 'OUT';
      }
    }

    // ---- powertrain ----
    let g = 1;
    while (g < 8 && car.v > GEAR_TOP[g]) g++;
    car.gear = car.v < 0.5 ? (car.pit?.phase === 'stop' ? 0 : 1) : g;
    const lo = GEAR_TOP[g - 1] || 0, hi = GEAR_TOP[g] > 150 ? 92 : GEAR_TOP[g];
    const frac = Math.min(1, Math.max(0, (car.v - lo) / (hi - lo)));
    car.rpm = car.v < 0.5 ? 4200 : Math.round(9200 + frac * 3100 + (rnd() - 0.5) * 60);
    car.ers = Math.max(0, Math.min(100, car.ers + (car.thr > 0.95 && car.v > 70 ? -5.5 : 0) * dt + car.brk * 14 * dt + 0.4 * dt));
    car.fuel = Math.max(0, car.fuel - (FUEL_PER_LAP_KG / L) * car.v * dt * (0.55 + 0.45 * car.thr));

    // ---- tyres ----
    const latG = (car.v * car.v * Math.abs(kappa)) / 9.81;
    const leftTurn = kappa > 0;
    const wetCool = (compound.wet ? 12 : 30) * s.wetness;
    for (let t = 0; t < 4; t++) {
      const front = t < 2, left = t % 2 === 0;
      const outer = leftTurn ? !left : left;
      let target = compound.idealTemp - 10 + latG * (outer ? 5.8 : 2.2) + (front ? car.brk * 16 : car.thr * 6) + (s.trackTemp - 40) * 0.35 - wetCool;
      if (front && !left) target += 3; // this circuit loads the front-right a little more
      if (car.incident.overheat > 0 && t === car.incident.overheatCorner) target += 30;
      if (car.pit?.phase === 'stop') target = 60;
      const k = 0.35 * dt;
      const camber = [4.5, 0, -3.5];
      for (let b = 0; b < 3; b++) {
        const idx = t * 3 + b;
        const bandTarget = target + camber[b] + (b === 2 && outer ? latG * 1.4 : 0);
        car.tyreT[idx] += (bandTarget - car.tyreT[idx]) * k + (rnd() - 0.5) * 0.15;
      }
      const avg = (car.tyreT[t * 3] + car.tyreT[t * 3 + 1] + car.tyreT[t * 3 + 2]) / 3;
      const basePsi = front ? 21.4 : 20.6;
      let psi = basePsi + (avg - 85) * 0.045;
      if (car.incident.puncture === CORNERS[t]) {
        car.punctureDrop = (car.punctureDrop || 0) + 0.85 * dt;
        psi = Math.max(3.5, psi - car.punctureDrop);
      }
      car.psi[t] += (psi - car.psi[t]) * Math.min(1, 2 * dt);
      // brakes
      let bTarget = 380 + car.brk * car.v * (front ? 10.5 : 7.5);
      if (car.incident.brakeFade > 0 && front) bTarget *= 1.55;
      car.brakeT[t] += (bTarget - car.brakeT[t]) * Math.min(1, dt * (car.brk > 0 ? 2.4 : car.incident.brakeFade > 0 ? 0.25 : 0.55));
    }
    // overheating tyres wear faster
    const avgTyre = car.tyreT.reduce((x, y) => x + y, 0) / 12;
    const overheat = Math.max(0, avgTyre - compound.idealTemp - 12) * 0.08;
    car.extraAge += (overheat * car.v * dt) / L;

    // ---- engine ----
    let waterTarget = 98 + car.thr * 9 - car.v * 0.04 + (s.airTemp - 25) * 0.3;
    if (car.incident.engine > 0) waterTarget += 34;
    car.waterT += (waterTarget - car.waterT) * Math.min(1, dt * 0.25);
    car.oilT += (car.waterT + 11 - car.oilT) * Math.min(1, dt * 0.2);
    if (car.incident.brakeFade > 0) car.incident.brakeFade -= dt;
    if (car.incident.engine > 0) car.incident.engine -= dt;
    if (car.incident.overheat > 0) car.incident.overheat -= dt;
    if (car.incident.puncture && car.status === 'RUN' && !car.pit && car.psi[CORNERS.indexOf(car.incident.puncture)] < 10) {
      car.pit = { phase: 'requested', compound: this.nextCompound(car), source: 'auto' };
    }
    if (car.status === 'RUN' && car.incident.puncture && car.psi[CORNERS.indexOf(car.incident.puncture)] < 12) car.status = 'SLOW';

    car.seq += 1;
    car.outbox.push(this.frame(car));
  }

  passed(prev, cur, mark) {
    const L = this.track.L;
    if (cur >= prev) return mark > prev && mark <= cur;
    return mark > prev || mark <= cur; // wrapped past the line
  }

  changeTyres(car) {
    const next = car.pit.compound;
    car.compound = next;
    car.used.add(next);
    car.tyreAge = 0;
    car.extraAge = 0;
    car.tyreT.fill(62);
    car.stops += 1;
    car.incident.puncture = null;
    car.punctureDrop = 0;
    car.status = 'PIT';
    car.pit.phase = 'lane-out';
    car.plannedStopAge = this.planStop(car);
  }

  /** AI teams decide at the line: planned stops, weather crossovers, cheap stops under SC. */
  aiDecide(car) {
    if (car.pit || car.finished) return;
    const s = this.session;
    const remaining = this.totalLaps - car.lap;
    if (remaining < 2) return;
    const onSlicks = !COMPOUNDS[car.compound].wet;
    const best = bestCompoundFor(s.wetness, undefined, 0);
    if (onSlicks && s.wetness > 0.32 && this.rng() < 0.75) {
      car.pit = { phase: 'requested', compound: best === 'W' ? 'W' : 'I', source: 'auto' };
      return;
    }
    if (!onSlicks && s.wetness < 0.18 && this.rng() < 0.7) {
      car.pit = { phase: 'requested', compound: this.nextCompound({ ...car, used: new Set([car.compound]), compound: 'I' }), source: 'auto' };
      return;
    }
    const cheap = s.trackStatus === 'SC' || s.trackStatus === 'VSC';
    const due = car.tyreAge >= car.plannedStopAge;
    const needsSecondCompound = onSlicks && car.used.size < 2 && ![...car.used].some((c) => COMPOUNDS[c].wet);
    if ((due || (cheap && car.tyreAge >= car.plannedStopAge - 6)) && (remaining > 3 || needsSecondCompound)) {
      car.pit = { phase: 'requested', compound: this.nextCompound(car), source: 'auto' };
    }
  }

  frame(car) {
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      carId: car.id,
      seq: car.seq,
      ts: Date.now(),
      lap: car.lap,
      d: Math.round(car.d * 100) / 100,
      v: r1(car.v * 3.6),
      thr: Math.round(car.thr * 100) / 100,
      brk: Math.round(car.brk * 100) / 100,
      g: car.gear,
      rpm: car.rpm,
      drs: car.drs,
      ers: r1(car.ers),
      fuel: r1(car.fuel),
      tc: car.compound,
      ta: car.tyreAge,
      tw: r1(Math.min(100, ((car.tyreAge + car.extraAge) / COMPOUNDS[car.compound].cliff) * 75)),
      tt: car.tyreT.map(r1),
      tp: car.psi.map(r1),
      bt: car.brakeT.map((x) => Math.round(x)),
      et: r1(car.waterT),
      ot: r1(car.oilT),
      st: car.status
    };
  }

  drain(car) {
    const out = car.outbox;
    car.outbox = [];
    return out;
  }
}
