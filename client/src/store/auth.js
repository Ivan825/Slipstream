import { create } from 'zustand';

const KEY = 'slipstream.auth';
const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
};
const save = (v) => {
  try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ }
};

const initial = load();

export const useAuth = create((set) => ({
  token: initial.token || null,
  user: initial.user || null,
  login(token, user) { save({ token, user }); set({ token, user }); },
  logout() { save(null); set({ token: null, user: null }); }
}));

// No sign-in needed for real sessions: anyone without a token is a guest (role viewer).
export const roleOf = (s) => s.user?.role || 'viewer';
/** a real team's pit crew: works on real timing, its mocks are private to the team */
export const isCrew = (user) => user?.role === 'crew' && !!user.team;
/** what the simulator lets this user do: engineers and race control get their seats, everyone else views */
export const simRole = (user) => (user?.role === 'engineer' || user?.role === 'race_control' ? user.role : 'viewer');
