import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ReplaySession, Mock } from '../models/index.js';
import { catalog, liveAvailable } from '../openf1/client.js';
import { VERSION } from '../openf1/source.js';

const MOCK_ID = /^[a-z0-9]{8,16}$/;

/** the channel for a key: a shared session, the live feed, or a crew's mock (reopened from MongoDB if it was closed) */
async function resolve(hub, key) {
  const k = String(key);
  const open = hub.replays.get(k);
  if (open) return open;
  if (k.startsWith('m-')) {
    const id = k.slice(2);
    if (!MOCK_ID.test(id)) throw Object.assign(new Error('bad mock id'), { status: 400 });
    const m = await Mock.findById(id).lean();
    if (!m) throw Object.assign(new Error('this mock session has expired or never existed'), { status: 404 });
    return hub.replays.openMock({ id, key: m.key, startAt: m.startAt, t: m.t, team: m.team });
  }
  if (k === 'live') return hub.replays.open('live', { live: true });
  if (!/^\d+$/.test(k)) throw Object.assign(new Error('unknown session'), { status: 400 });
  return hub.replays.open(Number(k));
}
const fail = (res, e) => res.status(e.status || (e.message.includes('busy') ? 503 : 502)).json({ error: e.message });

/**
 * Real sessions from OpenF1 (unofficial, free historical data for non-commercial use).
 * Anyone can browse the catalogue and open a session; it plays as a shared channel.
 */
export function replayRouter(hub) {
  const r = Router();
  const openLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many sessions opened, wait a minute' } });

  r.get('/catalog', async (req, res, next) => {
    try {
      const year = Number(req.query.year) || new Date().getFullYear();
      if (year < 2023 || year > 2100) return res.status(400).json({ error: 'OpenF1 has data from 2023 onwards' });
      res.json({ year, sessions: await catalog(year) });
    } catch (e) { next(e); }
  });

  r.get('/channels', async (_req, res, next) => {
    try {
      const cached = await ReplaySession.find({ v: VERSION }, { _id: 0, key: 1, name: 1, complete: 1, chunks: 1, from: 1, to: 1, chunkMs: 1 }).sort({ importedAt: -1 }).limit(30).lean();
      res.json({
        live: liveAvailable(),
        channels: hub.replays.list(),
        cached: cached.map((c) => ({ key: c.key, name: c.name, complete: c.complete, recorded: Math.round(((c.chunks?.length || 0) * (c.chunkMs || 120000)) / 60000), minutes: Math.round((+c.to - +c.from) / 60000) }))
      });
    } catch (e) { next(e); }
  });

  r.post('/open', openLimiter, async (req, res) => {
    const p = z.object({ key: z.union([z.number().int().positive(), z.literal('live'), z.string().regex(/^m-[a-z0-9]{8,16}$/)]) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'key (OpenF1 session_key), "live" or a mock id required' });
    if (typeof p.data.key === 'string' && p.data.key.startsWith('m-')) {
      try { return res.json((await resolve(hub, p.data.key)).snapshot()); } catch (e) { return fail(res, e); }
    }
    const live = p.data.key === 'live';
    if (live && !liveAvailable()) {
      return res.status(403).json({ error: 'Live data needs an OpenF1 subscription. Set OPENF1_TOKEN (or OPENF1_USERNAME and OPENF1_PASSWORD) on the server. Past sessions work without a key.' });
    }
    try {
      const ch = await hub.replays.open(p.data.key, { live });
      res.json(ch.snapshot());
    } catch (e) {
      res.status(e.message.includes('busy') ? 503 : 502).json({ error: e.message });
    }
  });

  /**
   * Analysis of a real session from its timing events: laps (with position at the
   * line), stints, pit stops, speed traps. The client filters by the replay clock
   * so a historical session unfolds as if live.
   */
  r.get('/:key/analysis', async (req, res) => {
    try {
      const ch = await resolve(hub, req.params.key);
      const events = ch.events || [];
      const posBy = new Map();
      for (const e of events) if (e.type === 'position') {
        let a = posBy.get(e.data.n);
        if (!a) { a = []; posBy.set(e.data.n, a); }
        a.push([e.t, e.data.pos]);
      }
      const posAt = (n, t) => {
        const a = posBy.get(n);
        if (!a?.length) return null;
        let lo = 0, hi = a.length - 1, best = null;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m][0] <= t) { best = a[m][1]; lo = m + 1; } else hi = m - 1; }
        return best;
      };
      const laps = events.filter((e) => e.type === 'lap').map((e) => ({
        n: e.data.n, lap: e.data.lap, t: e.t, time: e.data.time, s: e.data.s, st: e.data.st ?? null, pitOut: !!e.data.pitOut, pos: posAt(e.data.n, e.t + 500)
      }));
      const pits = events.filter((e) => e.type === 'pit').map((e) => ({ n: e.data.n, lap: e.data.lap, duration: e.data.duration, t: e.t }));
      res.json({ key: ch.meta.key, ch: ch.ch(), name: ch.meta.name, type: ch.meta.type, drivers: ch.meta.drivers, stints: ch.meta.stints, laps, pits, from: ch.from, to: ch.to });
    } catch (e) { fail(res, e); }
  });

  r.get('/:key/state', (req, res) => {
    const ch = hub.replays.get(req.params.key);
    if (!ch) return res.status(404).json({ error: 'channel not open' });
    res.json(ch.snapshot());
  });

  const controlLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many playback changes, slow down' } });
  // anyone watching can drive the channel's shared clock (rate-limited), like a watch party
  r.post('/:key/control', controlLimiter, async (req, res) => {
    let ch;
    try { ch = await resolve(hub, req.params.key); } catch (e) { return fail(res, e); }
    const p = z.object({ action: z.enum(['play', 'pause', 'seek', 'speed', 'restart']), t: z.number().min(0).optional(), speed: z.number().min(0.25).max(16).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid control' });
    try { res.json(ch.control(p.data)); } catch (e) { res.status(409).json({ error: e.message }); }
  });

  return r;
}

/**
 * Mock sessions: a crew rehearses on a past session with its own private clock,
 * logs its strategy calls as it goes, and gets a debrief against what the real
 * teams did. Anyone holding the link is on that crew (share it to work together).
 */
export function mockRouter(hub) {
  const r = Router();
  const createLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many mock sessions started, wait a minute' } });
  const callLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many calls logged, slow down' } });
  const team = z.string().trim().max(40).optional();

  r.post('/', createLimiter, async (req, res) => {
    const p = z.object({ key: z.number().int().positive(), lap: z.number().int().min(1).max(100).optional(), team }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'key (a past OpenF1 session) required' });
    const id = randomBytes(8).toString('hex').slice(0, 12);
    try {
      const ch = await hub.replays.openMock({ id, key: p.data.key, team: p.data.team });
      let startAt = ch.from;
      if (p.data.lap && p.data.lap > 1) {
        const ls = ch.events.find((e) => e.type === 'lapstart' && e.data.lap === p.data.lap);
        if (ls) startAt = Math.max(ch.from, ls.t + 500);
      }
      ch.mock.startAt = startAt;
      ch.seek(startAt);
      const now = new Date();
      await Mock.create({ _id: id, key: ch.meta.key, name: ch.meta.name, team: p.data.team || null, from: ch.from, to: ch.to, startAt, t: startAt, calls: [], createdAt: now, updatedAt: now });
      res.status(201).json({ id, ch: ch.ch(), snapshot: ch.snapshot() });
    } catch (e) { fail(res, e); }
  });

  // a crew's own list: the browser keeps the ids of the mocks it started or was sent
  r.get('/', async (req, res, next) => {
    try {
      const ids = String(req.query.ids || '').split(',').filter((x) => MOCK_ID.test(x)).slice(0, 40);
      if (!ids.length) return res.json({ mocks: [] });
      const list = await Mock.find({ _id: { $in: ids } }).sort({ updatedAt: -1 }).lean();
      res.json({ mocks: list.map(({ calls, ...m }) => ({ ...m, id: m._id, calls: calls?.length || 0, open: !!hub.replays.get(`m-${m._id}`) })) });
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      if (!MOCK_ID.test(req.params.id)) return res.status(400).json({ error: 'bad mock id' });
      const m = await Mock.findById(req.params.id).lean();
      if (!m) return res.status(404).json({ error: 'this mock session has expired or never existed' });
      const ch = hub.replays.get(`m-${m._id}`);
      res.json({ ...m, id: m._id, t: ch ? ch.t : m.t });
    } catch (e) { next(e); }
  });

  r.patch('/:id', async (req, res, next) => {
    const p = z.object({ team, ended: z.boolean().optional() }).safeParse(req.body);
    if (!p.success || !MOCK_ID.test(req.params.id)) return res.status(400).json({ error: 'invalid update' });
    try {
      const m = await Mock.findByIdAndUpdate(req.params.id, { ...p.data, updatedAt: new Date() }, { new: true }).lean();
      if (!m) return res.status(404).json({ error: 'not found' });
      const ch = hub.replays.get(`m-${m._id}`);
      if (ch && p.data.team !== undefined) ch.mock.team = p.data.team;
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // log a strategy call: stamped with the mock's clock and the car's position, lap and tyres at that moment
  r.post('/:id/calls', callLimiter, async (req, res) => {
    const p = z.object({
      n: z.number().int().min(1).max(99),
      kind: z.enum(['box', 'stay', 'note']),
      compound: z.enum(['S', 'M', 'H', 'I', 'W']).optional(),
      note: z.string().trim().max(200).optional(),
      advice: z.string().trim().max(120).optional(),
      by: z.string().trim().max(30).optional()
    }).safeParse(req.body);
    if (!p.success || !MOCK_ID.test(req.params.id)) return res.status(400).json({ error: 'invalid call' });
    try {
      const ch = await resolve(hub, `m-${req.params.id}`);
      const car = ch.carNow(p.data.n);
      if (!car) return res.status(400).json({ error: 'that car is not in this session' });
      const call = { id: randomBytes(4).toString('hex'), t: ch.t, at: new Date(), ...p.data, ...car };
      const m = await Mock.findOneAndUpdate({ _id: req.params.id, 'calls.299': { $exists: false } }, { $push: { calls: call }, t: ch.t, updatedAt: new Date() }, { new: true, projection: { _id: 1 } }).lean();
      if (!m) return res.status(409).json({ error: 'call log is full (300 calls)' });
      res.status(201).json(call);
    } catch (e) { fail(res, e); }
  });

  r.delete('/:id/calls/:cid', async (req, res, next) => {
    if (!MOCK_ID.test(req.params.id) || !/^[a-f0-9]{8}$/.test(req.params.cid)) return res.status(400).json({ error: 'bad id' });
    try {
      await Mock.updateOne({ _id: req.params.id }, { $pull: { calls: { id: req.params.cid } }, updatedAt: new Date() });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
