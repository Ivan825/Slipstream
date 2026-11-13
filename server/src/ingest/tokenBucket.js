/**
 * Token bucket per data source. Each frame costs one token; tokens refill at
 * `refillPerSec` up to `capacity` (the allowed burst). Frames beyond the
 * available tokens are rejected and counted as rate-limited.
 */
export class TokenBuckets {
  constructor({ capacity = 300, refillPerSec = 150 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  /** Try to take `n` tokens. Returns how many were granted (0..n). */
  take(key, n = 1, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.last = now;
    const granted = Math.min(n, Math.floor(b.tokens));
    b.tokens -= granted;
    return granted;
  }

  delete(key) {
    this.buckets.delete(key);
  }
}
