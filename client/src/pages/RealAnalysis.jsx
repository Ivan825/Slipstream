import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatLapTime } from '@slipstream/shared';
import { useReplay } from '../store/replay.js';
import { useTicker } from '../lib/hooks.js';
import UChart from '../components/UChart.jsx';
import { Scatter } from '../components/Plots.jsx';
import { Tyre } from '../components/TimingTower.jsx';
import { useRealAnalysis } from './RealTelemetry.jsx';

const lt = (s) => (s == null ? '—' : formatLapTime(s));
const s3 = (x) => (x == null ? '—' : x.toFixed(3));
const COMP = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const COMP_COL = { S: '#ff3b3b', M: '#ffd60a', H: '#f2f2f2', I: '#2bd94e', W: '#3d8bff' };
const TABS = [['classification', 'Classification'], ['history', 'Race history'], ['strategy', 'Tyre strategy'], ['pace', 'Lap times'], ['pits', 'Pit stops']];

/**
 * Analysis of a real session (OpenF1), computed from laps, positions, stints and
 * pit stops. By default it only uses what has happened up to the replay clock, so
 * a historical race unfolds as if it were live.
 */
export default function RealAnalysis() {
  useTicker(1);
  const { meta, state } = useReplay();
  const data = useRealAnalysis(meta?.key);
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'classification';
  const [full, setFull] = useState(false);
  const drivers = useMemo(() => new Map((data?.drivers || []).map((d) => [d.n, d])), [data]);
  const until = full ? Infinity : state.t;
  const laps = useMemo(() => (data?.laps || []).filter((l) => l.t <= until), [data, until]);
  const stintOf = (n, lap) => {
    const s = (data?.stints || []).find((x) => x.n === n && lap >= (x.from ?? 0) && lap <= (x.to ?? 999));
    return s ? COMP[s.compound] || '?' : '?';
  };

  if (!meta || !data) return <div className="shimmer" style={{ height: 300 }} />;
  const Drv = ({ n }) => { const d = drivers.get(n); return <span className="drv"><i style={{ background: d?.color }} />{d?.code}<span className="mu" style={{ fontWeight: 400 }}>{d?.last}</span></span>; };

  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Analysis</h1><p>{meta.name}: real timing from OpenF1. {full ? 'Showing the whole session.' : `Showing what has happened up to the replay clock (${laps.length} laps so far), so the race unfolds as if live.`}</p></div>
        <div className="row">
          <span className="tag" style={{ background: '#fff', color: 'var(--bg)' }}>Real data</span>
          <div className="seg"><button className={!full ? 'on' : ''} onClick={() => setFull(false)}>Up to clock</button><button className={full ? 'on' : ''} onClick={() => setFull(true)}>Whole session</button></div>
        </div>
      </div>
      <div className="seg" style={{ alignSelf: 'start' }}>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setParams((p) => { p.set('tab', k); return p; }, { replace: true })}>{l}</button>)}</div>
      {!laps.length && <div className="card"><div className="empty"><b>No completed laps yet</b>Let the session play, or switch to "Whole session".</div></div>}
      {laps.length > 0 && tab === 'classification' && <Classification laps={laps} drivers={drivers} Drv={Drv} />}
      {laps.length > 0 && tab === 'history' && <History laps={laps} drivers={drivers} />}
      {laps.length > 0 && tab === 'strategy' && <Strategy laps={laps} data={data} drivers={drivers} Drv={Drv} until={until} />}
      {laps.length > 0 && tab === 'pace' && <Pace laps={laps} drivers={drivers} stintOf={stintOf} />}
      {laps.length > 0 && tab === 'pits' && <Pits data={data} until={until} Drv={Drv} />}
    </div>
  );
}

function Classification({ laps, drivers, Drv }) {
  const by = new Map();
  for (const l of laps) {
    const cur = by.get(l.n) || { n: l.n, laps: 0, best: null, last: null, pos: null, s: [null, null, null], lastLap: 0 };
    cur.laps = Math.max(cur.laps, l.lap);
    if (!l.pitOut && (cur.best == null || l.time < cur.best)) cur.best = l.time;
    if (l.lap >= cur.lastLap) { cur.lastLap = l.lap; cur.last = l.time; cur.pos = l.pos; }
    l.s?.forEach((x, k) => { if (x != null && (cur.s[k] == null || x < cur.s[k])) cur.s[k] = x; });
    by.set(l.n, cur);
  }
  const rows = [...by.values()].sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
  const sb = [0, 1, 2].map((k) => Math.min(...rows.map((r) => r.s[k]).filter((x) => x != null)));
  const fastest = Math.min(...rows.map((r) => r.best).filter((x) => x != null));
  return (
    <div className="card">
      <div className="card-h"><b>Classification at the line</b><span className="chip">session ideal {lt(sb.reduce((a, b) => a + b, 0))}</span></div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th className="n">Laps</th><th className="n">Last</th><th className="n">Best</th><th className="n">S1</th><th className="n">S2</th><th className="n">S3</th><th className="n">Ideal</th></tr></thead>
          <tbody>{rows.map((r) => {
            const ideal = r.s.every((x) => x != null) ? r.s.reduce((a, b) => a + b, 0) : null;
            return (
              <tr key={r.n}><td style={{ fontWeight: 900 }}>{r.pos ?? '–'}</td><td><Drv n={r.n} /></td><td className="mu">{drivers.get(r.n)?.team}</td><td className="n">{r.laps}</td><td className="n">{lt(r.last)}</td>
                <td className={`n ${r.best === fastest ? 'pur' : ''}`}>{lt(r.best)}</td>
                {[0, 1, 2].map((k) => <td key={k} className={`n ${r.s[k] === sb[k] ? 'pur' : ''}`}>{s3(r.s[k])}</td>)}
                <td className="n">{lt(ideal)}</td></tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

function History({ laps, drivers }) {
  const cars = [...new Set(laps.map((l) => l.n))];
  const [only, setOnly] = useState(null);
  const { trace, chart } = useMemo(() => {
    const maxLap = Math.max(...laps.map((l) => l.lap));
    const xs = Array.from({ length: maxLap }, (_, i) => i + 1);
    const by = new Map();
    for (const l of laps) (by.get(l.n) || by.set(l.n, new Map()).get(l.n)).set(l.lap, l);
    // reference pace = the leader's average lap so far
    let ref = null;
    for (const [, m] of by) {
      const arr = [...m.values()];
      const tot = arr.reduce((a, l) => a + l.time, 0);
      if (!ref || arr.length > ref.n || (arr.length === ref.n && tot < ref.tot)) ref = { n: arr.length, tot };
    }
    const avg = ref ? ref.tot / ref.n : 90;
    const trace = [xs, ...cars.map((n) => { let cum = 0; const m = by.get(n); return xs.map((L) => { const l = m.get(L); if (!l) return null; cum += l.time; return Math.round((L * avg - cum) * 100) / 100; }); })];
    const chart = [xs, ...cars.map((n) => xs.map((L) => by.get(n).get(L)?.pos ?? null))];
    return { trace, chart };
  }, [laps]); // eslint-disable-line react-hooks/exhaustive-deps
  const series = cars.map((n) => ({ label: drivers.get(n)?.code, stroke: drivers.get(n)?.color, width: only && only !== n ? 0.6 : 1.8, points: { show: false } }));
  return (
    <div className="stack">
      <div className="row">{cars.map((n) => <button key={n} className="chip" style={{ borderColor: only === n ? '#fff' : drivers.get(n)?.color }} onClick={() => setOnly(only === n ? null : n)}>{drivers.get(n)?.code}</button>)}</div>
      <div className="card"><div className="card-h"><b>Race history chart</b><span className="chip">gap to the leader's average pace (s)</span></div>
        <div className="card-b"><UChart className="chart-box lg" optsKey={`rh:${cars.join()}:${only}:${trace[0].length}`} data={trace} series={series} axes={[{ label: 'lap', incrs: [1, 2, 5, 10] }, { label: 'seconds' }]} /></div></div>
      <div className="card"><div className="card-h"><b>Lap chart</b><span className="chip">position at each line crossing</span></div>
        <div className="card-b"><UChart className="chart-box lg" optsKey={`lc:${cars.join()}:${only}:${chart[0].length}`} data={chart} series={series} scales={{ x: { time: false }, y: { dir: -1, range: [0.5, cars.length + 0.5] } }} axes={[{ label: 'lap', incrs: [1, 2, 5, 10] }, { label: 'position', splits: () => [1, 5, 10, 15, 20] }]} /></div></div>
    </div>
  );
}

function Strategy({ laps, data, drivers, Drv, until }) {
  const lastLap = new Map();
  for (const l of laps) lastLap.set(l.n, Math.max(lastLap.get(l.n) || 0, l.lap));
  const maxLap = Math.max(...lastLap.values(), 1);
  const order = [...lastLap.keys()].sort((a, b) => (laps.filter((l) => l.n === a).at(-1)?.pos ?? 99) - (laps.filter((l) => l.n === b).at(-1)?.pos ?? 99));
  return (
    <div className="card">
      <div className="card-h"><b>Tyre strategy</b><div className="row">{['S', 'M', 'H', 'I', 'W'].map((c) => <Tyre key={c} c={c} />)}</div></div>
      <div className="card-b stack" style={{ gap: 5 }}>
        {order.map((n) => {
          const done = lastLap.get(n);
          const stints = data.stints.filter((s) => s.n === n && (s.from ?? 1) <= done);
          return (
            <div key={n} className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              <span style={{ width: 64 }}><Drv n={n} /></span>
              <div style={{ flex: 1, height: 18, position: 'relative', background: '#1a1a22', borderRadius: 2 }}>
                {stints.map((s, k) => {
                  const from = s.from ?? 1, to = Math.min(s.to ?? done, done);
                  const c = COMP[s.compound] || '?';
                  return <div key={k} title={`${s.compound}: laps ${from}–${to}`} style={{ position: 'absolute', left: `${((from - 1) / maxLap) * 100}%`, width: `${((to - from + 1) / maxLap) * 100}%`, top: 0, bottom: 0, background: COMP_COL[c] || '#888', borderRight: '2px solid var(--p1)', display: 'grid', placeItems: 'center', color: '#15151e', fontSize: 10, fontWeight: 900 }}>{to - from > 1 ? to - from + 1 : ''}</div>;
                })}
              </div>
            </div>
          );
        })}
        <div className="wx-axis" style={{ marginLeft: 74 }}><span>lap 1</span><span>{maxLap}</span></div>
      </div>
      {until !== Infinity && <div className="merge-note"><span>stints shown up to each driver's last completed lap at the replay clock</span></div>}
    </div>
  );
}

function Pace({ laps, drivers, stintOf }) {
  const [focus, setFocus] = useState(null);
  const clean = laps.filter((l) => !l.pitOut);
  const best = Math.min(...clean.map((l) => l.time));
  const pts = clean.filter((l) => l.time < best * 1.07).map((l) => {
    const c = stintOf(l.n, l.lap);
    return { x: l.lap, y: l.time, color: COMP_COL[c] || '#888', r: focus === l.n ? 4.5 : 3, alpha: focus && focus !== l.n ? 0.15 : 0.85, stroke: focus === l.n ? drivers.get(l.n)?.color : null };
  });
  return (
    <div className="card">
      <div className="card-h"><b>Lap times by compound</b>
        <select className="input" style={{ height: 30 }} value={focus || ''} onChange={(e) => setFocus(Number(e.target.value) || null)}><option value="">Highlight a driver…</option>{[...drivers.values()].map((d) => <option key={d.n} value={d.n}>{d.code} · {d.last}</option>)}</select></div>
      <div className="card-b"><Scatter points={pts} xLabel="lap" yLabel="lap time (s)" yFmt={(v) => formatLapTime(v)} height={380} /></div>
      <div className="merge-note"><span>laps within 107% of the fastest; out-laps excluded; colour = tyre compound from the stint data</span></div>
    </div>
  );
}

function Pits({ data, until, Drv }) {
  const pits = data.pits.filter((p) => p.t <= until).sort((a, b) => a.t - b.t);
  return (
    <div className="card">
      <div className="card-h"><b>Pit stop summary</b><span className="chip">{pits.length} stops</span></div>
      <div className="scroll"><table className="tbl">
        <thead><tr><th>Driver</th><th className="n">Lap</th><th className="n">Pit lane time</th><th>Time of day (UTC)</th></tr></thead>
        <tbody>
          {!pits.length && <tr><td colSpan="4" className="mu">No pit stops yet.</td></tr>}
          {pits.map((p, i) => <tr key={i}><td><Drv n={p.n} /></td><td className="n">{p.lap}</td><td className="n">{p.duration ? p.duration.toFixed(1) + ' s' : '—'}</td><td className="mono">{new Date(p.t).toISOString().slice(11, 19)}</td></tr>)}
        </tbody>
      </table></div>
    </div>
  );
}
