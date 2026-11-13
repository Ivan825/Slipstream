/**
 * Marina Ridge International Circuit (fictional).
 *
 * The circuit is described by a handful of normalised control points that are
 * turned into a smooth closed Catmull-Rom spline, scaled to a real length of
 * 5,218 m. From the geometry we derive everything the simulator, server and
 * client need: a reference speed profile (from curvature), corners, sectors,
 * DRS zones, timing loops and the pit lane. Server, simulator and client all
 * build the same track from this module, so a car's position only needs to be
 * sent as "distance into the lap" (one number instead of x/y).
 */

const CONTROL = [
  [0.10, 0.80], [0.07, 0.52], [0.13, 0.28], [0.27, 0.14], [0.42, 0.17], [0.50, 0.33],
  [0.58, 0.40], [0.68, 0.27], [0.80, 0.12], [0.93, 0.20], [0.92, 0.40], [0.78, 0.50],
  [0.83, 0.66], [0.74, 0.84], [0.55, 0.80], [0.42, 0.90], [0.25, 0.92]
];

export const TRACK_INFO = {
  id: 'marina-ridge',
  name: 'Marina Ridge International Circuit',
  shortName: 'Marina Ridge',
  lengthM: 5218,
  referenceLapS: 91.0,
  timingLoops: 60
};

const SAMPLES_PER_SEGMENT = 40;

function catmullRom(points, seg) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    for (let j = 0; j < seg; j++) {
      const t = j / seg, t2 = t * t, t3 = t2 * t;
      const f = (k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push({ x: f(0), y: f(1) });
    }
  }
  return out;
}

function circularSmooth(arr, w) {
  const n = arr.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -w; k <= w; k++) s += arr[(i + k + n) % n];
    out[i] = s / (2 * w + 1);
  }
  return out;
}

function cumulative(pts) {
  const n = pts.length, cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return cum;
}

function longestRuns(values, threshold, n) {
  // circular runs of indices where values[i] > threshold, longest first
  const runs = [];
  let start = -1;
  // find a starting index that is below threshold so runs don't wrap mid-way
  let origin = 0;
  for (let i = 0; i < n; i++) if (values[i] <= threshold) { origin = i; break; }
  for (let q = 0; q <= n; q++) {
    const i = (origin + q) % n;
    const above = q < n && values[i] > threshold;
    if (above && start < 0) start = origin + q;
    if (!above && start >= 0) { runs.push([start, origin + q - 1]); start = -1; }
  }
  return runs.map(([a, b]) => ({ from: a % n, to: b % n, len: b - a + 1 })).sort((x, y) => y.len - x.len);
}

let cached = null;

/** Build (once) and return the full track model. Distances are metres. */
export function getTrack() {
  if (cached) return cached;

  // 1. spline in an arbitrary unit space
  let pts = catmullRom(CONTROL.map(([x, y]) => [x * 1000, y * 800]), SAMPLES_PER_SEGMENT);
  const N = pts.length;

  // 2. curvature -> normalised speed factor (0 slow .. 1 flat out)
  const k = 6;
  let curv = new Float64Array(N), signed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = pts[(i - k + N) % N], b = pts[i], c = pts[(i + k) % N];
    let d = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    curv[i] = Math.abs(d);
    signed[i] = d;
  }
  curv = circularSmooth(circularSmooth(curv, 4), 4);
  signed = circularSmooth(signed, 6);
  let maxC = 0;
  for (const v of curv) maxC = Math.max(maxC, v);
  let sp = new Float64Array(N);
  for (let i = 0; i < N; i++) sp[i] = 1 - Math.pow(curv[i] / maxC, 0.75) * 0.76;
  sp = circularSmooth(sp, 8);

  // normalise to 0..1 so thresholds are meaningful
  let spMin = Infinity, spMax = -Infinity;
  for (const v of sp) { spMin = Math.min(spMin, v); spMax = Math.max(spMax, v); }
  for (let i = 0; i < N; i++) sp[i] = (sp[i] - spMin) / (spMax - spMin);
  const fastThreshold = [...sp].sort((a, b) => a - b)[Math.floor(N * 0.8)];

  // 3. rotate so that index 0 (start/finish) sits 40% into the longest straight
  const straight = longestRuns(sp, fastThreshold, N)[0];
  const shift = (straight.from + Math.floor(straight.len * 0.4)) % N;
  const rot = (arr) => Array.from({ length: N }, (_, i) => arr[(i + shift) % N]);
  pts = rot(pts);
  sp = Float64Array.from(rot(sp));
  curv = Float64Array.from(rot(curv));
  signed = Float64Array.from(rot(signed));

  // 4. scale to the real circuit length
  const rawCum = cumulative(pts);
  const scale = TRACK_INFO.lengthM / rawCum[N];
  pts = pts.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const cum = cumulative(pts);
  const L = cum[N];

  // 5. reference speed (m/s): v = vMin + (vMax - vMin) * sp^gamma, with gamma
  //    solved by bisection so the lap takes exactly the reference lap time.
  const vMin = 21, vMax = 92;
  const vRef = new Float64Array(N);
  const lapFor = (gamma) => {
    let t = 0;
    for (let i = 0; i < N; i++) t += (cum[i + 1] - cum[i]) / (vMin + (vMax - vMin) * Math.pow(sp[i], gamma));
    return t;
  };
  let lo = 0.05, hi = 6;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (lapFor(mid) > TRACK_INFO.referenceLapS) hi = mid; else lo = mid;
  }
  const gamma = (lo + hi) / 2;
  for (let i = 0; i < N; i++) vRef[i] = vMin + (vMax - vMin) * Math.pow(sp[i], gamma);
  let lap = 0;
  for (let i = 0; i < N; i++) lap += (cum[i + 1] - cum[i]) / vRef[i];
  const cal = lap / TRACK_INFO.referenceLapS;
  for (let i = 0; i < N; i++) vRef[i] *= cal;

  // lateral curvature in 1/m (signed: + = left-hand)
  const kappa = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const ds = (cum[Math.min(N, i + k)] - cum[Math.max(0, i - k)]) || 1;
    kappa[i] = signed[i] / ds;
  }

  // 6. corners: local curvature peaks
  const corners = [];
  for (let i = 0; i < N; i++) {
    if (curv[i] < 0.3 * maxC) continue;
    let peak = true;
    for (let j = -16; j <= 16; j++) if (curv[(i + j + N) % N] > curv[i]) { peak = false; break; }
    if (peak && (!corners.length || i - corners[corners.length - 1].i > 20)) corners.push({ i, d: cum[i], n: 0 });
  }
  corners.forEach((c, idx) => { c.n = idx + 1; });

  // 7. DRS zones: the two longest flat-out runs
  const drs = longestRuns(sp, fastThreshold, N).slice(0, 2).map((r) => {
    const from = cum[r.from], to = cum[(r.to + 1) % N] || L;
    return { from, to: to > from ? to : to + L, detection: (from - 120 + L) % L };
  });

  // centre point for "outward" label placement
  let cx = 0, cy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    cx += p.x; cy += p.y;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }

  cached = {
    ...TRACK_INFO,
    N, pts, cum, L, sp, vRef, kappa, corners, drs,
    sectors: [L / 3, (2 * L) / 3],
    pit: { entry: L - 300, box: L - 60, exit: 260, speedLimit: 22.2, stopS: 2.6 },
    centre: { x: cx / N, y: cy / N },
    bounds: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
  };
  return cached;
}

export const wrap = (d, L) => ((d % L) + L) % L;

/** index of the sample at distance d (binary search on cumulative length) */
export function indexAt(track, d) {
  d = wrap(d, track.L);
  let lo = 0, hi = track.N;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (track.cum[m] <= d) lo = m; else hi = m;
  }
  return lo;
}

/** x/y position (metres) at distance d, linearly interpolated */
export function positionAt(track, d) {
  d = wrap(d, track.L);
  const i = indexAt(track, d);
  const a = track.pts[i], b = track.pts[(i + 1) % track.N];
  const seg = track.cum[i + 1] - track.cum[i];
  const f = seg ? (d - track.cum[i]) / seg : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, i };
}

/** unit tangent + outward normal at sample i */
export function frameAt(track, i) {
  const N = track.N;
  const a = track.pts[(i - 2 + N) % N], b = track.pts[(i + 2) % N];
  let tx = b.x - a.x, ty = b.y - a.y;
  const l = Math.hypot(tx, ty) || 1;
  tx /= l; ty /= l;
  let nx = -ty, ny = tx;
  const p = track.pts[i];
  if (nx * (p.x - track.centre.x) + ny * (p.y - track.centre.y) < 0) { nx = -nx; ny = -ny; }
  return { tx, ty, nx, ny };
}

export function sectorOf(track, d) {
  d = wrap(d, track.L);
  return d < track.sectors[0] ? 0 : d < track.sectors[1] ? 1 : 2;
}

export function inDrsZone(track, d) {
  d = wrap(d, track.L);
  return track.drs.some((z) => (z.to <= track.L ? d >= z.from && d <= z.to : d >= z.from || d <= z.to - track.L));
}

export function referenceSpeedAt(track, d) {
  return track.vRef[indexAt(track, d)];
}
