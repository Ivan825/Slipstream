import { getTrack, CAR_BY_ID, CAR_INDEX, CARS } from '@slipstream/shared';

const TRACE_STEP_M = 25;

/**
 * Live race state, built only from in-order telemetry frames.
 *
 * Timing uses "timing loops" like real circuits: the lap is divided into 60
 * virtual loops; for every loop we record when each car crossed it (timestamp
 * interpolated between two frames). The gap to the leader is the difference
 * between a car's crossing time and the first car's crossing time at the same
 * loop. That gives true time gaps updated 60x per lap without any history scan.
 */
export class RaceState {
  constructor({ onLap = () => {}, onPit = () => {}, onFinish = () => {} } = {}) {
    this.track = getTrack();
    this.loopLen = this.track.L / this.track.timingLoops;
    this.onLap = onLap;
    this.onPit = onPit;
    this.onFinish = onFinish;
    this.reset('none', 36);
  }

  reset(sessionId, totalLaps) {
    this.sessionId = sessionId;
    this.totalLaps = totalLaps;
    this.cars = new Map();
    this.loopFirst = new Map();
    this.fastest = null;
    this.bestSectors = [null, null, null];
    this.finishOrder = [];
    this.trackStatus = 'GREEN';
    this.wetness = 0;
  }

  car(id) {
    let c = this.cars.get(id);
    if (c) return c;
    const meta = CAR_BY_ID[id];
    if (!meta) return null; // stress-test sources are not race cars
    c = {
      id, meta, team: meta.team, index: CAR_INDEX[id],
      frame: null, lap: 0, d: 0, v: 0, status: 'RUN',
      lapStartTs: null, lapStartSeq: null, sectorTs: [null, null], curSectors: [null, null, null],
      lastLap: null, bestLap: null, lastSectors: [null, null, null], bestSectorsPB: [null, null, null], sectorFlags: [null, null, null],
      crossings: new Map(), lastCross: null,
      trace: null, nextSample: 0, stats: null, lapFlags: { pit: false, startedInPit: false, slow: false, sc: false },
      stops: 0, stints: [], lapsCompleted: 0, finished: false, lastSeenAt: 0, lastBroadcastSeq: 0,
      hot: [], pending: [], lapHistory: []
    };
    this.cars.set(id, c);
    return c;
  }

  /** Apply one in-order frame. Returns the car state (or null for non-race sources). */
  apply(f, receivedAt = Date.now()) {
    const c = this.car(f.carId);
    if (!c) return null;
    const L = this.track.L;
    const prev = c.frame;
    c.lastSeenAt = receivedAt;

    if (prev) {
      const prevTotal = prev.lap * L + prev.d;
      const curTotal = f.lap * L + f.d;
      const span = curTotal - prevTotal;
      if (span > 0 && span < 600) {
        const interp = (x) => prev.ts + ((x - prevTotal) / span) * (f.ts - prev.ts);
        // sector boundaries within the lap
        for (let k = 0; k < 2; k++) {
          const b = f.lap * L + this.track.sectors[k];
          const bPrevLap = prev.lap * L + this.track.sectors[k];
          for (const x of [bPrevLap, b]) {
            if (x > prevTotal && x <= curTotal && c.lapStartTs != null) {
              const t = interp(x);
              c.sectorTs[k] = t;
              const start = k === 0 ? c.lapStartTs : c.sectorTs[0];
              if (start != null) this.closeSector(c, k, t - start);
            }
          }
        }
        // timing loops
        const first = Math.floor(prevTotal / this.loopLen) + 1;
        for (let m = first; m * this.loopLen <= curTotal; m++) {
          const t = interp(m * this.loopLen);
          if (!this.loopFirst.has(m)) this.loopFirst.set(m, t);
          c.crossings.set(m, t);
          c.lastCross = { m, t };
          if (c.crossings.size > 180) c.crossings.delete(c.crossings.keys().next().value);
        }
        // lap trace (25 m resolution, time since lap start)
        if (c.trace && f.lap === prev.lap) {
          while (c.nextSample <= f.d) {
            const x = f.lap * L + c.nextSample;
            if (x > prevTotal) this.pushTrace(c, c.nextSample, interp(x) - c.lapStartTs, f);
            c.nextSample += TRACE_STEP_M;
          }
        }
        // finish line
        if (f.lap > prev.lap) {
          const tCross = interp(f.lap * L);
          this.crossLine(c, prev, f, tCross);
        }
      }
    } else {
      c.stints.push({ compound: f.tc, fromLap: Math.max(1, f.lap) });
    }

    // pit tracking
    if (f.st === 'PIT' || f.st === 'OUT') c.lapFlags.pit = true;
    if (f.st === 'SLOW') c.lapFlags.slow = true;
    if (this.trackStatus === 'SC' || this.trackStatus === 'VSC' || this.trackStatus === 'RED') c.lapFlags.sc = true;
    if (prev && f.st === 'PIT' && prev.st !== 'PIT') {
      c.stops += 1;
      this.onPit({ carId: c.id, team: c.team, lap: f.lap, compound: prev.tc, stop: c.stops });
    }
    if (prev && f.tc !== prev.tc) c.stints.push({ compound: f.tc, fromLap: f.lap });

    // lap stats
    if (c.stats) {
      const s = c.stats;
      s.n++; s.sumV += f.v; s.maxV = Math.max(s.maxV, f.v);
      s.maxT = Math.max(s.maxT, ...f.tt);
      s.maxB = Math.max(s.maxB, ...f.bt);
      s.minP = Math.min(s.minP, ...f.tp);
    }

    c.frame = f;
    c.lap = f.lap; c.d = f.d; c.v = f.v; c.status = f.st;
    c.hot.push(f);
    if (c.hot.length > 1200) c.hot.splice(0, c.hot.length - 1200);
    c.pending.push(f);
    return c;
  }

  pushTrace(c, d, t, f) {
    const tr = c.trace;
    tr.d.push(Math.round(d));
    tr.t.push(Math.round(t));
    tr.v.push(Math.round(f.v));
    tr.thr.push(f.thr);
    tr.brk.push(f.brk);
    tr.g.push(f.g);
  }

  closeSector(c, k, ms) {
    if (ms <= 0) return;
    c.curSectors[k] = ms;
    const valid = !c.lapFlags.pit && !c.lapFlags.sc;
    let flag = 'y';
    if (valid && (c.bestSectorsPB[k] == null || ms < c.bestSectorsPB[k])) { c.bestSectorsPB[k] = ms; flag = 'g'; }
    if (valid && (this.bestSectors[k] == null || ms < this.bestSectors[k])) { this.bestSectors[k] = ms; flag = 'p'; }
    c.sectorFlags[k] = flag;
    if (k === 0) c.sectorFlags[1] = c.sectorFlags[2] = null;
  }

  crossLine(c, prev, f, tCross) {
    const completed = prev.lap;
    if (c.lapStartTs != null && completed >= 1) {
      const timeMs = Math.round(tCross - c.lapStartTs);
      const s3 = c.sectorTs[1] != null ? tCross - c.sectorTs[1] : null;
      if (s3 != null) this.closeSector(c, 2, s3);
      const sectors = c.curSectors.map((x) => (x == null ? null : Math.round(x)));
      const pitIn = c.lapFlags.pit && !c.lapFlags.startedInPit;
      const pitOut = c.lapFlags.startedInPit;
      const valid = !c.lapFlags.pit && !c.lapFlags.slow && !c.lapFlags.sc && sectors.every((x) => x != null) && timeMs > 30000;
      const pb = valid && (c.bestLap == null || timeMs < c.bestLap);
      const fastest = valid && (!this.fastest || timeMs < this.fastest.timeMs);
      if (pb) c.bestLap = timeMs;
      if (fastest) this.fastest = { carId: c.id, lap: completed, timeMs };
      c.lastLap = timeMs;
      c.lastSectors = sectors;
      c.lapsCompleted = completed;
      if (c.trace) this.pushTrace(c, this.track.L, timeMs, prev);
      const s = c.stats;
      const lap = {
        sessionId: this.sessionId, carId: c.id, team: c.team, lap: completed, timeMs, sectors,
        startTs: new Date(c.lapStartTs), endTs: new Date(tCross),
        compound: prev.tc, tyreAge: prev.ta, wetness: Math.round(this.wetness * 100) / 100,
        trackStatus: c.lapFlags.sc ? 'NEUTRALISED' : 'GREEN',
        valid, pitIn, pitOut, pb, fastest,
        stats: s ? {
          maxSpeed: Math.round(s.maxV), avgSpeed: Math.round(s.sumV / Math.max(1, s.n)),
          maxTyreTemp: Math.round(s.maxT), maxBrakeTemp: Math.round(s.maxB), minPsi: Math.round(s.minP * 10) / 10,
          fuelUsed: Math.round((s.fuel0 - prev.fuel) * 10) / 10
        } : null,
        startSeq: c.lapStartSeq, endSeq: prev.seq,
        trace: c.trace
      };
      c.lapHistory.push({ lap: completed, timeMs, valid, compound: prev.tc, tyreAge: prev.ta, wetness: lap.wetness, sc: c.lapFlags.sc });
      if (c.lapHistory.length > 80) c.lapHistory.shift();
      this.onLap(lap, c);
    }
    // finish
    if (f.lap > this.totalLaps && !c.finished) {
      c.finished = true;
      this.finishOrder.push(c.id);
      this.onFinish(c, this.finishOrder.length);
    }
    // start the new lap
    c.lapStartTs = tCross;
    c.lapStartSeq = f.seq;
    c.sectorTs = [null, null];
    c.curSectors = [null, null, null];
    c.trace = { d: [], t: [], v: [], thr: [], brk: [], g: [] };
    this.pushTrace(c, 0, 0, f);
    c.nextSample = TRACE_STEP_M;
    c.stats = { n: 0, sumV: 0, maxV: 0, maxT: 0, maxB: 0, minP: 99, fuel0: f.fuel };
    c.lapFlags = { pit: f.st === 'PIT' || f.st === 'OUT', startedInPit: f.st === 'PIT' || f.st === 'OUT', slow: false, sc: false };
    // prune old loop crossings
    if (this.loopFirst.size > 600) {
      const minKeep = (f.lap - 4) * this.track.timingLoops;
      for (const k of this.loopFirst.keys()) { if (k < minKeep) this.loopFirst.delete(k); else break; }
    }
  }

  /** cars ordered by race position */
  order() {
    const L = this.track.L;
    return [...this.cars.values()]
      .filter((c) => c.frame)
      .sort((a, b) => {
        const fa = this.finishOrder.indexOf(a.id), fb = this.finishOrder.indexOf(b.id);
        if (fa >= 0 || fb >= 0) return (fa < 0 ? 999 : fa) - (fb < 0 ? 999 : fb);
        return (b.lap * L + b.d) - (a.lap * L + a.d);
      });
  }

  /** time gap of car c behind the leader (s) and laps down */
  gapInfo(c, leader, ahead) {
    const L = this.track.L;
    if (c === leader) return { gap: 0, int: 0, lapsDown: 0 };
    const lapsDown = Math.floor(((leader.lap * L + leader.d) - (c.lap * L + c.d)) / L);
    let gap = null, int = null;
    if (c.lastCross) {
      const first = this.loopFirst.get(c.lastCross.m);
      if (first != null) gap = (c.lastCross.t - first) / 1000;
      const a = ahead?.crossings.get(c.lastCross.m);
      if (a != null) int = (c.lastCross.t - a) / 1000;
    }
    return { gap, int, lapsDown: Math.max(0, lapsDown) };
  }

  timingRows() {
    const order = this.order();
    const leader = order[0];
    return order.map((c, i) => {
      const g = this.gapInfo(c, leader, order[i - 1]);
      const f = c.frame;
      return {
        c: c.id,
        pos: i + 1,
        lap: c.lap,
        gap: g.gap == null ? null : Math.round(g.gap * 1000) / 1000,
        int: g.int == null ? null : Math.round(g.int * 1000) / 1000,
        down: g.lapsDown,
        last: c.lastLap,
        best: c.bestLap,
        fl: this.fastest?.carId === c.id ? 1 : 0,
        sf: c.sectorFlags.join(''),
        tc: f.tc,
        ta: f.ta,
        stops: c.stops,
        st: c.finished ? 'FIN' : f.st,
        drs: f.drs
      };
    });
  }
}

export { CARS };
