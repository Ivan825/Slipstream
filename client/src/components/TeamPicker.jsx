import { useUI } from '../store/stores.js';
import { teamsOf, sameTeam, CURRENT_TEAMS } from '../lib/teams.js';
import { useMock } from '../lib/crew.js';
import { useAuth, isCrew } from '../store/auth.js';

/** "Your team": the crew's cars get the strategist, alerts and highlights in real sessions */
export function TeamPicker({ meta, style }) {
  const team = useUI((s) => s.realTeam);
  const setTeam = useUI((s) => s.setRealTeam);
  const setMockTeam = useMock((s) => s.setTeam);
  const list = meta ? teamsOf(meta) : CURRENT_TEAMS;
  const cur = list.find((t) => sameTeam(t.name, team));
  const color = cur?.color;
  const user = useAuth((s) => s.user);
  if (isCrew(user)) {
    // a crew account always works its own team's cars
    const c = CURRENT_TEAMS.find((t) => sameTeam(t.name, user.team));
    return (
      <span className="row team-pick" style={{ gap: 8, ...style }} title="Set by your crew account">
        <span className="lbl" style={{ margin: 0 }}>Your team</span>
        <span className="chip" style={{ borderLeft: `4px solid ${c?.color || 'var(--ln)'}`, fontWeight: 900, color: '#fff', padding: '5px 10px' }}>{user.team} crew</span>
      </span>
    );
  }
  const pick = (name) => {
    setTeam(name || null);
    if (meta?.mock) setMockTeam(name || null);
  };
  return (
    <label className="row team-pick" style={{ gap: 8, ...style }}>
      <span className="lbl" style={{ margin: 0 }}>Your team</span>
      <select className="input" aria-label="Your team" style={{ height: 32, borderLeft: `4px solid ${color || 'var(--ln)'}`, minWidth: 170 }} value={cur?.name || ''} onChange={(e) => pick(e.target.value)}>
        <option value="">{team && !cur ? `${team} (not in this session)` : 'Pick a team…'}</option>
        {list.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      </select>
    </label>
  );
}
