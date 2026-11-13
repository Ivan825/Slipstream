import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useNow } from '../lib/hooks.js';
import { useAuth } from '../store/auth.js';
import { useUI } from '../store/stores.js';
import { Mark } from '../components/Nav.jsx';
import { SessionGrid } from './Replay.jsx';

const until = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

/**
 * The front door: pick what to watch. Live F1, any past session, or the
 * simulated race weekend. Whatever you pick, every page follows it.
 */
export default function Home() {
  const nav = useNavigate();
  const now = useNow(1000);
  const user = useAuth((s) => s.user);
  const setSource = useUI((s) => s.setSource);
  const [sessions, setSessions] = useState(null);
  const [live, setLive] = useState(false);
  const [channels, setChannels] = useState([]);
  useEffect(() => {
    const y = new Date().getFullYear();
    Promise.all([api(`/replay/catalog?year=${y}`), api(`/replay/catalog?year=${y - 1}`).catch(() => ({ sessions: [] }))])
      .then(([a, b]) => setSessions([...b.sessions, ...a.sessions]))
      .catch(() => setSessions([]));
    const loadCh = () => api('/replay/channels').then((d) => { setLive(d.live); setChannels(d.channels.filter((c) => c.viewers > 0)); }).catch(() => {});
    loadCh();
    const id = setInterval(loadCh, 10_000);
    return () => clearInterval(id);
  }, []);

  const { running, next, latestRace, latest } = useMemo(() => {
    const list = sessions || [];
    const t = Date.now();
    const running = list.find((s) => Date.parse(s.start) <= t && Date.parse(s.end) + 30 * 60_000 >= t) || null;
    const next = list.filter((s) => Date.parse(s.start) > t).sort((a, b) => a.start.localeCompare(b.start))[0] || null;
    const done = list.filter((s) => Date.parse(s.end) < t - 60 * 60_000);
    const latestRace = [...done].reverse().find((s) => s.name === 'Race') || null;
    const latest = done[done.length - 1] || null;
    return { running, next, latestRace, latest };
  }, [sessions]);

  const watchSim = () => { setSource({ kind: 'sim' }); nav('/pitwall'); };
  const watch = (key) => nav(`/real/${key}`);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="home-hero carbon">
        <div>
          <div className="lbl" style={{ color: 'rgba(255,255,255,.7)' }}>Real-time race telemetry</div>
          <h1>What do you want to watch?</h1>
          <p>Follow a Formula 1 session live, relive any session since 2023 as if it were happening now, or run our simulated race weekend with team roles, alerts and a live strategist. Whatever you choose, the pit wall, telemetry and analysis follow it.</p>
        </div>
        <Mark size={90} />
      </div>

      <div className="three">
        <div className={`card home-card ${running && live ? 'hl' : ''}`}>
          <div className="card-h"><b>Live now</b><span className={`live-pill ${running ? '' : 'off'}`} style={{ fontSize: 10, padding: '2px 8px' }}><i />{running ? 'ON TRACK' : 'NOTHING RUNNING'}</span></div>
          <div className="card-b stack" style={{ gap: 10 }}>
            {!sessions && <div className="shimmer" style={{ height: 60 }} />}
            {running && <div><div className="lbl">{running.circuit}</div><b className="home-big">{running.country} · {running.name}</b></div>}
            {!running && next && <div><div className="lbl">Next session · {next.circuit}</div><b className="home-big">{next.country} · {next.name}</b><div className="mono mu">starts in {until(Date.parse(next.start) - now)}</div></div>}
            {running && live && <button className="btn red" onClick={() => watch('live')}>Watch live</button>}
            {running && !live && <p className="mu" style={{ margin: 0, fontSize: 12.5 }}>Live F1 data needs an OpenF1 subscription key on this server (<span className="mono">OPENF1_TOKEN</span>). Past sessions are free, and the live session appears here as soon as it's published.</p>}
            {!running && !live && <p className="mu" style={{ margin: 0, fontSize: 12.5 }}>With an OpenF1 key on the server, the session running right now streams here live and is recorded for replay.</p>}
            {latest && <button className="btn ghost" onClick={() => watch(latest.key)}>Watch the latest session: {latest.country} {latest.name}</button>}
          </div>
        </div>

        <div className="card home-card">
          <div className="card-h"><b>Relive a race</b><span className="chip">every session since 2023</span></div>
          <div className="card-b stack" style={{ gap: 8 }}>
            <p className="mu" style={{ margin: 0, fontSize: 13 }}>Pick any practice, qualifying, sprint or race. It plays on a real-time clock with real drivers, telemetry, timing and race control. Pause, jump anywhere, or play it at up to 16×.</p>
            {latestRace && <button className="btn red" onClick={() => watch(latestRace.key)}>Latest race: {latestRace.country} GP</button>}
            <button className="btn ghost" onClick={() => watch(9636)}>2024 Brazil GP: rain, red flag, chaos</button>
            <button className="btn ghost" onClick={() => document.getElementById('all-sessions')?.scrollIntoView({ behavior: 'smooth' })}>Browse all sessions ↓</button>
          </div>
        </div>

        <div className="card home-card">
          <div className="card-h"><b>Simulated weekend</b><span className="chip">20 cars · practice, qualifying, race</span></div>
          <div className="card-b stack" style={{ gap: 8 }}>
            <p className="mu" style={{ margin: 0, fontSize: 13 }}>Our own race on a fictional circuit, with deep telemetry: tyre temperatures, brakes, fuel and ERS. Team engineers get alerts and a live pit-stop strategist. Race control runs the weekend.</p>
            <button className="btn red" onClick={watchSim}>Watch the simulated race</button>
            {!user && <button className="btn ghost" onClick={() => nav('/login')}>Sign in as engineer or race control</button>}
            {user && <span className="chip">signed in as {user.username} · {user.role.replace('_', ' ')}</span>}
          </div>
        </div>
      </div>

      {channels.length > 0 && (
        <div className="card">
          <div className="card-h"><b>Being watched right now</b><span className="chip">shared channels</span></div>
          <div className="card-b row">{channels.map((c) => <button key={c.key} className="btn sm" onClick={() => watch(c.live ? 'live' : c.key)}>{c.name} · {c.viewers} watching</button>)}</div>
        </div>
      )}

      <div id="all-sessions"><SessionGrid onPick={watch} /></div>
    </div>
  );
}
