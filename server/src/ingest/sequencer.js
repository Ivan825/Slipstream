/**
 * Per-source sequencer: duplicate detection + a short reorder buffer.
 *
 *  - Every frame carries a per-source, strictly increasing `seq`.
 *  - A frame whose seq was already seen (recent window or pending) is a DUPLICATE: dropped.
 *  - Frames are applied to live state strictly in seq order. If seq N+2 arrives
 *    before N+1, it waits in `pending` for up to `windowMs`; if N+1 shows up in
 *    time the pair is applied in order (counted as REORDERED). If not, we skip
 *    ahead and count a GAP.
 *  - A frame older than the last applied seq is LATE: it is still stored to the
 *    history (so history is complete) but never rewinds the live state.
 *  - A large backwards jump means the source restarted: its state is reset.
 */
export class Sequencer {
  constructor({ windowMs = 100, recent = 2048 } = {}) {
    this.windowMs = windowMs;
    this.recent = recent;
    this.sources = new Map();
    this.counters = { duplicates: 0, late: 0, reordered: 0, gaps: 0, resets: 0 };
  }

  state(id) {
    let s = this.sources.get(id);
    if (!s) {
      s = { last: null, pending: new Map(), seen: new Set(), seenQ: [], maxArrived: 0 };
      this.sources.set(id, s);
    }
    return s;
  }

  remember(s, seq) {
    s.seen.add(seq);
    s.seenQ.push(seq);
    if (s.seenQ.length > this.recent) s.seen.delete(s.seenQ.shift());
  }

  /**
   * Classify an incoming frame. Returns 'ok' (queued for in-order apply),
   * 'late' (store only) or 'dup' (drop).
   */
  accept(frame, now = Date.now()) {
    const s = this.state(frame.carId);
    const seq = frame.seq;
    if (s.last !== null && seq < s.last - 5000) {
      // source restarted with a fresh counter
      this.sources.delete(frame.carId);
      this.counters.resets++;
      return this.accept(frame, now);
    }
    if (s.seen.has(seq) || s.pending.has(seq)) {
      this.counters.duplicates++;
      return 'dup';
    }
    this.remember(s, seq);
    if (s.last === null) s.last = seq - 1;
    if (seq <= s.last) {
      this.counters.late++;
      return 'late';
    }
    if (seq < s.maxArrived) this.counters.reordered++;
    s.maxArrived = Math.max(s.maxArrived, seq);
    s.pending.set(seq, { frame, at: now });
    return 'ok';
  }

  /** Release frames that can now be applied in order. Calls apply(frame) for each. */
  drain(id, now, apply) {
    const s = this.sources.get(id);
    if (!s) return 0;
    let released = 0;
    for (;;) {
      const next = s.last + 1;
      const hit = s.pending.get(next);
      if (hit) {
        s.pending.delete(next);
        s.last = next;
        apply(hit.frame);
        released++;
        continue;
      }
      if (!s.pending.size) break;
      // something is missing; wait for it unless the oldest pending frame has waited too long
      let minSeq = Infinity, oldest = Infinity;
      for (const [seq, p] of s.pending) {
        if (seq < minSeq) minSeq = seq;
        if (p.at < oldest) oldest = p.at;
      }
      if (now - oldest >= this.windowMs) {
        this.counters.gaps += minSeq - next;
        s.last = minSeq - 1;
        continue;
      }
      break;
    }
    return released;
  }

  drainAll(now, apply) {
    for (const id of this.sources.keys()) this.drain(id, now, apply);
  }

  lastSeq(id) {
    return this.sources.get(id)?.last ?? null;
  }
}
