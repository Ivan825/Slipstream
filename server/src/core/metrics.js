import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Rolling percentile reservoir */
class Reservoir {
  constructor(size = 4000) { this.size = size; this.buf = new Float64Array(size); this.n = 0; this.i = 0; }
  add(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.size; this.n = Math.min(this.size, this.n + 1); }
  pct(p) {
    if (!this.n) return 0;
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  }
  reset() { this.n = 0; this.i = 0; }
}

/**
 * Pipeline metrics. Monotonic counters are converted to per-second rates once a
 * second, and the last 120 seconds are kept for the Systems page charts.
 */
export class Metrics {
  constructor() {
    this.c = {
      received: 0, accepted: 0, rejected: 0, limited: 0, duplicates: 0, late: 0, reordered: 0, gaps: 0,
      dbWritten: 0, dbDupKeys: 0, dbDropped: 0, dbBatches: 0, dbErrors: 0,
      bcMessages: 0, bcBytes: 0, bcDropped: 0, alerts: 0, strategyRuns: 0
    };
    this.g = { dbBuffer: 0, dbLastBatchMs: 0, dbLastBatchSize: 0, clients: 0, slowClients: 0, sources: 0, roles: {} };
    this.procLatency = new Reservoir();   // server receive -> broadcast
    this.e2eLatency = new Reservoir();    // source timestamp -> broadcast
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
    this.prev = { ...this.c };
    this.rates = {};
    this.history = [];
    this.peak = { ingestPerSec: 0, clients: 0 };
    this.startedAt = Date.now();
  }

  inc(key, n = 1) { this.c[key] += n; }

  tick() {
    // normalise by the real interval: under load the 1 s timer can fire late
    const now = performance.now();
    const secs = this.lastTick ? Math.max(0.2, (now - this.lastTick) / 1000) : 1;
    this.lastTick = now;
    const r = {};
    for (const k of Object.keys(this.c)) r[k] = Math.round((this.c[k] - (this.prev[k] || 0)) / secs);
    this.prev = { ...this.c };
    this.rates = r;
    const point = {
      t: Date.now(),
      ingest: r.received,
      accepted: r.accepted,
      rejected: r.rejected + r.limited,
      dup: r.duplicates,
      dbWritten: r.dbWritten,
      bcMessages: r.bcMessages,
      bcKB: Math.round(r.bcBytes / 102.4) / 10,
      p95: Math.round(this.procLatency.pct(95) * 10) / 10,
      loopLag: Math.round((this.loop.percentile(99) / 1e6) * 10) / 10,
      clients: this.g.clients
    };
    this.history.push(point);
    if (this.history.length > 120) this.history.shift();
    this.peak.ingestPerSec = Math.max(this.peak.ingestPerSec, r.received);
    this.peak.clients = Math.max(this.peak.clients, this.g.clients);
    this.loop.reset();
    return point;
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      t: Date.now(),
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      totals: this.c,
      rates: this.rates,
      gauges: this.g,
      latency: {
        procP50: round(this.procLatency.pct(50)), procP95: round(this.procLatency.pct(95)), procP99: round(this.procLatency.pct(99)),
        e2eP50: round(this.e2eLatency.pct(50)), e2eP95: round(this.e2eLatency.pct(95)), e2eP99: round(this.e2eLatency.pct(99))
      },
      peak: this.peak,
      memoryMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      history: this.history.slice(-60)
    };
  }
}
const round = (x) => Math.round(x * 10) / 10;
