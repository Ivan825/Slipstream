/** Fictional teams and drivers. `pace` is a per-driver lap-time offset in seconds (negative = faster). */
export const TEAMS = [
  { id: 'vortex', name: 'Vortex Racing', short: 'VOR', color: '#00d7b6' },
  { id: 'ardent', name: 'Ardent Motorsport', short: 'ARD', color: '#e8102e' },
  { id: 'kestrel', name: 'Kestrel GP', short: 'KES', color: '#3d7dff' },
  { id: 'halcyon', name: 'Halcyon', short: 'HAL', color: '#ff8a1c' },
  { id: 'solaris', name: 'Solaris', short: 'SOL', color: '#ffd400' },
  { id: 'monarch', name: 'Monarch', short: 'MON', color: '#9b5cff' },
  { id: 'nordwind', name: 'Nordwind', short: 'NOR', color: '#c9ced6' },
  { id: 'verdant', name: 'Verdant', short: 'VER', color: '#2bd94e' },
  { id: 'azzurra', name: 'Azzurra', short: 'AZZ', color: '#5ad1ff' },
  { id: 'basalt', name: 'Basalt', short: 'BAS', color: '#ff4fa3' }
];

export const CARS = [
  { id: 'VOS', number: 4, first: 'Jonas', last: 'Vossberg', team: 'vortex', pace: -0.55, nat: 'GER' },
  { id: 'OKA', number: 8, first: 'Ren', last: 'Okada', team: 'vortex', pace: -0.25, nat: 'JPN' },
  { id: 'ADE', number: 11, first: 'Tobi', last: 'Adeyemi', team: 'ardent', pace: -0.45, nat: 'NGA' },
  { id: 'RUI', number: 31, first: 'Marco', last: 'Ruiz', team: 'ardent', pace: -0.15, nat: 'ESP' },
  { id: 'KAL', number: 17, first: 'Elias', last: 'Kallio', team: 'kestrel', pace: -0.4, nat: 'FIN' },
  { id: 'LIN', number: 63, first: 'Sofia', last: 'Lindgren', team: 'kestrel', pace: -0.1, nat: 'SWE' },
  { id: 'MER', number: 22, first: 'Luca', last: 'Meraldi', team: 'halcyon', pace: -0.3, nat: 'ITA' },
  { id: 'PAR', number: 2, first: 'Arjun', last: 'Parekh', team: 'halcyon', pace: 0.0, nat: 'IND' },
  { id: 'BRE', number: 9, first: 'Noah', last: 'Brenner', team: 'solaris', pace: 0.1, nat: 'SUI' },
  { id: 'QUI', number: 30, first: 'Ana', last: 'Quintero', team: 'solaris', pace: 0.25, nat: 'COL' },
  { id: 'SAN', number: 5, first: 'Diego', last: 'Santoro', team: 'monarch', pace: -0.05, nat: 'ARG' },
  { id: 'ITO', number: 12, first: 'Haru', last: 'Ito', team: 'monarch', pace: 0.2, nat: 'JPN' },
  { id: 'HAK', number: 27, first: 'Mikael', last: 'Hakala', team: 'nordwind', pace: 0.3, nat: 'FIN' },
  { id: 'FEL', number: 19, first: 'Clara', last: 'Fellner', team: 'nordwind', pace: 0.45, nat: 'AUT' },
  { id: 'DUM', number: 14, first: 'Pierre', last: 'Dumont', team: 'verdant', pace: 0.35, nat: 'FRA' },
  { id: 'OSE', number: 7, first: 'Kofi', last: 'Osei', team: 'verdant', pace: 0.5, nat: 'GHA' },
  { id: 'TES', number: 77, first: 'Gianni', last: 'Testa', team: 'azzurra', pace: 0.55, nat: 'ITA' },
  { id: 'ROS', number: 21, first: 'Bea', last: 'Rossetti', team: 'azzurra', pace: 0.7, nat: 'ITA' },
  { id: 'NAK', number: 3, first: 'Yuki', last: 'Nakamura', team: 'basalt', pace: 0.65, nat: 'JPN' },
  { id: 'WEL', number: 6, first: 'Sam', last: 'Wells', team: 'basalt', pace: 0.85, nat: 'GBR' }
];

export const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
export const CAR_BY_ID = Object.fromEntries(CARS.map((c) => [c.id, c]));
export const CAR_INDEX = Object.fromEntries(CARS.map((c, i) => [c.id, i]));
export const carsOfTeam = (teamId) => CARS.filter((c) => c.team === teamId);
export const teamColor = (carId) => TEAM_BY_ID[CAR_BY_ID[carId]?.team]?.color ?? '#888888';
