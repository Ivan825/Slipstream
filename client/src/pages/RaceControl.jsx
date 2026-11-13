import { useEffect, useState } from 'react';
import { CARS, TEAM_BY_ID } from '@slipstream/shared';
import { api } from '../lib/api.js';
import { useRooms } from '../lib/live.js';
import { useSession, useToasts, useUI, colorOf } from '../store/stores.js';
import { AlertFeed, WeatherCard } from '../components/Panels.jsx';

const INCIDENTS = [
  ['puncture', 'Puncture', '#ff4d4d', 'Pressure falls ~0.85 psi/s on one corner'],
  ['tyre-overheat', 'Tyre overheat', '#ff8a1c', '+30 °C on a front tyre for 40 s'],
  ['brake-fade', 'Brake fade', '#ffd60a', 'Front brakes run 55% hotter for 45 s'],
  ['engine', 'Engine overheat', '#b84dff', 'Coolant climbs past 128 °C for 50 s']
];

export default function RaceControl() {
  useRooms(['race', 'timing', 'metrics']);
  const session = useSession((s) => s.session);
  const sel = useUI((s) => s.selected);
  const toast = useToasts((s) => s.push);
  const [car, setCar] = useState(sel || 'KAL');
  const [wx, setWx] = useState({ inLaps: 3, durationLaps: 6, intensity: 0.65 });
  const [hz, setHz] = useState(session?.simHz || 20);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(null);

  const loadLog = () => api('/control/commands').then((d) => setLog(d.commands)).catch(() => {});
  useEffect(() => { loadLog(); const id = setInterval(loadLog, 5000); return () => clearInterval(id); }, []);
  useEffect(() => { if (session?.simHz) setHz(session.simHz); }, [session?.simHz]);

  const call = async (label, path, body) => {
    setBusy(label);
    try { await api(path, { method: 'POST', body }); toast({ kind: 'grn', title: 'Race control', text: label }); loadLog(); }
    catch (e) { toast({ kind: 'red', title: label, text: e.message }); }
    finally { setBusy(null); }
  };
  const ts = session?.trackStatus;

  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Race control</h1><p>Run the weekend. Every action goes to the simulator over its control channel, is written to the audit log and is broadcast to the pit walls.</p></div>
        <span className="chip">session {session?.sessionId} · {session?.status}</span>
      </div>
      <div className="three">
        <div className="card">
          <div className="card-h"><b>Session</b></div>
          <div className="card-b stack">
            <div className="lbl">Start a new session</div>
            <div className="row">
              {[['practice', 'Practice'], ['qualifying', 'Qualifying'], ['race', 'Race']].map(([t, l]) => (
                <button key={t} className={`btn ${t === 'race' ? 'red' : ''}`} disabled={!!busy} onClick={() => call(`New ${l.toLowerCase()} session`, '/control/session', { action: 'new', type: t })}>{l}</button>
              ))}
            </div>
            <p className="mu" style={{ margin: 0, fontSize: 12 }}>The race grid is taken from the latest finished qualifying session.</p>
            <div className="row">
              {session?.status === 'paused'
                ? <button className="btn" onClick={() => call('Session resumed', '/control/session', { action: 'resume' })}>Resume</button>
                : <button className="btn" onClick={() => call('Session paused', '/control/session', { action: 'pause' })}>Pause</button>}
              <button className="btn ghost" onClick={() => call('Chequered flag', '/control/session', { action: 'finish' })}>End session</button>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Track status</b><span className={`track-status ts-${ts}`} style={{ margin: 0 }}>{ts}</span></div>
          <div className="card-b stack">
            <div className="seg" style={{ width: '100%' }}>
              {['GREEN', 'YELLOW', 'VSC', 'SC', 'RED'].map((s) => (
                <button key={s} className={ts === s ? 'on' : ''} style={{ flex: 1, padding: '9px 0' }} onClick={() => call(`Track status ${s}`, '/control/track-status', { status: s })}>{s}</button>
              ))}
            </div>
            <p className="mu" style={{ margin: 0, fontSize: 12 }}>Under SC or VSC the field slows and bunches up, pit loss falls to 10.5 s or 13.5 s, and every strategist on the pit wall re-ranks its options.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Data stream</b><span className="chip">{hz} Hz × {CARS.length} cars = {hz * CARS.length} ev/s</span></div>
          <div className="card-b stack">
            <div className="field"><label htmlFor="hz">Rate per car · {hz} Hz</label><input id="hz" type="range" min="1" max="60" value={hz} onChange={(e) => setHz(Number(e.target.value))} onMouseUp={() => call(`Stream rate ${hz} Hz`, '/control/stream', { hz })} onTouchEnd={() => call(`Stream rate ${hz} Hz`, '/control/stream', { hz })} /></div>
            <div className="row">
              <button className="btn" onClick={() => call('Burst: 100 Hz for 10 s', '/control/stream', { burst: { hz: 100, seconds: 10 } })}>Burst 100 Hz · 10 s</button>
              <button className="btn ghost" onClick={() => call('Burst: 200 Hz for 5 s', '/control/stream', { burst: { hz: 200, seconds: 5 } })}>200 Hz · 5 s</button>
            </div>
            <p className="mu" style={{ margin: 0, fontSize: 12 }}>A 200 Hz burst goes past the per-source token bucket on purpose, so you can watch the rate limiter work on the Systems page.</p>
          </div>
        </div>
      </div>
      <div className="three">
        <div className="card">
          <div className="card-h"><b>Weather</b></div>
          <div className="card-b stack">
            <div className="two">
              <div className="field"><label htmlFor="wi">Starts in (laps)</label><input id="wi" className="input" type="number" min="0" max="30" step="0.5" value={wx.inLaps} onChange={(e) => setWx({ ...wx, inLaps: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="wd">Lasts (laps)</label><input id="wd" className="input" type="number" min="1" max="30" value={wx.durationLaps} onChange={(e) => setWx({ ...wx, durationLaps: Number(e.target.value) })} /></div>
            </div>
            <div className="field"><label htmlFor="wn">Intensity · {Math.round(wx.intensity * 100)}%</label><input id="wn" type="range" min="0.1" max="1" step="0.05" value={wx.intensity} onChange={(e) => setWx({ ...wx, intensity: Number(e.target.value) })} /></div>
            <div className="row">
              <button className="btn red" onClick={() => call(`Rain in ${wx.inLaps} laps`, '/control/weather', { action: 'shower', ...wx })}>Schedule shower</button>
              <button className="btn ghost" onClick={() => call('Clear skies', '/control/weather', { action: 'clear' })}>Clear</button>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Incidents</b>
            <select className="input" style={{ height: 30 }} value={car} onChange={(e) => setCar(e.target.value)}>
              {CARS.map((c) => <option key={c.id} value={c.id}>{c.number} {c.id} · {TEAM_BY_ID[c.team].short}</option>)}
            </select>
          </div>
          <div className="card-b stack" style={{ gap: 8 }}>
            {INCIDENTS.map(([type, label, col, desc]) => (
              <div key={type} className="row" style={{ borderLeft: `3px solid ${col}`, background: 'var(--bg-2)', padding: '8px 10px' }}>
                <div style={{ flex: 1 }}><b>{label}</b><div className="mu" style={{ fontSize: 11.5 }}>{desc}</div></div>
                <button className="btn sm" onClick={() => call(`${label} · ${car}`, '/control/incident', { type, carId: car })}>Inject</button>
              </div>
            ))}
            <p className="mu" style={{ margin: 0, fontSize: 12 }}>The anomaly engine has to detect each one from the telemetry. Nothing tells it what was injected.</p>
          </div>
        </div>
        <WeatherCard />
      </div>
      <div className="two">
        <div style={{ height: 420, display: 'grid' }}><AlertFeed /></div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-h"><b>Audit log</b><span className="chip">commands collection</span></div>
          <div className="scroll" style={{ maxHeight: 380 }}>
            <table className="tbl">
              <thead><tr><th>Time</th><th>Action</th><th>Car</th><th>By</th></tr></thead>
              <tbody>
                {!log.length && <tr><td colSpan="4" className="mu">No commands yet this session.</td></tr>}
                {log.map((c) => (
                  <tr key={c._id}>
                    <td className="mono">{new Date(c.ts).toLocaleTimeString()}</td>
                    <td>{c.type}{c.payload?.compound ? ` → ${c.payload.compound}` : c.payload?.status ? ` ${c.payload.status}` : c.payload?.hz ? ` ${c.payload.hz} Hz` : ''}</td>
                    <td>{c.carId ? <span className="drv"><i style={{ background: colorOf(c.carId) }} />{c.carId}</span> : '—'}</td>
                    <td className="mu">{c.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
