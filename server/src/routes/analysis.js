import { Router } from 'express';
import { getTrack, CAR_BY_ID, FUEL_EFFECT_PER_KG } from '@slipstream/shared';
import { Lap, Session, PitStop } from '../models/index.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const FUEL_MS_PER_KG = Math.round(FUEL_EFFECT_PER_KG * 1000);
const MINI_SECTORS = 25;

/**
 * Post-session analysis, published to everyone like official timing documents.
 * Heavy lifting happens inside MongoDB aggregation pipelines.
 */
export function analysisRouter(hub) {
  const r = Router();

  const resolveSession = async (id) => {
    if (id === 'current') return Session.findOne({ sessionId: hub.session.sessionId }).lean();
    if (id === 'latest') return Session.findOne({ status: 'finished' }).sort({ endedAt: -1 }).lean();
    return Session.findOne({ sessionId: id }).lean();
  };

  r.get('/sessions', wrap(async (_req, res) => {
    const sessions = await Session.find({}, { _id: 0, results: 0 }).sort({ startedAt: -1 }).limit(40).lean();
    const counts = await Lap.aggregate([{ $group: { _id: '$sessionId', laps: { $sum: 1 } } }]);
    const byId = new Map(counts.map((c) => [c._id, c.laps]));
    res.json({ sessions: sessions.map((s) => ({ ...s, laps: byId.get(s.sessionId) || 0 })) });
  }));

  r.get('/:sessionId', wrap(async (req, res) => {
    const session = await resolveSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const sessionId = session.sessionId;
    const started = performance.now();

    const [laps, stints, drivers, pitStops, sectorBests] = await Promise.all([
      Lap.find({ sessionId }, { _id: 0, trace: 0 }).sort({ carId: 1, lap: 1 }).lean(),

      // degradation per stint: least squares of fuel-corrected lap time on tyre age
      Lap.aggregate([
        { $match: { sessionId, valid: true, wetness: { $lt: 0.15 } } },
        { $addFields: {
          stintStart: { $subtract: ['$lap', '$tyreAge'] },
          corr: { $subtract: ['$timeMs', { $multiply: [{ $ifNull: ['$fuel', 0] }, FUEL_MS_PER_KG] }] }
        } },
        { $group: {
          _id: { carId: '$carId', compound: '$compound', stintStart: '$stintStart' },
          n: { $sum: 1 }, sx: { $sum: '$tyreAge' }, sy: { $sum: '$corr' },
          sxy: { $sum: { $multiply: ['$tyreAge', '$corr'] } }, sxx: { $sum: { $multiply: ['$tyreAge', '$tyreAge'] } },
          best: { $min: '$timeMs' }, avg: { $avg: '$timeMs' }, avgCorr: { $avg: '$corr' }, sd: { $stdDevSamp: '$timeMs' },
          fromLap: { $min: '$lap' }, toLap: { $max: '$lap' },
          points: { $push: { age: '$tyreAge', t: '$corr', lap: '$lap', raw: '$timeMs' } }
        } },
        { $addFields: { denom: { $subtract: [{ $multiply: ['$n', '$sxx'] }, { $multiply: ['$sx', '$sx'] }] } } },
        { $addFields: { slopeMs: { $cond: [{ $and: [{ $gte: ['$n', 3] }, { $ne: ['$denom', 0] }] }, { $divide: [{ $subtract: [{ $multiply: ['$n', '$sxy'] }, { $multiply: ['$sx', '$sy'] }] }, '$denom'] }, null] } } },
        { $addFields: { interceptMs: { $cond: [{ $ne: ['$slopeMs', null] }, { $divide: [{ $subtract: ['$sy', { $multiply: ['$slopeMs', '$sx'] }] }, '$n'] }, null] } } },
        { $project: { _id: 0, carId: '$_id.carId', compound: '$_id.compound', stintStart: '$_id.stintStart', n: 1, best: 1, avg: 1, avgCorr: 1, sd: 1, fromLap: 1, toLap: 1, slopeMs: 1, interceptMs: 1, points: 1 } },
        { $sort: { carId: 1, fromLap: 1 } }
      ]),

      // per driver: pace, consistency, speed trap
      Lap.aggregate([
        { $match: { sessionId } },
        { $group: {
          _id: '$carId', team: { $first: '$team' }, laps: { $sum: 1 },
          validLaps: { $sum: { $cond: ['$valid', 1, 0] } },
          best: { $min: { $cond: ['$valid', '$timeMs', null] } },
          median: { $median: { input: { $cond: ['$valid', '$timeMs', null] }, method: 'approximate' } },
          sd: { $stdDevSamp: { $cond: ['$valid', '$timeMs', null] } },
          vmax: { $max: '$stats.maxSpeed' }, maxTyre: { $max: '$stats.maxTyreTemp' }, maxBrake: { $max: '$stats.maxBrakeTemp' },
          fuelPerLap: { $avg: '$stats.fuelUsed' }
        } },
        { $sort: { best: 1 } }
      ]),

      PitStop.find({ sessionId }, { _id: 0 }).sort({ enterTs: 1 }).lean(),

      // best sector times per driver -> ideal (theoretical best) lap
      Lap.aggregate([
        { $match: { sessionId, 'sectors.2': { $ne: null } } },
        { $group: {
          _id: '$carId',
          s1: { $min: { $arrayElemAt: ['$sectors', 0] } }, s2: { $min: { $arrayElemAt: ['$sectors', 1] } }, s3: { $min: { $arrayElemAt: ['$sectors', 2] } },
          best: { $min: { $cond: ['$valid', '$timeMs', null] } }
        } },
        { $addFields: { ideal: { $add: ['$s1', '$s2', '$s3'] } } },
        { $addFields: { lostToIdeal: { $subtract: ['$best', '$ideal'] } } },
        { $sort: { ideal: 1 } }
      ])
    ]);

    const sessionBest = [0, 1, 2].map((k) => Math.min(...sectorBests.map((s) => s['s' + (k + 1)]).filter((x) => x != null)));
    const fieldMedian = (() => {
      const v = drivers.map((d) => d.median).filter(Boolean).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })();
    // pit loss: pit lane time minus the time to cover the same stretch at racing speed
    const t = getTrack();
    const laneLen = t.L - t.pit.entry + t.pit.exit;
    let laneRef = 0;
    for (let i = 0; i < t.N; i++) {
      const d = t.cum[i];
      if (d >= t.pit.entry || d <= t.pit.exit) laneRef += (t.cum[i + 1] - t.cum[i]) / t.vRef[i];
    }
    const stops = pitStops.map((p) => ({ ...p, lossMs: Math.round(p.laneMs - laneRef * 1000) }));

    res.json({
      session, laps, stints, drivers, pitStops: stops, sectorBests, sessionBestSectors: sessionBest,
      reference: { fieldMedianMs: fieldMedian, laneLengthM: Math.round(laneLen), laneRacingS: Math.round(laneRef * 10) / 10, fuelMsPerKg: FUEL_MS_PER_KG },
      ms: Math.round(performance.now() - started)
    });
  }));

  /** best valid lap (with 25 m trace) for each requested car */
  r.get('/:sessionId/traces', wrap(async (req, res) => {
    const session = await resolveSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const cars = String(req.query.cars || '').toUpperCase().split(',').filter((c) => CAR_BY_ID[c]).slice(0, 4);
    if (!cars.length) return res.status(400).json({ error: 'cars=KAL,VOS required' });
    const specific = req.query.laps ? String(req.query.laps).split(',').map((x) => Number(x)) : null;
    const laps = await Promise.all(cars.map((carId, i) => {
      const q = { sessionId: session.sessionId, carId };
      if (specific?.[i]) return Lap.findOne({ ...q, lap: specific[i] }, { _id: 0 }).lean();
      return Lap.findOne({ ...q, valid: true }, { _id: 0 }).sort({ timeMs: 1 }).lean();
    }));
    res.json({ sessionId: session.sessionId, laps: laps.filter(Boolean) });
  }));

  /** track dominance: fastest driver through each of 25 equal-length mini-sectors */
  r.get('/:sessionId/dominance', wrap(async (req, res) => {
    const session = await resolveSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const best = await Lap.aggregate([
      { $match: { sessionId: session.sessionId, valid: true } },
      { $sort: { timeMs: 1 } },
      { $group: { _id: '$carId', team: { $first: '$team' }, timeMs: { $first: '$timeMs' }, d: { $first: '$trace.d' }, t: { $first: '$trace.t' } } }
    ]);
    const L = getTrack().L;
    const timeAt = (lap, x) => {
      const { d, t: tt } = lap;
      for (let i = 1; i < d.length; i++) {
        if (d[i] >= x) { const f = (x - d[i - 1]) / ((d[i] - d[i - 1]) || 1); return tt[i - 1] + f * (tt[i] - tt[i - 1]); }
      }
      return tt[tt.length - 1];
    };
    const sectors = [];
    for (let k = 0; k < MINI_SECTORS; k++) {
      const a = (k / MINI_SECTORS) * L, b = ((k + 1) / MINI_SECTORS) * L;
      let win = null;
      for (const lap of best) {
        if (!lap.d?.length) continue;
        const ms = timeAt(lap, b) - timeAt(lap, a);
        if (!win || ms < win.ms) win = { carId: lap._id, team: lap.team, ms: Math.round(ms) };
      }
      sectors.push({ from: a, to: b, ...win });
    }
    const count = {};
    for (const s of sectors) if (s.carId) count[s.carId] = (count[s.carId] || 0) + 1;
    res.json({ sessionId: session.sessionId, miniSectors: MINI_SECTORS, sectors, count, cars: best.map((b) => ({ carId: b._id, team: b.team, timeMs: b.timeMs })) });
  }));

  return r;
}
