import { create } from 'zustand';

/** Real-session replay state. Positions are mutable (read by the canvas), the rest is React state. */
export const replayCars = new Map(); // n -> { x, y, px, py, t, pt, v, g, thr, brk, drs, rpm }
export const replayTrace = new Map(); // n -> [{t, v, thr, brk, g}] rolling ~60 s
export const replayClock = { t: 0, at: 0, speed: 1, playing: true };

export function onReplayFrame(f) {
  const now = performance.now();
  replayClock.t = f.t; replayClock.at = now;
  for (const [n, x, y, v, g, thr, brk, drs, rpm] of f.cars) {
    const c = replayCars.get(n);
    if (c) { c.px = c.dx ?? x; c.py = c.dy ?? y; c.pt = now; Object.assign(c, { x, y, t: now + 200, v, g, thr, brk, drs, rpm }); }
    else replayCars.set(n, { x, y, px: x, py: y, t: now, pt: now - 200, v, g, thr, brk, drs, rpm });
    let tr = replayTrace.get(n);
    if (!tr) { tr = []; replayTrace.set(n, tr); }
    if (!tr.length || f.t > tr[tr.length - 1].t) tr.push({ t: f.t, v, thr, brk, g });
    else if (f.t < tr[tr.length - 1].t) tr.length = 0; // seek or loop
    while (tr.length && f.t - tr[0].t > 60_000) tr.shift();
  }
}

/** interpolated position for drawing at 60 fps */
export function replayPos(n, now = performance.now()) {
  const c = replayCars.get(n);
  if (!c) return null;
  const span = c.t - c.pt;
  const a = span > 0 ? Math.min(1.2, Math.max(0, (now - c.pt) / span)) : 1;
  c.dx = c.px + (c.x - c.px) * a; c.dy = c.py + (c.y - c.py) * a;
  return { x: c.dx, y: c.dy };
}

export const useReplay = create((set, get) => ({
  meta: null,
  state: { loaded: false },
  rows: [],
  rc: [],
  feed: [],
  selected: null,
  snapshot(s) {
    if (!s?.meta) return set({ state: s?.state || { loaded: false } });
    replayCars.clear(); replayTrace.clear();
    if (s.frame) onReplayFrame(s.frame);
    set({ meta: s.meta, state: s.state, rows: s.rows || [], rc: (s.rc || []).slice().reverse(), feed: [], selected: get().selected || s.rows?.[0]?.n || null });
  },
  setState(st) {
    if (get().state.t && st.t < get().state.t - 1000) { replayTrace.clear(); set({ feed: [] }); }
    set({ state: { ...get().state, ...st } });
  },
  timing(m) { set({ rows: m.rows, state: { ...get().state, t: m.t, flag: m.flag, bestLap: m.bestLap, weather: m.weather ?? get().state.weather, playing: m.playing, speed: m.speed } }); },
  events(evs) {
    const rc = evs.filter((e) => e.type === 'rc');
    const feed = evs.filter((e) => e.type === 'pit' || (e.type === 'lap' && e.fastest));
    const st = { ...get().state };
    for (const e of evs) if (e.type === 'weather') st.weather = { air: e.air, track: e.track, rain: e.rain, humidity: e.humidity, wind: e.wind };
    set({ rc: [...rc.reverse(), ...get().rc].slice(0, 40), feed: [...feed.reverse(), ...get().feed].slice(0, 30), state: st });
  },
  select(n) { set({ selected: n }); }
}));
