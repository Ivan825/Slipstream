import { getTrack, frameAt, positionAt } from '@slipstream/shared';

export const HEAT = [[0, [91, 77, 255]], [0.45, [0, 200, 255]], [0.75, [255, 214, 0]], [1, [255, 30, 40]]];
export const TYRE_RAMP = [[0, [60, 110, 255]], [0.4, [0, 214, 107]], [0.7, [255, 214, 10]], [1, [255, 40, 40]]];

export function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(',')})`;
}

/** Map track metres to canvas pixels, fitted with padding. */
export function fitTrack(w, h, pad = 40, topPad = 0) {
  const t = getTrack();
  const b = t.bounds;
  const s = Math.min((w - pad * 2) / b.w, (h - pad * 2 - topPad) / b.h);
  const ox = (w - b.w * s) / 2 - b.minX * s;
  const oy = (h - b.h * s + topPad) / 2 - b.minY * s;
  return { s, X: (x) => ox + x * s, Y: (y) => oy + y * s, t };
}

/**
 * Draw the static circuit layer once (offscreen): dotted grid, run-off, kerbs,
 * asphalt, a channel-coloured racing line, DRS zones, sector lines, the
 * chequered start line and corner numbers.
 */
export function drawCircuit(ctx, w, h, { colorAt, fit = fitTrack(w, h), labels = true, kerbs = true, width = 1 } = {}) {
  const { X, Y, t } = fit;
  const P = (i) => t.pts[((i % t.N) + t.N) % t.N];
  const path = (i0, i1, off = 0) => {
    ctx.beginPath();
    for (let q = i0; q <= i1; q++) {
      const p = P(q);
      let x = X(p.x), y = Y(p.y);
      if (off) { const n = frameAt(t, ((q % t.N) + t.N) % t.N); x += n.nx * off; y += n.ny * off; }
      q === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  };
  const k = width;
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  for (let x = 10; x < w; x += 22) for (let y = 10; y < h; y += 22) ctx.fillRect(x, y, 1, 1);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  path(0, t.N);
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 30 * k; ctx.stroke();
  ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 21 * k; ctx.stroke();
  if (kerbs) {
    for (const c of t.corners) {
      path(c.i - 13, c.i + 13);
      ctx.lineWidth = 22 * k; ctx.lineCap = 'butt';
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#e10600'; ctx.lineDashOffset = 0; ctx.stroke();
      ctx.strokeStyle = '#f4f4f4'; ctx.lineDashOffset = 4; ctx.stroke();
      ctx.setLineDash([]); ctx.lineCap = 'round';
    }
  }
  path(0, t.N);
  ctx.strokeStyle = '#22222c'; ctx.lineWidth = 16 * k; ctx.stroke();
  // pit lane
  const pe = t.pit.entry, px = t.pit.exit;
  const iE = idxOf(t, pe), iX = idxOf(t, px);
  path(iE, iX + t.N, -16 * k);
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 3 * k; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
  // coloured racing line
  ctx.lineWidth = 3.6 * k;
  for (let i = 0; i < t.N; i++) {
    const a = P(i), b = P(i + 1);
    ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y));
    ctx.strokeStyle = colorAt ? colorAt(i, t.cum[i]) : ramp(HEAT, t.sp[i]);
    ctx.stroke();
  }
  // DRS zones
  for (const z of t.drs) {
    const a = idxOf(t, z.from), b = idxOf(t, z.to % t.L) + (z.to > t.L || idxOf(t, z.to % t.L) < a ? t.N : 0);
    path(a, b, 15 * k);
    ctx.strokeStyle = '#00d66b'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    if (labels) {
      const m = Math.floor((a + b) / 2), p = P(m), n = frameAt(t, m % t.N);
      const x = X(p.x) + n.nx * 30, y = Y(p.y) + n.ny * 30;
      ctx.fillStyle = '#00d66b'; ctx.fillRect(x - 17, y - 8, 34, 16);
      ctx.fillStyle = '#15151e'; ctx.font = '900 10px "Titillium Web", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('DRS', x, y + 0.5);
    }
  }
  // sector boundaries
  [[t.sectors[0], 'S2', '#00d66b'], [t.sectors[1], 'S3', '#ffd60a']].forEach(([d, lab, col]) => {
    const i = idxOf(t, d), p = P(i), n = frameAt(t, i);
    ctx.beginPath(); ctx.moveTo(X(p.x) - n.nx * 11, Y(p.y) - n.ny * 11); ctx.lineTo(X(p.x) + n.nx * 11, Y(p.y) + n.ny * 11);
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'butt'; ctx.stroke(); ctx.lineCap = 'round';
    if (labels) {
      ctx.fillStyle = col; ctx.font = '700 10px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lab, X(p.x) - n.nx * 24, Y(p.y) - n.ny * 24);
    }
  });
  // chequered start/finish
  {
    const p = P(0), n = frameAt(t, 0);
    ctx.save(); ctx.translate(X(p.x), Y(p.y)); ctx.rotate(Math.atan2(n.ny, n.nx));
    for (let a = -3; a < 3; a++) for (let b = 0; b < 2; b++) { ctx.fillStyle = (a + b) % 2 ? '#fff' : '#111'; ctx.fillRect(a * 3.4, -3.4 + b * 3.4, 3.4, 3.4); }
    ctx.restore();
  }
  if (labels) {
    t.corners.forEach((c) => {
      const p = P(c.i), n = frameAt(t, c.i);
      const x = X(p.x) + n.nx * 26, y = Y(p.y) + n.ny * 26;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = 'rgba(21,21,30,.9)'; ctx.fill();
      ctx.strokeStyle = '#4a4a58'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#c9c9d4'; ctx.font = '700 9px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.n, x, y + 0.5);
    });
  }
  return fit;
}

export function idxOf(t, d) {
  d = ((d % t.L) + t.L) % t.L;
  let lo = 0, hi = t.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t.cum[m] <= d) lo = m; else hi = m; }
  return lo;
}

/** car position in canvas coordinates; cars in the pit lane are drawn offset into it */
export function carXY(fit, total, status) {
  const t = fit.t;
  const d = ((total % t.L) + t.L) % t.L;
  const p = positionAt(t, d);
  let x = fit.X(p.x), y = fit.Y(p.y);
  if (status === 'PIT' || status === 'GARAGE') {
    const n = frameAt(t, p.i);
    x -= n.nx * 16; y -= n.ny * 16;
  }
  return { x, y };
}

export function pill(ctx, x, y, text, bg, fg, maxW = Infinity) {
  ctx.font = '900 11px "Titillium Web", sans-serif';
  const tw = ctx.measureText(text).width + 14;
  if (x + tw > maxW - 4) x = x - tw - 28; // flip to the left near the right edge
  if (y < 4) y = 4;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + tw, y); ctx.lineTo(x + tw - 5, y + 18); ctx.lineTo(x - 5, y + 18); ctx.closePath(); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 5, y + 9.5);
}
