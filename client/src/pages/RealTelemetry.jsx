import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatLapTime } from '@slipstream/shared';
import { api } from '../lib/api.js';
import { useCanvas, useAnimationFrame, useTicker } from '../lib/hooks.js';
import { useReplay, replayCars, replayTrace, replayClock, onReplayEvents } from '../store/replay.js';
import { useUI } from '../store/stores.js';
import { Tyre } from '../components/TimingTower.jsx';
import { RealTrack, gapText } from './Replay.jsx';

const lt = (s) => (s == null ? '—' : formatLapTime(s));
const s3 = (x) => (x == null ? '—' : x.toFixed(3));

/**
 * Laps, stints and stops of a real session. One fetch per channel shared by every
 * page and the team watcher; a live session is refreshed every 30 s.
 *
 * A takeover's timing is made as it runs: the history comes from MongoDB once,
 * then the laps, stops, tyre changes, overtakes, race control and weather that
 * stream in are merged into it (deduplicated by car and lap, or by time), at most
 * every 2 s so the engines aren't rerun on every message. A full refetch every
 * 20 s keeps it consistent with the server.
 */
const analysisCache = new Map(); // channel -> { data, at, p, subs:Set }

function mergeInto(d, evs) {
  const laps = new Map(d.laps.map((l) => [`${l.n}:${l.lap}`, l]));
  const pits = new Set(d.pits.map((p) => `${p.n}:${p.lap}`));
  const seen = (arr, k) => new Set(arr.map(k));
  const ot = seen(d.overtakes || [], (o) => `${o.t}:${o.n}:${o.o}`), rc = seen(d.rc || [], (r) => `${r.t}:${r.message}`), wx = seen(d.weather || [], (w) => w.t);
  const out = { ...d, laps: d.laps.slice(), pits: d.pits.slice(), stints: d.stints.map((x) => ({ ...x })), overtakes: (d.overtakes || []).slice(), rc: (d.rc || []).slice(), weather: (d.weather || []).slice() };
  for (const e of evs) {
    if (e.type === 'lap' && !laps.has(`${e.n}:${e.lap}`)) { const l = { n: e.n, lap: e.lap, t: e.t, time: e.time, s: e.s, st: e.st ?? null, pitOut: !!e.pitOut, pos: e.pos ?? null }; laps.set(`${e.n}:${e.lap}`, l); out.laps.push(l); }
    else if (e.type === 'pit' && !pits.has(`${e.n}:${e.lap}`)) { pits.add(`${e.n}:${e.lap}`); out.pits.push({ n: e.n, lap: e.lap, duration: e.duration, t: e.t }); }
    else if (e.type === 'stint') {
      const i = out.stints.findIndex((x) => x.n === e.n && x.from === e.from);
      const st = { n: e.n, from: e.from, to: e.to ?? null, compound: e.compound, age: e.age ?? 0 };
      if (i >= 0) out.stints[i] = st;
      else {
        for (const x of out.stints) if (x.n === e.n && (x.to == null || x.to >= e.from) && x.from < e.from) x.to = e.from - 1;
        out.stints.push(st);
      }
    } else if (e.type === 'overtake' && !ot.has(`${e.t}:${e.n}:${e.o}`)) out.overtakes.push({ t: e.t, n: e.n, o: e.o, pos: e.pos });
    else if (e.type === 'rc' && !rc.has(`${e.t}:${e.message}`)) { const { type, fastest, ...r } = e; out.rc.push(r); }
    else if (e.type === 'weather' && !wx.has(e.t)) { const { type, fastest, ...w } = e; out.weather.push(w); }
  }
  return out;
}

export function useRealAnalysis(key) {
  const [data, setData] = useState(() => (key && analysisCache.get(String(key))?.data) || null);
  useEffect(() => {
    if (!key) { setData(null); return; }
    const k = String(key);
    let e = analysisCache.get(k);
    if (!e) { e = { data: null, at: 0, p: null, subs: new Set(), queue: [] }; analysisCache.set(k, e); }
    const sub = (d) => setData(d);
    e.subs.add(sub);
    const fork = () => !!useReplay.getState().meta?.fork;
    const load = () => {
      if (e.p || Date.now() - e.at < (fork() ? 15_000 : 25_000)) return;
      e.p = api(`/replay/${k}/analysis`).then((d) => { e.data = e.queue?.length ? mergeInto(d, e.queue) : d; e.queue = []; e.at = Date.now(); e.subs.forEach((f) => f(e.data)); }).catch(() => {}).finally(() => { e.p = null; });
    };
    if (e.data) setData(e.data);
    load();
    // a finished session's timing never changes; only live sessions and takeovers need refreshing
    const id = setInterval(() => { const m = useReplay.getState().meta; if (m?.live || m?.fork) load(); }, 20_000);
    // a takeover's events, merged in as they arrive
    const pending = [];
    const off = onReplayEvents((evs, ch) => { if (ch === k && fork()) pending.push(...evs); });
    const flush = setInterval(() => {
      if (!pending.length || !e.data) return;
      const evs = pending.splice(0);
      if (e.p) { e.queue = [...(e.queue || []), ...evs]; return; }
      e.data = mergeInto(e.data, evs);
      e.subs.forEach((f) => f(e.data));
    }, 2000);
    return () => { e.subs.delete(sub); clearInterval(id); clearInterval(flush); off(); };
  }, [key]);
  return data;
}

export default function RealTelemetry() {
  useTicker(4);
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, state, rows } = useReplay();
  const setRealDriver = useUI((s) => s.setRealDriver);
  const drivers = useMemo(() => new Map((meta?.drivers || []).map((d) => [d.n, d])), [meta]);
  const n = Number(id) || useUI.getState().realDriver || rows[0]?.n;
  const d = drivers.get(n);
  const row = rows.find((r) => r.n === n);
  const analysis = useRealAnalysis(meta?.ch ?? meta?.key);
  useEffect(() => { if (n) setRealDriver(n); }, [n, setRealDriver]);

  if (!meta || !state.loaded) return <div className="card"><div className="empty"><b>Opening the real session</b>Loading drivers and timing from OpenF1.</div></div>;
  if (!d) return <div className="card"><div className="empty"><b>Pick a driver</b><div className="row" style={{ justifyContent: 'center' }}>{meta.drivers.map((x) => <Link key={x.n} className="chip" to={`/car/${x.n}`}>{x.code}</Link>)}</div></div></div>;

  const laps = (analysis?.laps || []).filter((l) => l.n === n && l.t <= state.t).sort((a, b) => b.lap - a.lap);
  const best = laps.filter((l) => !l.pitOut).reduce((m, l) => (m == null || l.time < m ? l.time : m), null);
  const bestS = [0, 1, 2].map((k) => laps.reduce((m, l) => (l.s?.[k] != null && (m == null || l.s[k] < m) ? l.s[k] : m), null));
  const ideal = bestS.every((x) => x != null) ? bestS.reduce((a, b) => a + b, 0) : null;
  const sessionBestS = [0, 1, 2].map((k) => (analysis?.laps || []).filter((l) => l.t <= state.t).reduce((m, l) => (l.s?.[k] != null && (m == null || l.s[k] < m) ? l.s[k] : m), null));

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <span className="tag" style={{ background: '#fff', color: 'var(--bg)' }}>Real data · {meta.name}</span>
        {meta.drivers.map((x) => (
          <button key={x.n} className="chip" onClick={() => nav(`/car/${x.n}`)} style={{ borderColor: x.n === n ? '#fff' : x.color, color: x.n === n ? '#fff' : 'var(--tx-2)', background: x.n === n ? x.color + '55' : 'transparent' }}>{x.code}</button>
        ))}
      </div>
      <div className="tl-hero card" style={{ '--tc': d.color, borderTopRightRadius: 14 }}>
        <div className="tl-num">{d.n}</div>
        <div className="tl-id">
          <small>{(d.team || '').toUpperCase()} · {d.country || ''}</small>
          <h1>{d.first} <b>{d.last}</b></h1>
          <div className="pills">
            <span>P{row?.pos ?? '–'}</span>
            {row?.pos > 1 && row?.int != null && <span>INT {gapText(row.int)}</span>}
            {row?.lap ? <span>LAP {row.lap}</span> : null}
            <span>LAST {lt(row?.last)}</span>
            <span className={best && best === sessionBestLap(analysis, state.t) ? 'pb' : ''}>BEST {lt(best)}</span>
            {row?.tc && <span>{{ S: 'SOFT', M: 'MEDIUM', H: 'HARD', I: 'INTER', W: 'WET' }[row.tc] || row.tc} · {row.ta} LAPS</span>}
            {row?.pits ? <span>{row.pits} PIT{row.pits > 1 ? 'S' : ''}</span> : null}
          </div>
        </div>
        <div className="tl-delta">
          <small>IDEAL LAP (BEST SECTORS)</small>
          <b style={{ color: 'var(--pur)', fontSize: 44 }}>{lt(ideal)}</b>
          <span>{best && ideal ? `lost to ideal ${(best - ideal).toFixed(3)} s` : 'appears after a clean lap'}</span>
        </div>
      </div>
      <RealGauges n={n} />
      <div className="tl-main">
        <div className="card">
          <div className="card-h"><b>Live channels · last 2 minutes</b>
            <div className="lgd"><span><i style={{ background: d.color }} />SPEED</span><span><i style={{ background: 'var(--grn)' }} />THROTTLE</span><span><i style={{ background: 'var(--red)' }} />BRAKE</span><span><i style={{ background: 'var(--yel)' }} />GEAR</span><span><i style={{ background: 'var(--cyan)' }} />RPM</span></div></div>
          <div className="traces"><RealTraces n={n} color={d.color} /></div>
          <div className="merge-note"><span>car data from OpenF1 at ~3.7 Hz, streamed in 2-minute chunks and replayed on the session clock</span><span>speed trap = <b>{laps[0]?.st ?? '—'}</b> km/h last lap</span></div>
        </div>
        <div className="stack">
          <div className="card" style={{ height: 300 }}><RealTrack meta={meta} drivers={drivers} selected={n} onSelect={(x) => nav(`/car/${x}`)} rows={rows} yellows={state.yellows || []} compact /></div>
          <div className="card">
            <div className="card-h"><b>Laps</b><span className="chip">{laps.length} completed</span></div>
            <div className="scroll" style={{ maxHeight: 260 }}>
              <table className="tbl">
                <thead><tr><th>Lap</th><th className="n">Time</th><th className="n">S1</th><th className="n">S2</th><th className="n">S3</th><th className="n">Trap</th></tr></thead>
                <tbody>
                  {!laps.length && <tr><td colSpan="6" className="mu">No completed laps yet at this point of the session.</td></tr>}
                  {laps.slice(0, 40).map((l) => (
                    <tr key={l.lap}>
                      <td>{l.lap}{l.pitOut ? ' OUT' : ''}</td>
                      <td className={`n ${l.time === best ? 'grn' : ''}`}>{lt(l.time)}</td>
                      {[0, 1, 2].map((k) => <td key={k} className={`n ${l.s?.[k] != null && l.s[k] === sessionBestS[k] ? 'pur' : l.s?.[k] === bestS[k] ? 'grn' : ''}`}>{s3(l.s?.[k])}</td>)}
                      <td className="n">{l.st ?? '—'}</td>
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

function sessionBestLap(analysis, t) {
  return (analysis?.laps || []).filter((l) => l.t <= t && !l.pitOut).reduce((m, l) => (m == null || l.time < m ? l.time : m), null);
}

function RealGauges({ n }) {
  const refs = useRef({});
  const r = (k) => (el) => { refs.current[k] = el; };
  const LED_COL = (i) => (i < 5 ? '#00d66b' : i < 10 ? '#ff2a2a' : '#4d7dff');
  useAnimationFrame(() => {
    const c = replayCars.get(n);
    const el = refs.current;
    if (!c || !el.spd) return;
    el.spd.textContent = Math.round(c.v);
    el.gear.textContent = c.g || 'N';
    el.rpm.textContent = (c.rpm || 0).toLocaleString('en-US');
    const lit = Math.round(Math.max(0, Math.min(1, ((c.rpm || 0) - 9500) / 3000)) * 15);
    (el.leds || []).forEach((led, k) => { const on = k < lit; led.style.background = on ? LED_COL(k) : '#2c2c38'; led.style.boxShadow = on ? `0 0 10px ${LED_COL(k)}` : 'none'; });
    el.thr.style.width = `${c.thr || 0}%`; el.thrV.textContent = Math.round(c.thr || 0);
    el.brk.style.width = c.brk ? '100%' : '0'; el.brkV.textContent = c.brk ? 'ON' : '0';
    el.drs.classList.toggle('on', !!c.drs);
  }, [n]);
  return (
    <div className="gauges" style={{ gridTemplateColumns: '160px 110px minmax(240px,1.6fr) minmax(200px,1.1fr) 160px' }}>
      <div className="card gauge"><span className="lbl">Speed</span><div className="g-big"><span ref={r('spd')}>—</span><sub>KM/H</sub></div></div>
      <div className="card gauge"><span className="lbl">Gear</span><div className="g-big" style={{ fontSize: 54 }} ref={r('gear')}>—</div></div>
      <div className="card gauge"><div className="rpmrow"><span className="lbl">RPM · shift lights</span><b ref={r('rpm')}>—</b></div>
        <div className="shift">{Array.from({ length: 15 }, (_, k) => <i key={k} ref={(el) => { (refs.current.leds ||= [])[k] = el; }} />)}</div></div>
      <div className="card gauge ped"><span className="lbl">Pedals</span>
        <div><span>THROTTLE</span><span className="trk"><i ref={r('thr')} style={{ background: 'var(--grn)' }} /></span><span ref={r('thrV')}>0</span></div>
        <div><span>BRAKE</span><span className="trk"><i ref={r('brk')} style={{ background: 'var(--red)' }} /></span><span ref={r('brkV')}>0</span></div></div>
      <div className="card gauge"><span className="lbl">DRS</span><span className="drs" ref={r('drs')} style={{ alignSelf: 'flex-start' }}>DRS</span></div>
    </div>
  );
}

/** time-based channel plot (MoTeC-style), last 2 minutes of the selected driver */
function RealTraces({ n, color }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const tr = replayTrace.get(n) || [];
    const padL = 64, padR = 12, padT = 10, padB = 22, W = w - padL - padR, H = h - padT - padB;
    const lanes = [['SPEED', 0.36, 0, 350, (p) => p.v, color], ['THROTTLE', 0.16, 0, 100, (p) => p.thr, '#00d66b'], ['BRAKE', 0.1, 0, 1, (p) => p.brk, '#e10600'], ['GEAR', 0.16, 0, 8, (p) => p.g, '#ffd60a'], ['RPM', 0.22, 4000, 13000, (p) => p.rpm, '#38d8ff']];
    let y0 = padT;
    const lay = lanes.map((l) => { const r2 = [y0, H * l[1]]; y0 += H * l[1]; return r2; });
    const t1 = replayClock.t, t0 = t1 - 120_000;
    const X = (t) => padL + ((t - t0) / 120_000) * W;
    lay.forEach(([y, lh], k) => {
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.035)'; ctx.fillRect(padL, y + 2, W, lh - 4);
      ctx.fillStyle = '#9d9dad'; ctx.font = '700 10px "Titillium Web", sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(lanes[k][0], padL - 10, y + lh / 2);
    });
    ctx.fillStyle = '#6c6c7c'; ctx.font = '600 9px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let s = 0; s <= 120; s += 20) ctx.fillText(`−${120 - s}s`, padL + (s / 120) * W, h - 6);
    if (tr.length < 2) {
      ctx.fillStyle = '#9d9dad'; ctx.font = '600 13px "Titillium Web"'; ctx.textAlign = 'center'; ctx.fillText('Collecting telemetry…', padL + W / 2, padT + H / 2);
      return;
    }
    lanes.forEach(([, , mn, mx, val, col], k) => {
      const [y, lh] = lay[k];
      const Y = (v) => y + lh - 4 - ((Math.max(mn, Math.min(mx, v ?? mn)) - mn) / (mx - mn)) * (lh - 8);
      ctx.beginPath();
      tr.forEach((p, i) => { const x = X(p.t), yy = Y(val(p)); if (k === 3 && i) { ctx.lineTo(x, Y(val(tr[i - 1]))); } i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
      ctx.strokeStyle = col; ctx.lineWidth = k === 0 ? 2 : 1.4; ctx.stroke();
      if (k === 2 || k === 1) { ctx.lineTo(X(tr[tr.length - 1].t), y + lh - 4); ctx.lineTo(X(tr[0].t), y + lh - 4); ctx.closePath(); ctx.fillStyle = k === 2 ? 'rgba(225,6,0,.35)' : 'rgba(0,214,107,.14)'; ctx.fill(); }
    });
    const last = tr[tr.length - 1];
    const cx = X(last.t);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, h - padB); ctx.stroke();
  }, [n, color]);
  return <canvas ref={ref} aria-label="Speed, throttle, brake, gear and RPM over the last two minutes" />;
}

export { Tyre };
