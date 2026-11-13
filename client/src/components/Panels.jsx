import { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CAR_BY_ID, TEAM_BY_ID, COMPOUNDS, formatLapTime, FUEL_EFFECT_PER_KG } from '@slipstream/shared';
import { useAlerts, useSession, useStrategy, useTiming, useUI, useLaps, colorOf } from '../store/stores.js';
import { useAuth } from '../store/auth.js';
import { race, ackAlert } from '../lib/live.js';
import { api } from '../lib/api.js';
import { useTicker } from '../lib/hooks.js';
import { canOpen } from './TrackMap.jsx';
import { Tyre } from './TimingTower.jsx';

const lt = (ms) => (ms == null ? '—' : formatLapTime(ms / 1000));
const SEV = { crit: '#ff3b3b', warn: '#ffd60a', info: '#38d8ff' };

export function CarCard() {
  useTicker(5);
  const sel = useUI((s) => s.selected);
  const user = useAuth((s) => s.user);
  const row = useTiming((s) => s.rows[sel]);
  const nav = useNavigate();
  const meta = CAR_BY_ID[sel];
  if (!meta) return <div className="card"><div className="empty"><b>No car selected</b>Click a car on the map or a row in the timing tower.</div></div>;
  const live = race.cars.get(sel);
  const team = TEAM_BY_ID[meta.team];
  const open = canOpen(user, sel);
  return (
    <div className="card carcard" style={{ '--tc': team.color }}>
      <div className="cc-top stripes" onClick={() => open && nav(`/car/${sel}`)} title={open ? 'Open telemetry' : ''}>
        <span className="n">{meta.number}</span>
        <small>{team.name.toUpperCase()} · P{row?.pos ?? '–'}</small>
        <h3>{meta.first} <b>{meta.last}</b></h3>
      </div>
      <div className="cc-body">
        <div className="kv"><small>km/h</small><b>{live ? Math.round(live.v) : '—'}</b></div>
        <div className="kv"><small>Last</small><b style={{ fontSize: 15 }}>{lt(row?.last)}</b></div>
        <div className="kv"><small>Best</small><b style={{ fontSize: 15, color: row?.fl ? 'var(--pur)' : undefined }}>{lt(row?.best ?? row?.pb)}</b></div>
      </div>
      <div className="rooms">
        {row && <><Tyre c={row.tc} age={row.ta} /><span className="chip">{row.ta ?? 0} laps on set</span><span className="chip">{row.stops ?? 0} stop{row.stops === 1 ? '' : 's'}</span></>}
        {open ? <Link className="chip" to={`/car/${sel}`} style={{ borderColor: 'var(--red)' }}>Telemetry →</Link> : <span className="chip">car:{sel} · team only</span>}
      </div>
    </div>
  );
}

export function AlertFeed() {
  const list = useAlerts((s) => s.list);
  const user = useAuth((s) => s.user);
  if (!user) {
    return (
      <div className="card" style={{ minHeight: 160 }}>
        <div className="card-h"><b>Team radio &amp; alerts</b></div>
        <div className="empty"><b>Team channel</b>Alerts go only to the team concerned and race control. Sign in as an engineer to see them.</div>
      </div>
    );
  }
  const open = list.filter((a) => !a.acknowledged).length;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 180 }}>
      <div className="card-h"><b>Team radio &amp; alerts</b>{open > 0 && <span className="live-pill" style={{ fontSize: 10, padding: '2px 8px' }}><i />{open} OPEN</span>}</div>
      <ul className="feed" style={{ flex: 1 }}>
        {!list.length && <li style={{ gridTemplateColumns: '1fr' }}><div className="empty"><b>All quiet</b>Tyre, brake, puncture, engine and data-loss detectors are watching every frame.</div></li>}
        {list.map((a) => (
          <li key={a._id} className={a.acknowledged ? 'acked' : ''}>
            <i style={{ background: SEV[a.severity] }} />
            <div>
              <div className="t"><span style={{ color: SEV[a.severity] }}>{a.severity.toUpperCase()} · {a.carId}</span><span>LAP {a.lap ?? '–'} · {new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
              <div className="m">{a.severity === 'crit' && <span className="radio" style={{ color: SEV.crit }}><s /><s /><s /><s /></span>}<b>{a.title}.</b> {a.message}</div>
              {a.acknowledged
                ? <div className="mu" style={{ fontSize: 11, marginTop: 4 }}>Acknowledged by {a.ackBy}</div>
                : <button className="btn sm ghost ack" onClick={() => ackAlert(a._id)}>Acknowledge</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WeatherCard() {
  const w = useSession((s) => s.session?.weather);
  if (!w) return null;
  const fc = w.forecast || [];
  return (
    <div className="card">
      <div className="card-h"><b>Weather radar</b><span className="chip">wetness {w.wetness.toFixed(2)}</span></div>
      <div className="card-b">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="kv"><small>Rain now</small><b style={{ color: w.rain > 0.05 ? 'var(--cyan)' : '#fff' }}>{Math.round(w.rain * 100)}%</b></div>
          <div className="kv"><small>Track</small><b>{w.trackTemp}°</b></div>
          <div className="kv"><small>Wind</small><b>{w.wind}</b></div>
        </div>
        <div className="lbl" style={{ marginTop: 10 }}>Rain probability · next 10 laps</div>
        <div className="wx-strip">
          {fc.map((f) => <div key={f.lap} title={`Lap +${f.lap}: ${Math.round(f.rainProb * 100)}% · wetness ${f.wetness}`}><span>{Math.round(f.rainProb * 100)}</span><i style={{ height: `${f.rainProb * 100}%` }} /></div>)}
        </div>
        <div className="wx-axis"><span>now</span><span>+5</span><span>+10 laps</span></div>
      </div>
    </div>
  );
}

export function StrategyMini() {
  const sel = useUI((s) => s.selected);
  const user = useAuth((s) => s.user);
  const strat = useStrategy((s) => s.byCar[sel]);
  if (!canOpen(user, sel)) return <WeatherCard />;
  const rec = strat?.options?.[0];
  return (
    <div className="card">
      <div className="card-h"><b>Strategist · {sel}</b><Link to="/strategy" className="chip">All options →</Link></div>
      <div className="card-b stack" style={{ gap: 8 }}>
        {!strat && <div className="shimmer" style={{ height: 70 }} />}
        {rec && (
          <div className="opt rec">
            <div className="row"><span className="tag" style={{ background: 'var(--grn)', color: '#15151e' }}>Recommended</span><span className="chip">P{rec.position} projected</span><span className={`chip risk-${rec.risk}`}>{rec.risk} risk</span></div>
            <h4>{rec.title}</h4>
            <StintBar stints={rec.stints} total={strat.totalLaps} from={strat.lap} />
          </div>
        )}
        {strat?.insights?.slice(0, 2).map((i, k) => <Insight key={k} i={i} />)}
      </div>
    </div>
  );
}

export function Insight({ i }) {
  const col = i.level === 'threat' ? 'var(--crit)' : i.level === 'opportunity' ? 'var(--grn)' : 'var(--cyan)';
  return <div className="insight"><i style={{ background: col }} /><div><b>{i.title}</b><p>{i.detail}</p></div></div>;
}

export function StintBar({ stints = [], total, from = 1 }) {
  const span = Math.max(1, total - from + 1);
  return (
    <div className="stint-bar">
      {stints.map((s, k) => {
        const len = Math.max(0, Math.min(total, s.to) - Math.max(from, s.from) + 1);
        return <div key={k} style={{ flex: len / span, background: COMPOUNDS[s.compound].color }} title={`${COMPOUNDS[s.compound].name}: laps ${s.from}–${s.to}`}>{len > 2 ? s.compound : ''}</div>;
      })}
    </div>
  );
}

/** Practice: run monitor for the selected car with lap types and long-run analysis */
export function RunMonitor() {
  const sel = useUI((s) => s.selected);
  const session = useSession((s) => s.session);
  const laps = useLaps((s) => s.byCar[sel]) || [];
  useEffect(() => {
    if (!sel || !session?.sessionId) return;
    api(`/laps?carId=${sel}`).then((d) => { for (const l of d.laps) useLaps.getState().add(l); }).catch(() => {});
  }, [sel, session?.sessionId]);
  const typed = laps.map((l) => ({ ...l, kind: l.pitOut ? 'OUT' : l.pitIn ? 'IN' : l.valid ? 'PUSH' : 'COOL' }));
  // long run = latest stint's clean push laps; fuel corrected; least squares slope on tyre age
  const long = useMemo(() => {
    const last = typed[typed.length - 1];
    if (!last) return null;
    const stint = typed.filter((l) => l.kind === 'PUSH' && l.compound === last.compound && l.lap - l.tyreAge === last.lap - last.tyreAge);
    if (stint.length < 2) return { n: stint.length };
    const pts = stint.map((l) => ({ x: l.tyreAge, y: l.timeMs / 1000 - (l.fuel ?? 0) * FUEL_EFFECT_PER_KG }));
    const n = pts.length, sx = pts.reduce((a, p) => a + p.x, 0), sy = pts.reduce((a, p) => a + p.y, 0);
    const sxy = pts.reduce((a, p) => a + p.x * p.y, 0), sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
    const den = n * sxx - sx * sx;
    return { n, avg: sy / n, slope: den ? (n * sxy - sx * sy) / den : null, compound: last.compound };
  }, [typed]);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="card-h"><b>Run monitor · {sel || '—'}</b>{long?.compound && <Tyre c={long.compound} />}</div>
      {long?.n >= 2 && (
        <div className="three" style={{ padding: '10px 14px', borderBottom: '1px solid var(--ln)' }}>
          <div className="kv"><small>Long run (fuel corr.)</small><b style={{ fontSize: 16 }}>{formatLapTime(long.avg)}</b></div>
          <div className="kv"><small>Deg</small><b style={{ fontSize: 16, color: long.slope > 0.08 ? 'var(--crit)' : 'var(--grn)' }}>{long.slope != null ? (long.slope >= 0 ? '+' : '') + long.slope.toFixed(3) : '—'}<span className="mu" style={{ fontSize: 10 }}> s/lap</span></b></div>
          <div className="kv"><small>Clean laps</small><b style={{ fontSize: 16 }}>{long.n}</b></div>
        </div>
      )}
      <div className="scroll" style={{ flex: 1, minHeight: 120, maxHeight: 320 }}>
        <table className="tbl">
          <thead><tr><th>Lap</th><th>Type</th><th className="n">Time</th><th className="n">S1</th><th className="n">S2</th><th className="n">S3</th><th>Tyre</th></tr></thead>
          <tbody>
            {!typed.length && <tr><td colSpan="7" className="mu">No completed laps yet. The car is on an out-lap or in the garage.</td></tr>}
            {typed.slice().reverse().map((l) => (
              <tr key={l.lap} className="run-row">
                <td>{l.lap}</td><td className={`lt-${l.kind}`}>{l.kind}</td>
                <td className={`n ${l.fastest ? 'pur' : l.pb ? 'grn' : ''}`}>{lt(l.timeMs)}</td>
                {[0, 1, 2].map((k) => <td key={k} className="n">{l.sectors?.[k] ? (l.sectors[k] / 1000).toFixed(3) : '—'}</td>)}
                <td>{l.compound} · {l.tyreAge}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Qualifying: cut-off, margin to safety, ideal lap and potential position */
export function QualiPanel() {
  const sel = useUI((s) => s.selected);
  const session = useSession((s) => s.session);
  const { rows, order } = useTiming();
  const seg = session?.segment;
  const active = order.map((id) => rows[id]).filter((r) => r && !r.ko);
  const cut = seg && active[seg.advance - 1]?.best;
  const me = rows[sel];
  const ideals = active.map((r) => r.best).filter(Boolean).sort((a, b) => a - b);
  const potential = me?.ideal ? ideals.filter((b) => b < me.ideal).length + 1 : null;
  const margin = me?.best && cut ? (me.best - cut) / 1000 : null;
  return (
    <div className="card">
      <div className="card-h"><b>{seg?.name || 'Qualifying'} · knockout</b><span className="chip">top {seg?.advance ?? '—'} advance</span></div>
      {seg && seg.index < seg.total - 1 && (
        <div className="cutoff"><span className="lbl">Cut-off (P{seg.advance})</span><b>{lt(cut)}</b></div>
      )}
      <div className="card-b three">
        <div className="kv"><small>{sel} best</small><b style={{ fontSize: 16 }}>{lt(me?.best)}</b></div>
        <div className="kv"><small>Ideal lap</small><b style={{ fontSize: 16, color: 'var(--pur)' }}>{lt(me?.ideal)}</b></div>
        <div className="kv"><small>{margin != null && margin <= 0 ? 'Safe by' : 'To safety'}</small><b style={{ fontSize: 16, color: margin == null ? undefined : margin <= 0 ? 'var(--grn)' : 'var(--crit)' }}>{margin == null ? '—' : (margin <= 0 ? '' : '+') + Math.abs(margin).toFixed(3)}</b></div>
      </div>
      <div className="card-b" style={{ paddingTop: 0, fontSize: 12.5, color: 'var(--tx-2)' }}>
        {me?.ko ? <>Knocked out in {me.ko}. Final position P{me.pos}.</>
          : potential ? <>Ideal lap (best sectors) would be worth <b style={{ color: '#fff' }}>P{potential}</b>{me.best && me.ideal ? <>. Lost to ideal: <b className="mono">{(Math.max(0, me.best - me.ideal) / 1000).toFixed(3)} s</b></> : ' once a lap is set in this segment'}.</>
            : <>Set a lap to see the margin to the drop zone and the ideal-lap potential.</>}
      </div>
    </div>
  );
}

export { colorOf };
