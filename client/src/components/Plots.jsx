import { useCanvas, useAnimationFrame } from '../lib/hooks.js';
import { drawCircuit, fitTrack } from '../lib/draw.js';
import { getTrack } from '@slipstream/shared';
import { useEffect, useRef } from 'react';

/** Generic canvas scatter: points [{x, y, color, r, alpha}], optional lines [{pts:[{x,y}], color, dash}] */
export function Scatter({ points = [], lines = [], xLabel = '', yLabel = '', yFmt = (v) => v.toFixed(1), xFmt = (v) => String(Math.round(v)), height = 320, yRange }) {
  const [ref, get] = useCanvas();
  const key = useRef('');
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const k = `${g.v}:${points.length}:${lines.length}:${points[0]?.y}:${points[points.length - 1]?.y}`;
    if (key.current === k) return;
    key.current = k;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    if (!points.length) {
      ctx.fillStyle = '#9d9dad'; ctx.font = '600 13px "Titillium Web"'; ctx.textAlign = 'center'; ctx.fillText('No data yet', w / 2, h / 2);
      return;
    }
    const xs = points.map((p) => p.x).concat(lines.flatMap((l) => l.pts.map((p) => p.x)));
    const ys = points.map((p) => p.y).concat(lines.flatMap((l) => l.pts.map((p) => p.y)));
    let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = yRange || [Math.min(...ys), Math.max(...ys)];
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const py = (y1 - y0) * 0.06; y0 -= py; y1 += py;
    const L = 58, R = 12, T = 10, B = 30;
    const X = (x) => L + ((x - x0) / (x1 - x0)) * (w - L - R);
    const Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (h - T - B);
    ctx.font = '10px "JetBrains Mono", monospace'; ctx.fillStyle = '#9d9dad';
    for (let i = 0; i <= 5; i++) {
      const v = y0 + ((y1 - y0) * i) / 5, y = Y(v);
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(yFmt(v), L - 6, y);
    }
    const steps = Math.min(10, Math.max(1, Math.round(x1 - x0)));
    for (let i = 0; i <= steps; i++) {
      const v = x0 + ((x1 - x0) * i) / steps;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(xFmt(v), X(v), h - 12);
    }
    ctx.fillStyle = '#6c6c7c'; ctx.textAlign = 'center'; ctx.fillText(xLabel, L + (w - L - R) / 2, h - 1);
    ctx.save(); ctx.translate(11, T + (h - T - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
    for (const l of lines) {
      if (l.pts.length < 2) continue;
      ctx.beginPath(); l.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width || 2; ctx.setLineDash(l.dash || []); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const p of points) {
      ctx.globalAlpha = p.alpha ?? 0.9;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), p.r || 3.2, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.fill();
      if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }, [points, lines]);
  return <div style={{ height }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} /></div>;
}

/** Box plot per group: groups [{label, color, values:[]}], sorted by median by the caller */
export function BoxPlot({ groups = [], height = 300, fmt = (v) => v.toFixed(2) }) {
  const [ref, get] = useCanvas();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const g = get();
      if (!g || !g.w) return;
      const { ctx, w, h } = g;
      ctx.clearRect(0, 0, w, h);
      const all = groups.flatMap((x) => x.values);
      if (!all.length) return;
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
      const lo = q(all, 0.02), hi = q(all, 0.98);
      const L = 56, R = 10, T = 10, B = 26;
      const Y = (v) => T + (1 - (v - lo) / ((hi - lo) || 1)) * (h - T - B);
      const bw = (w - L - R) / groups.length;
      ctx.font = '10px "JetBrains Mono", monospace';
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4, y = Y(v);
        ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
        ctx.fillStyle = '#9d9dad'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v), L - 6, y);
      }
      groups.forEach((gr, i) => {
        if (!gr.values.length) return;
        const cx = L + bw * i + bw / 2, half = Math.min(18, bw * 0.3);
        const [a, m, b] = [q(gr.values, 0.25), q(gr.values, 0.5), q(gr.values, 0.75)];
        const iqr = b - a, wl = Math.max(Math.min(...gr.values), a - 1.5 * iqr), wh = Math.min(Math.max(...gr.values), b + 1.5 * iqr);
        ctx.strokeStyle = gr.color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(cx, Y(wl)); ctx.lineTo(cx, Y(a)); ctx.moveTo(cx, Y(b)); ctx.lineTo(cx, Y(wh)); ctx.stroke();
        ctx.fillStyle = gr.color + '55'; ctx.fillRect(cx - half, Y(b), half * 2, Y(a) - Y(b));
        ctx.strokeRect(cx - half, Y(b), half * 2, Y(a) - Y(b));
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - half, Y(m)); ctx.lineTo(cx + half, Y(m)); ctx.stroke();
        ctx.fillStyle = '#d6d7df'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(gr.label, cx, h - 8);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [groups, get, fmt]);
  return <div style={{ height }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} /></div>;
}

/** Static circuit map coloured per mini-sector (dominance, gain/loss) */
export function SectorMap({ colorFor, height = 380, version = '' }) {
  const [ref, get] = useCanvas();
  const t = getTrack();
  useEffect(() => {
    let id;
    const draw = () => {
      const g = get();
      if (!g || !g.w) { id = requestAnimationFrame(draw); return; }
      const { ctx, w, h } = g;
      ctx.clearRect(0, 0, w, h);
      drawCircuit(ctx, w, h, { fit: fitTrack(w, h, 34), colorAt: (i, d) => colorFor(d / t.L), kerbs: false, width: 1.15 });
    };
    id = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => { cancelAnimationFrame(id); id = requestAnimationFrame(draw); });
    if (ref.current) ro.observe(ref.current);
    return () => { cancelAnimationFrame(id); ro.disconnect(); };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div style={{ height }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} /></div>;
}
