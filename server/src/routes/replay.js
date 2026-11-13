import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ReplaySession } from '../models/index.js';
import { catalog, liveAvailable } from '../openf1/client.js';

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
      const cached = await ReplaySession.find({ v: 2 }, { _id: 0, key: 1, name: 1, complete: 1, chunks: 1, from: 1, to: 1, chunkMs: 1 }).sort({ importedAt: -1 }).limit(30).lean();
      res.json({
        live: liveAvailable(),
        channels: hub.replays.list(),
        cached: cached.map((c) => ({ key: c.key, name: c.name, complete: c.complete, recorded: Math.round(((c.chunks?.length || 0) * (c.chunkMs || 120000)) / 60000), minutes: Math.round((+c.to - +c.from) / 60000) }))
      });
    } catch (e) { next(e); }
  });

  r.post('/open', openLimiter, async (req, res) => {
    const p = z.object({ key: z.union([z.number().int().positive(), z.literal('live')]) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'key (OpenF1 session_key) or "live" required' });
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

  r.get('/:key/state', (req, res) => {
    const ch = hub.replays.get(req.params.key);
    if (!ch) return res.status(404).json({ error: 'channel not open' });
    res.json(ch.snapshot());
  });

  const controlLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many playback changes, slow down' } });
  // anyone watching can drive the channel's shared clock (rate-limited), like a watch party
  r.post('/:key/control', controlLimiter, (req, res) => {
    const ch = hub.replays.get(req.params.key);
    if (!ch) return res.status(404).json({ error: 'channel not open' });
    const p = z.object({ action: z.enum(['play', 'pause', 'seek', 'speed', 'restart']), t: z.number().min(0).optional(), speed: z.number().min(0.25).max(16).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid control' });
    try { res.json(ch.control(p.data)); } catch (e) { res.status(409).json({ error: e.message }); }
  });

  return r;
}
