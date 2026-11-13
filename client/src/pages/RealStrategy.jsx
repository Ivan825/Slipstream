import { useMemo, useState } from 'react';
import { formatLapTime } from '@slipstream/shared';
import { useReplay } from '../store/replay.js';
import { useUI, useToasts } from '../store/stores.js';
import { useAuth } from '../store/auth.js';
import { useTicker } from '../lib/hooks.js';
import { Tyre } from '../components/TimingTower.jsx';
import { useRealAnalysis } from './RealTelemetry.jsx';
import { sessionModel, plansFor, SC_FACTOR, FUEL_S_PER_LAP } from '../lib/realStrategy.js';
import { teamDrivers, sameTeam } from '../lib/teams.js';
import { useMock, useTeamFeed } from '../lib/crew.js';
import { TeamPicker } from '../components/TeamPicker.jsx';

const lt = (s) => (s == null ? '—' : formatLapTime(s));
const sec = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(d)} s`);
export const TONE = { red: 'var(--red)', amber: '#ffb020', green: '#2bd94e', mu: 'var(--mu)' };

/**
 * The strategist on real timing, focused on the crew's own cars. In a mock
 * session every call the crew makes is logged against the clock for the debrief.
 */
export default function RealStrategy() {
  useTicker(1);
  const { meta, state, rows, key } = useReplay();
  const data = useRealAnalysis(key);
  const realDriver = useUI((s) => s.realDriver);
  const setRealDriver = useUI((s) => s.setRealDriver);
  const team = useUI((s) => s.realTeam);
  const mock = useMock((s) => s.doc);
  const t = state.t || 0;
  const tSec = Math.floor(t / 2000); // recompute the session model every two seconds of session time
  const model = useMemo(() => (data ? sessionModel(data, t, meta?.live) : null), [data, tSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta || !data || !model) return <div className="shimmer" style={{ height: 300 }} />;
  const s = plansFor({ meta, state, rows, data, model });
  const { isRace, drivers, flag, rain, leaderLap, remaining, field, plans } = s;
  const ours = teamDrivers(meta, team).filter((d) => plans.has(d.n));
  const focus = ours.length ? ours.map((d) => d.n) : [(field.find((r) => r.n === realDriver) || field[0])?.n].filter(Boolean);
  const inMock = !!meta.mock && mock;

  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Strategy</h1><p>{meta.name}. Pit loss, degradation and tyre life come from this session's own laps and stops, up to the {meta.mock ? 'mock' : 'session'} clock. Real timing has no tyre temperatures or fuel loads, so those are estimated.</p></div>
        <div className="row" style={{ gap: 8 }}>
          <TeamPicker meta={meta} />
          <span className="tag" style={{ background: meta.mock ? 'var(--cyan)' : meta.live ? 'var(--red)' : '#fff', color: meta.live ? '#fff' : 'var(--bg)' }}>{meta.mock ? 'Mock session' : meta.live ? 'Live' : 'Replay'}</span>
        </div>
      </div>

      <div className="three">
        <div className="card">
          <div className="card-h"><b>Pit loss</b><span className="chip">{model.losses.length ? `from ${model.losses.length} stops` : 'estimate'}</span></div>
          <div className="card-b row" style={{ gap: 22 }}>
            <div><div className="lbl">Green flag</div><b className="big mono">{sec(model.pitLoss)}</b></div>
            <div><div className="lbl">Under VSC</div><b className="mono">{sec(model.pitLoss * SC_FACTOR.VSC)}</b></div>
            <div><div className="lbl">Under SC</div><b className="mono">{sec(model.pitLoss * SC_FACTOR.SC)}</b></div>
            {model.laneTime && <div><div className="lbl">Pit lane</div><b className="mono">{sec(model.laneTime)}</b></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Race</b><span className="chip" style={{ color: flag === 'GREEN' ? undefined : '#ffb020' }}>{flag === 'GREEN' ? 'green flag' : flag}</span></div>
          <div className="card-b row" style={{ gap: 22 }}>
            <div><div className="lbl">Lap</div><b className="big mono">{leaderLap}{model.totalLaps ? ` / ${model.totalLaps}` : ''}</b></div>
            {remaining != null && <div><div className="lbl">To go</div><b className="mono">{remaining}</b></div>}
            <div><div className="lbl">Rain</div><b className="mono">{rain ? 'YES' : 'no'}</b></div>
            {state.weather?.track != null && <div><div className="lbl">Track</div><b className="mono">{state.weather.track}°</b></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Tyre life</b><span className="chip">laps per set</span></div>
          <div className="card-b row" style={{ gap: 14 }}>
            {['S', 'M', 'H', 'I', 'W'].map((c) => <span key={c} className="row" style={{ gap: 6 }} title={model.life[c].from ? `from ${model.life[c].from} finished stints` : 'typical value until stints finish'}><Tyre c={c} /><b className="mono">{model.life[c].laps}</b>{!model.life[c].from && <span className="mu" style={{ fontSize: 11 }}>est.</span>}</span>)}
          </div>
        </div>
      </div>

      {!isRace && <div className="card"><div className="empty"><b>Pit strategy is for races and sprints</b>This is {meta.type || 'a non-race session'}. The table below still shows each driver's tyres and degradation on the current set.</div></div>}

      {isRace && !team && <div className="card"><div className="empty"><b>Which team are you running?</b>Pick your team above and the strategist follows both of your cars, raises alerts for them, and {meta.mock ? 'logs your calls for the debrief' : 'highlights them everywhere'}.</div></div>}

      {isRace && (
        <div className={focus.length > 1 ? 'two' : ''} style={{ display: focus.length > 1 ? undefined : 'block' }}>
          {focus.map((n) => <Strategist key={n} n={n} s={s} model={model} field={field} canLog={inMock} pick={!ours.length} onPick={setRealDriver} />)}
        </div>
      )}

      {isRace && (
        <div className={inMock ? 'two' : ''} style={{ display: inMock ? undefined : 'block' }}>
          <TeamAlerts />
          {inMock && <CallLog drivers={drivers} />}
        </div>
      )}

      <div className="card">
        <div className="card-h"><b>The field</b><span className="chip">{ours.length ? 'your cars are highlighted' : 'pick a row to focus the strategist'}</span></div>
        <div className="scroll"><table className="tbl">
          <thead><tr><th className="n">Pos</th><th>Driver</th><th>Tyre</th><th className="n">Age</th><th className="n">Stops</th><th className="n">Gap</th><th className="n">Int</th><th className="n">Deg s/lap</th>{isRace && <th className="n">Box now → P</th>}{isRace && <th>Call</th>}</tr></thead>
          <tbody>
            {field.map((r) => { const q = plans.get(r.n); const d = drivers.get(r.n); const mine = team && sameTeam(d?.team, team); return (
              <tr key={r.n} onClick={() => setRealDriver(r.n)} style={{ cursor: 'pointer', background: mine ? 'rgba(0,200,255,.10)' : r.n === focus[0] ? 'rgba(225,6,0,.12)' : undefined }}>
                <td className="n">{r.pos}</td><td><Drv d={d} mine={mine} /></td><td>{r.tc && <Tyre c={r.tc} />}</td><td className="n">{r.ta ?? '—'}</td><td className="n">{r.pits}</td>
                <td className="n">{r.pos === 1 ? '—' : r.g == null ? '—' : `+${r.g.toFixed(1)}`}</td><td className="n">{typeof r.int === 'number' ? `+${r.int.toFixed(1)}` : r.int || '—'}</td>
                <td className="n">{q.deg == null ? '—' : q.deg.toFixed(3)}</td>
                {isRace && <td className="n">{q.rejoin?.pos ?? '—'}</td>}
                {isRace && <td style={{ color: TONE[q.tone], fontWeight: 700, fontSize: 12 }}>{q.call}</td>}
              </tr>
            ); })}
          </tbody>
        </table></div>
        <div className="merge-note"><span>pit loss = in-lap + out-lap − 2 green laps, median over stops so far · SC/VSC stops cost ~55% / 65% · degradation = lap-time slope on the current set + {FUEL_S_PER_LAP} s/lap fuel effect</span></div>
      </div>
    </div>
  );
}

const Drv = ({ d, mine }) => <span className="drv"><i style={{ background: d?.color }} />{d?.code}<span className="mu" style={{ fontWeight: 400 }}>{d?.last}</span>{mine && <span className="chip" style={{ marginLeft: 6, fontSize: 9, padding: '0 5px', color: 'var(--cyan)', borderColor: 'var(--cyan)' }}>OURS</span>}</span>;

/** one car's strategist card; in a mock it also logs the crew's call */
function Strategist({ n, s, field, canLog, pick, onPick }) {
  const { drivers } = s;
  const p = s.plans.get(n);
  const sel = field.find((r) => r.n === n);
  const d = drivers.get(n);
  const call = useMock((m) => m.call);
  const user = useAuth((a) => a.user);
  const toast = useToasts((x) => x.push);
  const [busy, setBusy] = useState(false);
  if (!p || !sel) return null;
  const log = async (body) => {
    setBusy(true);
    try {
      const c = await call({ n, advice: p.call, by: user?.username, ...body });
      toast({ kind: 'cyan', title: `Logged · ${d?.code} lap ${c.lap}`, text: body.kind === 'box' ? `Box for ${body.compound}` : 'Stay out', ms: 2500 });
    } catch (e) { toast({ kind: '', title: 'Call not logged', text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="card hl" style={{ '--tc': d?.color }}>
      <div className="card-h">
        <b>Strategist · <span style={{ color: d?.color }}>{d?.name || d?.code}</span> <span className="mu" style={{ fontWeight: 400 }}>P{sel.pos}</span></b>
        {pick
          ? <select className="input" style={{ height: 30 }} value={n} onChange={(e) => onPick(Number(e.target.value))}>
              {field.map((r) => <option key={r.n} value={r.n}>P{r.pos} · {drivers.get(r.n)?.code} · {drivers.get(r.n)?.last}</option>)}
            </select>
          : <span className="chip">{d?.team}</span>}
      </div>
      <div className="card-b stack" style={{ gap: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 900, textTransform: 'uppercase', color: TONE[p.tone] }}>{p.call}</div>
        <div className="four">
          <div><div className="lbl">Tyres</div><div className="row" style={{ gap: 8 }}>{p.c && <Tyre c={p.c} />}<b className="mono">{p.age} laps</b><span className="mu">of ~{p.L}</span></div>
            <div className="bar" style={{ marginTop: 6, height: 6, background: '#1a1a22' }}><i style={{ display: 'block', height: '100%', width: `${Math.min(100, (p.age / p.L) * 100)}%`, background: p.age > p.L * 0.9 ? 'var(--red)' : p.age > p.L * 0.7 ? '#ffb020' : '#2bd94e' }} /></div></div>
          <div><div className="lbl">Degradation</div><b className="mono">{p.deg == null ? '—' : `${p.deg >= 0 ? '+' : ''}${p.deg.toFixed(3)} s/lap`}</b><div className="mu" style={{ fontSize: 12 }}>{p.stintLaps} clean laps, fuel-corrected</div></div>
          <div><div className="lbl">If we box now</div><b className="mono">rejoin P{p.rejoin?.pos ?? '—'}</b><div className="mu" style={{ fontSize: 12 }}>
            {p.rejoin?.ahead && <>{sec(p.rejoin.gapAhead)} behind {drivers.get(p.rejoin.ahead.n)?.code}</>}
            {p.rejoin?.ahead && p.rejoin?.behind && ' · '}
            {p.rejoin?.behind && <>{sec(p.rejoin.gapBehind)} ahead of {drivers.get(p.rejoin.behind.n)?.code}</>}
            {p.rejoin && ((p.rejoin.gapAhead ?? 9) < 1.5 || (p.rejoin.gapBehind ?? 9) < 1.5) && <b style={{ color: '#ffb020' }}> · traffic</b>}
          </div></div>
          <div><div className="lbl">Fresh-tyre gain</div><b className="mono">~{sec(p.freshGain)}</b><div className="mu" style={{ fontSize: 12 }}>
            {p.undercutThreat ? <span style={{ color: '#ffb020' }}>{drivers.get(p.behindCar.n)?.code} is in undercut range</span> : p.undercutChance ? <span style={{ color: '#2bd94e' }}>undercut on the car ahead is on</span> : 'no undercut in play'}
          </div></div>
        </div>
        {p.needStop && <div className="mu" style={{ fontSize: 12.5 }}>Still has to use a second dry compound before the flag. Suggested set: <Tyre c={p.fit} /></div>}
        <div className="mu" style={{ fontSize: 12.5 }}>Last lap {lt(sel.last)} · best {lt(sel.best)} · {sel.pits} stop{sel.pits === 1 ? '' : 's'} · gap {sel.g == null ? '—' : sel.pos === 1 ? 'leader' : `+${sel.g.toFixed(1)} s`}</div>
        {canLog && (
          <div className="row" style={{ gap: 6, borderTop: '1px solid var(--ln)', paddingTop: 12 }}>
            <span className="lbl" style={{ marginRight: 4 }}>Your call</span>
            {['S', 'M', 'H', 'I', 'W'].map((c) => (
              <button key={c} className={`btn sm ${c === p.fit && p.kind === 'box' ? 'red' : ''}`} disabled={busy} onClick={() => log({ kind: 'box', compound: c })} title={`Box this lap for ${c}`}>Box · {c}</button>
            ))}
            <button className="btn sm ghost" disabled={busy} onClick={() => log({ kind: 'stay' })}>Stay out</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** what the team watcher has raised for the crew's cars */
export function TeamAlerts({ compact = false }) {
  const list = useTeamFeed((s) => s.list);
  const team = useUI((s) => s.realTeam);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: compact ? 0 : 220 }}>
      <div className="card-h"><b>Team alerts</b><span className="chip">{team ? team : 'no team picked'}</span></div>
      <ul className="feed" style={{ flex: 1, maxHeight: compact ? 220 : 320 }}>
        {!list.length && <li><i style={{ background: 'transparent' }} /><div className="m mu" style={{ padding: '6px 0' }}>{team ? 'Quiet. Stop calls, undercuts, rivals pitting around your cars, flags and rain show up here.' : 'Pick your team to get alerts for your cars.'}</div></li>}
        {list.map((a) => (
          <li key={a.id}>
            <i style={{ background: a.level === 'red' ? 'var(--red)' : a.level === 'amber' ? 'var(--yel)' : 'var(--cyan)' }} />
            <div><div className="t"><span>{a.title}</span><span>{new Date(a.t).toISOString().slice(11, 19)}</span></div><div className="m">{a.text}</div></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** the crew's calls so far in this mock */
function CallLog({ drivers }) {
  const doc = useMock((s) => s.doc);
  const remove = useMock((s) => s.remove);
  const calls = [...(doc?.calls || [])].reverse();
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 220 }}>
      <div className="card-h"><b>Call log</b><span className="chip">{calls.length} calls · for the debrief</span></div>
      <ul className="feed" style={{ flex: 1, maxHeight: 320 }}>
        {!calls.length && <li><i style={{ background: 'transparent' }} /><div className="m mu" style={{ padding: '6px 0' }}>Make your calls from the strategist cards. Each one is stamped with the lap, position and tyres, and compared with what the team really did in the debrief.</div></li>}
        {calls.map((c) => { const d = drivers.get(c.n); return (
          <li key={c.id}>
            <i style={{ background: d?.color || '#888' }} />
            <div style={{ flex: 1 }}><div className="t"><span>{d?.code} · lap {c.lap} · P{c.pos} · {c.kind === 'box' ? `BOX ${c.compound}` : c.kind === 'stay' ? 'STAY OUT' : 'NOTE'}</span><span>{new Date(c.t).toISOString().slice(11, 19)}</span></div>
              <div className="m">{[c.advice && `Strategist said: ${c.advice}`, c.by].filter(Boolean).join(' · ')} <button className="link-btn" onClick={() => remove(c.id)} title="Remove this call">undo</button></div></div>
          </li>
        ); })}
      </ul>
    </div>
  );
}
