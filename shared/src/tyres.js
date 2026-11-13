/**
 * Tyre + weather performance model shared by the simulator (to drive the cars)
 * and the strategy engine (to predict lap times). Keeping one model means the
 * strategist's predictions match what the cars actually do.
 *
 * All values are seconds added to the reference lap time.
 */

export const COMPOUNDS = {
  S: { id: 'S', name: 'Soft', color: '#ff3b3b', offset: -0.65, deg: 0.085, cliff: 13, idealTemp: 100, wear: 7.0, wet: false },
  M: { id: 'M', name: 'Medium', color: '#ffd60a', offset: 0.0, deg: 0.055, cliff: 22, idealTemp: 95, wear: 4.4, wet: false },
  H: { id: 'H', name: 'Hard', color: '#f2f2f2', offset: 0.55, deg: 0.035, cliff: 32, idealTemp: 90, wear: 3.0, wet: false },
  I: { id: 'I', name: 'Intermediate', color: '#2bd94e', offset: 0.0, deg: 0.06, cliff: 26, idealTemp: 75, wear: 3.6, wet: true },
  W: { id: 'W', name: 'Wet', color: '#3d8bff', offset: 0.0, deg: 0.05, cliff: 30, idealTemp: 65, wear: 3.0, wet: true }
};
export const DRY = ['S', 'M', 'H'];
export const ALL_COMPOUNDS = ['S', 'M', 'H', 'I', 'W'];

export const PIT_LOSS = { GREEN: 21.0, VSC: 13.5, SC: 10.5, RED: 0, YELLOW: 21.0 };
export const FUEL_EFFECT_PER_KG = 0.032;
export const FUEL_PER_LAP_KG = 1.55;

/** degradation (s) for a compound at a given tyre age (laps) */
export function degradation(compound, age, degMultiplier = 1) {
  const c = COMPOUNDS[compound];
  const linear = c.deg * age;
  const over = Math.max(0, age - c.cliff);
  return (linear + over * over * 0.22) * degMultiplier;
}

/** penalty (s) for running a compound on a track with wetness 0 (dry) .. 1 (flooded) */
export function wetPenalty(compound, wetness) {
  const w = Math.max(0, Math.min(1, wetness));
  if (compound === 'I') return 2.8 - 1.2 * Math.min(w, 0.55) + 9 * Math.max(0, w - 0.78);
  if (compound === 'W') return 5.6 - 2.6 * w;
  // slicks
  return 15 * w + (w > 0.45 ? 22 * (w - 0.45) : 0);
}

/** Predicted lap time (s) relative to nothing: reference + every effect. */
export function predictLapTime({ base = 91, compound, age, wetness = 0, fuelKg = 0, driverPace = 0, degMultiplier = 1 }) {
  return base + COMPOUNDS[compound].offset + degradation(compound, age, degMultiplier) + wetPenalty(compound, wetness) + fuelKg * FUEL_EFFECT_PER_KG + driverPace;
}

/** Best compound for a given wetness, used for crossover decisions. */
export function bestCompoundFor(wetness, candidates = ALL_COMPOUNDS, age = 0) {
  let best = null, bestT = Infinity;
  for (const c of candidates) {
    const t = COMPOUNDS[c].offset + degradation(c, age) + wetPenalty(c, wetness);
    if (t < bestT) { bestT = t; best = c; }
  }
  return best;
}
