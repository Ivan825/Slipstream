/**
 * Estimated tyre temperatures and wear for real sessions.
 *
 * Public timing has no tyre sensors, so each car's four tyres are run through a
 * small thermal model fed by its own replay frames: lateral load from the
 * car's yaw rate and speed (the outside tyres of a corner work hardest),
 * braking load on the fronts, traction on the rears at low speed, and cooling
 * towards the track temperature that grows with airflow. A stop resets the set
 * to blanket temperature. The surface reacts in seconds; the carcass follows
 * slowly. Wear per corner shares the set's age-versus-life by the work each
 * corner has done on this set.
 *
 * Order everywhere: [front-left, front-right, rear-left, rear-right].
 */
export const tyres = new Map(); // n -> { surf[4], core[4], work[4], last, ta }
const BLANKET = 75;

const wrap = (a) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);

function fresh() {
  return { surf: [BLANKET, BLANKET, BLANKET, BLANKET], core: [BLANKET, BLANKET, BLANKET, BLANKET], work: [1, 1, 1, 1], last: null, ta: null, peak: 0 };
}

/** feed one replay frame: [n, x, y, km/h, gear, throttle, brake, drs, rpm] per car */
export function tyreStep(t, cars, trackTemp = 35) {
  const amb = (trackTemp ?? 35) + 12;
  for (const [n, x, y, v, , thr, brk] of cars) {
    let s = tyres.get(n);
    if (!s) { s = fresh(); tyres.set(n, s); }
    const last = s.last;
    s.last = { t, x, y, v, h: last?.h ?? 0 };
    if (!last || t <= last.t || t - last.t > 2500) continue;
    const dt = (t - last.t) / 1000;
    const dist = Math.hypot(x - last.x, y - last.y);
    const vms = v / 3.6;
    let yaw = 0;
    if (dist > 2) {
      const h = Math.atan2(y - last.y, x - last.x);
      yaw = wrap(h - last.h) / dt;
      s.last.h = h;
      if (Math.abs(yaw) > 3) yaw = 0; // a seek or a glitch, not a corner
    }
    const lat = Math.min(5.5, Math.abs(vms * yaw) / 9.81); // g
    const lon = (vms - last.v / 3.6) / dt / 9.81; // g, negative under braking
    const left = yaw > 0; // counter-clockwise in track coordinates: the right-hand tyres are on the outside
    const load = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const outside = (k % 2 === 1) === left;
      load[k] += lat * (outside ? 1 : 0.45);
    }
    const braking = brk || lon < -0.6 ? Math.min(5, Math.abs(Math.min(lon, -0.6))) : 0;
    load[0] += braking * 0.9; load[1] += braking * 0.9; load[2] += braking * 0.35; load[3] += braking * 0.35;
    if (thr > 60 && lon > 0.1 && v < 220) { load[2] += lon * 1.6; load[3] += lon * 1.6; }
    for (let k = 0; k < 4; k++) load[k] += 0.25 + vms / 160; // rolling and aero load
    const cool = 0.18 * (0.5 + vms / 70);
    for (let k = 0; k < 4; k++) {
      const heat = 7.2 * load[k];
      s.surf[k] += (heat - cool * (s.surf[k] - amb) - 0.35 * (s.surf[k] - s.core[k])) * dt;
      s.surf[k] = Math.max(amb - 5, Math.min(150, s.surf[k]));
      s.core[k] += ((s.surf[k] - s.core[k]) / 25) * dt;
      s.work[k] += load[k] * dt * (vms > 5 ? 1 : 0);
    }
  }
}

/** a new set: blanket temperatures, no work done */
export function tyreReset(n) {
  const s = tyres.get(n);
  if (!s) return;
  const f = fresh();
  s.surf = f.surf; s.core = f.core; s.work = f.work;
}

/**
 * The set on one car as the panels show it. `age` and `life` come from timing
 * and the strategist; temperatures from the model above.
 */
export function tyreView(n, { compound, age, life, deg }) {
  const s = tyres.get(n);
  if (s && s.ta != null && age != null && age < s.ta) tyreReset(n); // the stint restarted: a stop
  if (s) s.ta = age;
  const total = s ? s.work.reduce((a, b) => a + b, 0) : 4;
  const share = s ? s.work.map((w) => (w / total) * 4) : [1, 1, 1, 1];
  const used = life ? Math.max(0, (age ?? 0) / life) : 0;
  const wear = share.map((k) => Math.min(100, Math.round(used * k * 78))); // a set is usually changed at ~75–80% worn
  const win = WINDOW[compound] || WINDOW.M;
  return {
    surf: s ? s.surf.map(Math.round) : null, core: s ? s.core.map(Math.round) : null, wear, win,
    cliffIn: life && age != null ? Math.round(life - age) : null, deg, compound, age, life
  };
}

/** working windows (surface, °C), roughly: softer compounds work cooler */
export const WINDOW = { S: [85, 105], M: [90, 112], H: [95, 120], I: [60, 85], W: [50, 75] };

/** colour for a temperature against the compound's window */
export function tempColour(T, [lo, hi]) {
  if (T == null) return '#2c2c38';
  if (T < lo - 12) return '#3a6bff';
  if (T < lo) return '#38d8ff';
  if (T <= hi) return '#00d66b';
  if (T <= hi + 10) return '#ffd60a';
  return '#ff3b3b';
}
