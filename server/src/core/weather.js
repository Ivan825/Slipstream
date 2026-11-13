/**
 * Weather engine. Race control (or the random generator) schedules showers;
 * rain intensity ramps in and out, and track wetness follows it with lag
 * (tracks get wet fast and dry slowly). It also produces a lap-by-lap forecast
 * with honest uncertainty, which the strategy engine plans against.
 */
export class Weather {
  constructor({ random = true, rng = Math.random } = {}) {
    this.random = random;
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.rain = 0;
    this.wetness = 0;
    this.airTemp = 26 + Math.round(this.rng() * 4);
    this.trackTemp = this.airTemp + 14;
    this.wind = Math.round((1 + this.rng() * 4) * 10) / 10;
    this.showers = [];
    this.nextRandomCheck = Date.now() + 6 * 60_000;
  }

  /** Schedule a shower: starts in `inSec`, lasts `durationSec`, peak intensity 0..1. */
  schedule({ inSec = 180, durationSec = 300, intensity = 0.6 }) {
    const start = Date.now() + inSec * 1000;
    const s = {
      id: Math.random().toString(36).slice(2, 8),
      start, end: start + durationSec * 1000,
      intensity: Math.max(0.05, Math.min(1, intensity)),
      // forecast models are never certain about timing
      timingErrorSec: (this.rng() - 0.5) * 50,
      confidence: 0.75 + this.rng() * 0.2
    };
    this.showers.push(s);
    return s;
  }

  clear() {
    this.showers = [];
  }

  intensityAt(t, { useForecastError = false } = {}) {
    let x = 0;
    for (const s of this.showers) {
      const shift = useForecastError ? s.timingErrorSec * 1000 : 0;
      const a = s.start + shift, b = s.end + shift;
      if (t < a - 0 || t > b) continue;
      const ramp = 45_000;
      const k = Math.min(1, (t - a) / ramp, (b - t) / ramp);
      x = Math.max(x, s.intensity * Math.max(0, k));
    }
    return x;
  }

  tick(dtSec) {
    const now = Date.now();
    this.rain = this.intensityAt(now);
    const target = Math.min(1, this.rain * 1.15);
    const k = target > this.wetness ? 0.03 : 0.0045;
    this.wetness += (target - this.wetness) * Math.min(1, k * dtSec);
    if (this.wetness < 0.002) this.wetness = 0;
    this.trackTemp += ((this.airTemp + 14 - this.wetness * 16) - this.trackTemp) * Math.min(1, 0.01 * dtSec);
    this.showers = this.showers.filter((s) => s.end > now - 60_000);
    if (this.random && now > this.nextRandomCheck) {
      this.nextRandomCheck = now + 8 * 60_000;
      if (this.rng() < 0.35 && !this.showers.length) {
        this.schedule({ inSec: 240 + this.rng() * 240, durationSec: 180 + this.rng() * 300, intensity: 0.35 + this.rng() * 0.5 });
      }
    }
  }

  /**
   * Predicted wetness at future times (ms epochs), integrating the same wetness
   * dynamics forward. `override` lets the strategy what-if inject hypothetical rain.
   */
  predictWetness(times, override = null) {
    const out = [];
    let w = this.wetness;
    let t = Date.now();
    const step = 5000;
    const rainAt = (tt) => {
      let r = this.intensityAt(tt, { useForecastError: true });
      if (override) {
        if (override.noRain) r = 0;
        if (override.rain && tt >= override.rain.start && tt <= override.rain.end) r = Math.max(r, override.rain.intensity);
      }
      return r;
    };
    for (const target of times) {
      while (t < target) {
        const goal = Math.min(1, rainAt(t) * 1.15);
        const k = goal > w ? 0.03 : 0.0045;
        w += (goal - w) * Math.min(1, k * (step / 1000));
        t += step;
      }
      out.push(Math.max(0, Math.min(1, w)));
    }
    return out;
  }

  /** forecast per upcoming lap: probability of rain and expected intensity */
  forecast(laps = 10, lapSec = 95) {
    const now = Date.now();
    const out = [];
    for (let j = 0; j < laps; j++) {
      const a = now + j * lapSec * 1000, b = a + lapSec * 1000;
      let prob = 0, intensity = 0;
      for (const s of this.showers) {
        const sa = s.start + s.timingErrorSec * 1000, sb = s.end + s.timingErrorSec * 1000;
        if (sb < a || sa > b) {
          // near misses still carry some probability (timing uncertainty)
          const dist = Math.min(Math.abs(sa - b), Math.abs(sb - a)) / 1000;
          if (dist < 90) prob = Math.max(prob, 0.25 * (1 - dist / 90));
          continue;
        }
        const minutesAhead = Math.max(0, (sa - now) / 60000);
        const p = Math.max(0.3, s.confidence - 0.03 * minutesAhead);
        prob = Math.max(prob, p);
        intensity = Math.max(intensity, s.intensity);
      }
      const wet = this.predictWetness([b])[0];
      out.push({ lap: j, rainProb: Math.round(prob * 100) / 100, intensity: Math.round(intensity * 100) / 100, wetness: Math.round(wet * 100) / 100 });
    }
    return out;
  }

  snapshot(lapSec) {
    return {
      rain: round2(this.rain), wetness: round2(this.wetness), airTemp: Math.round(this.airTemp),
      trackTemp: Math.round(this.trackTemp), wind: this.wind,
      showers: this.showers.map((s) => ({ id: s.id, start: s.start, end: s.end, intensity: s.intensity })),
      forecast: this.forecast(10, lapSec)
    };
  }
}
const round2 = (x) => Math.round(x * 100) / 100;
