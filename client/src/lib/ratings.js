/**
 * Driver ratings from this session's own data, up to the clock:
 *   pace         best fuel-corrected clean laps against the field's best
 *   consistency  spread of clean laps around each stint's degradation trend
 *   tyres        degradation on each compound against the field's for that compound
 *   racecraft    on-track overtakes made minus overtakes suffered (OpenF1 overtakes)
 * Scored 0–100 and blended into one rating. Used by the battle forecast (a
 * better racer passes and defends a little better) and shown on the Drivers tab.
 */
import { FUEL_S_PER_LAP, COMP } from './realStrategy.js';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function fit(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  const k = den ? num / den : 0;
  const res = pts.map(([x, y]) => y - (my + k * (x - mx)));
  return { k, sd: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n) };
}

export function ratings({ data, model, t }) {
  if (!data || !model) return new Map();
  const out = new Map();
  const degBy = {}; // compound -> [slopes]
  const per = new Map();
  for (const [n, laps] of model.byDriver) {
    const clean = laps.filter(model.clean);
    // fuel-corrected: add back the time the burnt fuel gave
    const fc = clean.map((l) => ({ ...l, fc: l.time + FUEL_S_PER_LAP * l.lap }));
    const best5 = fc.map((l) => l.fc).sort((a, b) => a - b).slice(0, 5);
    const stints = (data.stints || []).filter((s) => s.n === n);
    const slopes = [], sds = [];
    for (const s of stints) {
      const pts = fc.filter((l) => l.lap >= (s.from ?? 1) && l.lap <= (s.to ?? 999)).map((l) => [l.lap - (s.from ?? 1) + (s.age || 0), l.fc]);
      const f = fit(pts);
      if (!f) continue;
      const c = COMP[s.compound];
      slopes.push({ c, k: f.k, w: pts.length }); sds.push(f.sd);
      if (pts.length >= 5) (degBy[c] ||= []).push(f.k);
    }
    per.set(n, { pace: best5.length ? median(best5) : null, slopes, sd: sds.length ? median(sds) : null, laps: clean.length });
  }
  const medDeg = Object.fromEntries(Object.entries(degBy).map(([c, a]) => [c, median(a)]));
  const bestPace = Math.min(...[...per.values()].map((p) => p.pace).filter(Boolean), Infinity);
  const ot = new Map();
  for (const o of data.overtakes || []) {
    if (o.t > t) continue;
    const a = ot.get(o.n) || { made: 0, lost: 0 }; a.made++; ot.set(o.n, a);
    const b = ot.get(o.o) || { made: 0, lost: 0 }; b.lost++; ot.set(o.o, b);
  }
  for (const [n, p] of per) {
    const paceDelta = p.pace != null && Number.isFinite(bestPace) ? p.pace - bestPace : null;
    const pace = paceDelta == null ? null : clamp(100 - paceDelta * 22, 0, 100);
    const cons = p.sd == null ? null : clamp(100 - (p.sd - 0.15) * 90, 0, 100);
    let tyreDelta = null, w = 0;
    for (const s of p.slopes) if (medDeg[s.c] != null && s.w >= 5) { tyreDelta = (tyreDelta || 0) + (s.k - medDeg[s.c]) * s.w; w += s.w; }
    tyreDelta = w ? tyreDelta / w : null;
    const tyres = tyreDelta == null ? null : clamp(70 - tyreDelta * 500, 0, 100);
    const o = ot.get(n) || { made: 0, lost: 0 };
    const racecraft = clamp(55 + (o.made - o.lost) * 7, 0, 100);
    const parts = [[pace, 0.45], [cons, 0.2], [tyres, 0.2], [racecraft, 0.15]].filter(([v]) => v != null);
    const wsum = parts.reduce((a, [, k]) => a + k, 0);
    const overall = wsum ? parts.reduce((a, [v, k]) => a + v * k, 0) / wsum : null;
    out.set(n, { pace, paceDelta, cons, sd: p.sd, tyres, tyreDelta, racecraft, made: o.made, lost: o.lost, overall, laps: p.laps });
  }
  return out;
}
