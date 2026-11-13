import { log } from '../lib/log.js';

/**
 * Buffered, batched MongoDB writer.
 *
 *  - Frames are queued in memory and flushed with one unordered insertMany every
 *    `batchMs` (or sooner when `batchMax` frames are waiting).
 *  - Only one flush is in flight at a time; if MongoDB is slow, frames queue up.
 *  - Backpressure: if the queue exceeds `bufferMax`, the oldest raw frames are
 *    shed (and counted). The live path never waits on the database.
 *  - Duplicate-key errors (E11000) are expected and harmless: the unique index
 *    on (sessionId, carId, seq) makes writes idempotent.
 */
export class BatchWriter {
  constructor({ collection, metrics, batchMs = 500, batchMax = 2000, bufferMax = 60000 }) {
    this.collection = collection;
    this.metrics = metrics;
    this.batchMs = batchMs;
    this.batchMax = batchMax;
    this.bufferMax = bufferMax;
    this.queue = [];
    this.inFlight = false;
    this.timer = setInterval(() => this.flush(), batchMs);
  }

  push(doc) {
    this.queue.push(doc);
    if (this.queue.length > this.bufferMax) {
      const drop = this.queue.length - this.bufferMax;
      this.queue.splice(0, drop);
      this.metrics.inc('dbDropped', drop);
    }
    if (this.queue.length >= this.batchMax && !this.inFlight) this.flush();
    this.metrics.g.dbBuffer = this.queue.length;
  }

  async flush() {
    if (this.inFlight || !this.queue.length) return;
    this.inFlight = true;
    const batch = this.queue.splice(0, this.batchMax * 2);
    const started = performance.now();
    try {
      const res = await this.collection.insertMany(batch, { ordered: false });
      this.metrics.inc('dbWritten', res.insertedCount ?? batch.length);
    } catch (err) {
      const inserted = err?.result?.insertedCount ?? err?.insertedCount ?? 0;
      const writeErrors = err?.writeErrors ? (Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]) : [];
      const dupes = writeErrors.filter((e) => (e.code ?? e.err?.code) === 11000).length;
      this.metrics.inc('dbWritten', inserted);
      this.metrics.inc('dbDupKeys', dupes);
      if (dupes !== writeErrors.length || !writeErrors.length) {
        this.metrics.inc('dbErrors');
        log.warn('batch write failed:', err.message);
        if (!writeErrors.length) this.queue.unshift(...batch.slice(0, this.bufferMax - this.queue.length)); // retry later
      }
    } finally {
      this.metrics.inc('dbBatches');
      this.metrics.g.dbLastBatchMs = Math.round(performance.now() - started);
      this.metrics.g.dbLastBatchSize = batch.length;
      this.metrics.g.dbBuffer = this.queue.length;
      this.inFlight = false;
    }
  }

  async close() {
    clearInterval(this.timer);
    while (this.queue.length) {
      if (this.inFlight) await new Promise((r) => setTimeout(r, 20));
      else await this.flush();
    }
  }
}
