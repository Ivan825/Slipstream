import { useEffect, useState } from 'react';
import { CARS, CAR_BY_ID, TEAM_BY_ID, COMPOUNDS, carsOfTeam } from '@slipstream/shared';
import { useRooms } from '../lib/live.js';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';
import { useStrategy, useUI, useSession, useToasts, colorOf } from '../store/stores.js';
import { Insight, StintBar } from '../components/Panels.jsx';
import { Tyre } from '../components/TimingTower.jsx';
import { canOpen } from '../components/TrackMap.jsx';

const KIND = { optimal: 'Optimal', now: 'Box now', extend: 'Extend', weather: 'Weather call', aggressive: 'Aggressive', damage: 'Damage' };

function Option({ o, strat, onApply, applying, readOnly }) {
  return (
    <div className={`opt ${o.recommended ? 'rec' : ''}`}>
      <div className="meta">
        {o.recommended ? <span className="tag" style={{ background: 'var(--grn)', color: '#15151e' }}>Recommended</span> : <span className="tag" style={{ background: 'var(--p3)' }}>{KIND[o.kind] || o.kind}</span>}
        <span className="chip">P{o.position} projected</span>
        <span className="chip">{o.delta === 0 ? 'fastest' : `+${o.delta.toFixed(1)} s`}</span>
        <span className={`chip risk-${o.risk}`}>{o.risk} risk</span>
        <span className="chip">{Math.round(o.confidence * 100)}% confidence</span>
        {o.urgency === 'now' && <span className="tag" style={{ background: 'var(--red)' }}>Now</span>}
      </div>
      <h4>{o.title}</h4>
      <StintBar stints={o.stints} total={strat.totalLaps} from={strat.lap} />
      <ul>{o.reasons.map((r, k) => <li key={k}>{r}</li>)}</ul>
      {!readOnly && o.stops.length > 0 && (
        <div className="row">
          <button className="btn sm red" disabled={applying} onClick={() => onApply(o)}>{o.stops[0].k === 0 ? `Box this lap → ${COMPOUNDS[o.stops[0].compound].name}` : `Call pit for lap ${o.stops[0].lap}`}</button>
          <span className="mu" style={{ fontSize: 11 }}>Sends the pit call to the car and logs it to the audit trail</span>
        </div>
      )}
    </div>
  );
}

export default function Strategy() {
  const user = useAuth((s) => s.user);
  const session = useSession((s) => s.session);
  const sel = useUI((s) => s.selected);
  const select = useUI((s) => s.select);
  const toast = useToasts((s) => s.push);
  const allowed = user?.role === 'race_control' ? CARS : user ? carsOfTeam(user.team) : [];
  const carId = allowed.some((c) => c.id === sel) ? sel : allowed[0]?.id;
  useRooms(carId ? [`team:${CAR_BY_ID[carId].team}`, `car:${carId}`, 'timing'] : []);
  const live = useStrategy((s) => s.byCar[carId]);
  const [what, setWhat] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [sc, setSc] = useState({ rainOn: true, rainIn: 3, rainDur: 8, rainInt: 0.7, scOn: false, scIn: 1, deg: 1, rivalOn: false, rival: '', rivalIn: 0, rivalComp: 'H', noRain: false });

  useEffect(() => { setWhat(null); }, [carId]);
  useEffect(() => {
    if (!carId || live) return;
    api(`/strategy/${carId}`).then((s) => useStrategy.getState().put(s)).catch(() => {});
  }, [carId, live]);

  if (!user) return <div className="card"><div className="empty"><b>Strategy is team-only</b>Sign in as a team engineer or race control.</div></div>;
  if (session?.type && session.type !== 'race') {
    return <div className="card"><div className="empty"><b>The strategist runs during the race</b>This is a {session.type} session. Use the run monitor on the pit wall, or open Analysis for long-run pace and degradation.</div></div>;
  }

  const runWhatIf = async () => {
    setBusy(true);
    const body = {};
    if (sc.rainOn) body.rain = { inLaps: Number(sc.rainIn), durationLaps: Number(sc.rainDur), intensity: Number(sc.rainInt) };
    if (sc.noRain) body.noRain = true;
    if (sc.scOn) body.safetyCar = { inLaps: Number(sc.scIn), laps: 3, type: 'SC' };
    if (Number(sc.deg) !== 1) body.degMultiplier = Number(sc.deg);
    if (sc.rivalOn && sc.rival) body.rivalPit = { carId: sc.rival, inLaps: Number(sc.rivalIn), compound: sc.rivalComp };
    try { setWhat(await api(`/strategy/${carId}/whatif`, { method: 'POST', body })); }
    catch (e) { toast({ kind: 'red', title: 'What-if failed', text: e.message }); }
    finally { setBusy(false); }
  };

  const apply = async (o) => {
    setApplying(true);
    try {
      const s = o.stops[0];
      const r = await api(`/strategy/${carId}/apply`, { method: 'POST', body: { compound: s.compound, lap: s.k === 0 ? undefined : s.lap } });
      toast({ kind: 'grn', title: r.immediate ? `Box box · ${carId}` : `Pit call scheduled · ${carId}`, text: r.immediate ? `${COMPOUNDS[s.compound].name}s this lap` : `Lap ${r.lap}, ${COMPOUNDS[s.compound].name}s` });
    } catch (e) { toast({ kind: 'red', title: 'Pit call failed', text: e.message }); }
    finally { setApplying(false); }
  };
  const cancel = async () => { await api(`/strategy/${carId}/scheduled`, { method: 'DELETE' }).catch(() => {}); toast({ kind: 'cyan', title: 'Pit call cancelled', text: carId }); };

  const meta = CAR_BY_ID[carId];
  const others = CARS.filter((c) => c.id !== carId);
  const readOnly = !canOpen(user, carId);
  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Strategy</h1><p>The live strategist searches every no-stop, one-stop and two-stop plan for the rest of the race. It uses the tyre and weather model the cars run on, calibrated from their real lap times. Options refresh every 3 seconds.</p></div>
        <div className="seg">{allowed.map((c) => <button key={c.id} className={c.id === carId ? 'on' : ''} onClick={() => select(c.id)} style={{ borderLeft: `3px solid ${colorOf(c.id)}` }}>{c.number} {c.id}</button>)}</div>
      </div>
      {meta && (
        <div className="four">
          <div className="card kpi"><small>{TEAM_BY_ID[meta.team].name}</small><b>{meta.number} {meta.last.toUpperCase()}</b></div>
          <div className="card kpi"><small>Position · lap</small><b>P{live?.position ?? '–'}<em>lap {live?.lap ?? '–'}/{live?.totalLaps ?? '–'}</em></b></div>
          <div className="card kpi"><small>Tyre</small><b className="row" style={{ gap: 8 }}>{live && <Tyre c={live.tyre.compound} />}{live ? `${live.tyre.age}/${live.tyre.cliff}` : '–'}<em>{live ? `+${live.tyre.degPerLap.toFixed(3)} s/lap` : ''}</em></b></div>
          <div className="card kpi"><small>Fuel margin · predicted lap</small><b style={{ color: live?.fuel.margin < 1 ? 'var(--crit)' : undefined }}>{live ? `${live.fuel.margin.toFixed(1)} kg` : '–'}<em>{live?.predictedLap}</em></b></div>
        </div>
      )}
      {live?.scheduled && (
        <div className="cutoff" style={{ borderColor: 'var(--cyan)', background: 'linear-gradient(90deg, rgba(56,216,255,.12), transparent)' }}>
          <span className="lbl">Pit call scheduled</span><b>Lap {live.scheduled.lap} · {COMPOUNDS[live.scheduled.compound].name}</b><span className="mu">by {live.scheduled.by}</span>
          <span className="spacer" />{!readOnly && <button className="btn sm ghost" onClick={cancel}>Cancel</button>}
        </div>
      )}
      <div className="two">
        <div className="card">
          <div className="card-h"><b>Live options</b><span className="chip">{live ? `${live.model.plansEvaluated.toLocaleString()} plans · model residual ${live.model.residual}s` : 'computing…'}</span></div>
          <div className="card-b stack">
            {!live && <><div className="shimmer" style={{ height: 120 }} /><div className="shimmer" style={{ height: 120 }} /></>}
            {live?.options.map((o) => <Option key={o.id} o={o} strat={live} onApply={apply} applying={applying} readOnly={readOnly} />)}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-h"><b>Race situation</b><span className="chip">track {live?.trackStatus ?? '–'}</span></div>
            <div className="card-b stack" style={{ gap: 8 }}>
              {!live?.insights?.length && <div className="mu">No threats or opportunities right now.</div>}
              {live?.insights?.map((i, k) => <Insight key={k} i={i} />)}
              {live && (
                <>
                  <div className="lbl">Forecast track wetness · next 10 laps</div>
                  <div className="wx-strip">{live.weather.forecast.map((w, k) => <div key={k} title={`lap +${k}: ${w}`}><span>{w.toFixed(2)}</span><i style={{ height: `${Math.min(100, w * 100)}%` }} /></div>)}</div>
                  <div className="wx-axis"><span>now</span><span>slick / inter crossover ≈ 0.25</span><span>+10</span></div>
                </>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><b>What if…</b><button className="btn sm red" onClick={runWhatIf} disabled={busy || !live}>{busy ? 'Running…' : 'Run scenario'}</button></div>
            <div className="card-b stack">
              <label className="row"><input type="checkbox" checked={sc.rainOn} onChange={(e) => setSc({ ...sc, rainOn: e.target.checked, noRain: false })} /> <b>Rain</b> in
                <input className="input" style={{ width: 64 }} type="number" min="0" max="30" value={sc.rainIn} onChange={(e) => setSc({ ...sc, rainIn: e.target.value })} /> laps for
                <input className="input" style={{ width: 64 }} type="number" min="1" max="30" value={sc.rainDur} onChange={(e) => setSc({ ...sc, rainDur: e.target.value })} /> laps</label>
              <div className="field"><label htmlFor="ri">Rain intensity · {Math.round(sc.rainInt * 100)}%</label><input id="ri" type="range" min="0.1" max="1" step="0.05" value={sc.rainInt} onChange={(e) => setSc({ ...sc, rainInt: e.target.value })} /></div>
              <label className="row"><input type="checkbox" checked={sc.noRain} onChange={(e) => setSc({ ...sc, noRain: e.target.checked, rainOn: false })} /> Forecast rain <b>does not arrive</b></label>
              <label className="row"><input type="checkbox" checked={sc.scOn} onChange={(e) => setSc({ ...sc, scOn: e.target.checked })} /> <b>Safety car</b> in
                <input className="input" style={{ width: 64 }} type="number" min="0" max="30" value={sc.scIn} onChange={(e) => setSc({ ...sc, scIn: e.target.value })} /> laps</label>
              <div className="field"><label htmlFor="dg">Tyre degradation × {Number(sc.deg).toFixed(2)}</label><input id="dg" type="range" min="0.6" max="1.8" step="0.05" value={sc.deg} onChange={(e) => setSc({ ...sc, deg: e.target.value })} /></div>
              <label className="row"><input type="checkbox" checked={sc.rivalOn} onChange={(e) => setSc({ ...sc, rivalOn: e.target.checked })} /> <b>Rival</b>
                <select className="input" value={sc.rival} onChange={(e) => setSc({ ...sc, rival: e.target.value, rivalOn: true })}><option value="">choose…</option>{others.map((c) => <option key={c.id} value={c.id}>{c.number} {c.id}</option>)}</select>
                pits in <input className="input" style={{ width: 56 }} type="number" min="0" max="20" value={sc.rivalIn} onChange={(e) => setSc({ ...sc, rivalIn: e.target.value })} />
                <select className="input" value={sc.rivalComp} onChange={(e) => setSc({ ...sc, rivalComp: e.target.value })}>{['S', 'M', 'H', 'I', 'W'].map((c) => <option key={c}>{c}</option>)}</select></label>
            </div>
          </div>
        </div>
      </div>
      {what && (
        <div className="card hl">
          <div className="card-h"><b>Scenario result</b><span className="chip">{what.model.plansEvaluated.toLocaleString()} plans in {what.ms} ms</span><button className="btn sm ghost" onClick={() => setWhat(null)}>Clear</button></div>
          <div className="card-b two">
            <div className="stack">{what.options.map((o) => <Option key={o.id} o={o} strat={what} onApply={apply} applying={applying} readOnly={readOnly} />)}</div>
            <div className="stack">{what.insights.map((i, k) => <Insight key={k} i={i} />)}
              <div className="lbl">Scenario wetness forecast</div>
              <div className="wx-strip">{what.weather.forecast.map((w, k) => <div key={k}><span>{w.toFixed(2)}</span><i style={{ height: `${Math.min(100, w * 100)}%` }} /></div>)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
