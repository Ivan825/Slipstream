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
  spectator: !!initial.spectator,
  login(token, user) { save({ token, user }); set({ token, user, spectator: false }); },
  watchAsSpectator() { save({ spectator: true }); set({ token: null, user: null, spectator: true }); },
  logout() { save(null); set({ token: null, user: null, spectator: false }); }
}));

export const roleOf = (s) => s.user?.role || (s.spectator ? 'viewer' : null);
