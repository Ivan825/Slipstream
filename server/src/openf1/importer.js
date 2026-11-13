import { SessionSource, CHUNK_MS } from './source.js';
import { log } from '../lib/log.js';

/**
 * Pre-download a session into MongoDB (metadata + car-data chunks), so the
 * first viewer doesn't wait for OpenF1. `minutes = 0` downloads the whole session.
 */
export async function importSession(key, { minutes = 15, onProgress = () => {} } = {}) {
  const src = new SessionSource(Number(key));
  const meta = await src.loadMeta();
  const total = src.chunkCount();
  const n = minutes > 0 ? Math.min(total, Math.ceil((minutes * 60_000) / CHUNK_MS)) : total;
  onProgress(`${meta.name}: ${meta.drivers.length} drivers, ${meta.events} events, ${total} chunks`);
  let frames = 0;
  for (let i = 0; i < n; i++) {
    if (src.chunks.has(i)) continue;
    const c = await src.chunk(i);
    frames += c.frames.length;
    onProgress(`chunk ${i + 1}/${n}: ${c.frames.length} frames`);
  }
  log.info(`openf1: ${meta.name} pre-downloaded (${n} of ${total} chunks, ${frames} new frames)`);
  return { ...meta, frames };
}
