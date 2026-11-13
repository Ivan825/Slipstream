import { COMPOUNDS, getTrack, indexAt } from '@slipstream/shared';

const CORNERS = ['FL', 'FR', 'RL', 'RR'];

/** Exponentially weighted mean/variance for streaming z-scores */
export class Ewma {
  constructor(alpha = 0.05) { this.alpha = alpha; this.mean = null; this.var = 0; this.n = 0; }
  update(x) {
    this.n++;
    if (this.mean === null) { this.mean = x; return; }
    const d = x - this.mean;
    this.mean += this.alpha * d;
    this.var = (1 - this.alpha) * (this.var + this.alpha * d * d);
  }
  z(x) {
    const sd = Math.sqrt(this.var);
    return sd > 1e-6 ? (x - this.mean) / sd : 0;
  }
}

/**
 * Streaming anomaly detection on in-order frames.
 * Detectors: sustained thresholds, rate of change, EWMA z-score, heartbeat.
 * Each (car, type) pair has a cooldown so one problem raises one alert.
 */
export class AnomalyEngine {
  constructor({ raise, cooldownMs = 30000 }) {
    this.raise = raise;
    this.cooldownMs = cooldownMs;
    this.track = getTrack();
    this.state = new Map();
    this.last = new Map();
  }

  reset() {
    this.state.clear();
    this.last.clear();
  }

  st(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { hotSince: [null, null, null, null], psiHist: [], brakePeak: 0, braking: false, brakeBase: new Ewma(0.04), engSince: null, slowSince: null };
      this.state.set(id, s);
    }
    return s;
  }

  fire(car, type, severity, title, message, extra = {}) {
    const key = `${car.id}:${type}`;
    const now = Date.now();
    if (now - (this.last.get(key) || 0) < this.cooldownMs) return;
    this.last.set(key, now);
    this.raise({ carId: car.id, team: car.team, type, severity, title, message, lap: car.frame?.lap, seq: car.frame?.seq, ts: new Date(), ...extra });
  }

  /** run all detectors for one frame */
  check(car, f, ctx) {
    const s = this.st(car.id);
    const comp = COMPOUNDS[f.tc];

    // 1. tyre overheating: corner average above limit for 2.5 s
    const limit = comp.idealTemp + (comp.wet ? 25 : 18);
    for (let t = 0; t < 4; t++) {
      const avg = (f.tt[t * 3] + f.tt[t * 3 + 1] + f.tt[t * 3 + 2]) / 3;
      if (avg > limit) {
        s.hotSince[t] ??= f.ts;
        if (f.ts - s.hotSince[t] > 2500) {
          this.fire(car, 'TYRE_OVERHEAT', 'crit', `${CORNERS[t]} tyre overheating`,
            `${CORNERS[t]} at ${avg.toFixed(0)}°C, above the ${limit}°C limit for ${comp.name.toLowerCase()}s for ${((f.ts - s.hotSince[t]) / 1000).toFixed(1)} s`,
            { value: Math.round(avg), threshold: limit });
        }
      } else s.hotSince[t] = null;
    }

    // 2. puncture: pressure falling faster than 0.4 psi/s
    s.psiHist.push({ ts: f.ts, p: f.tp.slice() });
    while (s.psiHist.length && f.ts - s.psiHist[0].ts > 1500) s.psiHist.shift();
    if (s.psiHist.length > 5) {
      const a = s.psiHist[0];
      const dt = (f.ts - a.ts) / 1000;
      if (dt > 0.8) {
        for (let t = 0; t < 4; t++) {
          const rate = (f.tp[t] - a.p[t]) / dt;
          if (rate < -0.4 && f.tp[t] < 19.5) {
            this.fire(car, 'PUNCTURE', 'crit', `Puncture suspected · ${CORNERS[t]}`,
              `${CORNERS[t]} pressure falling ${Math.abs(rate).toFixed(2)} psi/s, now ${f.tp[t].toFixed(1)} psi`,
              { value: f.tp[t], threshold: -0.4 });
          }
        }
      }
    }

    // 3. brake fade: peak front brake temp per braking event vs EWMA baseline
    const front = Math.max(f.bt[0], f.bt[1]);
    if (f.brk > 0.05) {
      s.braking = true;
      s.brakePeak = Math.max(s.brakePeak, front);
    } else if (s.braking) {
      s.braking = false;
      const peak = s.brakePeak;
      s.brakePeak = 0;
      const z = s.brakeBase.z(peak);
      if (s.brakeBase.n > 25 && z > 3.5 && peak > 900) {
        this.fire(car, 'BRAKE_TEMP', 'warn', 'Brake temperature spike',
          `Front brake peak ${Math.round(peak)}°C (z = ${z.toFixed(1)} vs this car's baseline ${Math.round(s.brakeBase.mean)}°C). Possible brake fade`,
          { value: Math.round(peak), threshold: Math.round(s.brakeBase.mean) });
      } else {
        s.brakeBase.update(peak);
      }
    }

    // 4. engine coolant temperature
    if (f.et > 120) {
      s.engSince ??= f.ts;
      if (f.ts - s.engSince > 3000) {
        const crit = f.et > 128;
        this.fire(car, crit ? 'ENGINE_TEMP_CRIT' : 'ENGINE_TEMP', crit ? 'crit' : 'warn', crit ? 'Engine overheating' : 'Engine temperature high',
          `Coolant ${f.et.toFixed(1)}°C (limit ${crit ? 128 : 120}°C). Consider lift-and-coast`, { value: f.et, threshold: crit ? 128 : 120 });
      }
    } else s.engSince = null;

    // 5. slow car on track under green
    if (ctx.trackStatus === 'GREEN' && f.st !== 'PIT' && f.lap >= 1) {
      const ref = this.track.vRef[indexAt(this.track, f.d)] * 3.6;
      if (f.v < ref * 0.45 && f.v < 160) {
        s.slowSince ??= f.ts;
        if (f.ts - s.slowSince > 3000) {
          this.fire(car, 'SLOW_CAR', 'warn', 'Car slow on track',
            `${Math.round(f.v)} km/h vs ${Math.round(ref)} km/h expected at ${Math.round(f.d)} m. Possible damage or puncture`,
            { value: Math.round(f.v), threshold: Math.round(ref * 0.45) });
        }
      } else s.slowSince = null;
    } else s.slowSince = null;
  }

  /** heartbeat: called periodically with all race cars */
  heartbeat(cars, running) {
    if (!running) return;
    const now = Date.now();
    for (const c of cars) {
      if (!c.frame || c.finished) continue;
      if (now - c.lastSeenAt > 2000) {
        this.fire(c, 'TELEMETRY_LOST', 'warn', 'Telemetry lost', `No frames from car ${c.meta.number} for ${((now - c.lastSeenAt) / 1000).toFixed(1)} s`);
      }
    }
  }
}
