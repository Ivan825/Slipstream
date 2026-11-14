import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CARS, CAR_BY_ID, getTrack } from '@slipstream/shared';
import { useCanvas, useAnimationFrame } from '../lib/hooks.js';
import { drawCircuit, fitTrack, carXY, pill, idxOf } from '../lib/draw.js';
import { race, drawTotal } from '../lib/live.js';
import { useUI, useSession, useTiming, colorOf } from '../store/stores.js';
import { useAuth } from '../store/auth.js';
import { api } from '../lib/api.js';

const SECTOR_COL = ['#ff3d6e', '#38d8ff', '#ffd60a'];

export default function TrackMap() {
  const [ref, get] = useCanvas();
  const off = useRef({ canvas: null, key: '' });
  const trails = useRef(new Map());
  const fitRef = useRef(null);
  const sel = useUI((s) => s.selected);
  const select = useUI((s) => s.select);
  const mode = useUI((s) => s.mapMode);
  const setMode = useUI((s) => s.setMapMode);
  const session = useSession((s) => s.session);
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const [dominance, setDominance] = useState(null);
  const t = getTrack();

  // live track dominance: refreshed from the analysis API while that mode is on
  useEffect(() => {
    if (mode !== 'dominance' || !session?.sessionId) return;
    let alive = true;
    const load = () => api(`/analysis/${session.sessionId}/dominance`).then((d) => alive && setDominance(d)).catch(() => {});
    load();
    const id = setInterval(load, 20000);
    return () => { alive = false; clearInterval(id); };
  }, [mode, session?.sessionId]);

  useAnimationFrame((ts) => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h, dpr } = g;
    const key = `${w}x${h}@${dpr}:${mode}:${dominance?.sectors?.map((s) => s.carId).join('') || ''}`;
    if (off.current.key !== key) {
      const c = off.current.canvas || document.createElement('canvas');
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const octx = c.getContext('2d');
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, w, h);
      const fit = fitTrack(w, h, 46, 40);
      let colorAt;
      if (mode === 'sectors') colorAt = (i, d) => SECTOR_COL[d < t.sectors[0] ? 0 : d < t.sectors[1] ? 1 : 2];
      if (mode === 'dominance' && dominance?.sectors) {
        const n = dominance.miniSectors;
        colorAt = (i, d) => { const s = dominance.sectors[Math.min(n - 1, Math.floor((d / t.L) * n))]; return s?.carId ? colorOf(s.carId) : '#555'; };
      }
      drawCircuit(octx, w, h, { fit, colorAt });
      off.current = { canvas: c, key };
      fitRef.current = fit;
      trails.current.clear();
    }
    const fit = fitRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(off.current.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // rain radar sweep
    const rain = session?.weather?.rain || 0;
    if (rain > 0.03) {
      const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
      const ang = (ts / 1600) % (Math.PI * 2);
      ctx.save();
      ctx.globalAlpha = 0.18 + rain * 0.25;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      grad.addColorStop(0, 'rgba(56,216,255,.0)'); grad.addColorStop(1, 'rgba(56,140,255,.35)');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, ang - 0.5, ang); ctx.closePath();
      ctx.fillStyle = 'rgba(56,216,255,.22)'; ctx.fill();
      ctx.restore();
    }

    const now = performance.now();
    const rows = useTiming.getState().rows;
    const leader = useTiming.getState().order[0];
    const drawn = [];
    for (const c of CARS) {
      const st = race.cars.get(c.id);
      if (!st) continue;
      const total = drawTotal(c.id, now);
      const { x, y } = carXY(fit, total, st.status);
      let tr = trails.current.get(c.id);
      if (!tr) { tr = []; trails.current.set(c.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - x, last.y - y) > 1.5) { tr.push({ x, y }); if (tr.length > 18) tr.shift(); }
      if (last && Math.hypot(last.x - x, last.y - y) > 60) tr.length = 0;
      drawn.push({ id: c.id, x, y, status: st.status, tr });
    }
    for (const d of drawn) {
      if (d.status === 'GARAGE') continue;
      const col = colorOf(d.id);
      for (let k = 1; k < d.tr.length; k++) {
        ctx.globalAlpha = (k / d.tr.length) * (d.id === sel ? 0.9 : 0.5);
        ctx.beginPath(); ctx.moveTo(d.tr[k - 1].x, d.tr[k - 1].y); ctx.lineTo(d.tr[k].x, d.tr[k].y);
        ctx.strokeStyle = col; ctx.lineWidth = d.id === sel ? 4 : 3; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const d of drawn.slice().reverse()) {
      if (d.status === 'GARAGE') continue;
      const col = colorOf(d.id);
      ctx.shadowColor = col; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.id === sel ? 7 : 5.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 1.6; ctx.strokeStyle = d.status === 'PIT' ? '#ffd60a' : '#fff'; ctx.stroke();
    }
    const me = drawn.find((d) => d.id === sel && d.status !== 'GARAGE');
    if (me) {
      const r = 12 + 4 * Math.sin(ts / 200);
      ctx.beginPath(); ctx.arc(me.x, me.y, r, 0, Math.PI * 2); ctx.strokeStyle = colorOf(me.id); ctx.lineWidth = 2; ctx.stroke();
      pill(ctx, me.x + 14, me.y - 26, `${CAR_BY_ID[me.id].number}  ${me.id}`, colorOf(me.id), '#fff', w);
    }
    const ld = drawn.find((d) => d.id === leader);
    if (ld && ld.id !== sel && ld.status !== 'GARAGE') pill(ctx, ld.x + 12, ld.y - 24, `P1  ${ld.id}`, '#fff', '#15151e', w);
    ref.current._hits = drawn;
    void rows;
  }, [sel, mode, dominance, session?.weather?.rain]);

  const onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = (ref.current._hits || []).filter((d) => d.status !== 'GARAGE').map((d) => ({ d, k: Math.hypot(d.x - x, d.y - y) })).sort((a, b) => a.k - b.k)[0];
    if (hit && hit.k < 16) {
      if (e.detail === 2 && canOpen(user, hit.d.id)) nav(`/car/${hit.d.id}`);
      else select(hit.d.id);
    }
  };

  const sector = (k) => {
    const row = useTiming.getState().rows[sel];
    const f = row?.sf?.[k];
    return f === 'p' ? '#b84dff' : f === 'g' ? '#00d66b' : f === 'y' ? '#ffd60a' : 'var(--ln)';
  };

  return (
    <div className="card mapcard">
      <div className="mapbox">
        <canvas ref={ref} onClick={onClick} style={{ cursor: 'pointer' }} aria-label="Live track map. Click a car to select it." />
        <div className="ov tl">
          <h4>Marina Ridge</h4><span className="mu">5.218 km · {t.corners.length} turns · {t.drs.length} DRS zones · {race.cars.size} cars{session?.type === 'race' && session?.totalLaps ? ` · lap ${session.lap || 0} / ${session.totalLaps}` : ''}</span>
          <div className="seg pe" style={{ marginTop: 8 }}>
            {[['speed', 'Speed heat'], ['sectors', 'Sectors'], ['dominance', 'Dominance']].map(([k, l]) => (
              <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>
            ))}
          </div>
        </div>
        {sel && (
          <div className="ov tr">
            {[0, 1, 2].map((k) => {
              const f = useTiming.getState().rows[sel]?.sf?.[k];
              return <div key={k} className="sect" style={{ borderColor: sector(k) }}><small>{sel} · S{k + 1}</small><b style={{ color: sector(k) }}>{f === 'p' ? 'FASTEST' : f === 'g' ? 'PB' : f === 'y' ? 'SLOWER' : '—'}</b></div>;
            })}
          </div>
        )}
        <div className="ov bl">
          {mode === 'speed' && (<><span className="mu">SPEED</span><div className="legend-bar">75<i />330 km/h</div></>)}
          {mode === 'sectors' && <span className="mu">S1 · S2 · S3 boundaries, DRS zones in green</span>}
          {mode === 'dominance' && <span className="mu">Fastest car through each of {dominance?.miniSectors || 25} mini-sectors (best laps)</span>}
        </div>
        <div className="ov br">10 Hz positions · interpolated 60 fps<br />room · {useAuth.getState().user ? 'race' : 'race:2hz'}</div>
      </div>
    </div>
  );
}

export const canOpen = (user, carId) => user?.role === 'race_control' || (user?.role === 'engineer' && CAR_BY_ID[carId]?.team === user.team);
export { idxOf };
