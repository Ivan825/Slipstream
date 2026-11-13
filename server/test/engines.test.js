import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaceSim } from '../../simulator/src/model.js';
import { RaceState } from '../src/core/raceState.js';
import { StrategyEngine } from '../src/core/strategy.js';
import { AnomalyEngine, Ewma } from '../src/core/anomaly.js';
import { Weather } from '../src/core/weather.js';

/**
 * Drive the real simulator model offline (no sockets, no DB) through the race
 * state, anomaly and strategy engines. Simulated time is mapped onto the frame
 * timestamps so ~4 minutes of racing runs in about a second.
 */
function runRace(seconds, { onSim } = {}) {
  const sim = new RaceSim({ carCount: 20, totalLaps: 36, seed: 42 });
  sim.setSession({ status: 'running' });
  const laps = [];
  const alerts = [];
  const race = new RaceState({ onLap: (l) => laps.push(l) });
  race.reset('test', 36);
  const anomaly = new AnomalyEngine({ raise: (a) => alerts.push(a), cooldownMs: 0 });
  const t0 = Date.now();
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    onSim?.(sim, t);
    sim.step(dt);
    for (const car of sim.cars) {
      for (const f of sim.drain(car)) {
        f.ts = t0 + Math.round(t * 1000);
        const c = race.apply(f);
        anomaly.check(c, f, { trackStatus: 'GREEN' });
      }
    }
  }
  return { sim, race, laps, alerts };
}

test('race state times laps and sectors from the stream', () => {
  const { laps, race } = runRace(240);
  assert.ok(laps.length >= 20, `expected laps, got ${laps.length}`);
  const valid = laps.filter((l) => l.valid);
  assert.ok(valid.length > 0);
  for (const l of valid) {
    assert.ok(l.timeMs > 85_000 && l.timeMs < 110_000, `lap time ${l.timeMs}`);
    const sum = l.sectors.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - l.timeMs) < 60, 'sectors add up to the lap time');
    assert.ok(l.trace.d.length > 150, 'lap carries a 25 m trace');
  }
  const rows = race.timingRows();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].gap, 0);
  assert.ok(rows.slice(1).every((r) => r.gap == null || r.gap >= 0), 'gaps behind the leader are positive');
  assert.ok(race.fastest?.timeMs > 0);
});

test('anomaly engine catches an injected puncture and tyre overheat', () => {
  const { alerts } = runRace(150, {
    onSim: (sim, t) => {
      if (Math.abs(t - 100) < 0.025) sim.command({ type: 'puncture', carId: 'KAL', corner: 'RL' });
      if (Math.abs(t - 90) < 0.025) sim.command({ type: 'tyre-overheat', carId: 'VOS' });
    }
  });
  assert.ok(alerts.some((a) => a.type === 'PUNCTURE' && a.carId === 'KAL'), 'puncture detected');
  assert.ok(alerts.some((a) => a.type === 'TYRE_OVERHEAT' && a.carId === 'VOS'), 'overheat detected');
});

test('EWMA z-score flags an outlier only', () => {
  const e = new Ewma(0.1);
  for (let i = 0; i < 200; i++) e.update(800 + (i % 7) * 5);
  assert.ok(Math.abs(e.z(815)) < 2);
  assert.ok(e.z(1200) > 5);
});

test('strategy engine ranks plans and reacts to forecast rain', () => {
  const { race } = runRace(200);
  const weather = new Weather({ random: false });
  const session = { totalLaps: 36, trackStatus: 'GREEN' };
  const strat = new StrategyEngine({ race, weather, getSession: () => session });
  const dry = strat.compute('KAL');
  assert.ok(dry.options.length >= 2);
  assert.equal(dry.options[0].recommended, true);
  assert.equal(dry.options[0].delta, 0);
  assert.ok(dry.options.every((o, i) => i === 0 || o.delta >= 0), 'recommended plan is the fastest');
  assert.ok(!dry.options[0].stops.some((s) => s.compound === 'I' || s.compound === 'W'), 'no wet tyres in the dry');

  const wet = strat.compute('KAL', { rain: { inLaps: 3, durationLaps: 30, intensity: 0.8 } });
  assert.ok(wet.options[0].stops.some((s) => s.compound === 'I' || s.compound === 'W'), 'rain forecast leads to a wet-tyre crossover');
  assert.ok(wet.insights.some((i) => /Rain crossover/.test(i.title)));

  session.trackStatus = 'SC';
  const sc = strat.compute('KAL');
  assert.ok(sc.insights.some((i) => /cheap pit stop/.test(i.title)));
});

test('weather: wetness follows rain with lag and the forecast sees showers coming', () => {
  const w = new Weather({ random: false, rng: () => 0.5 });
  w.schedule({ inSec: 120, durationSec: 600, intensity: 0.8 });
  const f = w.forecast(10, 90);
  assert.ok(f[0].rainProb < 0.3, "only a small near-miss probability before the shower");
  assert.ok(f.slice(1, 4).some((x) => x.rainProb > 0.5));
  const future = w.predictWetness([Date.now() + 60_000, Date.now() + 600_000]);
  assert.ok(future[0] < 0.05 && future[1] > 0.5);
});
