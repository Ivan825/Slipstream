import { useRef } from 'react';
import { useCanvas, useAnimationFrame } from '../lib/hooks.js';
import { replayCars, replayPos } from '../store/replay.js';
import { useUI } from '../store/stores.js';
import { ramp, HEAT } from '../lib/draw.js';
import { circuitOf, backAlong } from '../lib/circuit.js';

const SECTOR_COL = ['#ff3d6e', '#38d8ff', '#ffd60a'];
const MODES = [['track', 'Track'], ['speed', 'Speed'], ['sectors', 'Sectors']];

/**
 * The circuit of a real session with every car, drawn from the cars' own
 * coordinates. The static layer (outline, racing line, sectors, DRS and
 * overtaking zones, corners, speed trap, start/finish, yellow sectors) is drawn
 * once per size and mode; cars, trails, battles and the pit-rejoin ghost every frame.
 */
export default function RealTrack({ meta, drivers, selected, onSelect, rows = [], yellows = [], ghost = null, lap = null, total = null, compact = false }) {
  const [ref, get] = useCanvas();
  const off = useRef({ canvas: null, key: '' });
  const fitRef = useRef(null);
  const trails = useRef(new Map());
  const hint = useRef(new Map());
  const mode = useUI((s) => s.realMap);
  const setMode = useUI((s) => s.setRealMap);
  const c = circuitOf(meta);
  const yKey = yellows.map((y) => `${y.sector}${y.flag}`).join(',');

  useAnimationFrame((ts) => {
    const g = get();
    if (!g || !g.w || !c) return;
    const { ctx, w, h, dpr } = g;
    const key = `${w}x${h}@${dpr}:${g.v}:${mode}:${yKey}:${compact}`;
    if (off.current.key !== key) {
      const cv = off.current.canvas || document.createElement('canvas');
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const o = cv.getContext('2d');
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.clearRect(0, 0, w, h);
      fitRef.current = drawStatic(o, w, h, c, { mode, yellows, compact });
      off.current = { canvas: cv, key };
      trails.current.clear();
    }
    const { X, Y } = fitRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(off.current.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const now = performance.now();
    const cars = [];
    for (const [n] of replayCars) {
      const p = replayPos(n, now);
      if (!p) continue;
      const x = X(p.x), y = Y(p.y);
      let tr = trails.current.get(n);
      if (!tr) { tr = []; trails.current.set(n, tr); }
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - x, last.y - y) > 1.5) { tr.push({ x, y }); if (tr.length > 16) tr.shift(); }
      if (last && Math.hypot(last.x - x, last.y - y) > 80) tr.length = 0;
      const i = c.nearest(p.x, p.y, hint.current.get(n));
      hint.current.set(n, i);
      cars.push({ n, x, y, i, d: drivers.get(n), tr });
    }
    const byN = new Map(cars.map((k) => [k.n, k]));
    for (const k of cars) {
      for (let q = 1; q < k.tr.length; q++) {
        ctx.globalAlpha = (q / k.tr.length) * 0.5;
        ctx.beginPath(); ctx.moveTo(k.tr[q - 1].x, k.tr[q - 1].y); ctx.lineTo(k.tr[q].x, k.tr[q].y);
        ctx.strokeStyle = k.d?.color || '#888'; ctx.lineWidth = 3; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // battles: a car within a second of the one ahead
    for (let q = 1; q < rows.length; q++) {
      const r = rows[q];
      if (typeof r.int !== 'number' || r.int > 1 || r.pos >= 99) continue;
      const a = byN.get(r.n), b = byN.get(rows[q - 1].n);
      if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > 90) continue;
      ctx.save();
      ctx.strokeStyle = r.int < 0.5 ? '#ff3b3b' : '#ffb020'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
    // where the selected car would rejoin if it boxed this lap
    if (ghost && c) {
      const ahead = ghost.ahead != null ? byN.get(ghost.ahead) : null;
      const metresPerSec = c.lengthM / (ghost.refLap || 90);
      let gi = null;
      if (ahead) gi = backAlong(c, ahead.i, (ghost.gapAhead || 0) * metresPerSec);
      else if (ghost.behind != null && byN.get(ghost.behind)) gi = backAlong(c, byN.get(ghost.behind).i, -(ghost.gapBehind || 0) * metresPerSec);
      if (gi != null) {
        const p = c.track[gi], x = X(p[0]), y = Y(p[1]);
        ctx.save();
        ctx.globalAlpha = 0.65 + 0.25 * Math.sin(ts / 260);
        ctx.setLineDash([3, 3]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '900 10px "Titillium Web"'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`PIT NOW → P${ghost.pos}`, x + 12, y + 12);
        ctx.restore();
      }
    }
    for (const k of cars) {
      const col = k.d?.color || '#888';
      ctx.shadowColor = col; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(k.x, k.y, k.n === selected ? 7 : 5.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.font = k.n === selected ? '900 12px "Titillium Web"' : '700 10px "Titillium Web"';
      ctx.fillStyle = k.n === selected ? '#fff' : 'rgba(255,255,255,.75)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(k.d?.code || k.n, k.x + 9, k.y - 9);
    }
    const s = byN.get(selected);
    if (s) { ctx.beginPath(); ctx.arc(s.x, s.y, 12 + 4 * Math.sin(ts / 200), 0, Math.PI * 2); ctx.strokeStyle = s.d?.color || '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
    ref.current._hits = cars;
  }, [meta, selected, drivers, mode, yKey, rows, ghost, compact]);

  const onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = (ref.current._hits || []).map((k) => ({ k, d: Math.hypot(k.x - x, k.y - y) })).sort((a, b) => a.d - b.d)[0];
    if (hit && hit.d < 18) onSelect(hit.k.n);
  };

  if (!c) return <div className="mapbox"><div className="empty"><b>No circuit outline</b>This session has no location data for a clean lap.</div></div>;
  return (
    <div className="mapbox">
      <canvas ref={ref} onClick={onClick} style={{ cursor: 'pointer' }} aria-label={`Track map of ${meta.circuit} with every car, sectors, DRS zones and corners`} />
      <div className="ov tl">
        <h4>{meta.circuit}</h4>
        <span className="mu">{(c.lengthM / 1000).toFixed(3)} km · {c.corners.length} corners{c.hasDrs ? ` · ${c.drs.length} DRS zone${c.drs.length === 1 ? '' : 's'}` : ''}{lap != null ? ` · lap ${lap}${total ? ` / ${total}` : ''}` : ''}</span>
        {!compact && (
          <div className="seg pe" style={{ marginTop: 8 }}>
            {MODES.map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
          </div>
        )}
      </div>
      {!compact && (
        <div className="ov bl">
          {mode === 'speed' && <><span className="mu">SPEED · fastest lap</span><div className="legend-bar">{Math.round(c.vmin)}<i />{Math.round(c.vmax)} km/h</div></>}
          {mode === 'sectors' && <span className="mu"><b style={{ color: SECTOR_COL[0] }}>S1</b> · <b style={{ color: SECTOR_COL[1] }}>S2</b> · <b style={{ color: SECTOR_COL[2] }}>S3</b>{c.sectorsApprox ? ' (approximate)' : ''} · {c.marshal.length} marshal sectors</span>}
          {mode === 'track' && <span className="mu track-key"><i className="k-drs" />{c.hasDrs ? 'DRS zone' : 'overtaking straight'} <i className="k-yel" />yellow flag <i className="k-bat" />battle &lt;1 s <i className="k-gh" />pit-rejoin</span>}
        </div>
      )}
      {!compact && <div className="ov br">corners from speed minima on the fastest lap{c.estimated ? ' (estimated)' : ''}<br />5 Hz positions · interpolated 60 fps</div>}
    </div>
  );
}

/** the static circuit layer; returns the fit */
function drawStatic(ctx, w, h, c, { mode, yellows, compact }) {
  const xs = c.track.map((p) => p[0]), ys = c.track.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = compact ? 30 : 56, top = compact ? 0 : 30;
  const s = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2 - top) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s + top) / 2;
  const X = (x) => ox + (x - minX) * s, Y = (y) => h - (oy + (y - minY) * s) + top / 2;
  const N = c.N, at = c.at;
  const P = (i) => { const p = c.track[at(i)]; return [X(p[0]), Y(p[1])]; };
  const cx = w / 2, cy = h / 2;
  // outward normal in screen space
  const nrm = (i) => {
    const [ax, ay] = P(i - 2), [bx, by] = P(i + 2), [px, py] = P(i);
    let nx = -(by - ay), ny = bx - ax;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    if (nx * (px - cx) + ny * (py - cy) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  const path = (i0, i1, off = 0) => {
    ctx.beginPath();
    for (let q = i0; q <= i1; q++) {
      let [x, y] = P(q);
      if (off) { const [nx, ny] = nrm(q); x += nx * off; y += ny * off; }
      q === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  };
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  for (let x = 10; x < w; x += 22) for (let y = 10; y < h; y += 22) ctx.fillRect(x, y, 1, 1);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  path(0, N);
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 26; ctx.stroke();
  ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 18; ctx.stroke();
  // kerbs at corners
  if (!compact) for (const k of c.corners) {
    path(k.i - 4, k.i + 4);
    ctx.lineWidth = 19; ctx.lineCap = 'butt'; ctx.setLineDash([4, 4]); ctx.strokeStyle = '#e10600'; ctx.stroke();
    ctx.strokeStyle = '#f4f4f4'; ctx.lineDashOffset = 4; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.lineCap = 'round';
  }
  path(0, N); ctx.strokeStyle = '#22222c'; ctx.lineWidth = 13; ctx.stroke();
  // yellow flags by marshal sector
  for (const y of yellows) {
    const m = c.marshal[y.sector - 1];
    if (!m) continue;
    path(m.a, m.b); ctx.strokeStyle = y.flag === 'DOUBLE YELLOW' ? 'rgba(255,214,10,.95)' : 'rgba(255,214,10,.7)'; ctx.lineWidth = y.flag === 'DOUBLE YELLOW' ? 16 : 13; ctx.stroke();
  }
  // racing line
  ctx.lineWidth = mode === 'track' ? 2 : 3.4;
  for (let i = 0; i < N; i++) {
    const [ax, ay] = P(i), [bx, by] = P(i + 1);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.strokeStyle = mode === 'speed' ? ramp(HEAT, (c.v[i] - c.vmin) / (c.vmax - c.vmin || 1))
      : mode === 'sectors' ? SECTOR_COL[i < c.sectors[0] ? 0 : i < c.sectors[1] ? 1 : 2] : 'rgba(255,255,255,.7)';
    ctx.stroke();
  }
  const tag = (x, y, text, bg, fg = '#15151e') => {
    ctx.font = '900 9.5px "Titillium Web", sans-serif';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg; ctx.fillRect(x - tw / 2, y - 7.5, tw, 15);
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
  };
  // DRS zones, or the overtaking straights when the cars have no DRS
  const zs = c.hasDrs ? c.drs : (mode === 'track' ? c.zones : []);
  zs.forEach((z, k) => {
    path(z.a, z.b, 15);
    ctx.strokeStyle = c.hasDrs ? '#00d66b' : '#38d8ff'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    if (compact) return;
    const m = Math.round((z.a + z.b) / 2), [px, py] = P(m), [nx, ny] = nrm(m);
    tag(px + nx * 31, py + ny * 31, c.hasDrs ? `DRS ${z.n}` : `OT ${k + 1}`, c.hasDrs ? '#00d66b' : '#38d8ff');
  });
  // sector boundaries and labels
  const tick = (i, col, w2 = 3) => {
    const [px, py] = P(i), [nx, ny] = nrm(i);
    ctx.beginPath(); ctx.moveTo(px - nx * 11, py - ny * 11); ctx.lineTo(px + nx * 11, py + ny * 11);
    ctx.strokeStyle = col; ctx.lineWidth = w2; ctx.lineCap = 'butt'; ctx.stroke(); ctx.lineCap = 'round';
  };
  tick(c.sectors[0], SECTOR_COL[1]); tick(c.sectors[1], SECTOR_COL[2]);
  if (!compact) {
    const bounds = [0, c.sectors[0], c.sectors[1], N];
    for (let k = 0; k < 3; k++) {
      const m = Math.round((bounds[k] + bounds[k + 1]) / 2), [px, py] = P(m), [nx, ny] = nrm(m);
      ctx.fillStyle = SECTOR_COL[k]; ctx.font = '900 11px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`S${k + 1}`, px - nx * 26, py - ny * 26);
    }
  }
  // speed trap
  if (!compact) {
    const [px, py] = P(c.trap), [nx, ny] = nrm(c.trap);
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fillStyle = '#b84dff'; ctx.fill();
    tag(px - nx * 24, py - ny * 24, `TRAP ${Math.round(c.v[c.trap])}`, '#b84dff', '#fff');
  }
  // start / finish: chequered line, label and the direction of travel
  {
    const [px, py] = P(0), [bx, by] = P(3);
    const ang = Math.atan2(by - py, bx - px);
    ctx.save(); ctx.translate(px, py); ctx.rotate(ang + Math.PI / 2);
    for (let a = -3; a < 3; a++) for (let b = 0; b < 2; b++) { ctx.fillStyle = (a + b) % 2 ? '#fff' : '#111'; ctx.fillRect(a * 3.6, -3.6 + b * 3.6, 3.6, 3.6); }
    ctx.restore();
    if (!compact) {
      const [nx, ny] = nrm(0);
      tag(px + nx * 32, py + ny * 32, 'START · FINISH', '#fff');
      // arrow along the track
      const [ax, ay] = P(Math.round(N / 40)), [nx2, ny2] = nrm(Math.round(N / 40));
      const x0 = ax - nx2 * 22, y0 = ay - ny2 * 22;
      ctx.save(); ctx.translate(x0, y0); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(7, 0); ctx.moveTo(2, -5); ctx.lineTo(8, 0); ctx.lineTo(2, 5);
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    }
  }
  // corner numbers
  for (const k of c.corners) {
    const [px, py] = P(k.i), [nx, ny] = nrm(k.i);
    const x = px + nx * (compact ? 16 : 24), y = py + ny * (compact ? 16 : 24);
    ctx.beginPath(); ctx.arc(x, y, compact ? 7 : 9, 0, Math.PI * 2); ctx.fillStyle = 'rgba(21,21,30,.92)'; ctx.fill();
    ctx.strokeStyle = '#4a4a58'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#c9c9d4'; ctx.font = `700 ${compact ? 8 : 9}px "JetBrains Mono", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(k.n, x, y + 0.5);
  }
  return { X, Y };
}
