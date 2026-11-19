/**
 * Decides which raw telemetry frames are written to MongoDB.
 *
 * Every frame still drives the live pipeline (race state, alerts, broadcasts and the
 * in-memory hot cache, which covers the last couple of minutes per car). Only the
 * copy sent to the database is thinned, because on hosted tiers that write stream
 * is the main source of outbound bandwidth (about 300 MB an hour at 200 frames/s).
 *
 *  - `every`: keep one frame in N per source (1 keeps all).
 *  - `idleAfterMs`: once nobody has been connected for this long, write nothing
 *    (0 disables idling). The host can also be allowed to sleep while idle.
 */
export class PersistGate {
  constructor({ every = 1, idleAfterMs = 0, now = Date.now() } = {}) {
    this.every = Math.max(1, Math.floor(every) || 1);
    this.idleAfterMs = Math.max(0, idleAfterMs || 0);
    this.lastSeenAt = now;
    this.counts = new Map();
  }

  /** record that someone is watching */
  seen(now = Date.now()) { this.lastSeenAt = now; }

  idle(now = Date.now()) {
    return this.idleAfterMs > 0 && now - this.lastSeenAt > this.idleAfterMs;
  }

  /** true when this source's frame should be stored */
  keep(sourceId, now = Date.now()) {
    if (this.idle(now)) return false;
    if (this.every === 1) return true;
    const n = this.counts.get(sourceId) || 0;
    this.counts.set(sourceId, n + 1 >= this.every ? 0 : n + 1);
    return n === 0;
  }
}
