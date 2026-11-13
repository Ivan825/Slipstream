import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { TEAMS } from '@slipstream/shared';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';
import { Mark } from '../components/Nav.jsx';

export default function Login() {
  const login = useAuth((s) => s.login);
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const [role, setRole] = useState('engineer');
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
      const username = role === 'race_control' ? 'control' : team;
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      login(res.token, res.user);
      nav(role === 'race_control' ? '/control' : '/pitwall');
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

  if (user) return <Navigate to="/pitwall" replace />;
  return (
    <div className="login">
      <div className="login-hero">
        <div className="lines" />
        <Link to="/" className="logo" style={{ position: 'absolute', top: 28, left: 28 }}><Mark />Slipstream</Link>
        <div className="lights-row">{[1, 2, 3, 4, 5].map((k) => <i key={k} className={lights >= k ? 'on' : ''} />)}</div>
        <h1>Lights<br />out<span>.</span></h1>
        <p>Every car, every sensor, twenty times a second. Live timing, telemetry, alerts and a strategist that never blinks.</p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 900, textTransform: 'uppercase' }}>Take a seat on the pit wall</h2>
        <p className="mu" style={{ margin: '0 0 6px' }}>Signing in is for the simulated weekend's team engineers and race control. Demo accounts. The password for every seat is <b className="mono" style={{ color: '#fff' }}>slipstream</b>.</p>
        <RoleBtn id="engineer" ic="ENG" title="Team engineer" sub="Your team's two cars: full telemetry, alerts and strategy" color="#3d7dff" />
        {role === 'engineer' && (
          <div className="team-grid" role="radiogroup" aria-label="Team">
            {TEAMS.map((t) => (
              <button type="button" key={t.id} style={{ '--c': t.color }} className={team === t.id ? 'on' : ''} onClick={() => setTeam(t.id)}>{t.short}</button>
            ))}
          </div>
        )}
        <RoleBtn id="race_control" ic="RC" title="Race control" sub="Every car, flags, weather, incidents, session control" color="#e10600" />
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn red" style={{ height: 46, marginTop: 6 }} disabled={busy}>{busy ? 'Signing in…' : 'Enter the pit wall →'}</button>
        <Link to="/" className="mu" style={{ fontSize: 13, textAlign: 'center' }}>No sign-in needed to watch. ← Back to choosing a session</Link>
      </form>
    </div>
  );
}
