import { openf1 } from './client.js';
import { ReplaySession, ReplayFrame, ReplayEvent } from '../models/index.js';
import { log } from '../lib/log.js';

export const CHUNK_MS = 120_000;
const VERSION = 2;
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const ts = (s) => (s ? Date.parse(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z') : null);

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
        return this.meta;
      }
    }
    const [session] = await openf1('sessions', { session_key: this.key });
    if (!session) throw new Error(`OpenF1 session ${this.key} not found`);
    const key = session.session_key;
    this.key = key;
    const [driversRaw, laps, positions, rc, weather, pits, stintsRaw] = [
      await openf1('drivers', { session_key: key }),
      await openf1('laps', { session_key: key }),
      await openf1('position', { session_key: key }),
      await openf1('race_control', { session_key: key }),
      await openf1('weather', { session_key: key }),
      await openf1('pit', { session_key: key }),
      await openf1('stints', { session_key: key })
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
    for (const r of rc) add(ts(r.date), 'rc', { category: r.category, flag: r.flag, message: r.message, lap: r.lap_number, n: r.driver_number, scope: r.scope });
    for (const w of weather) add(ts(w.date), 'weather', { air: w.air_temperature, track: w.track_temperature, rain: w.rainfall, humidity: w.humidity, wind: w.wind_speed });
    for (const p of pits) add(ts(p.date), 'pit', { n: p.driver_number, lap: p.lap_number, duration: p.pit_duration });
    events.sort((a, b) => a.t - b.t);

    // circuit outline: one clean lap of location data for one car
    let track = [];
    const clean = laps.filter((l) => l.lap_duration && !l.is_pit_out_lap && l.lap_number >= 2 && l.date_start)
      .sort((a, b) => a.lap_duration - b.lap_duration)[0];
    if (clean) {
      const a = ts(clean.date_start), b = a + clean.lap_duration * 1000;
      const loc = await openf1('location', { session_key: key, driver_number: clean.driver_number, 'date>': iso(a), 'date<': iso(b) });
      const pts = loc.filter((l) => l.x || l.y).map((l) => [l.x, l.y]);
      const step = Math.max(1, Math.floor(pts.length / 700));
      track = pts.filter((_, i) => i % step === 0);
    }

    this.meta = {
      v: VERSION, key, name: `${session.year} ${session.country_name} · ${session.session_name}`, year: session.year,
      circuit: session.circuit_short_name, country: session.country_name, location: session.location, type: session.session_name,
      meeting: session.meeting_key, from: new Date(from), to: new Date(to), drivers, stints, track, complete, chunkMs: CHUNK_MS,
      events: events.length, importedAt: new Date()
    };
    this.events = events;
    // keep chunks already recorded (e.g. while this session was live); drop data from older formats
    const existing = await ReplaySession.findOne({ key }, { v: 1, chunks: 1 }).lean();
    if (existing && existing.v !== VERSION) {
      await ReplayFrame.deleteMany({ s: key });
      await ReplayEvent.deleteMany({ s: key });
    }
    this.chunks = new Set(existing?.v === VERSION ? existing.chunks || [] : []);
    await ReplayEvent.deleteMany({ s: key, type: { $ne: 'interval' } });
    if (events.length) await ReplayEvent.insertMany(events.map((e) => ({ s: key, t: new Date(e.t), type: e.type, data: e.data })), { ordered: false });
    await ReplaySession.findOneAndUpdate({ key }, { ...this.meta, chunks: [...this.chunks] }, { upsert: true });
    log.info(`openf1: ${this.meta.name} ready (${drivers.length} drivers, ${events.length} events, ${Math.round((to - from) / 60000)} min)`);
    return this.meta;
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
      const [frames, intervals] = await Promise.all([
        ReplayFrame.find({ s: key, t: { $gte: new Date(a), $lt: new Date(b) } }, { _id: 0, s: 0 }).sort({ t: 1 }).lean(),
        ReplayEvent.find({ s: key, type: 'interval', t: { $gte: new Date(a), $lt: new Date(b) } }, { _id: 0, s: 0 }).sort({ t: 1 }).lean()
      ]);
      return { i, frames: frames.map((f) => ({ ...f, t: +f.t })), intervals: intervals.map((e) => ({ t: +e.t, type: 'interval', data: e.data })) };
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
      await ReplayFrame.insertMany(frames.map((f) => ({ ...f, s: key, t: new Date(f.t) })), { ordered: false }).catch(() => {});
      if (intervals.length) await ReplayEvent.insertMany(intervals.map((e) => ({ s: key, t: new Date(e.t), type: 'interval', data: e.data })), { ordered: false }).catch(() => {});
      this.chunks.add(i);
      await ReplaySession.updateOne({ key }, { $addToSet: { chunks: i } }).catch(() => {});
    }
    return { i, frames, intervals };
  }

  /** live mode: newly published events since `since` */
  async liveEvents(since) {
    const key = this.meta.key;
    const q = { session_key: key, 'date>': iso(since) };
    const out = [];
    for (const p of await openf1('position', q)) out.push({ t: ts(p.date), type: 'position', data: { n: p.driver_number, pos: p.position } });
    for (const r of await openf1('race_control', q)) out.push({ t: ts(r.date), type: 'rc', data: { category: r.category, flag: r.flag, message: r.message, lap: r.lap_number, n: r.driver_number, scope: r.scope } });
    for (const l of await openf1('laps', { session_key: key, 'date_start>': iso(since - 180_000) })) {
      if (l.lap_duration && l.date_start) out.push({ t: ts(l.date_start) + l.lap_duration * 1000, type: 'lap', data: { n: l.driver_number, lap: l.lap_number, time: l.lap_duration, s: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3], pitOut: !!l.is_pit_out_lap } });
      if (l.date_start) out.push({ t: ts(l.date_start), type: 'lapstart', data: { n: l.driver_number, lap: l.lap_number } });
    }
    return out.filter((e) => e.t > since).sort((a, b) => a.t - b.t);
  }
}
