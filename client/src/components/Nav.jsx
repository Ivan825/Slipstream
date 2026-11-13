import { NavLink } from 'react-router-dom';
import { useAuth } from '../store/auth.js';
import { useSession, useUI, teamOf } from '../store/stores.js';
import { TEAM_BY_ID } from '@slipstream/shared';

export function Mark({ size = 30 }) {
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 30 18" aria-hidden="true">
      <path d="M8 0h22l-4 5H4z" fill="#fff" />
      <path d="M5 7h17l-4 5H1z" fill="#fff" opacity=".8" />
      <path d="M2 14h11l-3 4H-1z" fill="#fff" opacity=".6" />
    </svg>
  );
}

export default function Nav() {
  const { user, logout } = useAuth();
  const connected = useSession((s) => s.connected);
  const latency = useSession((s) => s.latencyMs);
  const { sound, toggleSound, setPalette } = useUI();
  const role = user?.role || 'viewer';
  const who = role === 'race_control' ? 'RACE CONTROL' : role === 'engineer' ? `ENGINEER · ${TEAM_BY_ID[user.team]?.name.toUpperCase()}` : 'SPECTATOR';
  const initials = (user?.username || 'SP').slice(0, 2).toUpperCase();

  return (
    <header className="nav">
      <NavLink to="/" className="logo"><Mark />Slipstream</NavLink>
      <nav className="nav-links">
        <NavLink to="/" end>Pit Wall</NavLink>
        {role !== 'viewer' && <NavLink to={`/car/${defaultCar(user)}`}>Telemetry</NavLink>}
        {role !== 'viewer' && <NavLink to="/strategy">Strategy</NavLink>}
        <NavLink to="/analysis">Analysis</NavLink>
        {role === 'race_control' && <NavLink to="/control">Race Control</NavLink>}
        <NavLink to="/systems">Systems</NavLink>
      </nav>
      <div className="nav-r">
        <button className="icon-btn" onClick={() => setPalette(true)} title="Command palette">Search <kbd>⌘K</kbd></button>
        <button className="icon-btn" onClick={toggleSound} aria-pressed={sound} title="Team-radio sounds">{sound ? 'Sound on' : 'Sound off'}</button>
        <span className={`live-pill ${connected ? '' : 'off'}`} title={latency != null ? `round trip ${latency} ms` : ''}><i />{connected ? 'LIVE' : 'OFFLINE'}</span>
        <span className="hide-sm">{who}</span>
        <button className="avatar" onClick={logout} title="Sign out">{initials}</button>
      </div>
    </header>
  );
}

export function defaultCar(user) {
  if (user?.role === 'engineer') {
    const ui = useUI.getState().selected;
    if (ui && teamOf(ui)?.id === user.team) return ui;
    return { kestrel: 'KAL', vortex: 'VOS', ardent: 'ADE', halcyon: 'MER', solaris: 'BRE', monarch: 'SAN', nordwind: 'HAK', verdant: 'DUM', azzurra: 'TES', basalt: 'NAK' }[user.team] || 'KAL';
  }
  return useUI.getState().selected || 'VOS';
}
