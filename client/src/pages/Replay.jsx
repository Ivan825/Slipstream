import { useMemo, useRef, useState } from 'react';
import { useRooms } from '../lib/live.js';
import { api } from '../lib/api.js';
import { useCanvas, useAnimationFrame, useTicker } from '../lib/hooks.js';
import { useReplay, replayCars, replayPos, replayTrace, replayClock } from '../store/replay.js';
import { useAuth } from '../store/auth.js';
import { useToasts } from '../store/stores.js';
import { Tyre } from '../components/TimingTower.jsx';
import { formatLapTime } from '@slipstream/shared';

const lt = (s) => (s == null ? '—' : formatLapTime(s));
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const gapText = (g) => (g == null ? '' : typeof g === 'number' ? '+' + g.toFixed(3) : String(g));
const FLAG = { GREEN: ['TRACK CLEAR', 'GREEN'], YELLOW: ['YELLOW FLAG', 'YELLOW'], 'DOUBLE YELLOW': ['DOUBLE YELLOW', 'YELLOW'], RED: ['RED FLAG', 'RED'], SC: ['SAFETY CAR', 'SC'], VSC: ['VIRTUAL SAFETY CAR', 'VSC'], CHEQUERED: ['CHEQUERED FLAG', 'CHQ'], BLUE: ['TRACK CLEAR', 'GREEN'] };

export default function Replay() {
  useRooms(['replay']);
  useTicker(4);
  const { meta, state, rows, rc, feed, selected, select } = useReplay();
  const role = useAuth((s) => s.user?.role);
  const toast = useToasts((s) => s.push);
  const drivers = useMemo(() => new Map((meta?.drivers || []).map((d) => [d.n, d])), [meta]);

  if (!state.loaded || !meta) {
    return (
      <div className="card"><div className="empty">
        <b>No real session loaded</b>
        Import one with <span className="mono">npm run openf1:import -w server -- --session 9636</span>, or set <span className="mono">REPLAY_AUTO_IMPORT=true</span>.
      </div></div>
    );
  }

  const elapsed = state.t - state.from, total = state.to - state.from;
  const leaderLap = rows[0]?.lap || 0;
  const [flagText, flagCls] = FLAG[state.flag] || [state.flag || 'TRACK CLEAR', 'GREEN'];
  const ctl = async (body) => {
    try { await api('/replay/control', { method: 'POST', body }); } catch (e) { toast({ kind: 'red', title: 'Replay', text: e.message }); }
  };
  const sel = drivers.get(selected) || drivers.get(rows[0]?.n);
  const w = state.weather;

  return (
    <div className="stack">
      <div className="card carbon" style={{ borderTopRightRadius: 14 }}>
        <div className="row" style={{ padding: '12px 16px', gap: 18 }}>
          <span className="tag" style={{ background: '#fff', color: 'var(--bg)' }}>Real data · OpenF1</span>
          <div><div className="lbl">{meta.circuit} · {meta.type}</div><b style={{ fontSize: 22, fontWeight: 900, fontStyle: 'italic', textTransform: 'uppercase' }}>{meta.year} {meta.country} Grand Prix</b></div>
          <div className="kv"><small>Replay clock</small><b className="mono">{clock(elapsed)} <span className="mu" style={{ fontSize: 13 }}>/ {clock(total)}</span></b></div>
          <div className="kv"><small>Leader lap</small><b>{leaderLap}</b></div>
          <span className={`track-status ts-${flagCls}`} style={{ margin: 0 }}>{flagText}</span>
          {w && <div className="kv"><small>Air · track · rain</small><b style={{ fontSize: 15 }}>{w.air}° · {w.track}° · <span style={{ color: w.rain ? 'var(--cyan)' : undefined }}>{w.rain ? 'RAIN' : 'dry'}</span></b></div>}
          {state.bestLap && <div className="kv"><small>Fastest lap</small><b style={{ fontSize: 15, color: 'var(--pur)' }}>{drivers.get(state.bestLap.n)?.code} {lt(state.bestLap.time)}</b></div>}
          <span className="spacer" />
          <div className="kv"><small>Recorded</small><b className="mono" style={{ fontSize: 13 }}>{new Date(state.t).toISOString().slice(11, 19)} UTC</b></div>
        </div>
        <div style={{ padding: '0 16px 12px' }}>
          <div className="row" style={{ gap: 8 }}>
            {role === 'race_control' && (
              <>
                <button className="btn sm" onClick={() => ctl({ action: state.playing ? 'pause' : 'play' })}>{state.playing ? 'Pause' : 'Play'}</button>
                <div className="seg">{[1, 2, 4, 8, 16].map((s) => <button key={s} className={state.speed === s ? 'on' : ''} onClick={() => ctl({ action: 'speed', speed: s })}>{s}×</button>)}</div>
                <button className="btn sm ghost" onClick={() => ctl({ action: 'restart' })}>Restart</button>
              </>
            )}
            <input aria-label="Replay position" type="range" min="0" max={total} value={elapsed} disabled={role !== 'race_control'} style={{ flex: 1, minWidth: 160 }}
              onChange={(e) => role === 'race_control' && ctl({ action: 'seek', t: Number(e.target.value) })} />
            <span className="chip">{state.playing ? `playing ${state.speed}×` : 'paused'} · shared clock for every viewer</span>
          </div>
        </div>
      </div>

      <div className="grid-pit" style={{ gridTemplateColumns: '330px minmax(0,1fr) 340px', height: 'calc(100vh - 54px - 60px - 36px - 118px)', minHeight: 600 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="card-h"><b>Live timing</b><span className="chip">{rows.length} cars</span></div>
          <div className="scroll" style={{ flex: 1 }}>
            {rows.map((r, i) => {
              const d = drivers.get(r.n);
              if (!d) return null;
              return (
                <div key={r.n} className={`tw ${r.n === sel?.n ? 'sel' : ''} ${i === 0 ? 'p1' : ''}`} style={{ '--tc': d.color, gridTemplateColumns: '26px 4px minmax(0,1fr) 80px 22px' }} onClick={() => select(r.n)} title={`${d.name} · ${d.team}`}>
                  <span className="p">{r.pos < 99 ? r.pos : '–'}</span>
                  <span className="tb" style={{ background: d.color }} />
                  <span className="c">{d.code}<small>{r.n}</small>{r.pits > 0 && <small style={{ color: 'var(--yel)' }}>{r.pits} PIT</small>}</span>
                  <span className="g">{i === 0 ? (r.lap ? `LAP ${r.lap}` : 'LEADER') : gapText(r.gap) || gapText(r.int) || '—'}</span>
                  {r.tc ? <Tyre c={r.tc} age={r.ta} /> : <span />}
                </div>
              );
            })}
          </div>
          <div className="tw-foot"><span>positions, intervals and laps from OpenF1</span><span className="mono">room · replay</span></div>
        </div>

        <div className="card mapcard"><RealTrack meta={meta} drivers={drivers} selected={sel?.n} onSelect={select} /></div>

        <div className="rcol" style={{ gridTemplateRows: 'auto auto minmax(0,1fr)' }}>
          {sel && <DriverPanel d={sel} row={rows.find((r) => r.n === sel.n)} />}
          <div className="card">
            <div className="card-h"><b>Speed · throttle · brake</b><span className="chip">last 60 s</span></div>
            <div style={{ height: 150, padding: '6px 10px' }}><TraceStrip n={sel?.n} color={sel?.color} /></div>
          </div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 200 }}>
            <div className="card-h"><b>Race control</b><span className="chip">{rc.length} messages</span></div>
            <ul className="feed" style={{ flex: 1 }}>
              {feed.slice(0, 4).map((e, k) => (
                <li key={'f' + k + e.t}>
                  <i style={{ background: e.type === 'pit' ? 'var(--yel)' : 'var(--pur)' }} />
                  <div><div className="t"><span>{e.type === 'pit' ? 'PIT STOP' : 'FASTEST LAP'} · {drivers.get(e.n)?.code}</span><span>{new Date(e.t).toISOString().slice(11, 19)}</span></div>
                    <div className="m">{e.type === 'pit' ? `Lap ${e.lap} · ${e.duration ? e.duration.toFixed(1) + ' s in the pit lane' : 'in the pits'}` : `${lt(e.time)} on lap ${e.lap}`}</div></div>
                </li>
              ))}
              {rc.map((m, k) => (
                <li key={k + '-' + m.t}>
                  <i style={{ background: /RED/.test(m.flag || '') ? 'var(--red)' : /YELLOW/.test(m.flag || '') ? 'var(--yel)' : m.category === 'SafetyCar' ? 'var(--org)' : /GREEN|CLEAR/.test(m.flag || '') ? 'var(--grn)' : 'var(--cyan)' }} />
                  <div><div className="t"><span>{m.category?.toUpperCase()}{m.lap ? ` · LAP ${m.lap}` : ''}</span><span>{new Date(m.t).toISOString().slice(11, 19)}</span></div><div className="m">{m.message}</div></div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <p className="mu" style={{ fontSize: 12, margin: 0 }}>
        Real timing and telemetry from <a href="https://openf1.org" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>OpenF1</a>, an unofficial open API, used here for non-commercial demonstration. Not associated with Formula 1 companies. Car data is sampled at about 3.7 Hz and replayed on a shared server clock to every viewer in the <span className="mono">replay</span> room.
      </p>
    </div>
  );
}

function DriverPanel({ d, row }) {
  const c = replayCars.get(d.n);
  return (
    <div className="card carcard" style={{ '--tc': d.color }}>
      <div className="cc-top stripes">
        <span className="n">{d.n}</span>
        <small>{(d.team || '').toUpperCase()} · P{row?.pos ?? '–'}</small>
        <h3>{d.first} <b>{d.last}</b></h3>
      </div>
      <div className="cc-body" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="kv"><small>km/h</small><b>{c ? Math.round(c.v) : '—'}</b></div>
        <div className="kv"><small>Gear</small><b>{c?.g || 'N'}</b></div>
        <div className="kv"><small>RPM</small><b style={{ fontSize: 15 }}>{c ? c.rpm.toLocaleString() : '—'}</b></div>
        <div className="kv"><small>DRS</small><b style={{ fontSize: 15, color: c?.drs ? 'var(--grn)' : 'var(--mu)' }}>{c?.drs ? 'OPEN' : 'off'}</b></div>
      </div>
      <div className="ped" style={{ padding: '10px 14px', borderBottom: '1px solid var(--ln)' }}>
        <div><span>THROTTLE</span><span className="trk"><i style={{ width: `${c?.thr ?? 0}%`, background: 'var(--grn)' }} /></span><span>{c?.thr ?? 0}</span></div>
        <div><span>BRAKE</span><span className="trk"><i style={{ width: c?.brk ? '100%' : 0, background: 'var(--red)' }} /></span><span>{c?.brk ? 'ON' : '0'}</span></div>
      </div>
      <div className="cc-body" style={{ border: 0 }}>
        <div className="kv"><small>Last lap</small><b style={{ fontSize: 15 }}>{lt(row?.last)}</b></div>
        <div className="kv"><small>Best</small><b style={{ fontSize: 15 }}>{lt(row?.best)}</b></div>
        <div className="kv"><small>Tyre</small><b style={{ fontSize: 15 }}>{row?.tc ? `${row.tc} · ${row.ta}` : '—'}</b></div>
      </div>
    </div>
  );
}

function RealTrack({ meta, drivers, selected, onSelect }) {
  const [ref, get] = useCanvas();
  const fitRef = useRef(null);
  const trails = useRef(new Map());
  const [mode] = useState('names');
  useAnimationFrame((ts) => {
    const g = get();
    if (!g || !g.w || !meta.track?.length) return;
    const { ctx, w, h } = g;
    if (!fitRef.current || fitRef.current.v !== g.v) {
      const xs = meta.track.map((p) => p[0]), ys = meta.track.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const pad = 50, s = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
      const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
      fitRef.current = { v: g.v, X: (x) => ox + (x - minX) * s, Y: (y) => h - (oy + (y - minY) * s) };
      trails.current.clear();
    }
    const { X, Y } = fitRef.current;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    for (let x = 10; x < w; x += 22) for (let y = 10; y < h; y += 22) ctx.fillRect(x, y, 1, 1);
    const path = () => { ctx.beginPath(); meta.track.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    path(); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 26; ctx.stroke();
    ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 18; ctx.stroke();
    ctx.strokeStyle = '#22222c'; ctx.lineWidth = 13; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2; ctx.stroke();
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
      cars.push({ n, x, y, d: drivers.get(n), tr });
    }
    for (const c of cars) {
      for (let k = 1; k < c.tr.length; k++) {
        ctx.globalAlpha = (k / c.tr.length) * 0.5;
        ctx.beginPath(); ctx.moveTo(c.tr[k - 1].x, c.tr[k - 1].y); ctx.lineTo(c.tr[k].x, c.tr[k].y);
        ctx.strokeStyle = c.d?.color || '#888'; ctx.lineWidth = 3; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const c of cars) {
      const col = c.d?.color || '#888';
      ctx.shadowColor = col; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.n === selected ? 7 : 5.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      if (mode === 'names') {
        ctx.font = c.n === selected ? '900 12px "Titillium Web"' : '700 10px "Titillium Web"';
        ctx.fillStyle = c.n === selected ? '#fff' : 'rgba(255,255,255,.75)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(c.d?.code || c.n, c.x + 9, c.y - 9);
      }
    }
    const s = cars.find((c) => c.n === selected);
    if (s) {
      ctx.beginPath(); ctx.arc(s.x, s.y, 12 + 4 * Math.sin(ts / 200), 0, Math.PI * 2); ctx.strokeStyle = s.d?.color || '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    ref.current._hits = cars;
  }, [meta, selected, drivers]);
  const onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = (ref.current._hits || []).map((c) => ({ c, k: Math.hypot(c.x - x, c.y - y) })).sort((a, b) => a.k - b.k)[0];
    if (hit && hit.k < 18) onSelect(hit.c.n);
  };
  return (
    <div className="mapbox">
      <canvas ref={ref} onClick={onClick} style={{ cursor: 'pointer' }} aria-label="Track map of the real session with every car" />
      <div className="ov tl"><h4>{meta.circuit}</h4><span className="mu">{meta.drivers.length} cars · positions from the cars' own GPS-style coordinates</span></div>
      <div className="ov br">{meta.frames.toLocaleString()} frames · {meta.events.toLocaleString()} events<br />5 Hz to the browser · interpolated 60 fps</div>
    </div>
  );
}

function TraceStrip({ n, color = '#fff' }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const tr = replayTrace.get(n) || [];
    if (tr.length < 2) return;
    const t1 = replayClock.t, t0 = t1 - 60_000;
    const X = (t) => ((t - t0) / 60_000) * w;
    const Y = (v) => h - 4 - (v / 350) * (h * 0.7);
    ctx.fillStyle = 'rgba(0,214,107,.18)';
    for (const p of tr) if (p.thr > 0) ctx.fillRect(X(p.t), h - 4 - (p.thr / 100) * h * 0.25, 2, (p.thr / 100) * h * 0.25);
    ctx.fillStyle = 'rgba(225,6,0,.8)';
    for (const p of tr) if (p.brk) ctx.fillRect(X(p.t), 0, 2, 6);
    ctx.beginPath(); tr.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
    const last = tr[tr.length - 1];
    ctx.fillStyle = '#fff'; ctx.font = '700 11px "JetBrains Mono"'; ctx.textAlign = 'right'; ctx.fillText(`${Math.round(last.v)} km/h`, w - 4, 14);
  }, [n, color]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="Speed trace, throttle and brake for the last 60 seconds" />;
}
