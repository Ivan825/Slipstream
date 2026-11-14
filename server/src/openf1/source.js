import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { openf1 } from './client.js';
import { ReplaySession, ReplayChunk, ReplayEvent } from '../models/index.js';
import { log } from '../lib/log.js';

export const CHUNK_MS = 120_000;
export const VERSION = 3;
const deflate = promisify(zlib.deflate), inflate = promisify(zlib.inflate);
const COLS = 10; // dt, n, x, y, v, g, thr, brk, rpm, drs

/** pack frames as Int32 columns and deflate them on the thread pool, so the event loop stays free */
async function pack(frames, a) {
  const arr = new Int32Array(frames.length * COLS);
  frames.forEach((f, k) => {
    const o = k * COLS;
    arr[o] = f.t - a; arr[o + 1] = f.n; arr[o + 2] = Math.round(f.x); arr[o + 3] = Math.round(f.y); arr[o + 4] = f.v | 0;
    arr[o + 5] = f.g | 0; arr[o + 6] = f.thr | 0; arr[o + 7] = f.brk | 0; arr[o + 8] = f.rpm | 0; arr[o + 9] = f.drs | 0;
  });
  return deflate(Buffer.from(arr.buffer), { level: 6 });
}
async function unpack(buf, a) {
  const bytes = buf instanceof Uint8Array ? buf : buf.read(0, buf.length()); // Buffer or BSON Binary
  let raw = await inflate(bytes);
  if (raw.byteOffset % 4) raw = Buffer.from(raw); // Int32Array views need 4-byte alignment
  const arr = new Int32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const frames = new Array(arr.length / COLS);
  for (let k = 0, o = 0; o < arr.length; k++, o += COLS) {
    frames[k] = { n: arr[o + 1], t: a + arr[o], x: arr[o + 2], y: arr[o + 3], v: arr[o + 4], g: arr[o + 5], thr: arr[o + 6], brk: arr[o + 7], rpm: arr[o + 8], drs: arr[o + 9] };
  }
  return frames;
}
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const ts = (s) => (s ? Date.parse(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z') : null);
// what was recorded beyond the core timing (team radio, marshal sectors, circuit geometry); bump to backfill cached sessions
export const EXTRAS = 2;
const wxData = (w) => ({ air: w.air_temperature, track: w.track_temperature, rain: w.rainfall, humidity: w.humidity, wind: w.wind_speed, windDir: w.wind_direction ?? null, pressure: w.pressure ?? null });
const otData = (o) => ({ n: o.overtaking_driver_number, o: o.overtaken_driver_number, pos: o.position });
const rcData = (r) => ({ category: r.category, flag: r.flag, message: r.message, lap: r.lap_number, n: r.driver_number, scope: r.scope, sector: r.sector ?? null });
/** laps in a finished race: the most laps anyone completed */
export function totalLapsOf(events, type) {
  if (!/Race|Sprint/.test(type || '')) return null;
  let m = 0;
  for (const e of events) if (e.type === 'lap' && e.data.lap > m) m = e.data.lap;
  return m || null;
}

/**
 * The circuit from one clean lap: the outline (location samples), and for each
 * outline point the speed, DRS and brake from the same car, plus where sectors 2
 * and 3 start, how many mini-sectors each sector has and the lap length in metres.
 */
export async function circuitFromLap(key, n, a, b, lap = {}) {
  const range = { session_key: key, driver_number: n, 'date>': iso(a), 'date<': iso(b) };
  const loc = await openf1('location', range);
  const car = await openf1('car_data', range).catch(() => []);
  const pts = loc.filter((l) => l.x || l.y).map((l) => ({ t: ts(l.date), x: l.x, y: l.y })).sort((p, q) => p.t - q.t);
  const step = Math.max(1, Math.floor(pts.length / 700));
  const sel = pts.filter((_, i) => i % step === 0);
  const cs = car.map((c) => ({ t: ts(c.date), v: c.speed, drs: c.drs >= 10 ? 1 : 0, brk: c.brake > 0 ? 1 : 0 })).sort((p, q) => p.t - q.t);
  let j = 0;
  const near = (t) => { while (j < cs.length - 1 && Math.abs(cs[j + 1].t - t) <= Math.abs(cs[j].t - t)) j++; return cs[j]; };
  const v = [], drs = [], brk = [];
  for (const p of sel) { const c = near(p.t); v.push(c?.v ?? 0); drs.push(c?.drs ?? 0); brk.push(c?.brk ?? 0); }
  let length = 0;
  for (let k = 1; k < cs.length; k++) { const dt = (cs[k].t - cs[k - 1].t) / 1000; if (dt > 0 && dt < 2) length += ((cs[k].v + cs[k - 1].v) / 2 / 3.6) * dt; }
  const idxAt = (sec) => { if (!sec) return null; const t = a + sec * 1000; const i = sel.findIndex((p) => p.t >= t); return i > 0 ? i : null; };
  const s1 = lap.duration_sector_1, s2 = lap.duration_sector_2;
  const segs = [lap.segments_sector_1, lap.segments_sector_2, lap.segments_sector_3].map((x) => (Array.isArray(x) ? x.length : 0));
  return {
    track: sel.map((p) => [p.x, p.y]),
    info: {
      v, drs, brk, length: cs.length > 10 ? Math.round(length) : null,
      sectors: s1 && s2 ? [idxAt(s1), idxAt(s1 + s2)] : null,
      segments: segs.every((x) => x > 0) ? segs : null,
      ref: { n, lap: lap.lap_number ?? null, time: (b - a) / 1000 }
    }
  };
}

/**
 * One real session from OpenF1, streamed on demand.
 *
 * Metadata (drivers, laps, positions, race control, weather, pit stops, stints,
 * track outline) is fetched once. Car data + location + intervals are fetched in
 * 2-minute chunks just ahead of the playback clock, for all cars at once, and
 * every completed chunk is cached in MongoDB, so a session is only downloaded
 * once however many times it is watched. In live mode the latest chunk is
 * refetched as it grows.
 */
export class SessionSource {
  constructor(key, { live = false } = {}) {
    this.key = key;
    this.live = live;
    this.inflight = new Map();
  }

  async loadMeta() {
    if (!this.live && Number.isFinite(Number(this.key))) {
      const cached = await ReplaySession.findOne({ key: Number(this.key), v: VERSION }).lean();
      if (cached?.complete) {
        const events = await ReplayEvent.find({ s: cached.key, type: { $ne: 'interval' } }, { _id: 0, s: 0 }).sort({ t: 1 }).lean();
        this.meta = cached;
        this.events = events.map((e) => ({ ...e, t: +e.t }));
        this.chunks = new Set(cached.chunks || []);
        ReplaySession.updateOne({ key: cached.key }, { lastUsed: new Date() }).catch(() => {});
        if (cached.xv !== EXTRAS) await this.upgrade();
        this.meta.totalLaps ??= totalLapsOf(this.events, this.meta.type);
        return this.meta;
      }
    }
    const [session] = await openf1('sessions', { session_key: this.key });
    if (!session) throw new Error(`OpenF1 session ${this.key} not found`);
    const key = session.session_key;
    this.key = key;
    const [driversRaw, laps, positions, rc, weather, pits, stintsRaw, radio, overtakes] = [
      await openf1('drivers', { session_key: key }),
      await openf1('laps', { session_key: key }),
      await openf1('position', { session_key: key }),
      await openf1('race_control', { session_key: key }),
      await openf1('weather', { session_key: key }),
      await openf1('pit', { session_key: key }),
      await openf1('stints', { session_key: key }),
      await openf1('team_radio', { session_key: key }).catch(() => []),
      await openf1('overtakes', { session_key: key }).catch(() => [])
    ];
    const drivers = driversRaw.map((d) => ({ n: d.driver_number, code: d.name_acronym, name: d.full_name, first: d.first_name, last: d.last_name, team: d.team_name, color: '#' + (d.team_colour || '888888'), country: d.country_code }));
    const stints = stintsRaw.map((s) => ({ n: s.driver_number, from: s.lap_start, to: s.lap_end, compound: s.compound, age: s.tyre_age_at_start }));

    const isRace = /Race|Sprint$/.test(session.session_name);
    const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => ts(l.date_start)).sort((a, b) => a - b)[0];
    const lastEnd = Math.max(0, ...laps.filter((l) => l.date_start && l.lap_duration).map((l) => ts(l.date_start) + l.lap_duration * 1000));
    const from = isRace && lap1 ? lap1 - 60_000 : ts(session.date_start);
    let to = Math.max(lastEnd + 90_000, ts(session.date_end) || 0);
    if (this.live) to = Date.now();
    const complete = !this.live && ts(session.date_end) < Date.now() - 3600_000;

    const events = [];
    const add = (t, type, data) => { if (t != null) events.push({ t, type, data }); };
    for (const l of laps) {
      if (!l.date_start) continue;
      add(ts(l.date_start), 'lapstart', { n: l.driver_number, lap: l.lap_number });
      if (l.lap_duration) add(ts(l.date_start) + l.lap_duration * 1000, 'lap', { n: l.driver_number, lap: l.lap_number, time: l.lap_duration, s: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3], st: l.st_speed, pitOut: !!l.is_pit_out_lap });
    }
    for (const p of positions) add(ts(p.date), 'position', { n: p.driver_number, pos: p.position });
    for (const r of rc) add(ts(r.date), 'rc', rcData(r));
    for (const r of radio) if (r.recording_url) add(ts(r.date), 'radio', { n: r.driver_number, url: r.recording_url });
    for (const w of weather) add(ts(w.date), 'weather', wxData(w));
    for (const o of overtakes) add(ts(o.date), 'overtake', otData(o));
    for (const p of pits) add(ts(p.date), 'pit', { n: p.driver_number, lap: p.lap_number, duration: p.pit_duration });
    events.sort((a, b) => a.t - b.t);

    // circuit outline and geometry: one clean lap of location and car data for one car
    let track = [], info = null;
    const clean = laps.filter((l) => l.lap_duration && !l.is_pit_out_lap && l.lap_number >= 2 && l.date_start)
      .sort((a, b) => a.lap_duration - b.lap_duration)[0];
    if (clean) {
      const a = ts(clean.date_start);
      ({ track, info } = await circuitFromLap(key, clean.driver_number, a, a + clean.lap_duration * 1000, clean));
    }
    this.meta = {
      v: VERSION, key, name: `${session.year} ${session.country_name} · ${session.session_name}`, year: session.year,
      circuit: session.circuit_short_name, country: session.country_name, location: session.location, type: session.session_name,
      meeting: session.meeting_key, from: new Date(from), to: new Date(to), drivers, stints, track, info, xv: EXTRAS, totalLaps: complete ? totalLapsOf(events, session.session_name) : null, complete, chunkMs: CHUNK_MS,
      events: events.length, importedAt: new Date(), lastUsed: new Date()
    };
    this.events = events;
    // keep chunks already recorded (e.g. while this session was live); drop data from older formats
    const existing = await ReplaySession.findOne({ key }, { v: 1, chunks: 1 }).lean();
    if (existing && existing.v !== VERSION) {
      await ReplayChunk.deleteMany({ s: key });
      await ReplayEvent.deleteMany({ s: key });
    }
    this.chunks = new Set(existing?.v === VERSION ? existing.chunks || [] : []);
    await ReplayEvent.deleteMany({ s: key, type: { $ne: 'interval' } });
    // native driver: skips per-document casting, which is slow on a small CPU
    if (events.length) await ReplayEvent.collection.insertMany(events.map((e) => ({ s: key, t: new Date(e.t), type: e.type, data: e.data })), { ordered: false });
    await ReplaySession.findOneAndUpdate({ key }, { ...this.meta, chunks: [...this.chunks] }, { upsert: true });
    log.info(`openf1: ${this.meta.name} ready (${drivers.length} drivers, ${events.length} events, ${Math.round((to - from) / 60000)} min)`);
    return this.meta;
  }

  /**
   * Sessions cached before team radio, marshal sectors and circuit geometry were
   * recorded get them added in place (a handful of requests), without throwing
   * away their stored car data.
   */
  async upgrade() {
    const m = this.meta, key = m.key;
    try {
      const radio = await openf1('team_radio', { session_key: key }).catch(() => []);
      const rc = await openf1('race_control', { session_key: key });
      const weather = await openf1('weather', { session_key: key }).catch(() => []);
      const overtakes = await openf1('overtakes', { session_key: key }).catch(() => []);
      const extra = [
        ...weather.map((w) => ({ t: ts(w.date), type: 'weather', data: wxData(w) })),
        ...overtakes.map((o) => ({ t: ts(o.date), type: 'overtake', data: otData(o) })),
        ...rc.map((r) => ({ t: ts(r.date), type: 'rc', data: rcData(r) })),
        ...radio.filter((r) => r.recording_url).map((r) => ({ t: ts(r.date), type: 'radio', data: { n: r.driver_number, url: r.recording_url } }))
      ].filter((e) => e.t != null);
      // the fastest clean lap, from the stored lap events
      const starts = new Map(this.events.filter((e) => e.type === 'lapstart').map((e) => [`${e.data.n}:${e.data.lap}`, e.t]));
      const best = this.events.filter((e) => e.type === 'lap' && !e.data.pitOut && e.data.lap >= 2 && starts.has(`${e.data.n}:${e.data.lap}`))
        .sort((a, b) => a.data.time - b.data.time)[0];
      let geo = null;
      if (best) {
        const a = starts.get(`${best.data.n}:${best.data.lap}`);
        const [row] = await openf1('laps', { session_key: key, driver_number: best.data.n, lap_number: best.data.lap }).catch(() => []);
        geo = await circuitFromLap(key, best.data.n, a, a + best.data.time * 1000, row || { duration_sector_1: best.data.s?.[0], duration_sector_2: best.data.s?.[1] });
      }
      const REDONE = ['rc', 'radio', ...(weather.length ? ['weather'] : []), 'overtake'];
      await ReplayEvent.deleteMany({ s: key, type: { $in: REDONE } });
      if (extra.length) await ReplayEvent.collection.insertMany(extra.map((e) => ({ s: key, t: new Date(e.t), type: e.type, data: e.data })), { ordered: false });
      this.events = [...this.events.filter((e) => !REDONE.includes(e.type)), ...extra].sort((a, b) => a.t - b.t);
      const set = { xv: EXTRAS, events: this.events.length, totalLaps: m.complete ? totalLapsOf(this.events, m.type) : null };
      if (geo?.track?.length) Object.assign(set, { track: geo.track, info: geo.info });
      else if (m.info) delete set.info;
      Object.assign(this.meta, set);
      await ReplaySession.updateOne({ key }, set);
      log.info(`openf1: ${m.name} upgraded (${radio.length} radio clips, circuit geometry ${geo ? 'added' : 'unavailable'})`);
    } catch (e) {
      log.warn(`openf1: upgrade of ${m.name} failed, playing without the extras:`, e.message);
    }
  }

  chunkIndex(t) { return Math.floor((t - +this.meta.from) / CHUNK_MS); }
  chunkCount() { return Math.ceil((+this.meta.to - +this.meta.from) / CHUNK_MS); }

  /** frames (grouped by car) and interval events for chunk i; cached in MongoDB once complete */
  chunk(i) {
    if (this.inflight.has(i)) return this.inflight.get(i);
    const p = this.loadChunk(i).finally(() => this.inflight.delete(i));
    this.inflight.set(i, p);
    return p;
  }

  async loadChunk(i) {
    const a = +this.meta.from + i * CHUNK_MS, b = a + CHUNK_MS;
    const key = this.meta.key;
    if (this.chunks.has(i)) {
      const doc = await ReplayChunk.collection.findOne({ s: key, i });
      if (doc) {
        const frames = await unpack(doc.data, a);
        const intervals = (doc.ints || []).map(([dt, n, gap, int]) => ({ t: a + dt, type: 'interval', data: { n, gap, int } }));
        return { i, frames, intervals };
      }
      this.chunks.delete(i);
    }
    const range = { session_key: key, 'date>=': iso(a), 'date<': iso(b) };
    const car = await openf1('car_data', range);
    const loc = await openf1('location', range);
    const ints = this.meta.type === 'Race' || this.meta.type === 'Sprint' ? await openf1('intervals', range) : [];
    const locBy = new Map();
    for (const l of loc) {
      if (!l.x && !l.y) continue;
      let arr = locBy.get(l.driver_number);
      if (!arr) { arr = []; locBy.set(l.driver_number, arr); }
      arr.push({ t: ts(l.date), x: l.x, y: l.y });
    }
    for (const arr of locBy.values()) arr.sort((p, q) => p.t - q.t);
    const carBy = new Map();
    for (const c of car) {
      let arr = carBy.get(c.driver_number);
      if (!arr) { arr = []; carBy.set(c.driver_number, arr); }
      arr.push(c);
    }
    const frames = [];
    for (const [n, cs] of carBy) {
      cs.sort((p, q) => ts(p.date) - ts(q.date));
      const ls = locBy.get(n) || [];
      let j = 0;
      for (const c of cs) {
        const t = ts(c.date);
        while (j < ls.length - 1 && Math.abs(ls[j + 1].t - t) <= Math.abs(ls[j].t - t)) j++;
        const l = ls[j];
        if (!l) continue;
        frames.push({ n, t, x: l.x, y: l.y, v: c.speed, g: c.n_gear, thr: c.throttle, brk: c.brake > 0 ? 1 : 0, rpm: c.rpm, drs: c.drs >= 10 ? 1 : 0 });
      }
    }
    frames.sort((p, q) => p.t - q.t);
    const intervals = ints.map((x) => ({ t: ts(x.date), type: 'interval', data: { n: x.driver_number, gap: x.gap_to_leader, int: x.interval } })).sort((p, q) => p.t - q.t);
    const settled = b < Date.now() - 60_000;
    // record every settled chunk, live or historical, so a session is downloaded once
    // and a live session becomes replayable after it ends
    if (settled && frames.length) {
      const data = await pack(frames, a);
      const ints = intervals.map((e) => [e.t - a, e.data.n, e.data.gap ?? null, e.data.int ?? null]);
      await ReplayChunk.collection.replaceOne({ s: key, i }, { s: key, i, count: frames.length, data, ints }, { upsert: true }).catch((e) => log.warn(`chunk ${i} save:`, e.message));
      this.chunks.add(i);
      await ReplaySession.updateOne({ key }, { $addToSet: { chunks: i } }).catch(() => {});
    }
    return { i, frames, intervals };
  }

  /** live mode: newly published events since `since` */
  async liveEvents(since) {
    const key = this.meta.key;
    const q = { session_key: key, 'date>': iso(since) };
    const late = { session_key: key, 'date>': iso(since - 300_000) };
    const out = [];
    for (const p of await openf1('position', q)) out.push({ t: ts(p.date), type: 'position', data: { n: p.driver_number, pos: p.position } });
    for (const r of await openf1('race_control', q)) out.push({ t: ts(r.date), type: 'rc', data: rcData(r) });
    for (const w of await openf1('weather', q).catch(() => [])) out.push({ t: ts(w.date), type: 'weather', data: wxData(w) });
    for (const o of await openf1('overtakes', late).catch(() => [])) out.push({ t: ts(o.date), type: 'overtake', data: otData(o) });
    // radio clips and overtakes are published a while after the moment they're stamped with: `late` looks further back
    for (const r of await openf1('team_radio', late).catch(() => [])) if (r.recording_url) out.push({ t: ts(r.date), type: 'radio', data: { n: r.driver_number, url: r.recording_url } });
    for (const l of await openf1('laps', { session_key: key, 'date_start>': iso(since - 180_000) })) {
      if (l.lap_duration && l.date_start) out.push({ t: ts(l.date_start) + l.lap_duration * 1000, type: 'lap', data: { n: l.driver_number, lap: l.lap_number, time: l.lap_duration, s: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3], pitOut: !!l.is_pit_out_lap } });
      if (l.date_start) out.push({ t: ts(l.date_start), type: 'lapstart', data: { n: l.driver_number, lap: l.lap_number } });
    }
    return out.filter((e) => e.t > since || e.type === 'radio' || e.type === 'overtake').sort((a, b) => a.t - b.t);
  }
}

/**
 * Keep stored sessions under a size budget (the free MongoDB tier has 512 MB in all).
 * Drops whole sessions, least recently used first, never one that is playing.
 */
export async function pruneReplayCache({ maxBytes, keep = new Set() }) {
  const size = async (name) => {
    try { const s = await ReplayChunk.db.db.command({ collStats: name }); return (s.size || 0) + (s.totalIndexSize || 0); } catch { return 0; }
  };
  let total = (await size('replaychunks')) + (await size('replayevents'));
  if (total <= maxBytes) return [];
  const sessions = await ReplaySession.find({}, { key: 1, name: 1, lastUsed: 1, importedAt: 1, chunks: 1 }).lean();
  sessions.sort((a, b) => +(a.lastUsed || a.importedAt || 0) - +(b.lastUsed || b.importedAt || 0));
  const dropped = [];
  for (const s of sessions) {
    if (total <= maxBytes * 0.85) break;
    if (keep.has(s.key)) continue;
    await ReplayChunk.deleteMany({ s: s.key });
    await ReplayEvent.deleteMany({ s: s.key });
    await ReplaySession.deleteOne({ key: s.key });
    // estimate what was freed; the true figure only settles after compaction
    total -= (s.chunks?.length || 0) * 110_000 + 600_000;
    dropped.push(s.name);
  }
  if (dropped.length) log.info(`replay cache: dropped ${dropped.length} least recently used sessions: ${dropped.join(', ')}`);
  return dropped;
}
