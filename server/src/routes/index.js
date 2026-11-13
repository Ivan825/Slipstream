import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { CARS, TEAMS, CAR_BY_ID, TRACK_INFO, COMPOUNDS, ALL_COMPOUNDS } from '@slipstream/shared';
import { Lap, Alert, Session, Telemetry, Command } from '../models/index.js';
import { login, signToken, requireRole, canSeeCar, canSeeTeam, DEMO_PASSWORD } from '../auth.js';
import { analysisRouter } from './analysis.js';
import { verifyApiKey } from '../lib/keys.js';
import { config } from '../config.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parse(schema, data, res) {
  const r = schema.safeParse(data);
  if (!r.success) {
    res.status(400).json({ error: 'invalid request', issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return null;
  }
  return r.data;
}

export function apiRouter(hub) {
  const r = Router();

  /* ---------- auth ---------- */
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many login attempts, try again in a few minutes' } });
  r.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const body = parse(z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(100) }), req.body, res);
    if (!body) return;
    const user = await login(body.username, body.password);
    if (!user) return res.status(401).json({ error: 'wrong username or password' });
    res.json({ token: signToken(user), user: { username: user.username, role: user.role, team: user.team, name: user.displayName } });
  }));
  r.get('/auth/me', (req, res) => res.json({ user: req.user }));
  r.get('/auth/demo', (_req, res) => res.json({
    password: DEMO_PASSWORD,
    accounts: [{ username: 'control', role: 'race_control' }, ...TEAMS.map((t) => ({ username: t.id, role: 'engineer', team: t.id, name: t.name }))]
  }));

  /* ---------- HTTP ingest (for real devices and scripts without a socket client) ----------
   * POST /api/ingest   x-api-key: <sourceId>.<hmac>   body: Frame[] or { frames: Frame[] }
   * Same pipeline as the /ingest socket namespace: validation, token bucket, dedupe, storage.
   */
  r.post('/ingest', (req, res) => {
    const source = verifyApiKey(req.get('x-api-key'), config.ingestSecret);
    if (!source || source === 'sim') return res.status(401).json({ error: 'invalid or missing x-api-key' });
    const frames = Array.isArray(req.body) ? req.body : req.body?.frames;
    const result = hub.ingest(source, frames);
    res.status(result.error ? 400 : result.limited && !result.accepted ? 429 : 200).json(result);
  });

  /* ---------- session / reference data ---------- */
  r.get('/session', (req, res) => {
    res.json({ session: hub.publicSession(), track: { ...TRACK_INFO, laps: hub.session.totalLaps }, teams: TEAMS, cars: CARS, compounds: COMPOUNDS, user: req.user });
  });
  r.get('/sessions', wrap(async (_req, res) => {
    res.json({ sessions: await Session.find({}, { _id: 0 }).sort({ startedAt: -1 }).limit(20).lean() });
  }));

  /* ---------- telemetry history (team scoped) ---------- */
  const carGuard = (req, res, next) => {
    const id = String(req.params.carId || '').toUpperCase();
    if (!CAR_BY_ID[id]) return res.status(404).json({ error: 'unknown car' });
    if (!canSeeCar(req.user, id)) return res.status(req.user.role === 'viewer' ? 401 : 403).json({ error: 'this car belongs to another team' });
    req.carId = id;
    next();
  };
  r.get('/telemetry/:carId', carGuard, wrap(async (req, res) => {
    const q = parse(z.object({
      toSeq: z.coerce.number().int().optional(), fromSeq: z.coerce.number().int().optional(),
      sinceMs: z.coerce.number().int().min(1000).max(30 * 60_000).optional(), limit: z.coerce.number().int().min(1).max(5000).optional()
    }), req.query, res);
    if (!q) return;
    const started = performance.now();
    const out = await hub.history(req.carId, q);
    res.json({ carId: req.carId, sessionId: hub.session.sessionId, ...out, ms: Math.round(performance.now() - started) });
  }));

  /** historical analysis: MongoDB aggregation into time buckets */
  r.get('/telemetry/:carId/aggregate', carGuard, wrap(async (req, res) => {
    const q = parse(z.object({ minutes: z.coerce.number().min(1).max(120).default(10), bucketSec: z.coerce.number().int().min(1).max(300).default(10) }), req.query, res);
    if (!q) return;
    const since = new Date(Date.now() - q.minutes * 60_000);
    const rows = await Telemetry.aggregate([
      { $match: { sessionId: hub.session.sessionId, carId: req.carId, ts: { $gte: since } } },
      { $group: {
        _id: { $dateTrunc: { date: '$ts', unit: 'second', binSize: q.bucketSec } },
        n: { $sum: 1 }, avgSpeed: { $avg: '$v' }, maxSpeed: { $max: '$v' }, avgThrottle: { $avg: '$thr' },
        maxBrakeFront: { $max: { $max: [{ $arrayElemAt: ['$bt', 0] }, { $arrayElemAt: ['$bt', 1] }] } },
        maxTyre: { $max: { $max: '$tt' } }, minPsi: { $min: { $min: '$tp' } }, fuel: { $last: '$fuel' }, waterT: { $max: '$et' }
      } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ carId: req.carId, bucketSec: q.bucketSec, rows: rows.map((x) => ({ t: x._id, ...x, _id: undefined })) });
  }));

  /* ---------- laps ---------- */
  r.get('/laps', wrap(async (req, res) => {
    const q = parse(z.object({ carId: z.string().optional(), sessionId: z.string().optional() }), req.query, res);
    if (!q) return;
    const filter = { sessionId: q.sessionId || hub.session.sessionId };
    if (q.carId) filter.carId = q.carId.toUpperCase();
    const laps = await Lap.find(filter, { trace: 0, _id: 0 }).sort({ lap: 1 }).limit(2000).lean();
    res.json({ laps });
  }));
  r.get('/laps/:carId/best', carGuard, wrap(async (req, res) => {
    const sessionId = req.query.sessionId || hub.session.sessionId;
    const lap = await Lap.findOne({ sessionId, carId: req.carId, valid: true }, { _id: 0 }).sort({ timeMs: 1 }).lean();
    res.json({ lap });
  }));
  r.get('/laps/:carId/:lap', carGuard, wrap(async (req, res) => {
    const sessionId = req.query.sessionId || hub.session.sessionId;
    const lap = await Lap.findOne({ sessionId, carId: req.carId, lap: Number(req.params.lap) }, { _id: 0 }).lean();
    if (!lap) return res.status(404).json({ error: 'lap not found' });
    res.json({ lap });
  }));

  /** per-lap analysis across a stint: degradation trend from the laps collection */
  r.get('/analysis/:carId/stints', carGuard, wrap(async (req, res) => {
    const rows = await Lap.aggregate([
      { $match: { sessionId: hub.session.sessionId, carId: req.carId } },
      { $sort: { lap: 1 } },
      { $project: { _id: 0, lap: 1, timeMs: 1, compound: 1, tyreAge: 1, valid: 1, pitIn: 1, pitOut: 1, wetness: 1, 'stats.maxTyreTemp': 1, 'stats.avgSpeed': 1 } }
    ]);
    res.json({ carId: req.carId, laps: rows });
  }));

  /* ---------- alerts ---------- */
  r.get('/alerts', wrap(async (req, res) => {
    if (req.user.role === 'viewer') return res.status(401).json({ error: 'sign in to see alerts' });
    const filter = { sessionId: hub.session.sessionId };
    if (req.user.role !== 'race_control') filter.team = req.user.team;
    if (req.query.status === 'open') filter.acknowledged = false;
    res.json({ alerts: await Alert.find(filter).sort({ ts: -1 }).limit(200).lean() });
  }));
  r.post('/alerts/:id/ack', requireRole('race_control', 'engineer'), wrap(async (req, res) => {
    const alert = await Alert.findById(req.params.id).lean().catch(() => null);
    if (!alert) return res.status(404).json({ error: 'alert not found' });
    if (!canSeeTeam(req.user, alert.team)) return res.status(403).json({ error: 'forbidden' });
    const updated = await hub.ackAlert(req.params.id, req.user);
    res.json({ ok: !!updated });
  }));

  /* ---------- strategy ---------- */
  r.get('/strategy/:carId', carGuard, (req, res) => {
    const result = hub.strategy.latest.get(req.carId) || hub.strategy.compute(req.carId);
    if (!result) return res.status(409).json({ error: 'car has no telemetry yet' });
    res.json(result);
  });
  const scenarioSchema = z.object({
    rain: z.object({ inLaps: z.number().min(0).max(40), durationLaps: z.number().min(1).max(40).default(5), intensity: z.number().min(0.05).max(1).default(0.6) }).optional(),
    noRain: z.boolean().optional(),
    safetyCar: z.object({ inLaps: z.number().int().min(0).max(40), laps: z.number().int().min(1).max(8).default(3), type: z.enum(['SC', 'VSC']).default('SC') }).optional(),
    degMultiplier: z.number().min(0.5).max(2).optional(),
    rivalPit: z.object({ carId: z.string(), inLaps: z.number().int().min(0).max(40).default(0), compound: z.enum(ALL_COMPOUNDS).default('H') }).optional()
  }).strict();
  r.post('/strategy/:carId/whatif', carGuard, (req, res) => {
    const scenario = parse(scenarioSchema, req.body || {}, res);
    if (!scenario) return;
    const started = performance.now();
    const result = hub.strategy.compute(req.carId, scenario);
    if (!result) return res.status(409).json({ error: 'car has no telemetry yet' });
    res.json({ ...result, ms: Math.round(performance.now() - started) });
  });
  r.post('/strategy/:carId/apply', carGuard, requireRole('race_control', 'engineer'), (req, res) => {
    const body = parse(z.object({ compound: z.enum(ALL_COMPOUNDS), lap: z.number().int().min(0).max(500).optional() }), req.body, res);
    if (!body) return;
    try {
      const s = hub.strategy.schedule(req.carId, { lap: body.lap, compound: body.compound, by: req.user.username });
      if (s.immediate) hub.pitCall(req.carId, body.compound, req.user.username);
      else hub.emit('command', { sessionId: hub.session.sessionId, type: 'pit-scheduled', carId: req.carId, payload: s, by: req.user.username, ts: new Date(), team: CAR_BY_ID[req.carId].team });
      res.json({ ok: true, ...s });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });
  r.delete('/strategy/:carId/scheduled', carGuard, requireRole('race_control', 'engineer'), (req, res) => {
    res.json({ ok: hub.strategy.cancel(req.carId) });
  });

  /* ---------- race control ---------- */
  const rc = Router();
  rc.use(requireRole('race_control'));
  rc.post('/session', wrap(async (req, res) => {
    const body = parse(z.object({ action: z.enum(['new', 'pause', 'resume', 'finish']), type: z.enum(['practice', 'qualifying', 'race']).default('race') }), req.body, res);
    if (!body) return;
    try {
      if (body.action === 'new') await hub.newSession(body.type);
      if (body.action === 'pause') hub.setStatus('paused');
      if (body.action === 'resume') hub.setStatus('running');
      if (body.action === 'finish') await hub.finishSession();
      hub.simCommand({ type: 'session-' + body.action }, req.user);
      res.json({ ok: true, session: hub.publicSession() });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  }));
  rc.post('/track-status', (req, res) => {
    const body = parse(z.object({ status: z.enum(['GREEN', 'YELLOW', 'VSC', 'SC', 'RED']) }), req.body, res);
    if (!body) return;
    hub.setTrackStatus(body.status);
    hub.simCommand({ type: 'track-status', status: body.status }, req.user);
    res.json({ ok: true });
  });
  rc.post('/weather', (req, res) => {
    const body = parse(z.object({
      action: z.enum(['shower', 'clear']),
      inLaps: z.number().min(0).max(30).default(3),
      durationLaps: z.number().min(0.5).max(30).default(5),
      intensity: z.number().min(0.05).max(1).default(0.6)
    }), req.body, res);
    if (!body) return;
    const lapSec = 91 + hub.strategy.residualFor(hub.race.order()[0]?.id);
    if (body.action === 'clear') hub.weather.clear();
    else hub.weather.schedule({ inSec: body.inLaps * lapSec, durationSec: body.durationLaps * lapSec, intensity: body.intensity });
    hub.simCommand({ type: 'weather', ...body }, req.user);
    hub.broadcastSession({ event: 'weather' });
    res.json({ ok: true, weather: hub.weather.snapshot(lapSec) });
  });
  rc.post('/incident', (req, res) => {
    const body = parse(z.object({ type: z.enum(['puncture', 'brake-fade', 'engine', 'tyre-overheat']), carId: z.string() }), req.body, res);
    if (!body) return;
    const carId = body.carId.toUpperCase();
    if (!CAR_BY_ID[carId]) return res.status(404).json({ error: 'unknown car' });
    hub.simCommand({ type: body.type, carId }, req.user);
    res.json({ ok: true });
  });
  rc.post('/stream', (req, res) => {
    const body = parse(z.object({ hz: z.number().int().min(1).max(100).optional(), burst: z.object({ hz: z.number().int().min(1).max(200), seconds: z.number().int().min(1).max(60) }).optional() }), req.body, res);
    if (!body) return;
    if (body.hz) hub.setSimRate(body.hz);
    if (body.burst) hub.simCommand({ type: 'burst', ...body.burst }, req.user);
    res.json({ ok: true, hz: hub.session.simHz });
  });
  rc.get('/commands', wrap(async (_req, res) => {
    res.json({ commands: await Command.find({ sessionId: hub.session.sessionId }).sort({ ts: -1 }).limit(100).lean() });
  }));
  r.use('/control', rc);

  /* ---------- post-session analysis (public, like official timing) ---------- */
  r.use('/analysis', analysisRouter(hub));

  /* ---------- metrics ---------- */
  r.get('/metrics', (_req, res) => {
    const snap = hub.metrics.snapshot();
    snap.rejections = Object.fromEntries(hub.rejections);
    snap.sequencer = hub.sequencer.counters;
    res.json(snap);
  });

  return r;
}
