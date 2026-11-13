import { openf1 } from './client.js';
import { ReplaySession, ReplayFrame, ReplayEvent } from '../models/index.js';
import { log } from '../lib/log.js';

const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const ts = (s) => (s ? Date.parse(s.endsWith('Z') || s.includes('+') ? s : s + 'Z') : null);

/**
 * Import a window of a real session from OpenF1 into MongoDB:
 *   ReplaySession  meta, drivers, track outline, window
 *   ReplayFrame    per-driver car data (speed, rpm, gear, throttle, brake, DRS) merged with x/y location
 *   ReplayEvent    laps, positions, intervals, race control, weather, pit stops (time-stamped)
 * The window keeps the import small enough for a free-tier database (~15 minutes ≈ 70k frames).
 */
export async function importSession(sessionKey, { minutes = 15, offsetS = -20, onProgress = () => {} } = {}) {
  sessionKey = Number(sessionKey);
  const [session] = await openf1('sessions', { session_key: sessionKey });
  if (!session) throw new Error(`session ${sessionKey} not found on OpenF1`);
  const drivers = (await openf1('drivers', { session_key: sessionKey }))
    .map((d) => ({ n: d.driver_number, code: d.name_acronym, name: d.full_name, first: d.first_name, last: d.last_name, team: d.team_name, color: '#' + (d.team_colour || '888888'), headshot: d.headshot_url || null, country: d.country_code }));
  onProgress(`${drivers.length} drivers`);

  const laps = await openf1('laps', { session_key: sessionKey });
  const firstLap = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => ts(l.date_start)).sort((a, b) => a - b)[0];
  const from = (firstLap || ts(session.date_start)) + offsetS * 1000;
  const to = from + minutes * 60_000;
  onProgress(`window ${iso(from)} → ${iso(to)}`);

  await Promise.all([ReplayFrame.deleteMany({ s: sessionKey }), ReplayEvent.deleteMany({ s: sessionKey })]);

  // ---- car data + location, merged per driver ----
  let frames = 0;
  let trackPts = null;
  for (const d of drivers) {
    const range = { session_key: sessionKey, driver_number: d.n, 'date>': iso(from), 'date<': iso(to) };
    const car = await openf1('car_data', range);
    const loc = await openf1('location', range);
    const locT = loc.map((l) => ts(l.date));
    let j = 0;
    const docs = [];
    for (const c of car) {
      const t = ts(c.date);
      while (j < loc.length - 1 && Math.abs(locT[j + 1] - t) <= Math.abs(locT[j] - t)) j++;
      const l = loc[j];
      if (!l || (l.x === 0 && l.y === 0)) continue;
      docs.push({ s: sessionKey, n: d.n, t: new Date(t), x: l.x, y: l.y, v: c.speed, g: c.n_gear, thr: c.throttle, brk: c.brake > 0 ? 1 : 0, rpm: c.rpm, drs: c.drs >= 10 ? 1 : 0 });
    }
    if (docs.length) await ReplayFrame.insertMany(docs, { ordered: false });
    frames += docs.length;
    // a clean outline of the circuit: one full timed lap of this driver inside the window
    if (!trackPts) {
      const lap = laps.filter((l) => l.driver_number === d.n && l.lap_duration && !l.is_pit_out_lap && l.lap_number >= 2)
        .map((l) => ({ a: ts(l.date_start), b: ts(l.date_start) + l.lap_duration * 1000 }))
        .find((l) => l.a >= from && l.b <= to);
      if (lap) {
        const pts = loc.filter((l, k) => locT[k] >= lap.a && locT[k] <= lap.b && (l.x || l.y)).map((l) => [l.x, l.y]);
        if (pts.length > 200) trackPts = pts;
      }
    }
    onProgress(`${d.code}: ${docs.length} frames`);
  }

  // ---- events ----
  const events = [];
  const add = (t, type, data) => { if (t != null) events.push({ s: sessionKey, t: new Date(t), type, data }); };
  for (const l of laps) {
    if (!l.date_start || !l.lap_duration) { if (l.date_start) add(ts(l.date_start), 'lapstart', { n: l.driver_number, lap: l.lap_number }); continue; }
    const end = ts(l.date_start) + l.lap_duration * 1000;
    add(ts(l.date_start), 'lapstart', { n: l.driver_number, lap: l.lap_number });
    add(end, 'lap', { n: l.driver_number, lap: l.lap_number, time: l.lap_duration, s: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3], i1: l.i1_speed, i2: l.i2_speed, st: l.st_speed, pitOut: !!l.is_pit_out_lap });
  }
  for (const p of await openf1('position', { session_key: sessionKey })) add(ts(p.date), 'position', { n: p.driver_number, pos: p.position });
  for (const i of await openf1('intervals', { session_key: sessionKey, 'date>': iso(from - 60_000), 'date<': iso(to) })) {
    add(ts(i.date), 'interval', { n: i.driver_number, gap: i.gap_to_leader, int: i.interval });
  }
  for (const r of await openf1('race_control', { session_key: sessionKey })) add(ts(r.date), 'rc', { category: r.category, flag: r.flag, message: r.message, lap: r.lap_number, n: r.driver_number, scope: r.scope });
  for (const w of await openf1('weather', { session_key: sessionKey })) add(ts(w.date), 'weather', { air: w.air_temperature, track: w.track_temperature, rain: w.rainfall, humidity: w.humidity, wind: w.wind_speed });
  for (const p of await openf1('pit', { session_key: sessionKey })) add(ts(p.date), 'pit', { n: p.driver_number, lap: p.lap_number, duration: p.pit_duration });
  const stints = (await openf1('stints', { session_key: sessionKey })).map((s) => ({ n: s.driver_number, from: s.lap_start, to: s.lap_end, compound: s.compound, age: s.tyre_age_at_start }));
  if (events.length) await ReplayEvent.insertMany(events, { ordered: false });
  onProgress(`${events.length} events`);

  // downsample the outline to ~700 points
  let track = [];
  if (trackPts) {
    const step = Math.max(1, Math.floor(trackPts.length / 700));
    track = trackPts.filter((_, i) => i % step === 0);
  }
  const doc = {
    key: sessionKey, name: `${session.year} ${session.country_name} · ${session.session_name}`, year: session.year,
    circuit: session.circuit_short_name, country: session.country_name, location: session.location, type: session.session_name,
    from: new Date(from), to: new Date(to), drivers, stints, track, frames, events: events.length, importedAt: new Date()
  };
  await ReplaySession.findOneAndUpdate({ key: sessionKey }, doc, { upsert: true });
  log.info(`openf1: imported ${doc.name}: ${frames} frames, ${events.length} events`);
  return doc;
}
