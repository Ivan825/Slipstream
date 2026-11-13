import { useEffect, useMemo, useState } from 'react';
import { CARS, CAR_BY_ID, TEAMS, TEAM_BY_ID, COMPOUNDS, SESSION_LABEL, formatLapTime, getTrack } from '@slipstream/shared';
import { api } from '../lib/api.js';
import { useSession, colorOf } from '../store/stores.js';
import UChart from '../components/UChart.jsx';
import { Scatter, BoxPlot, SectorMap } from '../components/Plots.jsx';
import { Tyre } from '../components/TimingTower.jsx';

const T = getTrack();
const lt = (ms) => (ms == null ? '—' : formatLapTime(ms / 1000));
const s3 = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(3));
const TABS = [
  ['classification', 'Classification'], ['history', 'Race history'], ['strategy', 'Tyre strategy'], ['pace', 'Pace'],
  ['deg', 'Degradation'], ['compare', 'Telemetry overlay'], ['dominance', 'Track dominance']
];
const Drv = ({ id }) => <span className="drv"><i style={{ background: colorOf(id) }} />{id}<span className="mu" style={{ fontWeight: 400 }}>{CAR_BY_ID[id]?.last}</span></span>;

export default function Analysis() {
  const live = useSession((s) => s.session);
  const [sessions, setSessions] = useState([]);
  const [sid, setSid] = useState('current');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('classification');

  useEffect(() => { api('/analysis/sessions').then((d) => setSessions(d.sessions)).catch(() => {}); }, [live?.sessionId, live?.status]);
  useEffect(() => {
    let alive = true;
    const load = () => api(`/analysis/${sid}`).then((d) => { if (alive) { setData(d); setErr(null); } }).catch((e) => alive && setErr(e.message));
    load();
    const id = sid === 'current' ? setInterval(load, 15000) : null;
    return () => { alive = false; clearInterval(id); };
  }, [sid]);

  const s = data?.session;
  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Analysis</h1><p>Post-session analysis built from MongoDB aggregation pipelines over the laps, pit-stop and session collections. Lap times and traces are published to everyone, like official timing. Live raw telemetry stays team-only.</p></div>
        <div className="row">
          <label className="lbl" htmlFor="sess">Session</label>
          <select id="sess" className="input" value={sid} onChange={(e) => setSid(e.target.value)}>
            <option value="current">Current session (live)</option>
            {sessions.map((x) => <option key={x.sessionId} value={x.sessionId}>{SESSION_LABEL[x.type] || x.type} · {new Date(x.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {x.status}{x.laps ? ` · ${x.laps} laps` : ''}</option>)}
          </select>
        </div>
      </div>
      <div className="seg" style={{ alignSelf: 'start' }}>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {err && <div className="card"><div className="empty"><b>Could not load the session</b>{err}</div></div>}
      {!data && !err && <div className="shimmer" style={{ height: 300 }} />}
      {data && !data.laps.length && <div className="card"><div className="empty"><b>No completed laps yet</b>Analysis fills in as cars complete laps. Pick a finished session above to see a full report.</div></div>}
      {data && data.laps.length > 0 && (
        <>
          <div className="four">
            <div className="card kpi"><small>{SESSION_LABEL[s.type]} · {s.status}</small><b>{s.name?.split('·').pop()?.trim() || s.sessionId}</b></div>
            <div className="card kpi"><small>{s.type === 'race' ? 'Winner' : 'Fastest'}</small><b>{s.winner || data.drivers[0]?._id || '—'}</b></div>
            <div className="card kpi"><small>Fastest lap</small><b style={{ color: 'var(--pur)' }}>{lt(data.drivers[0]?.best)}<em>{data.drivers[0]?._id}</em></b></div>
            <div className="card kpi"><small>Laps · stops · query</small><b>{data.laps.length}<em>{data.pitStops.length} stops · {data.ms} ms</em></b></div>
          </div>
          {tab === 'classification' && <Classification d={data} />}
          {tab === 'history' && <History d={data} />}
          {tab === 'strategy' && <TyreStrategy d={data} />}
          {tab === 'pace' && <Pace d={data} />}
          {tab === 'deg' && <Degradation d={data} />}
          {tab === 'compare' && <Compare d={data} />}
          {tab === 'dominance' && <Dominance d={data} />}
        </>
      )}
    </div>
  );
}

function Classification({ d }) {
  const s = d.session;
  const results = s.results?.length ? s.results : d.drivers.map((x, i) => ({ pos: i + 1, carId: x._id, best: x.best, laps: x.laps }));
  const ideal = new Map(d.sectorBests.map((x) => [x._id, x]));
  const [b1, b2, b3] = d.sessionBestSectors;
  return (
    <div className="two">
      <div className="card">
        <div className="card-h"><b>{s.status === 'finished' ? 'Official classification' : 'Provisional classification'}</b><span className="chip">{s.type}</span></div>
        <div className="scroll" style={{ maxHeight: 640 }}>
          <table className="tbl">
            <thead><tr><th>Pos</th><th>Driver</th>{s.type === 'race' && <th className="n">Grid</th>}<th className="n">Laps</th><th className="n">Best</th>{s.type === 'race' ? <th className="n">Stops</th> : <th>KO</th>}<th>Status</th></tr></thead>
            <tbody>
              {results.map((r) => {
                const gained = r.grid && r.pos ? r.grid - r.pos : null;
                return (
                  <tr key={r.carId}>
                    <td style={{ fontWeight: 900 }}>{r.pos}</td><td><Drv id={r.carId} /></td>
                    {s.type === 'race' && <td className="n">{r.grid ?? '—'}{gained ? <span className={gained > 0 ? 'grn' : 'red'}> {gained > 0 ? '▲' : '▼'}{Math.abs(gained)}</span> : ''}</td>}
                    <td className="n">{r.laps ?? '—'}</td>
                    <td className="n">{lt(r.best)}</td>
                    {s.type === 'race' ? <td className="n">{r.stops ?? '—'}</td> : <td>{r.knockedOut || ''}</td>}
                    <td className="mu">{r.status || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><b>Best sectors &amp; ideal laps</b><span className="chip">session ideal {lt((b1 || 0) + (b2 || 0) + (b3 || 0))}</span></div>
        <div className="scroll" style={{ maxHeight: 640 }}>
          <table className="tbl">
            <thead><tr><th>Driver</th><th className="n">S1</th><th className="n">S2</th><th className="n">S3</th><th className="n">Ideal</th><th className="n">Best</th><th className="n">Lost</th></tr></thead>
            <tbody>
              {d.sectorBests.map((x) => (
                <tr key={x._id}>
                  <td><Drv id={x._id} /></td>
                  <td className={`n ${x.s1 === b1 ? 'pur' : ''}`}>{s3(x.s1)}</td>
                  <td className={`n ${x.s2 === b2 ? 'pur' : ''}`}>{s3(x.s2)}</td>
                  <td className={`n ${x.s3 === b3 ? 'pur' : ''}`}>{s3(x.s3)}</td>
                  <td className="n">{lt(x.ideal)}</td>
                  <td className="n">{lt(x.best)}</td>
                  <td className="n">{x.lostToIdeal != null ? '+' + s3(x.lostToIdeal) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ideal.size && <div className="empty">Ideal laps appear once drivers complete all three sectors.</div>}
      </div>
    </div>
  );
}

function useByCar(laps) {
  return useMemo(() => {
    const m = new Map();
    for (const l of laps) (m.get(l.carId) || m.set(l.carId, []).get(l.carId)).push(l);
    for (const arr of m.values()) arr.sort((a, b) => a.lap - b.lap);
    return m;
  }, [laps]);
}

function History({ d }) {
  const byCar = useByCar(d.laps);
  const cars = [...byCar.keys()];
  const [only, setOnly] = useState(null);
  const { trace, chart, maxLap } = useMemo(() => {
    let maxLap = 0;
    for (const arr of byCar.values()) maxLap = Math.max(maxLap, arr[arr.length - 1].lap);
    const xs = Array.from({ length: maxLap }, (_, i) => i + 1);
    // reference pace: the winner's (most laps, least time) average lap
    let ref = null;
    for (const arr of byCar.values()) {
      const tot = arr.reduce((a, l) => a + l.timeMs, 0) / 1000;
      if (!ref || arr.length > ref.n || (arr.length === ref.n && tot < ref.tot)) ref = { n: arr.length, tot };
    }
    const avg = ref ? ref.tot / ref.n : 91;
    const trace = [xs, ...cars.map((id) => {
      const byLap = new Map(byCar.get(id).map((l) => [l.lap, l]));
      let cum = 0;
      return xs.map((L) => { const l = byLap.get(L); if (!l) return null; cum += l.timeMs / 1000; return Math.round((L * avg - cum) * 100) / 100; });
    })];
    const chart = [xs, ...cars.map((id) => { const byLap = new Map(byCar.get(id).map((l) => [l.lap, l.position])); return xs.map((L) => byLap.get(L) ?? null); })];
    return { trace, chart, maxLap };
  }, [byCar]); // eslint-disable-line react-hooks/exhaustive-deps
  if (d.session.type !== 'race') return <div className="card"><div className="empty"><b>Race-only views</b>Race history and the lap chart need a race session. Choose one above.</div></div>;
  const series = cars.map((id) => ({ label: id, stroke: colorOf(id), width: only && only !== id ? 0.6 : 1.8, alpha: only && only !== id ? 0.3 : 1, spanGaps: false, points: { show: false } }));
  return (
    <div className="stack">
      <div className="row">{cars.map((id) => <button key={id} className="chip" style={{ borderColor: only === id ? '#fff' : colorOf(id) }} onClick={() => setOnly(only === id ? null : id)}>{id}</button>)}</div>
      <div className="card"><div className="card-h"><b>Race history chart</b><span className="chip">gap to winner's average pace, s · pit stops show as drops</span></div>
        <div className="card-b"><UChart className="chart-box lg" optsKey={`hist:${cars.join()}:${only}`} data={trace} series={series} axes={[{ label: 'lap' }, { label: 'seconds' }]} /></div></div>
      <div className="card"><div className="card-h"><b>Lap chart</b><span className="chip">position at each line crossing</span></div>
        <div className="card-b"><UChart className="chart-box lg" optsKey={`lc:${cars.join()}:${only}:${maxLap}`} data={chart} series={series} scales={{ x: { time: false }, y: { dir: -1, range: [0.5, 20.5] } }} axes={[{ label: 'lap' }, { label: 'position', splits: () => [1, 5, 10, 15, 20] }]} /></div></div>
    </div>
  );
}

function TyreStrategy({ d }) {
  const byCar = useByCar(d.laps);
  const order = (d.session.results?.length ? d.session.results.map((r) => r.carId) : [...byCar.keys()]).filter((id) => byCar.has(id));
  const maxLap = Math.max(...d.laps.map((l) => l.lap));
  return (
    <div className="stack">
      <div className="card">
        <div className="card-h"><b>Tyre strategy</b><div className="row">{['S', 'M', 'H', 'I', 'W'].map((c) => <span key={c} className="row" style={{ gap: 4 }}><Tyre c={c} /><span className="mu" style={{ fontSize: 11 }}>{COMPOUNDS[c].name}</span></span>)}</div></div>
        <div className="card-b stack" style={{ gap: 5 }}>
          {order.map((id) => {
            const laps = byCar.get(id);
            const stints = [];
            for (const l of laps) {
              const last = stints[stints.length - 1];
              if (last && last.c === l.compound && l.lap - l.tyreAge === last.start) last.to = l.lap;
              else stints.push({ c: l.compound, from: l.lap, to: l.lap, start: l.lap - l.tyreAge });
            }
            return (
              <div key={id} className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                <span style={{ width: 54 }}><Drv id={id} /></span>
                <div style={{ flex: 1, display: 'flex', height: 18, position: 'relative', background: '#1a1a22', borderRadius: 2 }}>
                  {stints.map((st, k) => (
                    <div key={k} title={`${COMPOUNDS[st.c].name}: laps ${st.from}–${st.to}`} style={{ position: 'absolute', left: `${((st.from - 1) / maxLap) * 100}%`, width: `${((st.to - st.from + 1) / maxLap) * 100}%`, top: 0, bottom: 0, background: COMPOUNDS[st.c].color, borderRight: '2px solid var(--p1)', display: 'grid', placeItems: 'center', color: '#15151e', fontSize: 10, fontWeight: 900 }}>{st.to - st.from > 1 ? st.to - st.from + 1 : ''}</div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="wx-axis" style={{ marginLeft: 64 }}><span>lap 1</span><span>{Math.round(maxLap / 2)}</span><span>{maxLap}</span></div>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><b>Pit stop summary</b><span className="chip">reference: {d.reference.laneLengthM} m pit lane = {d.reference.laneRacingS} s at racing speed</span></div>
        <div className="scroll" style={{ maxHeight: 420 }}>
          <table className="tbl">
            <thead><tr><th>Driver</th><th className="n">Lap</th><th className="n">Stop</th><th>Tyres</th><th className="n">Pit lane</th><th className="n">Stationary</th><th className="n">Net loss</th></tr></thead>
            <tbody>
              {!d.pitStops.length && <tr><td colSpan="7" className="mu">No pit stops in this session.</td></tr>}
              {d.pitStops.map((p, i) => (
                <tr key={i}><td><Drv id={p.carId} /></td><td className="n">{p.lap}</td><td className="n">{p.stop}</td>
                  <td><span className="row" style={{ gap: 4 }}><Tyre c={p.from} />→<Tyre c={p.to} /></span></td>
                  <td className="n">{(p.laneMs / 1000).toFixed(2)} s</td><td className="n">{(p.stationaryMs / 1000).toFixed(2)} s</td><td className="n">{(p.lossMs / 1000).toFixed(1)} s</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Pace({ d }) {
  const [focus, setFocus] = useState(null);
  const valid = d.laps.filter((l) => l.valid);
  const best = Math.min(...valid.map((l) => l.timeMs));
  const clean = valid.filter((l) => l.timeMs < best * 1.07);
  const points = clean.map((l) => ({ x: l.lap, y: l.timeMs / 1000, color: COMPOUNDS[l.compound].color, r: focus === l.carId ? 4.5 : 3, alpha: focus && focus !== l.carId ? 0.15 : 0.85, stroke: focus === l.carId ? colorOf(l.carId) : null }));
  const teams = TEAMS.map((t) => ({ label: t.short, color: t.color, values: clean.filter((l) => l.team === t.id).map((l) => l.timeMs / 1000) }))
    .filter((g) => g.values.length)
    .sort((a, b) => median(a.values) - median(b.values));
  return (
    <div className="stack">
      <div className="card">
        <div className="card-h"><b>Lap times by compound</b>
          <select className="input" style={{ height: 30 }} value={focus || ''} onChange={(e) => setFocus(e.target.value || null)}><option value="">Highlight a driver…</option>{CARS.map((c) => <option key={c.id} value={c.id}>{c.number} {c.id}</option>)}</select></div>
        <div className="card-b"><Scatter points={points} xLabel="lap" yLabel="lap time (s)" yFmt={(v) => formatLapTime(v)} height={340} /></div>
        <div className="merge-note"><span>clean laps within 107% of the fastest · pit, SC/VSC and out-laps excluded</span></div>
      </div>
      <div className="two">
        <div className="card"><div className="card-h"><b>Team pace ranking</b><span className="chip">box plot of clean laps, by median</span></div>
          <div className="card-b"><BoxPlot groups={teams} fmt={(v) => formatLapTime(v)} /></div></div>
        <div className="card"><div className="card-h"><b>Consistency &amp; speed traps</b></div>
          <div className="scroll" style={{ maxHeight: 340 }}>
            <table className="tbl">
              <thead><tr><th>Driver</th><th className="n">Median</th><th className="n">σ</th><th className="n">Laps</th><th className="n">V max</th><th className="n">Fuel/lap</th></tr></thead>
              <tbody>{[...d.drivers].sort((a, b) => (a.sd ?? 1e9) - (b.sd ?? 1e9)).map((x) => (
                <tr key={x._id}><td><Drv id={x._id} /></td><td className="n">{lt(x.median)}</td><td className="n">{x.sd != null ? (x.sd / 1000).toFixed(3) : '—'}</td><td className="n">{x.validLaps}/{x.laps}</td><td className="n">{x.vmax ?? '—'}</td><td className="n">{x.fuelPerLap != null ? x.fuelPerLap.toFixed(2) : '—'}</td></tr>
              ))}</tbody>
            </table>
          </div></div>
      </div>
    </div>
  );
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function Degradation({ d }) {
  const drivers = [...new Set(d.stints.map((s) => s.carId))];
  const [sel, setSel] = useState(() => drivers.slice(0, 3));
  const shown = d.stints.filter((s) => sel.includes(s.carId) && s.n >= 2);
  const points = shown.flatMap((s) => s.points.map((p) => ({ x: p.age, y: p.t / 1000, color: colorOf(s.carId), r: 3.4, stroke: COMPOUNDS[s.compound].color })));
  const lines = shown.filter((s) => s.slopeMs != null).map((s) => {
    const ages = s.points.map((p) => p.age), a0 = Math.min(...ages), a1 = Math.max(...ages);
    return { color: colorOf(s.carId), pts: [a0, a1].map((a) => ({ x: a, y: (s.interceptMs + s.slopeMs * a) / 1000 })), dash: COMPOUNDS[s.compound].id === 'H' ? [6, 4] : [] };
  });
  // compound crossover from average fitted lines
  const byComp = {};
  for (const s of d.stints) if (s.slopeMs != null && s.n >= 3) (byComp[s.compound] ||= []).push(s);
  const fit = Object.fromEntries(Object.entries(byComp).map(([c, arr]) => [c, { slope: avg(arr.map((x) => x.slopeMs)) / 1000, int: avg(arr.map((x) => x.interceptMs)) / 1000, n: arr.length }]));
  const cross = (a, b) => (fit[a] && fit[b] && fit[a].slope !== fit[b].slope ? (fit[b].int - fit[a].int) / (fit[a].slope - fit[b].slope) : null);
  return (
    <div className="stack">
      <div className="row">{drivers.map((id) => <button key={id} className="chip" style={{ borderColor: sel.includes(id) ? colorOf(id) : 'var(--ln)', color: sel.includes(id) ? '#fff' : 'var(--mu)' }} onClick={() => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])}>{id}</button>)}</div>
      <div className="two">
        <div className="card"><div className="card-h"><b>Fuel-corrected lap time vs tyre age</b><span className="chip">{d.reference.fuelMsPerKg} ms/kg · least squares per stint</span></div>
          <div className="card-b"><Scatter points={points} lines={lines} xLabel="tyre age (laps)" yLabel="fuel-corrected time (s)" yFmt={(v) => formatLapTime(v)} height={360} /></div></div>
        <div className="card"><div className="card-h"><b>Stints</b><span className="chip">computed in a MongoDB aggregation pipeline</span></div>
          <div className="scroll" style={{ maxHeight: 400 }}>
            <table className="tbl">
              <thead><tr><th>Driver</th><th>Tyre</th><th className="n">Laps</th><th className="n">Clean</th><th className="n">Avg (corr.)</th><th className="n">Deg s/lap</th><th className="n">σ</th></tr></thead>
              <tbody>{d.stints.filter((s) => sel.length === 0 || sel.includes(s.carId)).map((s, i) => (
                <tr key={i}><td><Drv id={s.carId} /></td><td><Tyre c={s.compound} /></td><td className="n">{s.fromLap}–{s.toLap}</td><td className="n">{s.n}</td><td className="n">{lt(s.avgCorr)}</td>
                  <td className={`n ${s.slopeMs > 80 ? 'red' : s.slopeMs != null ? 'grn' : ''}`}>{s.slopeMs != null ? (s.slopeMs >= 0 ? '+' : '') + (s.slopeMs / 1000).toFixed(3) : '—'}</td><td className="n">{s.sd != null ? (s.sd / 1000).toFixed(3) : '—'}</td></tr>
              ))}</tbody>
            </table>
          </div></div>
      </div>
      <div className="card"><div className="card-h"><b>Compound model from this session</b></div>
        <div className="card-b four">
          {['S', 'M', 'H', 'I'].map((c) => (
            <div key={c} className="kpi" style={{ padding: 0 }}><small className="row" style={{ gap: 6 }}><Tyre c={c} />{COMPOUNDS[c].name}</small>
              <b style={{ fontSize: 16 }}>{fit[c] ? `${formatLapTime(fit[c].int)} + ${fit[c].slope.toFixed(3)}·age` : 'not enough laps'}</b></div>
          ))}
        </div>
        <div className="merge-note">
          <span>Soft → Medium crossover {cross('S', 'M') != null ? <b>{cross('S', 'M').toFixed(1)} laps</b> : '—'}</span>
          <span>Medium → Hard crossover {cross('M', 'H') != null ? <b>{cross('M', 'H').toFixed(1)} laps</b> : '—'}</span>
          <span>The lap age where the slower-starting compound becomes the faster one</span>
        </div>
      </div>
    </div>
  );
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function Compare({ d }) {
  const ranked = d.drivers.filter((x) => x.best).map((x) => x._id);
  const [a, setA] = useState(ranked[0]);
  const [b, setB] = useState(ranked[1]);
  const [laps, setLaps] = useState(null);
  useEffect(() => {
    if (!a || !b) return;
    setLaps(null);
    api(`/analysis/${d.session.sessionId}/traces?cars=${a},${b}`).then((r) => setLaps(r.laps)).catch(() => setLaps([]));
  }, [a, b, d.session.sessionId]);
  const A = laps?.find((l) => l.carId === a), B = laps?.find((l) => l.carId === b);
  const view = useMemo(() => {
    if (!A?.trace || !B?.trace) return null;
    const xs = A.trace.d;
    const at = (tr, key, x) => {
      const D = tr.d; let i = 1;
      while (i < D.length - 1 && D[i] < x) i++;
      const f = (x - D[i - 1]) / ((D[i] - D[i - 1]) || 1);
      return tr[key][i - 1] + f * (tr[key][i] - tr[key][i - 1]);
    };
    const tB = xs.map((x) => at(B.trace, 't', x));
    const delta = xs.map((x, i) => Math.round((tB[i] - A.trace.t[i])) / 1000);
    // gain/loss per mini-sector for the map
    const n = 25, gain = [];
    for (let k = 0; k < n; k++) {
      const x0 = (k / n) * T.L, x1 = ((k + 1) / n) * T.L;
      gain.push((at(B.trace, 't', x1) - at(B.trace, 't', x0)) - (at(A.trace, 't', x1) - at(A.trace, 't', x0)));
    }
    return {
      speed: [xs, A.trace.v, xs.map((x) => at(B.trace, 'v', x))],
      delta: [xs, delta],
      pedals: [xs, A.trace.thr.map((v) => v * 100), xs.map((x) => at(B.trace, 'thr', x) * 100), A.trace.brk.map((v) => v * 100), xs.map((x) => at(B.trace, 'brk', x) * 100)],
      gear: [xs, A.trace.g, xs.map((x) => Math.round(at(B.trace, 'g', x)))],
      gain
    };
  }, [A, B]);
  const cA = colorOf(a), cB = a && b && CAR_BY_ID[a]?.team === CAR_BY_ID[b]?.team ? '#ffffff' : colorOf(b);
  const sync = { drag: { x: true, y: false }, sync: { key: 'cmp' }, points: { size: 5 } };
  const xAxis = { label: 'distance (m)' };
  return (
    <div className="stack">
      <div className="row">
        <select className="input" value={a || ''} onChange={(e) => setA(e.target.value)}>{ranked.map((id) => <option key={id} value={id}>{id} · {lt(d.drivers.find((x) => x._id === id)?.best)}</option>)}</select>
        <span className="mu">vs</span>
        <select className="input" value={b || ''} onChange={(e) => setB(e.target.value)}>{ranked.map((id) => <option key={id} value={id}>{id} · {lt(d.drivers.find((x) => x._id === id)?.best)}</option>)}</select>
        {A && B && <span className="chip">fastest laps: {a} L{A.lap} {lt(A.timeMs)} · {b} L{B.lap} {lt(B.timeMs)} · Δ {((B.timeMs - A.timeMs) / 1000).toFixed(3)} s</span>}
      </div>
      {!view && <div className="shimmer" style={{ height: 300 }} />}
      {view && (
        <div className="tl-main" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
          <div className="card">
            <div className="card-h"><b>Speed</b><div className="lgd"><span><i style={{ background: cA }} />{a}</span><span><i style={{ background: cB }} />{b}</span></div></div>
            <div className="card-b"><UChart className="chart-box" optsKey={`sp${a}${b}`} data={view.speed} cursor={sync} series={[{ label: a, stroke: cA, width: 1.8 }, { label: b, stroke: cB, width: 1.8 }]} axes={[xAxis, { label: 'km/h' }]} /></div>
            <div className="card-h" style={{ borderTop: '1px solid var(--ln)' }}><b>Delta-T · {b} relative to {a}</b><span className="chip">above zero: {b} slower</span></div>
            <div className="card-b"><UChart className="chart-box sm" optsKey={`dt${a}${b}`} data={view.delta} cursor={sync} series={[{ label: 'Δt s', stroke: '#fff', width: 1.6, fill: 'rgba(225,6,0,.18)' }]} axes={[xAxis, { label: 's' }]} /></div>
            <div className="card-h" style={{ borderTop: '1px solid var(--ln)' }}><b>Throttle &amp; brake</b></div>
            <div className="card-b"><UChart className="chart-box sm" optsKey={`pd${a}${b}`} data={view.pedals} cursor={sync} series={[{ label: `${a} thr`, stroke: cA, width: 1.4 }, { label: `${b} thr`, stroke: cB, width: 1.4 }, { label: `${a} brk`, stroke: '#e10600', width: 1.2, dash: [4, 3] }, { label: `${b} brk`, stroke: '#ff8a80', width: 1.2, dash: [2, 3] }]} axes={[xAxis, { label: '%' }]} /></div>
            <div className="card-h" style={{ borderTop: '1px solid var(--ln)' }}><b>Gear</b></div>
            <div className="card-b"><UChart className="chart-box sm" optsKey={`gr${a}${b}`} data={view.gear} cursor={sync} series={[{ label: a, stroke: cA, width: 1.4 }, { label: b, stroke: cB, width: 1.4 }]} axes={[xAxis, { label: 'gear' }]} /></div>
          </div>
          <div className="card">
            <div className="card-h"><b>Where the time goes</b></div>
            <SectorMap version={`${a}${b}${A.lap}${B.lap}`} height={340} colorFor={(f) => { const g = view.gain[Math.min(24, Math.floor(f * 25))]; return Math.abs(g) < 8 ? '#555' : g > 0 ? cA : cB; }} />
            <div className="merge-note"><span><b style={{ color: cA }}>■</b> {a} faster</span><span><b style={{ color: cB }}>■</b> {b} faster</span><span>25 mini-sectors · grey within 8 ms</span></div>
            <table className="tbl"><tbody>
              {[0, 1, 2].map((k) => <tr key={k}><td>Sector {k + 1}</td><td className="n">{s3(A.sectors?.[k])}</td><td className="n">{s3(B.sectors?.[k])}</td><td className={`n ${B.sectors?.[k] - A.sectors?.[k] > 0 ? 'grn' : 'red'}`}>{A.sectors?.[k] && B.sectors?.[k] ? ((B.sectors[k] - A.sectors[k]) / 1000).toFixed(3) : '—'}</td></tr>)}
              <tr><td>V max</td><td className="n">{A.stats?.maxSpeed}</td><td className="n">{B.stats?.maxSpeed}</td><td /></tr>
              <tr><td>Tyre</td><td className="n">{A.compound} · {A.tyreAge}</td><td className="n">{B.compound} · {B.tyreAge}</td><td /></tr>
            </tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}

function Dominance({ d }) {
  const [dom, setDom] = useState(null);
  useEffect(() => { api(`/analysis/${d.session.sessionId}/dominance`).then(setDom).catch(() => setDom(null)); }, [d.session.sessionId, d.laps.length]);
  const count = dom ? Object.entries(dom.count).sort((a, b) => b[1] - a[1]) : [];
  const teamCount = {};
  for (const [id, n] of count) teamCount[CAR_BY_ID[id].team] = (teamCount[CAR_BY_ID[id].team] || 0) + n;
  return (
    <div className="tl-main" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
      <div className="card">
        <div className="card-h"><b>Track dominance</b><span className="chip">fastest car through each of {dom?.miniSectors || 25} mini-sectors on its best lap</span></div>
        {dom ? <SectorMap version={dom.sectors.map((s) => s.carId).join('')} height={520} colorFor={(f) => { const s = dom.sectors[Math.min(dom.miniSectors - 1, Math.floor(f * dom.miniSectors))]; return s?.carId ? colorOf(s.carId) : '#444'; }} /> : <div className="shimmer" style={{ height: 520 }} />}
      </div>
      <div className="stack">
        <div className="card"><div className="card-h"><b>Mini-sectors won</b></div>
          <table className="tbl"><tbody>{count.map(([id, n]) => <tr key={id}><td><Drv id={id} /></td><td className="n">{n}</td><td style={{ width: '45%' }}><span className="trk"><i style={{ width: `${(n / (dom?.miniSectors || 25)) * 100}%`, background: colorOf(id) }} /></span></td></tr>)}</tbody></table>
          <div className="merge-note">{Object.entries(teamCount).map(([t, n]) => <span key={t}><b style={{ color: TEAM_BY_ID[t].color }}>■</b> {TEAM_BY_ID[t].short} {n}</span>)}</div>
        </div>
        <div className="card"><div className="card-h"><b>Maximum speeds</b><span className="chip">speed trap</span></div>
          <table className="tbl"><tbody>{[...d.drivers].filter((x) => x.vmax).sort((a, b) => b.vmax - a.vmax).slice(0, 10).map((x, i) => <tr key={x._id}><td>{i + 1}</td><td><Drv id={x._id} /></td><td className="n">{x.vmax} km/h</td></tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}
