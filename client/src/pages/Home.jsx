import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useNow } from '../lib/hooks.js';
import { useAuth, isCrew } from '../store/auth.js';
import { useUI, useToasts } from '../store/stores.js';
import { Mark } from '../components/Nav.jsx';
import { TeamPicker } from '../components/TeamPicker.jsx';
import { SessionGrid } from './Replay.jsx';
import { startMock, myMockIds, forgetMock } from '../lib/crew.js';
import { startTakeover } from '../lib/takeover.js';

const until = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const ago = (d) => {
  const m = Math.round((Date.now() - Date.parse(d)) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const BRAZIL_2024 = { key: 9636, label: '2024 São Paulo GP · rain, red flag' };

/**
 * The launcher: a race team's pit wall software. Work the live session, rehearse
 * on a past race as a mock session (own clock, call log, debrief), or drill a
 * full weekend in the simulator.
 */
export default function Home() {
  const nav = useNavigate();
  const now = useNow(1000);
  const user = useAuth((s) => s.user);
  const setSource = useUI((s) => s.setSource);
  const team = useUI((s) => s.realTeam);
  const toast = useToasts((s) => s.push);
  const [sessions, setSessions] = useState(null);
  const [live, setLive] = useState(false);
  const [mocks, setMocks] = useState([]);
  const [pick, setPick] = useState(null); // { key, label }
  const [lap, setLap] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const y = new Date().getFullYear();
    Promise.all([api(`/replay/catalog?year=${y}`), api(`/replay/catalog?year=${y - 1}`).catch(() => ({ sessions: [] }))])
      .then(([a, b]) => setSessions([...b.sessions, ...a.sessions]))
      .catch(() => setSessions([]));
    api('/replay/channels').then((d) => setLive(d.live)).catch(() => {});
  }, []);
  // a crew sees every mock its team has run; a guest sees the ones this browser started or was sent
  useEffect(() => {
    const ids = myMockIds();
    if (!ids.length && !isCrew(user)) return setMocks([]);
    api(`/mocks?ids=${ids.join(',')}`).then((d) => setMocks(d.mocks)).catch(() => {});
  }, [user]);

  const { running, next, races } = useMemo(() => {
    const list = sessions || [];
    const t = Date.now();
    const running = list.find((s) => Date.parse(s.start) <= t && Date.parse(s.end) + 30 * 60_000 >= t) || null;
    const next = list.filter((s) => Date.parse(s.start) > t).sort((a, b) => a.start.localeCompare(b.start))[0] || null;
    const done = list.filter((s) => Date.parse(s.end) < t - 60 * 60_000);
    const races = done.filter((s) => s.name === 'Race' || s.name === 'Sprint').reverse().slice(0, 10)
      .map((s) => ({ key: s.key, label: `${s.start.slice(0, 4)} ${s.country} · ${s.name}` }));
    return { running, next, races };
  }, [sessions]);
  const options = useMemo(() => {
    const o = [...races];
    if (!o.some((r) => r.key === BRAZIL_2024.key)) o.push(BRAZIL_2024);
    if (pick && !o.some((r) => r.key === pick.key)) o.unshift(pick);
    return o;
  }, [races, pick]);
  const chosen = pick || options[0] || null;

  const launch = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await startMock({ key: chosen.key, lap: Number(lap) || undefined, team: team || undefined });
      setSource({ kind: 'real', key: r.ch, name: r.snapshot.meta.name, mock: true });
      nav('/pitwall');
    } catch (e) {
      toast({ kind: '', title: 'Could not start the mock', text: e.message });
      setBusy(false);
    }
  };
  const takeover = async (from, atLap) => {
    setBusy(true);
    try {
      const r = await startTakeover({ from, lap: atLap, team: team || undefined });
      setSource({ kind: 'real', key: r.ch, name: r.snapshot.meta.name, mock: true });
      toast({ kind: 'cyan', title: 'You have the pit wall', text: `Real race to lap ${r.snapshot.meta.fork.lap0}, simulated from there. Press play, then make your calls.`, ms: 6000 });
      nav('/pitwall');
    } catch (e) {
      toast({ kind: '', title: 'Could not take over', text: e.message });
      setBusy(false);
    }
  };
  const openSim = () => { setSource({ kind: 'sim' }); nav('/pitwall'); };
  const resume = (m, to = '/pitwall') => { setSource({ kind: 'real', key: `m-${m.id}`, name: m.name, mock: true }); nav(to); };
  const fromCalendar = async (key) => {
    const s = (sessions || []).find((x) => x.key === key);
    setPick({ key, label: s ? `${s.start.slice(0, 4)} ${s.country} · ${s.name}` : `Session ${key}` });
    setLap('');
    document.getElementById('mock-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="home-hero carbon">
        <div>
          <div className="lbl" style={{ color: 'rgba(255,255,255,.7)' }}>Race engineering software</div>
          <h1>Run the pit wall</h1>
          <p>Strategy, telemetry and alerts for a race team, on real Formula 1 timing. Work the live session, rehearse on any past race as a mock session with your own clock and a debrief, or drill a full weekend in the simulator.</p>
          <div className="row" style={{ marginTop: 14, gap: 12 }}>
            <TeamPicker />
            {!user && <button className="btn sm ghost" onClick={() => nav('/login')}>Sign in as your team's crew</button>}
          </div>
        </div>
        <Mark size={90} />
      </div>

      <div className="three">
        <div className={`card home-card ${running && live ? 'hl' : ''}`}>
          <div className="card-h"><b>Live session</b><span className={`live-pill ${running ? '' : 'off'}`} style={{ fontSize: 10, padding: '2px 8px' }}><i />{running ? 'ON TRACK' : 'NO SESSION'}</span></div>
          <div className="card-b stack" style={{ gap: 10 }}>
            {!sessions && <div className="shimmer" style={{ height: 60 }} />}
            {running && <div><div className="lbl">{running.circuit}</div><b className="home-big">{running.country} · {running.name}</b></div>}
            {!running && next && <div><div className="lbl">Next session · {next.circuit}</div><b className="home-big">{next.country} · {next.name}</b><div className="mono mu">starts in {until(Date.parse(next.start) - now)}</div></div>}
            <p className="mu" style={{ margin: 0, fontSize: 12.5 }}>Timing, positions, tyres and car data a few seconds behind real time, with the strategist and team alerts on your cars. Recorded as it runs, so the session is ready to rehearse afterwards.</p>
            {running && live && <button className="btn red" onClick={() => nav('/real/live')}>Open the live pit wall</button>}
            {running && live && /Race|Sprint/.test(running.name) && <button className="btn" disabled={busy} onClick={() => takeover('live')} title="Fork the live race now and run it yourself">Take over the live race</button>}
            {!live && <p className="mu" style={{ margin: 0, fontSize: 12 }}>The live feed needs an OpenF1 subscription key on the server (<span className="mono">OPENF1_TOKEN</span>). Past sessions need no key.</p>}
          </div>
        </div>

        <div className="card home-card hl" id="mock-card">
          <div className="card-h"><b>Mock session</b><span className="chip">rehearse a past race</span></div>
          <div className="card-b stack" style={{ gap: 10 }}>
            <p className="mu" style={{ margin: 0, fontSize: 13 }}>Your crew gets a private copy of a past race on its own clock. Pause, jump to any lap, make your pit calls, then debrief them against what the real team did.</p>
            <label className="stack" style={{ gap: 4 }}><span className="lbl">Session</span>
              <select className="input" value={chosen?.key || ''} onChange={(e) => setPick(options.find((o) => o.key === Number(e.target.value)) || null)}>
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            <div className="row" style={{ gap: 8 }}>
              <label className="row" style={{ gap: 6 }}><span className="lbl" style={{ margin: 0 }}>Start at lap</span>
                <input className="input" style={{ width: 70 }} inputMode="numeric" placeholder="1" value={lap} onChange={(e) => setLap(e.target.value.replace(/\D/g, ''))} />
              </label>
              <button className="btn red" style={{ flex: 1 }} disabled={!chosen || busy} onClick={launch}>{busy ? 'Preparing…' : 'Start mock session'}</button>
            </div>
            <button className="btn" disabled={!chosen || busy} onClick={() => takeover(chosen.key, Number(lap) || 1)} title="Real race up to that lap, then simulated: your calls change the result">{busy ? 'Preparing…' : `Take over from lap ${Number(lap) || 1}`}</button>
            <span className="mu" style={{ fontSize: 12 }}><b>Mock</b> replays what really happened and scores your calls. <b>Takeover</b> runs the race on from that lap: box, tyres, modes and team orders change the result, and you can throw in safety cars, rain and penalties.</span>
            {!team && <span className="mu" style={{ fontSize: 12 }}>Tip: pick your team above so the strategist and alerts follow your cars.</span>}
            {isCrew(user) && <span className="mu" style={{ fontSize: 12 }}>Private to the {user.team} crew: only your team's accounts can open it.</span>}
          </div>
        </div>

        <div className="card home-card">
          <div className="card-h"><b>Simulator</b><span className="chip">full weekend drills</span></div>
          <div className="card-b stack" style={{ gap: 8 }}>
            <p className="mu" style={{ margin: 0, fontSize: 13 }}>A synthetic 20-car weekend with deep telemetry: tyre temperatures, brakes, fuel and ERS. Race control throws safety cars, rain and failures at the grid; engineers answer with live alerts and the pit-stop strategist.</p>
            <button className="btn red" onClick={openSim}>Open the simulator</button>
            {!user && <button className="btn ghost" onClick={() => nav('/login')}>Sign in as engineer or race control</button>}
            {user && !isCrew(user) && <span className="chip">signed in as {user.username} · {user.role.replace('_', ' ')}</span>}
          </div>
        </div>
      </div>

      {mocks.length > 0 && (
        <div className="card">
          <div className="card-h"><b>{isCrew(user) ? `${user.team} crew: mock sessions` : 'Your mock sessions'}</b><span className="chip">{isCrew(user) ? 'kept for 60 days · your crew only' : 'kept for 60 days · anyone with the link can open them'}</span></div>
          <div className="scroll"><table className="tbl">
            <thead><tr><th>Session</th><th>Team</th><th className="n">Calls</th><th className="n">Clock</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {mocks.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.name}</b>{m.crew && <span className="chip" style={{ marginLeft: 8, fontSize: 9, padding: '0 5px' }}>CREW</span>}</td><td>{m.team || <span className="mu">—</span>}</td><td className="n">{m.calls}</td>
                  <td className="n">{Math.round(((m.t - m.from) / Math.max(1, m.to - m.from)) * 100)}%</td><td className="mu">{ago(m.updatedAt)}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="btn sm red" onClick={() => resume(m)}>Resume</button>
                    <button className="btn sm" onClick={() => resume(m, '/debrief')}>Debrief</button>
                    {!m.crew && <button className="btn sm ghost" title="Remove from this list" onClick={() => { forgetMock(m.id); setMocks(mocks.filter((x) => x.id !== m.id)); }}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      <div id="all-sessions"><SessionGrid onPick={fromCalendar} title="Session calendar" subtitle="Every session since 2023. Pick one to set it up as a mock session above." /></div>
    </div>
  );
}
