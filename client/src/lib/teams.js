import { REAL_TEAMS, sameTeam } from '@slipstream/shared';

export { sameTeam };


/** the session's teams, each with its drivers and colour, in a stable order */
export function teamsOf(meta) {
  const m = new Map();
  for (const d of meta?.drivers || []) {
    if (!d.team) continue;
    const t = m.get(d.team) || { name: d.team, color: d.color, drivers: [] };
    t.drivers.push(d);
    m.set(d.team, t);
  }
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** the crew's cars in this session */
export function teamDrivers(meta, team) {
  if (!team) return [];
  return (meta?.drivers || []).filter((d) => sameTeam(d.team, team));
}

/** this season's teams, for picking before a session is open */
export const CURRENT_TEAMS = REAL_TEAMS;
