/**
 * Circuit geometry for a real session, derived from one clean lap the server
 * recorded: the outline, and per outline point the car's speed, DRS and brake.
 *
 * From that: distance along the lap, corners (speed minima, numbered from the
 * line; these are detected, so a chicane may count as one), DRS zones, the
 * overtaking zones (the DRS zones, or the longest full-speed straights into a
 * braking point when the cars have no DRS), the speed trap, sector boundaries
 * and marshal sectors (each sector split by its mini-sector count).
 */
const cache = new WeakMap();

export function circuitOf(meta) {
  if (!meta?.track?.length) return null;
  const hit = cache.get(meta);
  if (hit) return hit;
  const c = build(meta.track, meta.info || null);
  cache.set(meta, c);
  return c;
}

export function build(track, info) {
  const N = track.length;
  const cum = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const a = track[i - 1], b = track[i % N];
    cum[i] = cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const L = cum[N] || 1;
  const metresPerUnit = info?.length ? info.length / L : 0.1;
  const lengthM = info?.length || Math.round(L * 0.1);
  const at = (i) => ((i % N) + N) % N;

  // speed along the lap: recorded, or estimated from curvature when the lap had no car data
  let v = info?.v?.length === N ? info.v.slice() : null;
  const estimated = !v;
  if (!v) {
    v = new Array(N);
    for (let i = 0; i < N; i++) {
      const p = track[at(i - 4)], q = track[i], r = track[at(i + 4)];
      const h1 = Math.atan2(q[1] - p[1], q[0] - p[0]), h2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
      let dh = Math.abs(h2 - h1); if (dh > Math.PI) dh = 2 * Math.PI - dh;
      v[i] = Math.max(70, 330 - dh * 420);
    }
  }
  const sm = v.map((_, i) => (v[at(i - 1)] + v[i] * 2 + v[at(i + 1)]) / 4);
  const vmax = Math.max(...sm), vmin = Math.min(...sm);

  // corners: local speed minima with a real drop from the preceding straight
  const win = Math.max(4, Math.round(N / 60));
  const mins = [];
  for (let i = 0; i < N; i++) {
    let isMin = true;
    for (let k = 1; k <= win && isMin; k++) if (sm[at(i - k)] < sm[i] || sm[at(i + k)] <= sm[i]) isMin = false;
    if (!isMin) continue;
    let pre = 0;
    for (let k = 1; k <= win * 4; k++) pre = Math.max(pre, sm[at(i - k)]);
    if (pre - sm[i] > 28) mins.push(i);
  }
  const corners = mins.map((i, k) => ({ n: k + 1, i, v: Math.round(sm[i]), d: cum[i] }));

  // contiguous runs of a per-point condition, wrapping across the line
  const runs = (pred, minLen) => {
    const out = [];
    let s = null;
    for (let i = 0; i < N; i++) {
      if (pred(i)) { if (s == null) s = i; } else if (s != null) { out.push([s, i - 1]); s = null; }
    }
    if (s != null) {
      if (out.length && out[0][0] === 0) out[0] = [s, out[0][1] + N];
      else out.push([s, N - 1]);
    }
    return out.filter(([a, b]) => b - a + 1 >= minLen);
  };
  const cornerAfter = (i) => corners.find((c) => c.i > i % N) || corners[0];
  const cornerBefore = (i) => [...corners].reverse().find((c) => c.i < i % N) || corners[corners.length - 1];
  const lenM = (a, b) => (b >= N ? cum[N] - cum[a] + cum[b - N] : cum[b] - cum[a]) * metresPerUnit;

  // full-speed straights, longest first
  const fast = runs((i) => sm[i] >= vmin + (vmax - vmin) * 0.78, Math.max(4, Math.round(N / 50)))
    .map(([a, b]) => ({ a, b, m: Math.round(lenM(a, b)), into: cornerAfter(b), after: cornerBefore(a) }))
    .sort((x, y) => y.m - x.m);
  const minDrs = Math.max(3, Math.round(N / 80));
  const C = { drs: [], zones: [], hasDrs: false, ver: 0 };
  /** DRS zones from per-point flags (0/1); the overtaking zones follow: DRS zones, else the longest straights */
  const setDrs = (flags) => {
    const drs = flags ? runs((i) => flags[i] === 1, minDrs).map(([a, b], k) => ({ n: k + 1, a, b, m: Math.round(lenM(a, b)), into: cornerAfter(b), after: cornerBefore(a) })) : [];
    C.drs = drs;
    C.hasDrs = drs.length > 0;
    C.zones = (drs.length ? drs.slice().sort((x, y) => y.m - x.m) : fast.slice(0, 3)).map((z, k) => ({
      ...z, kind: drs.length ? 'DRS' : 'straight', rank: k,
      label: drs.length ? `DRS ${z.n}${z.into ? ` into T${z.into.n}` : ''}` : `${Math.round(z.m)} m straight${z.into ? ` into T${z.into.n}` : ''}`
    }));
    C.ver++;
  };
  setDrs(info?.drs?.length === N ? info.drs : null);

  let trap = 0;
  for (let i = 1; i < N; i++) if (sm[i] > sm[trap]) trap = i;
  const brakes = info?.brk?.length === N ? runs((i) => info.brk[i] === 1, 2).map(([a, b]) => ({ a, b, into: cornerAfter(a) })) : [];

  const sectorsApprox = !info?.sectors?.[0] || !info?.sectors?.[1];
  const sectors = sectorsApprox ? [Math.round(N / 3), Math.round((2 * N) / 3)] : info.sectors;
  // marshal sectors: each timing sector split evenly (points are evenly spaced in time) by its mini-sector count
  const segs = info?.segments || [7, 7, 7];
  const bounds = [0, sectors[0], sectors[1], N];
  const marshal = [];
  for (let s = 0; s < 3; s++) {
    const a = bounds[s], b = bounds[s + 1], k = segs[s];
    for (let j = 0; j < k; j++) marshal.push({ n: marshal.length + 1, a: Math.round(a + ((b - a) * j) / k), b: Math.round(a + ((b - a) * (j + 1)) / k) });
  }

  /** index of the outline point nearest to (x, y); `hint` makes it a local search */
  const nearest = (x, y, hint) => {
    let best = 0, bd = Infinity;
    const scan = (i0, i1) => { for (let q = i0; q <= i1; q++) { const i = at(q), p = track[i], d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = i; } } };
    if (hint != null) { scan(hint - 25, hint + 40); if (bd < (L / N * 6) ** 2) return best; }
    scan(0, N - 1);
    return best;
  };
  /** the zone a car reaches next from point i, and the metres to it */
  const nextZone = (i) => {
    let bestZ = null, bm = Infinity;
    for (const z of C.zones) { const d = ((z.a - i + N) % N); if (d < bm) { bm = d; bestZ = z; } }
    return bestZ;
  };

  /*
   * The reference lap may not have used DRS (it needs a car within a second
   * ahead), so DRS zones are also learnt from every car as the session plays:
   * each frame with DRS open marks the point the car is at.
   */
  const hits = new Float32Array(N);
  let seen = 0, lastLearn = 0;
  const noteDrs = (i, open) => {
    if (!open) return;
    hits[i] += 1; seen++;
    if (seen - lastLearn < 200) return;
    lastLearn = seen;
    let mx = 0;
    for (let k = 0; k < N; k++) mx = Math.max(mx, hits[k]);
    const flags = Array.from(hits, (h) => (h >= Math.max(3, mx * 0.12) ? 1 : 0));
    // close one-point gaps so a zone isn't split by a missed sample
    for (let k = 0; k < N; k++) if (!flags[k] && flags[at(k - 1)] && flags[at(k + 1)]) flags[k] = 1;
    const was = C.drs.map((z) => `${z.a}-${z.b}`).join();
    const next = runs((k) => flags[k] === 1, minDrs);
    if (next.length && next.map(([a, b]) => `${a}-${b}`).join() !== was) setDrs(flags);
  };

  return Object.assign(C, {
    N, cum, L, track, v: sm, vmax, vmin, estimated, lengthM, metresPerUnit, corners, fast, trap, brakes,
    sectors, sectorsApprox, marshal, segs, nearest, nextZone, at, noteDrs
  });
}

/** distance along the lap (0..1) for an outline index */
export const frac = (c, i) => c.cum[i] / c.L;

/** where a car at fraction f of the lap is, stepped back by `metres` along the lap */
export function backAlong(c, i, metres) {
  const units = metres / c.metresPerUnit;
  let d = c.cum[i] - units;
  while (d < 0) d += c.L;
  let lo = 0, hi = c.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.cum[m] <= d) lo = m; else hi = m; }
  return lo;
}
