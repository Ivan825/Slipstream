/**
 * Live data layer.
 *
 * High-frequency data (10 Hz positions, 20 Hz car telemetry) never touches React
 * state: socket handlers write into mutable structures below and canvases read
 * them inside a requestAnimationFrame loop. Low-frequency data (session, timing,
 * alerts, strategy) goes into Zustand stores.
 *
 * Rooms are reference-counted: several components can ask for `car:KAL` and the
 * socket only subscribes once, and re-subscribes automatically after a reconnect.
 */
import { io } from 'socket.io-client';
import { useEffect } from 'react';
import { NS, EV, decodeRaceRow, CARS, getTrack, formatLapTime, CAR_BY_ID } from '@slipstream/shared';
import { API_URL, api } from './api.js';
import { useSession, useTiming, useAlerts, useStrategy, useMetrics, useLaps, useToasts, useUI } from '../store/stores.js';
import { beep, speak } from './sound.js';
import { useReplay, onReplayFrame } from '../store/replay.js';

const TRACK = getTrack();
const L = TRACK.L;

/* ------------------------------------------------------------------ */
/* positions: 10 Hz frames, interpolated by the renderer                */
/* ------------------------------------------------------------------ */
export const race = {
  cars: new Map(), // carId -> { lap, d, v, status, prevTotal, total, t, prevT }
  lastFrameAt: 0,
  frameEvery: 100,
  rx: 0
};

function onRace(frame) {
  const now = performance.now();
  if (race.lastFrameAt) race.frameEvery = race.frameEvery * 0.8 + (now - race.lastFrameAt) * 0.2;
  race.lastFrameAt = now;
  race.rx++;
  for (const row of frame.f) {
    const r = decodeRaceRow(row);
    const id = CARS[r.index]?.id;
    if (!id) continue;
    const total = r.lap * L + r.d;
    const c = race.cars.get(id);
    if (!c) { race.cars.set(id, { ...r, total, prevTotal: total, t: now, prevT: now - 100 }); continue; }
    // keep a smooth start point: where the car is drawn *now*
    const drawn = interp(c, now);
    c.prevTotal = Math.abs(total - drawn) > 400 ? total : drawn;
    c.prevT = now;
    c.total = total;
    c.t = now + race.frameEvery;
    c.lap = r.lap; c.d = r.d; c.v = r.v; c.status = r.status;
  }
}

function interp(c, now) {
  const span = c.t - c.prevT;
  const a = span > 0 ? Math.min(1.25, Math.max(0, (now - c.prevT) / span)) : 1;
  return c.prevTotal + (c.total - c.prevTotal) * a;
}

/** interpolated distance (metres, total over laps) for drawing at 60 fps */
export function drawTotal(id, now = performance.now()) {
  const c = race.cars.get(id);
  return c ? interp(c, now) : null;
}

/* ------------------------------------------------------------------ */
/* car telemetry: ring buffers merged by seq                            */
/* ------------------------------------------------------------------ */
const CAP = 2400; // ~2 minutes at 20 Hz
export const carBuf = new Map(); // carId -> { frames: [], seqs: Set, last, cursor, stats }

export function buffer(carId) {
  let b = carBuf.get(carId);
  if (!b) {
    b = { frames: [], seqs: new Set(), last: 0, cursor: null, version: 0, stats: { live: 0, history: 0, dupes: 0, gaps: 0, backfilled: 0, seam: null } };
    carBuf.set(carId, b);
  }
  return b;
}

function insertSorted(b, f) {
  if (b.seqs.has(f.seq)) { b.stats.dupes++; return false; }
  b.seqs.add(f.seq);
  const arr = b.frames;
  if (!arr.length || arr[arr.length - 1].seq < f.seq) arr.push(f);
  else {
    let i = arr.length - 1;
    while (i > 0 && arr[i - 1].seq > f.seq) i--;
    arr.splice(i, 0, f);
  }
  if (arr.length > CAP) {
    const drop = arr.splice(0, arr.length - CAP);
    for (const d of drop) b.seqs.delete(d.seq);
  }
  return true;
}

function onCar(msg) {
  const b = buffer(msg.c);
  for (const f of msg.f) {
    if (b.last && f.seq > b.last + 1 && b.cursor != null) {
      // a gap in the live stream (e.g. we were back-pressured): backfill it from the API
      backfill(msg.c, b.last + 1, f.seq - 1);
      b.stats.gaps++;
    }
    if (insertSorted(b, f)) b.stats.live++;
    if (f.seq > b.last) b.last = f.seq;
  }
  b.version++;
}

async function backfill(carId, fromSeq, toSeq) {
  try {
    const h = await api(`/telemetry/${carId}?fromSeq=${fromSeq}&toSeq=${toSeq}&limit=2000`);
    const b = buffer(carId);
    for (const f of h.frames) if (insertSorted(b, f)) b.stats.backfilled++;
    b.version++;
  } catch { /* best effort */ }
}

/**
 * History + live without duplicates:
 *  1. subscribe to car:<id> (live frames start buffering immediately)
 *  2. the ack returns cursor = last seq already broadcast to that room
 *  3. fetch history up to the cursor, merge by seq
 */
async function loadHistory(carId, cursor) {
  const b = buffer(carId);
  b.cursor = cursor;
  try {
    const h = await api(`/telemetry/${carId}?toSeq=${cursor}&sinceMs=60000&limit=1200`);
    let added = 0;
    for (const f of h.frames) if (insertSorted(b, f)) added++;
    b.stats.history += added;
    b.stats.seam = { cursor, fromDb: h.fromDb, fromCache: h.fromCache, ms: h.ms };
    b.version++;
  } catch (e) {
    b.stats.seam = { cursor, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* socket + rooms                                                       */
/* ------------------------------------------------------------------ */
let socket = null;
const roomRefs = new Map();

function emitSubscribe(rooms) {
  if (!socket?.connected || !rooms.length) return;
  socket.emit(EV.SUBSCRIBE, { rooms }, (ack) => {
    if (!ack) return;
    if (ack.timing) useTiming.getState().apply(ack.timing);
    if (ack.alerts) for (const a of ack.alerts.reverse()) useAlerts.getState().add({ ...a, _id: String(a._id) });
    if (ack.strategy) for (const s of Object.values(ack.strategy)) useStrategy.getState().put(s);
    if (ack.session) useSession.getState().set({ session: ack.session });
    for (const [carId, cursor] of Object.entries(ack.cursors || {})) loadHistory(carId, cursor);
    if (ack.replay) useReplay.getState().snapshot(ack.replay);
  });
}

export function connectLive(token) {
  if (socket) socket.close();
  race.cars.clear();
  useTiming.getState().reset();
  useAlerts.getState().clear();
  useStrategy.getState().clear();
  socket = io(API_URL + NS.LIVE, { auth: { token }, transports: ['websocket'], reconnectionDelayMax: 4000 });
  socket.on('connect', () => {
    useSession.getState().set({ connected: true });
    emitSubscribe([...roomRefs.keys()]);
  });
  socket.on('disconnect', () => useSession.getState().set({ connected: false }));
  socket.on(EV.SESSION, onSession);
  socket.on(EV.RACE, onRace);
  socket.on(EV.CAR, onCar);
  socket.on(EV.TIMING, (m) => useTiming.getState().apply(m));
  socket.on(EV.ALERT, (a) => {
    useAlerts.getState().add(a);
    if (a.severity === 'crit') {
      useToasts.getState().push({ kind: 'red', title: `${a.severity === 'crit' ? 'BOX BOX · ' : ''}${a.carId}`, text: a.message, ms: 7000 });
      if (useUI.getState().sound) { beep('alert'); speak(`${a.carId}, ${a.title}.`); }
    } else if (a.severity === 'warn' && useUI.getState().sound) beep('info');
  });
  socket.on(EV.ALERT_ACKED, (e) => useAlerts.getState().acked(e));
  socket.on(EV.STRATEGY, (s) => useStrategy.getState().put(s));
  socket.on(EV.METRICS, (m) => useMetrics.getState().set(m));
  socket.on(EV.LAP, (l) => {
    useLaps.getState().add(l);
    if (l.fastest) useToasts.getState().push({ kind: 'pur', title: `Fastest lap · ${l.carId}`, text: formatLapTime(l.timeMs / 1000), ms: 4500 });
  });
  socket.on('pitstop', (p) => {
    if (p.lap) useToasts.getState().push({ kind: 'yel', title: `Pit stop · ${p.carId}`, text: `${p.from} → ${p.to} · stationary ${(p.stationaryMs / 1000).toFixed(1)} s · lane ${(p.laneMs / 1000).toFixed(1)} s`, ms: 4000 });
  });
  socket.on(EV.COMMAND, (c) => {
    if (c.type === 'pit' || c.type === 'pit-scheduled') {
      const what = c.type === 'pit' ? `Box this lap → ${c.payload?.compound}` : `Pit call for lap ${c.payload?.lap} → ${c.payload?.compound}`;
      useToasts.getState().push({ kind: 'cyan', title: `Team radio · ${c.carId}`, text: `${what} (${c.by})` });
    }
  });
  // real-session replay
  socket.on('replay:frame', onReplayFrame);
  socket.on('replay:timing', (m) => useReplay.getState().timing(m));
  socket.on('replay:events', (evs) => useReplay.getState().events(evs));
  socket.on('replay:state', (st) => useReplay.getState().setState(st));

  // round-trip latency probe
  clearInterval(connectLive.ping);
  connectLive.ping = setInterval(() => {
    if (!socket?.connected) return;
    const t = performance.now();
    socket.emit('ping:latency', Date.now(), () => useSession.getState().set({ latencyMs: Math.round(performance.now() - t) }));
  }, 3000);
  return socket;
}

let lastSessionId = null;
function onSession(s) {
  const prev = useSession.getState().session;
  useSession.getState().set({ session: s, skew: s.serverTime ? s.serverTime - Date.now() : 0 });
  if (s.sessionId !== lastSessionId) {
    if (lastSessionId) {
      useLaps.getState().clear();
      useStrategy.getState().clear();
      carBuf.clear();
      race.cars.clear();
    }
    lastSessionId = s.sessionId;
  }
  if (s.event && s.event !== prev?.event) window.dispatchEvent(new CustomEvent('slipstream:session', { detail: s }));
}

export function subscribe(rooms) {
  const fresh = [];
  for (const r of rooms) {
    const n = roomRefs.get(r) || 0;
    roomRefs.set(r, n + 1);
    if (!n) fresh.push(r);
  }
  emitSubscribe(fresh);
}

export function unsubscribe(rooms) {
  const gone = [];
  for (const r of rooms) {
    const n = (roomRefs.get(r) || 1) - 1;
    if (n <= 0) { roomRefs.delete(r); gone.push(r); } else roomRefs.set(r, n);
  }
  if (gone.length && socket?.connected) socket.emit(EV.UNSUBSCRIBE, { rooms: gone });
  for (const r of gone) if (r.startsWith('car:')) carBuf.delete(r.slice(4));
}

/** React hook: hold these rooms while mounted */
export function useRooms(rooms) {
  const key = rooms.filter(Boolean).join('|');
  useEffect(() => {
    const list = key ? key.split('|') : [];
    subscribe(list);
    return () => unsubscribe(list);
  }, [key]);
}

export function ackAlert(id) {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false });
    socket.emit(EV.ALERT_ACK, { id }, resolve);
  });
}

export { TRACK, CAR_BY_ID };
