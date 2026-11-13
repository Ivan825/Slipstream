import { z } from 'zod';
import { CAR_STATUS } from '@slipstream/shared';

const n = z.number().finite();

/** One telemetry frame from a data source. Strict: unknown keys are rejected. */
export const FrameSchema = z.object({
  carId: z.string().min(1).max(24).regex(/^[A-Za-z0-9-]+$/),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().int().positive(),
  lap: z.number().int().min(0).max(1000),
  d: n.min(0).max(20000),
  v: n.min(0).max(420),
  thr: n.min(0).max(1),
  brk: n.min(0).max(1),
  g: z.number().int().min(0).max(8),
  rpm: n.min(0).max(16000),
  drs: z.union([z.literal(0), z.literal(1)]),
  ers: n.min(0).max(100),
  fuel: n.min(0).max(150),
  tc: z.enum(['S', 'M', 'H', 'I', 'W']),
  ta: z.number().int().min(0).max(500),
  tw: n.min(0).max(100),
  tt: z.array(n.min(-30).max(260)).length(12),
  tp: z.array(n.min(0).max(40)).length(4),
  bt: z.array(n.min(0).max(1800)).length(4),
  et: n.min(0).max(220),
  ot: n.min(0).max(240),
  st: z.enum(CAR_STATUS)
}).strict();

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Returns { ok: true, frame } or { ok: false, reason } */
export function validateFrame(raw, sourceId, now = Date.now()) {
  const r = FrameSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: 'schema:' + (r.error.issues[0]?.path.join('.') || 'invalid') };
  const f = r.data;
  if (f.carId !== sourceId) return { ok: false, reason: 'source-mismatch' };
  if (Math.abs(f.ts - now) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'clock-skew' };
  return { ok: true, frame: f };
}
