/**
 * Real teams in OpenF1 data. Team names change over the years (sponsors, rebrands),
 * so a crew's team is matched to a session by family, not exact string.
 */
const FAMILIES = [
  ['mclaren'],
  ['ferrari'],
  ['red bull racing', 'red bull'],
  ['mercedes'],
  ['aston martin'],
  ['alpine'],
  ['williams'],
  ['racing bulls', 'rb', 'visa cash app rb', 'alphatauri', 'scuderia alphatauri'],
  ['audi', 'kick sauber', 'sauber', 'stake f1 team kick sauber', 'alfa romeo'],
  ['haas f1 team', 'haas'],
  ['cadillac']
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const family = (name) => {
  const n = norm(name);
  return FAMILIES.findIndex((f) => f.some((a) => n === a || n.startsWith(a + ' ') || n.includes(a) && a.length > 3));
};

/** does a session's team name belong to the crew's team? */
export function sameTeam(a, b) {
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  const fa = family(a);
  return fa >= 0 && fa === family(b);
}

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
export const CURRENT_TEAMS = [
  { name: 'McLaren', color: '#FF8000' }, { name: 'Ferrari', color: '#E8002D' }, { name: 'Red Bull Racing', color: '#3671C6' },
  { name: 'Mercedes', color: '#27F4D2' }, { name: 'Aston Martin', color: '#229971' }, { name: 'Alpine', color: '#0093CC' },
  { name: 'Williams', color: '#64C4FF' }, { name: 'Racing Bulls', color: '#6692FF' }, { name: 'Audi', color: '#BB0A30' },
  { name: 'Haas F1 Team', color: '#B6BABD' }, { name: 'Cadillac', color: '#AAAAAD' }
];
