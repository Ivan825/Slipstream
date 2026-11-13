import { useEffect, useRef, useState } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { CAR_BY_ID, TEAM_BY_ID, COMPOUNDS, getTrack, formatLapTime, carsOfTeam } from '@slipstream/shared';
import { useRooms, buffer } from '../lib/live.js';
import { api } from '../lib/api.js';
import { useCanvas, useAnimationFrame, useTicker } from '../lib/hooks.js';
import { ramp, TYRE_RAMP } from '../lib/draw.js';
import { useAuth } from '../store/auth.js';
import { useTiming, useUI, useSession, useLaps } from '../store/stores.js';
import { canOpen } from '../components/TrackMap.jsx';
import { Tyre, SectorFlags } from '../components/TimingTower.jsx';

const T = getTrack();
const lt = (ms) => (ms == null ? '—' : formatLapTime(ms / 1000));

/** time (ms) at distance d along a 25 m trace, linear interpolation */
function traceTimeAt(trace, d) {
  const D = trace.d, Tt = trace.t;
  if (!D?.length) return null;
  let lo = 0, hi = D.length - 1;
  if (d <= D[0]) return Tt[0];
  if (d >= D[hi]) return Tt[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
  const f = (d - D[lo]) / ((D[hi] - D[lo]) || 1);
  return Tt[lo] + f * (Tt[hi] - Tt[lo]);
}

/** frames of the lap currently being driven, with time since the lap started */
function currentLap(b) {
  const fr = b.frames;
  if (!fr.length) return null;
  const last = fr[fr.length - 1];
  let i = fr.length - 1;
  while (i > 0 && fr[i - 1].lap === last.lap) i--;
  const first = fr[i];
  // estimate the line crossing from the first frame of the lap
  const t0 = first.ts - (first.d / Math.max(1, first.v / 3.6)) * 1000;
  return { frames: fr.slice(i), t0, last, complete: first.d < 40 };
}

export default function Telemetry() {
  const { id: raw } = useParams();
  const id = (raw || '').toUpperCase();
  const user = useAuth((s) => s.user);
  const meta = CAR_BY_ID[id];
  const select = useUI((s) => s.select);
  useRooms(meta && canOpen(user, id) ? [`car:${id}`, 'timing', `team:${meta.team}`] : []);
  useEffect(() => { if (meta) select(id); }, [id, meta, select]);
  if (!meta) return <Navigate to="/pitwall" />;
  if (!canOpen(user, id)) {
    return <div className="card"><div className="empty"><b>Team data</b>Full telemetry for car {meta.number} is only visible to {TEAM_BY_ID[meta.team].name} and race control.</div></div>;
  }
  return <CarView id={id} key={id} />;
}

function CarView({ id }) {
  useTicker(4);
  const meta = CAR_BY_ID[id];
  const team = TEAM_BY_ID[meta.team];
  const row = useTiming((s) => s.rows[id]);
  const session = useSession((s) => s.session);
  const user = useAuth((s) => s.user);
  const [ghost, setGhost] = useState(null);
  const laps = useLaps((s) => s.byCar[id]) || [];

  // ghost = this car's best valid lap from MongoDB (refreshed when a new PB is set)
  useEffect(() => {
    let alive = true;
    api(`/laps/${id}/best`).then((d) => alive && setGhost(d.lap)).catch(() => {});
    api(`/laps?carId=${id}`).then((d) => { for (const l of d.laps) useLaps.getState().add(l); }).catch(() => {});
    return () => { alive = false; };
  }, [id, session?.sessionId, row?.best]);

  const b = buffer(id);
  const latest = b.frames[b.frames.length - 1];
  const cur = currentLap(b);
  let delta = null;
  if (ghost?.trace && cur && latest) {
    const gt = traceTimeAt(ghost.trace, latest.d);
    if (gt != null) delta = (latest.ts - cur.t0 - gt) / 1000;
  }
  const siblings = user?.role === 'engineer' ? carsOfTeam(user.team) : [];

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="tl-hero card" style={{ '--tc': team.color, borderTopRightRadius: 14 }}>
        <div className="tl-num">{meta.number}</div>
        <div className="tl-id">
          <small>{team.name.toUpperCase()} · CAR {meta.number} · {meta.nat}</small>
          <h1>{meta.first} <b>{meta.last}</b></h1>
          <div className="pills">
            <span>P{row?.pos ?? '–'}</span>
            {row?.int != null && session?.type === 'race' && <span>INT +{row.int.toFixed(3)}</span>}
            <span>LAST {lt(row?.last)}</span>
            <span className={row?.fl ? 'pb' : ''}>BEST {lt(row?.best ?? row?.pb)}</span>
            {latest && <span>{COMPOUNDS[latest.tc].name.toUpperCase()} · {latest.ta} LAPS</span>}
            {siblings.map((c) => c.id !== id && <Link key={c.id} to={`/car/${c.id}`}><span style={{ background: 'rgba(255,255,255,.12)' }}>TEAMMATE {c.id} →</span></Link>)}
          </div>
        </div>
        <div className="tl-delta">
          <small>LIVE DELTA vs GHOST</small>
          <b style={{ color: delta == null ? 'var(--mu)' : delta < 0 ? 'var(--grn)' : '#ff4d4d' }}>{delta == null ? '—' : (delta < 0 ? '−' : '+') + Math.abs(delta).toFixed(3)}</b>
          <span>{ghost ? `ghost = lap ${ghost.lap} · ${lt(ghost.timeMs)} · laps collection` : 'ghost appears after the first clean lap'}</span>
        </div>
      </div>
      <Gauges id={id} />
      <div className="tl-main">
        <div className="card">
          <div className="card-h">
            <b>Trace · lap {latest?.lap ?? '–'} vs ghost</b>
            <div className="lgd">
              <span><i style={{ background: team.color }} />LIVE</span>
              <span><i style={{ background: 'repeating-linear-gradient(90deg,#9d9dad 0 4px,transparent 4px 7px)' }} />GHOST {ghost ? `L${ghost.lap}` : ''}</span>
              <span><i style={{ background: 'var(--grn)' }} />GAINING</span>
              <span><i style={{ background: '#ff4d4d' }} />LOSING</span>
            </div>
          </div>
          <div className="traces"><Traces id={id} ghost={ghost} color={team.color} /></div>
          <MergeNote b={b} />
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-h"><b>Tyres &amp; brakes</b><span className="lbl">inner · mid · outer °C</span></div>
            <div style={{ height: 230, padding: '6px 8px' }}><TyreView id={id} /></div>
          </div>
          <div className="card">
            <div className="card-h"><b>Laps</b><SectorFlags sf={row?.sf} /></div>
            <div className="scroll" style={{ maxHeight: 210 }}>
              <table className="tbl">
                <thead><tr><th>Lap</th><th className="n">Time</th><th className="n">S1</th><th className="n">S2</th><th className="n">S3</th><th>Tyre</th></tr></thead>
                <tbody>
                  {!laps.length && <tr><td colSpan="6" className="mu">No completed laps yet.</td></tr>}
                  {laps.slice().reverse().slice(0, 30).map((l) => (
                    <tr key={l.lap}>
                      <td>{l.lap}{l.pitIn ? ' IN' : l.pitOut ? ' OUT' : ''}</td>
                      <td className={`n ${l.fastest ? 'pur' : l.pb ? 'grn' : ''}`}>{lt(l.timeMs)}</td>
                      {[0, 1, 2].map((k) => <td key={k} className="n">{l.sectors?.[k] ? (l.sectors[k] / 1000).toFixed(3) : '—'}</td>)}
                      <td><Tyre c={l.compound} age={l.tyreAge} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MergeNote({ b }) {
  const s = b.stats;
  return (
    <div className="merge-note">
      <span>history <b>{s.history}</b> frames{s.seam ? ` (db ${s.seam.fromDb ?? 0} + hot cache ${s.seam.fromCache ?? 0}, ${s.seam.ms ?? '–'} ms)` : ''}</span>
      <span>seam at seq <b>{s.seam?.cursor ?? '…'}</b></span>
      <span>live <b>{s.live}</b></span>
      <span>duplicates dropped <b>{s.dupes}</b></span>
      <span>gaps backfilled <b>{s.backfilled}</b></span>
      <span>buffer {b.frames.length} frames</span>
    </div>
  );
}

function Gauges({ id }) {
  const refs = useRef({});
  const r = (k) => (el) => { refs.current[k] = el; };
  const LED_COL = (i) => (i < 5 ? '#00d66b' : i < 10 ? '#ff2a2a' : '#4d7dff');
  useAnimationFrame(() => {
    const b = buffer(id);
    const f = b.frames[b.frames.length - 1];
    const el = refs.current;
    if (!f || !el.spd) return;
    el.spd.textContent = Math.round(f.v);
    el.gear.textContent = f.g === 0 ? 'N' : f.g;
    el.rpm.textContent = f.rpm.toLocaleString('en-US');
    const lit = Math.round(Math.max(0, Math.min(1, (f.rpm - 9200) / 3100)) * 15);
    el.leds.forEach((led, k) => { const on = k < lit; led.style.background = on ? LED_COL(k) : '#2c2c38'; led.style.boxShadow = on ? `0 0 10px ${LED_COL(k)}` : 'none'; });
    el.thr.style.width = `${f.thr * 100}%`; el.thrV.textContent = Math.round(f.thr * 100);
    el.brk.style.width = `${f.brk * 100}%`; el.brkV.textContent = Math.round(f.brk * 100);
    el.drs.classList.toggle('on', !!f.drs);
    el.ers.style.width = `${f.ers}%`; el.ersV.textContent = Math.round(f.ers);
    el.fuel.textContent = f.fuel.toFixed(1);
    el.water.textContent = f.et.toFixed(0);
    el.water.style.color = f.et > 120 ? 'var(--crit)' : '';
  }, [id]);
  return (
    <div className="gauges">
      <div className="card gauge"><span className="lbl">Speed</span><div className="g-big"><span ref={r('spd')}>—</span><sub>KM/H</sub></div></div>
      <div className="card gauge"><span className="lbl">Gear</span><div className="g-big" style={{ fontSize: 54 }} ref={r('gear')}>—</div></div>
      <div className="card gauge"><div className="rpmrow"><span className="lbl">RPM · shift lights</span><b ref={r('rpm')}>—</b></div>
        <div className="shift">{Array.from({ length: 15 }, (_, k) => <i key={k} ref={(el) => { (refs.current.leds ||= [])[k] = el; }} />)}</div></div>
      <div className="card gauge ped"><span className="lbl">Pedals</span>
        <div><span>THROTTLE</span><span className="trk"><i ref={r('thr')} style={{ background: 'var(--grn)' }} /></span><span ref={r('thrV')}>0</span></div>
        <div><span>BRAKE</span><span className="trk"><i ref={r('brk')} style={{ background: 'var(--red)' }} /></span><span ref={r('brkV')}>0</span></div></div>
      <div className="card gauge"><div className="row" style={{ justifyContent: 'space-between' }}><span className="lbl">DRS</span><span className="drs" ref={r('drs')}>DRS</span></div>
        <div><span className="lbl">ERS · <span ref={r('ersV')}>0</span>%</span><span className="trk" style={{ marginTop: 4 }}><i ref={r('ers')} style={{ background: 'linear-gradient(90deg,#ffd60a,#ff8a00)' }} /></span></div></div>
      <div className="card gauge"><span className="lbl">Fuel · coolant</span><div className="g-big" style={{ fontSize: 28 }}><span ref={r('fuel')}>—</span><sub>KG</sub></div><span className="lbl">Water <span className="mono" ref={r('water')}>—</span> °C</span></div>
    </div>
  );
}

function Traces({ id, ghost, color }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const padL = 64, padR = 12, padT = 16, padB = 22, W = w - padL - padR, H = h - padT - padB;
    const lanes = [['SPEED', 0.4, 60, 350], ['THROTTLE', 0.14, 0, 1], ['BRAKE', 0.09, 0, 1], ['GEAR', 0.14, 1, 8], ['DELTA', 0.23, -0.6, 0.6]];
    let y0 = padT;
    const lay = lanes.map((l) => { const r = [y0, H * l[1]]; y0 += H * l[1]; return r; });
    const xd = (d) => padL + (d / T.L) * W;
    const yv = (k, v) => { const [y, lh] = lay[k], mn = lanes[k][2], mx = lanes[k][3]; return y + lh - 4 - ((Math.max(mn, Math.min(mx, v)) - mn) / (mx - mn)) * (lh - 8); };
    lay.forEach(([y, lh], k) => {
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.035)'; ctx.fillRect(padL, y + 2, W, lh - 4);
      ctx.fillStyle = '#9d9dad'; ctx.font = '700 10px "Titillium Web", sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(lanes[k][0], padL - 10, y + lh / 2);
    });
    T.sectors.forEach((d, k) => { const x = xd(d); ctx.strokeStyle = k ? 'rgba(255,214,10,.35)' : 'rgba(0,214,107,.35)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.setLineDash([]); });
    ctx.fillStyle = '#6c6c7c'; ctx.font = '600 9px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let km = 0; km <= 5; km++) ctx.fillText(km + ' km', xd(km * 1000), h - 6);
    T.corners.forEach((c) => ctx.fillText('T' + c.n, xd(c.d), padT - 4));
    // ghost (history) speed
    if (ghost?.trace) {
      const tr = ghost.trace;
      ctx.beginPath(); tr.d.forEach((d, i) => { const x = xd(d), y = yv(0, tr.v[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = 'rgba(157,157,173,.8)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
    const b = buffer(id);
    const cur = currentLap(b);
    if (!cur) {
      ctx.fillStyle = '#9d9dad'; ctx.font = '600 13px "Titillium Web", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Waiting for telemetry…', padL + W / 2, padT + H / 2);
      return;
    }
    const fr = cur.frames.filter((f) => f.st !== 'GARAGE');
    const series = (k, get2, col, lw, fill) => {
      if (fr.length < 2) return;
      ctx.beginPath(); fr.forEach((f, i) => { const x = xd(f.d), y = yv(k, get2(f)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
      if (fill) { const [y, lh] = lay[k]; ctx.lineTo(xd(fr[fr.length - 1].d), y + lh - 4); ctx.lineTo(xd(fr[0].d), y + lh - 4); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
    };
    ctx.shadowColor = color; ctx.shadowBlur = 8; series(0, (f) => f.v, color, 2, 'rgba(255,255,255,.04)'); ctx.shadowBlur = 0;
    series(1, (f) => f.thr, '#00d66b', 1.4, 'rgba(0,214,107,.14)');
    series(2, (f) => f.brk, '#e10600', 1.4, 'rgba(225,6,0,.35)');
    series(3, (f) => f.g, '#ffd60a', 1.4);
    if (ghost?.trace && fr.length > 1) {
      const zy = yv(4, 0);
      ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + W, zy); ctx.stroke();
      for (let i = 1; i < fr.length; i += 2) {
        const f = fr[i], gt = traceTimeAt(ghost.trace, f.d);
        if (gt == null) continue;
        const dv = (f.ts - cur.t0 - gt) / 1000;
        const y = yv(4, dv);
        ctx.fillStyle = dv < 0 ? 'rgba(0,214,107,.6)' : 'rgba(255,77,77,.6)';
        ctx.fillRect(xd(fr[i - 1].d), Math.min(y, zy), Math.max(1, xd(f.d) - xd(fr[i - 1].d)) + 0.5, Math.abs(y - zy));
      }
    }
    const last = fr[fr.length - 1];
    if (last) {
      const cx = xd(last.d);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, h - padB); ctx.stroke();
      const by = yv(0, last.v);
      ctx.beginPath(); ctx.arc(cx, by, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      const lbl = Math.round(last.v) + ' km/h';
      ctx.font = '700 11px "JetBrains Mono", monospace'; const tw = ctx.measureText(lbl).width + 12;
      const lx = cx + 8 + tw > w ? cx - 8 - tw : cx + 8;
      ctx.fillStyle = '#fff'; ctx.fillRect(lx, by - 20, tw, 17); ctx.fillStyle = '#15151e'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(lbl, lx + 6, by - 11);
    }
  }, [id, ghost, color]);
  return <canvas ref={ref} aria-label="Speed, throttle, brake, gear and delta traces against lap distance" />;
}

function TyreView({ id }) {
  const [ref, get] = useCanvas();
  useAnimationFrame((ts) => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const b = buffer(id);
    const f = b.frames[b.frames.length - 1];
    if (!f) return;
    const cx = w / 2, s = Math.min(1, h / 220);
    ctx.save(); ctx.translate(0, (h - 210 * s) / 2); ctx.scale(1, s);
    const team = TEAM_BY_ID[CAR_BY_ID[id].team].color;
    ctx.fillStyle = '#2a2a36'; ctx.fillRect(cx - 46, 8, 92, 10);
    ctx.beginPath(); ctx.moveTo(cx - 10, 18); ctx.lineTo(cx + 10, 18); ctx.lineTo(cx + 14, 70); ctx.lineTo(cx + 30, 92); ctx.lineTo(cx + 32, 150); ctx.lineTo(cx + 20, 186); ctx.lineTo(cx - 20, 186); ctx.lineTo(cx - 32, 150); ctx.lineTo(cx - 30, 92); ctx.lineTo(cx - 14, 70); ctx.closePath();
    const gr = ctx.createLinearGradient(0, 18, 0, 186); gr.addColorStop(0, team); gr.addColorStop(1, '#1b2030'); ctx.fillStyle = gr; ctx.fill();
    ctx.fillStyle = '#2a2a36'; ctx.fillRect(cx - 40, 190, 80, 12);
    ctx.beginPath(); ctx.ellipse(cx, 112, 8, 12, 0, 0, Math.PI * 2); ctx.fillStyle = '#0d0d14'; ctx.fill();
    const ideal = COMPOUNDS[f.tc].idealTemp;
    const pos = [['FL', cx - 96, 30], ['FR', cx + 58, 30], ['RL', cx - 96, 128], ['RR', cx + 58, 128]];
    pos.forEach(([lab, x, y], t) => {
      const tw = 38, th = 60, bw = tw / 3;
      const temps = [f.tt[t * 3], f.tt[t * 3 + 1], f.tt[t * 3 + 2]];
      const order = lab[1] === 'L' ? [2, 1, 0] : [0, 1, 2]; // inner band faces the car
      ctx.save(); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, tw, th, 7) : ctx.rect(x, y, tw, th); ctx.clip();
      order.forEach((bi, k) => { ctx.fillStyle = ramp(TYRE_RAMP, (temps[bi] - (ideal - 20)) / 40); ctx.fillRect(x + k * bw, y, bw + 0.5, th); });
      ctx.fillStyle = 'rgba(0,0,0,.18)'; for (let gy = y + 6; gy < y + th; gy += 9) ctx.fillRect(x, gy, tw, 1.5);
      ctx.restore();
      const bx = lab[1] === 'L' ? x + tw + 10 : x - 10, by = y + th / 2;
      const glow = Math.max(0, Math.min(1, (f.bt[t] - 350) / 700));
      const rg = ctx.createRadialGradient(bx, by, 0, bx, by, 13);
      rg.addColorStop(0, `rgba(255,170,40,${0.15 + 0.8 * glow})`); rg.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(bx, by, 13, 0, Math.PI * 2); ctx.fill();
      const avg = Math.round((temps[0] + temps[1] + temps[2]) / 3);
      const tx = lab[1] === 'L' ? x - 8 : x + tw + 8; ctx.textAlign = lab[1] === 'L' ? 'right' : 'left';
      ctx.fillStyle = '#9d9dad'; ctx.font = '700 10px "Titillium Web", sans-serif'; ctx.textBaseline = 'alphabetic'; ctx.fillText(lab, tx, y + 12);
      ctx.fillStyle = avg >= ideal + 18 ? '#ff4d4d' : '#fff'; ctx.font = '800 17px "JetBrains Mono", monospace'; ctx.fillText(avg + '°', tx, y + 32);
      ctx.fillStyle = f.tp[t] < 18 ? '#ff4d4d' : '#9d9dad'; ctx.font = '600 10px "JetBrains Mono", monospace'; ctx.fillText(f.tp[t].toFixed(1) + ' psi', tx, y + 47);
      ctx.fillText(Math.round(f.bt[t]) + '° brk', tx, y + 59);
    });
    ctx.restore();
    void ts;
  }, [id]);
  return <canvas ref={ref} className="tyrecv" aria-label="Tyre surface temperatures, pressures and brake temperatures" />;
}

export { traceTimeAt };
