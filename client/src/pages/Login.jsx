import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { TEAMS, REAL_TEAMS } from '@slipstream/shared';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';
import { useUI } from '../store/stores.js';
import { Mark } from '../components/Nav.jsx';

export default function Login() {
  const login = useAuth((s) => s.login);
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const [role, setRole] = useState('crew');
  const [crew, setCrew] = useState('mclaren');
  const [team, setTeam] = useState('kestrel');
  const [password, setPassword] = useState('slipstream');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lights, setLights] = useState(0);

  useEffect(() => {
    let n = 0;
    const id = setInterval(() => { n = (n + 1) % 8; setLights(n > 5 ? 0 : n); }, 650);
    return () => clearInterval(id);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const username = role === 'race_control' ? 'control' : role === 'crew' ? crew : team;
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      login(res.token, res.user);
      if (res.user.role === 'crew') {
        // a crew works real sessions for its own team: back to the launcher
        useUI.getState().setRealTeam(res.user.team);
        const src = useUI.getState().source;
        if (src.mock) useUI.getState().setSource({ kind: 'sim' }); // a guest mock stays reachable by its link
        nav('/');
      } else {
        useUI.getState().setSource({ kind: 'sim' });
        nav(role === 'race_control' ? '/control' : '/pitwall');
      }
    } catch (e2) {
      setErr(e2.status === 0 || e2.message.includes('fetch') ? 'Cannot reach the server. Is it running on port 4000?' : e2.message);
    } finally { setBusy(false); }
  };

  const RoleBtn = ({ id, ic, title, sub, color }) => (
    <button type="button" className={`role ${role === id ? 'on' : ''}`} onClick={() => setRole(id)} aria-pressed={role === id}>
      <span className="ic" style={{ background: color }}>{ic}</span>
      <span><b>{title}</b><small>{sub}</small></span>
      <span className="rd" />
    </button>
  );

  if (user) return <Navigate to={user.role === 'crew' ? '/' : '/pitwall'} replace />;
  return (
    <div className="login">
      <div className="login-hero">
        <div className="lines" />
        <Link to="/" className="logo" style={{ position: 'absolute', top: 28, left: 28 }}><Mark />Slipstream</Link>
        <div className="lights-row">{[1, 2, 3, 4, 5].map((k) => <i key={k} className={lights >= k ? 'on' : ''} />)}</div>
        <h1>Lights<br />out<span>.</span></h1>
        <p>Race engineering software for the pit wall: live timing, telemetry, team alerts and a strategist that never blinks, on real Formula 1 data or in the simulator.</p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 900, textTransform: 'uppercase' }}>Sign in to your pit wall</h2>
        <p className="mu" style={{ margin: '0 0 6px' }}>Demo accounts. The password for every seat is <b className="mono" style={{ color: '#fff' }}>slipstream</b>.</p>

        <div className="lbl" style={{ marginTop: 4 }}>Real Formula 1 timing</div>
        <RoleBtn id="crew" ic="CRW" title="Team pit crew" sub="Live sessions and mock sessions for your team's cars. Your mocks and call logs are private to your crew." color="#38d8ff" />
        {role === 'crew' && (
          <div className="team-grid" role="radiogroup" aria-label="Team" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
            {REAL_TEAMS.map((t) => (
              <button type="button" key={t.id} style={{ '--c': t.color }} className={crew === t.id ? 'on' : ''} onClick={() => setCrew(t.id)} title={t.name}>{t.short}</button>
            ))}
          </div>
        )}

        <div className="lbl" style={{ marginTop: 8 }}>Simulator</div>
        <RoleBtn id="engineer" ic="ENG" title="Simulator engineer" sub="A simulator team's two cars: full telemetry, alerts and strategy" color="#3d7dff" />
        {role === 'engineer' && (
          <div className="team-grid" role="radiogroup" aria-label="Simulator team">
            {TEAMS.map((t) => (
              <button type="button" key={t.id} style={{ '--c': t.color }} className={team === t.id ? 'on' : ''} onClick={() => setTeam(t.id)} title={t.name}>{t.short}</button>
            ))}
          </div>
        )}
        <RoleBtn id="race_control" ic="RC" title="Race control" sub="Runs the simulator: every car, flags, weather, incidents, sessions" color="#e10600" />
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn red" style={{ height: 46, marginTop: 6 }} disabled={busy}>{busy ? 'Signing in…' : 'Enter the pit wall →'}</button>
        <Link to="/" className="mu" style={{ fontSize: 13, textAlign: 'center' }}>← Back to the launcher. Without an account you can still run mock sessions, but anyone with the link can open them.</Link>
      </form>
    </div>
  );
}
