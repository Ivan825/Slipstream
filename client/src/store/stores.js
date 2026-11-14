import { create } from 'zustand';
import { CARS, CAR_BY_ID, TEAM_BY_ID } from '@slipstream/shared';

/* ---------- session (low frequency) ---------- */
export const useSession = create((set) => ({
  session: null,
  connected: false,
  latencyMs: null,
  set: (p) => set(p)
}));

/* ---------- timing tower (2 Hz, delta-applied) ---------- */
export const useTiming = create((set, get) => ({
  rows: {},       // carId -> row
  order: [],      // carIds by position
  fastest: null,
  prevPos: {},    // carId -> previous position (for arrows)
  changedAt: {},  // carId -> ms when the position changed
  apply(msg) {
    const rows = msg.full ? {} : { ...get().rows };
    for (const r of msg.rows || []) rows[r.c] = { ...(msg.full ? {} : rows[r.c]), ...r };
    const order = Object.values(rows).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99)).map((r) => r.c);
    const prev = get().rows, prevPos = { ...get().prevPos }, changedAt = { ...get().changedAt };
    const now = Date.now();
    for (const id of order) {
      const was = prev[id]?.pos, is = rows[id].pos;
      if (was != null && is != null && was !== is) { prevPos[id] = was; changedAt[id] = now; }
    }
    set({ rows, order, fastest: msg.fastest ?? get().fastest, prevPos, changedAt });
  },
  reset: () => set({ rows: {}, order: [], fastest: null, prevPos: {}, changedAt: {} })
}));

/* ---------- alerts ---------- */
export const useAlerts = create((set, get) => ({
  list: [],
  add(a) {
    if (get().list.some((x) => x._id === a._id)) return;
    set({ list: [a, ...get().list].slice(0, 80) });
  },
  setAll(list) { set({ list: list.map((a) => ({ ...a, _id: String(a._id) })) }); },
  acked(ev) { set({ list: get().list.map((a) => (a._id === ev.id ? { ...a, acknowledged: true, ackBy: ev.ackBy } : a)) }); },
  clear: () => set({ list: [] })
}));

/* ---------- strategy (per car) ---------- */
export const useStrategy = create((set, get) => ({
  byCar: {},
  put(s) { set({ byCar: { ...get().byCar, [s.carId]: s } }); },
  clear: () => set({ byCar: {} })
}));

/* ---------- metrics ---------- */
export const useMetrics = create((set) => ({ snap: null, set: (snap) => set({ snap }) }));

/* ---------- laps feed (for practice run monitor, quali improvements) ---------- */
export const useLaps = create((set, get) => ({
  byCar: {},
  add(l) {
    const cur = get().byCar[l.carId] || [];
    if (cur.some((x) => x.lap === l.lap)) return;
    set({ byCar: { ...get().byCar, [l.carId]: [...cur, l].slice(-60) } });
  },
  setAll(laps) {
    const byCar = {};
    for (const l of laps) (byCar[l.carId] ||= []).push(l);
    set({ byCar });
  },
  clear: () => set({ byCar: {} })
}));

/* ---------- ui ---------- */
const UI_KEY = 'slipstream.ui';
const uiLoad = () => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } };
const uiSave = (v) => { try { localStorage.setItem(UI_KEY, JSON.stringify(v)); } catch { /* ignore */ } };
const ui0 = uiLoad();
export const useUI = create((set, get) => ({
  // which data the whole app shows: the simulated weekend or a real session (OpenF1)
  source: ui0.source || { kind: 'sim' },
  setSource(source) { set({ source }); uiSave({ ...uiLoad(), source }); },
  realDriver: ui0.realDriver || null,
  // the crew's team in real sessions (OpenF1 team name); its cars get the strategist, alerts and highlights
  realTeam: ui0.realTeam || null,
  setRealTeam(t) { set({ realTeam: t }); uiSave({ ...uiLoad(), realTeam: t }); },
  setRealDriver(n) { set({ realDriver: n }); uiSave({ ...uiLoad(), realDriver: n }); },
  selected: ui0.selected || null,
  sound: !!ui0.sound,
  // which team radio plays by itself with sound on: our cars ('ours'), every car ('all') or none
  radioAuto: ui0.radioAuto || 'ours',
  setRadioAuto(v) { set({ radioAuto: v }); uiSave({ ...uiLoad(), radioAuto: v }); },
  // real pit wall map: track details, speed heat or sectors
  realMap: ui0.realMap || 'track',
  setRealMap(v) { set({ realMap: v }); uiSave({ ...uiLoad(), realMap: v }); },
  deckTab: ui0.deckTab || 'forecast',
  setDeckTab(v) { set({ deckTab: v }); uiSave({ ...uiLoad(), deckTab: v }); },
  mapMode: ui0.mapMode || 'speed',
  palette: false,
  select(id) { set({ selected: id }); uiSave({ ...uiLoad(), selected: id }); },
  toggleSound() { const v = !get().sound; set({ sound: v }); uiSave({ ...uiLoad(), sound: v }); },
  setMapMode(m) { set({ mapMode: m }); uiSave({ ...uiLoad(), mapMode: m }); },
  setPalette(v) { set({ palette: v }); }
}));

/* ---------- toasts ---------- */
let tid = 0;
export const useToasts = create((set, get) => ({
  list: [],
  push(t) {
    const id = ++tid;
    set({ list: [...get().list, { id, ...t }].slice(-4) });
    setTimeout(() => set({ list: get().list.filter((x) => x.id !== id) }), t.ms || 5000);
  }
}));

export const carMeta = (id) => CAR_BY_ID[id];
export const teamOf = (id) => TEAM_BY_ID[CAR_BY_ID[id]?.team];
export const colorOf = (id) => TEAM_BY_ID[CAR_BY_ID[id]?.team]?.color || '#888';
export { CARS };
