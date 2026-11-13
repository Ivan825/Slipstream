import { Router } from 'express';
import { z } from 'zod';
import { ReplaySession } from '../models/index.js';
import { requireRole } from '../auth.js';
import { importSession } from '../openf1/importer.js';
import { log } from '../lib/log.js';

/** Real-session replay (data: OpenF1, unofficial, free for non-commercial use). */
export function replayRouter(hub) {
  const r = Router();
  let importing = null;

  r.get('/sessions', async (_req, res, next) => {
    try {
      const list = await ReplaySession.find({}, { _id: 0, track: 0, stints: 0, drivers: 0 }).sort({ importedAt: -1 }).lean();
      res.json({ sessions: list, importing });
    } catch (e) { next(e); }
  });

  r.get('/state', (_req, res) => res.json(hub.replay?.snapshot() || { state: { loaded: false } }));

  r.post('/control', requireRole('race_control'), (req, res) => {
    const p = z.object({ action: z.enum(['play', 'pause', 'seek', 'speed', 'restart']), t: z.number().min(0).optional(), speed: z.number().min(0.25).max(16).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid control' });
    try { res.json(hub.replay.control(p.data)); } catch (e) { res.status(409).json({ error: e.message }); }
  });

  r.post('/load', requireRole('race_control'), async (req, res) => {
    const meta = await hub.replay.load(Number(req.body?.key)).catch(() => null);
    if (!meta) return res.status(404).json({ error: 'session not imported' });
    hub.replay.emit('replay:reload', {});
    res.json({ ok: true, name: meta.name });
  });

  r.post('/import', requireRole('race_control'), (req, res) => {
    const p = z.object({ session: z.number().int().positive(), minutes: z.number().min(2).max(30).default(15) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'session (OpenF1 session_key) required' });
    if (importing) return res.status(409).json({ error: `already importing ${importing}` });
    importing = p.data.session;
    importSession(p.data.session, { minutes: p.data.minutes })
      .then(() => hub.replay.load(p.data.session))
      .then(() => hub.replay.emit('replay:reload', {}))
      .catch((e) => log.warn('import failed', e.message))
      .finally(() => { importing = null; });
    res.status(202).json({ ok: true, importing: p.data.session });
  });

  return r;
}
