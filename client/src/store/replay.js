import { create } from 'zustand';
import { tyreStep, tyres } from '../lib/tyreModel.js';

/** Real-session replay state. Positions are mutable (read by the canvas), the rest is React state. */
export const replayCars = new Map(); // n -> { x, y, px, py, t, pt, v, g, thr, brk, drs, rpm }
export const replayTrace = new Map(); // n -> [{t, v, thr, brk, g, rpm, drs}] rolling ~120 s
export const replayClock = { t: 0, at: 0, speed: 1, playing: true };
const eventListeners = new Set();
/** be told of every batch of timing events the channel sends (a takeover's analysis is built from them) */
export function onReplayEvents(f) { eventListeners.add(f); return () => eventListeners.delete(f); }

/*
 * Smooth playback. Frames arrive at ~5 Hz with network and server jitter, so
 * cars are not drawn at the latest frame. Each car keeps a short buffer of
 * timestamped samples, a local estimate of the session clock follows the
 * server's, and the map draws RENDER_DELAY_MS behind it, interpolating between
 * the two samples either side. A late packet then changes nothing on screen.
 */
const RENDER_DELAY_MS = 1000;
const clk = { t: 0, at: 0, rate: 1 };
const estimate = (now) => clk.t + (now - clk.at) * clk.rate;

export function onReplayFrame(f) {
  if (f.k != null && useReplay.getState().key != null && String(f.k) !== String(useReplay.getState().key)) return;
  const now = performance.now();
  const st = useReplay.getState().state || {};
  const rate = st.playing === false || st.buffering ? 0 : (st.speed || 1);
  const err = f.t - estimate(now);
  // follow the server clock gently; snap on seeks, pauses and big stalls
  clk.t = !clk.at || rate === 0 || clk.rate === 0 || Math.abs(err) > 2500 * Math.max(1, rate) ? f.t : estimate(now) + err * 0.08;
  clk.at = now; clk.rate = rate;
  replayClock.t = f.t; replayClock.at = now;
  for (const [n, x, y, v, g, thr, brk, drs, rpm] of f.cars) {
    let c = replayCars.get(n);
    if (!c) { c = { buf: [] }; replayCars.set(n, c); }
    Object.assign(c, { x, y, v, g, thr, brk, drs, rpm });
    const last = c.buf[c.buf.length - 1];
    if (last && f.t < last.t - 1) c.buf.length = 0; // seek or loop
    if (!last || f.t > last.t) c.buf.push({ t: f.t, x, y });
    if (c.buf.length > 40) c.buf.splice(0, c.buf.length - 40);
    let tr = replayTrace.get(n);
    if (!tr) { tr = []; replayTrace.set(n, tr); }
    if (!tr.length || f.t > tr[tr.length - 1].t) tr.push({ t: f.t, v, thr, brk, g, rpm, drs });
    else if (f.t < tr[tr.length - 1].t) tr.length = 0;
    while (tr.length && f.t - tr[0].t > 120_000) tr.shift();
  }
  tyreStep(f.t, f.cars, useReplay.getState().state?.weather?.track);
}

/** interpolated position for drawing at 60 fps */
export function replayPos(n, now = performance.now()) {
  const c = replayCars.get(n);
  if (!c?.buf?.length) return null;
  const b = c.buf;
  const rt = estimate(now) - RENDER_DELAY_MS * Math.max(clk.rate, 0.25);
  let p;
  if (rt <= b[0].t) p = b[0];
  else if (rt >= b[b.length - 1].t) p = b[b.length - 1];
  else {
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > rt) i--;
    const a = b[i - 1], z = b[i];
    const k = (rt - a.t) / ((z.t - a.t) || 1);
    p = { x: a.x + (z.x - a.x) * k, y: a.y + (z.y - a.y) * k };
  }
  c.dx = p.x; c.dy = p.y;
  return { x: p.x, y: p.y };
}

export const useReplay = create((set, get) => ({
  key: null,
  meta: null,
  state: { loaded: false },
  rows: [],
  rc: [],
  feed: [],
  radio: [], // team radio clips heard so far, newest first: { t, n, url }
  selected: null,
  open(key) {
    replayCars.clear(); replayTrace.clear(); tyres.clear();
    set({ key: String(key), meta: null, state: { loaded: false }, rows: [], rc: [], feed: [], radio: [], selected: null });
  },
  snapshot(s) {
    if (!s?.meta) return set({ state: s?.state || { loaded: false } });
    const ch = String(s.meta.ch ?? s.meta.key); // channel id: session key, or m-… for a mock
    if (get().key != null && ch !== get().key && !(get().key === 'live' && s.meta.live)) return;
    replayCars.clear(); replayTrace.clear();
    useReplay.setState({ key: ch });
    if (s.frame) onReplayFrame({ ...s.frame, k: ch });
    const sel = get().selected;
    set({ key: ch, meta: s.meta, state: s.state, rows: s.rows || [], rc: s.rc || [], feed: [], radio: s.radio || [], selected: sel && s.meta.drivers.some((d) => d.n === sel) ? sel : s.rows?.[0]?.n || null });
  },
  mine(m) { return m?.k == null || String(m.k) === get().key; },
  setState(st) {
    if (!get().mine(st)) return;
    if (get().state.t && st.t < get().state.t - 1000) { replayTrace.clear(); set({ feed: [], radio: get().radio.filter((r) => r.t <= st.t) }); }
    set({ state: { ...get().state, ...st } });
  },
  timing(m) {
    if (!get().mine(m)) return;
    const { rows, k, ...st } = m;
    set({ rows, state: { ...get().state, ...st, weather: st.weather ?? get().state.weather } });
  },
  events(msg) {
    if (!get().mine(msg)) return;
    const evs = msg.events || [];
    for (const f of eventListeners) f(evs, get().key);
    const rc = evs.filter((e) => e.type === 'rc');
    const feed = evs.filter((e) => e.type === 'pit' || (e.type === 'lap' && e.fastest));
    const radio = evs.filter((e) => e.type === 'radio').map((e) => ({ t: e.t, n: e.n, url: e.url, fresh: true }));
    const st = { ...get().state };
    for (const e of evs) if (e.type === 'weather') st.weather = { air: e.air, track: e.track, rain: e.rain, humidity: e.humidity, wind: e.wind };
    set({ rc: [...rc.reverse(), ...get().rc].slice(0, 40), feed: [...feed.reverse(), ...get().feed].slice(0, 30), state: st, ...(radio.length ? { radio: [...radio.reverse(), ...get().radio].slice(0, 60) } : {}) });
  },
  select(n) { set({ selected: n }); }
}));
