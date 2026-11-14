import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForkSim } from '../src/fork/sim.js';

/** a small real-looking session: an oval, four cars, three laps of real timing before the fork */
function session({ totalLaps = 12 } = {}) {
  const N = 200, track = [], v = [], drs = [], brk = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI;
    track.push([Math.round(8000 * Math.cos(a)), Math.round(5000 * Math.sin(a))]);
    const slow = (i > 45 && i < 55) || (i > 145 && i < 155);
    v.push(slow ? 110 : 290); drs.push(i > 170 || i < 15 ? 1 : 0); brk.push(i > 40 && i < 46 ? 1 : 0);
  }
  const drivers = [
    { n: 1, code: 'AAA', team: 'McLaren', color: '#f80' }, { n: 2, code: 'BBB', team: 'McLaren', color: '#f80' },
    { n: 3, code: 'CCC', team: 'Ferrari', color: '#f00' }, { n: 4, code: 'DDD', team: 'Ferrari', color: '#f00' }
  ];
  const meta = {
    key: 1, name: 'Test GP · Race', type: 'Race', drivers, totalLaps, track,
    info: { v, drs, brk, length: 4000, sectors: [66, 133], ref: { time: 60 } },
    stints: drivers.map((d) => ({ n: d.n, from: 1, to: null, compound: 'MEDIUM', age: 0 })).concat([{ n: 3, from: 5, to: null, compound: 'HARD', age: 0 }])
  };
  meta.stints[2].to = 4;
  const t0 = 1_000_000, events = [];
  drivers.forEach((d, k) => {
    for (let lap = 1; lap <= 3; lap++) {
      const start = t0 + (lap - 1) * 60_000 + k * 1500;
      events.push({ t: start, type: 'lapstart', data: { n: d.n, lap } });
      if (lap < 3) events.push({ t: start + 60_000, type: 'lap', data: { n: d.n, lap, time: 60 + k * 0.2, s: [20, 20, 20] } });
    }
    events.push({ t: t0, type: 'position', data: { n: d.n, pos: k + 1 } });
  });
  events.sort((a, b) => a.t - b.t);
  return { meta, events, fork: t0 + 2 * 60_000 + 8000 };
}

const run = (sim, until = () => sim.ended, max = 50_000) => {
  const out = [];
  for (let i = 0; i < max && !until(); i++) { sim.step(0.1); out.push(...sim.drain()); }
  return out;
};

test('a takeover picks up the real race where it was and runs it to the flag', () => {
  const { meta, events, fork } = session();
  const sim = ForkSim.create({ meta, events, t0: fork, team: 'McLaren', seed: 3 });
  assert.deepEqual(sim.cars.map((c) => c.lap), [3, 3, 3, 3], 'everyone is on lap 3 at the fork');
  assert.ok(sim.cars[0].ours && sim.cars[1].ours && !sim.cars[2].ours, 'the crew owns its team\'s cars');
  const out = run(sim);
  assert.ok(sim.ended, 'the race finishes');
  const laps = out.filter((e) => e.type === 'lap');
  for (const n of [1, 2, 3, 4]) assert.equal(Math.max(...laps.filter((l) => l.data.n === n).map((l) => l.data.lap)), 12, `car ${n} completes the distance`);
  const green = laps.filter((l) => !l.data.pitOut && l.data.lap > 3).map((l) => l.data.time);
  assert.ok(Math.min(...green) > 50 && Math.max(...green) < 75, 'lap times stay near the session\'s pace');
  assert.ok(laps.every((l) => l.data.s.every((x) => x == null || x > 0)), 'sectors are positive');
  assert.ok(out.some((e) => e.type === 'rc' && e.data.flag === 'CHEQUERED'));
  // the rival team really stopped car 3 at the end of lap 4: it still does
  const pits = out.filter((e) => e.type === 'pit');
  assert.ok(pits.some((p) => p.data.n === 3 && p.data.lap === 4 && p.data.compound === 'HARD'), 'rivals follow their real stops');
  // the crew made no calls: its cars never stop
  assert.ok(!pits.some((p) => p.data.n === 1 || p.data.n === 2), 'the crew\'s cars only stop when called');
});

test('the crew\'s calls change the race: box, tyres, safety car', () => {
  const { meta, events, fork } = session();
  const sim = ForkSim.create({ meta, events, t0: fork, team: 'McLaren', seed: 5 });
  assert.equal(sim.command({ type: 'box', n: 1, compound: 'S', lap: 5 }), true);
  const out = run(sim, () => sim.cars[0].lap >= 7);
  const stop = out.find((e) => e.type === 'pit' && e.data.n === 1);
  assert.ok(stop, 'car 1 boxed');
  assert.equal(stop.data.lap, 5, 'at the end of the lap called');
  assert.equal(stop.data.compound, 'SOFT');
  assert.ok(out.some((e) => e.type === 'stint' && e.data.n === 1 && e.data.compound === 'SOFT' && e.data.from === 6), 'a new stint starts on the next lap');
  // safety car: deployed, no racing overtakes while it's out
  assert.equal(sim.command({ type: 'sc' }), true);
  assert.equal(sim.flag, 'SC');
  const under = run(sim, () => sim.flag !== 'SC');
  assert.ok(!under.some((e) => e.type === 'overtake'), 'no passing under the safety car');
  assert.ok(under.some((e) => e.type === 'rc' && /SAFETY CAR IN THIS LAP/.test(e.data.message)));
  assert.equal(sim.command({ type: 'mode', n: 2, mode: 'push' }), true);
  assert.equal(sim.command({ type: 'mode', n: 2, mode: 'flat-out' }), false, 'unknown modes are refused');
});

test('a saved takeover carries on exactly as if it had never stopped', () => {
  const { meta, events, fork } = session();
  const a = ForkSim.create({ meta, events, t0: fork, team: 'McLaren', seed: 9 });
  a.command({ type: 'rain', level: 'light' });
  run(a, () => a.cars[0].lap >= 5);
  const b = ForkSim.restore(meta, JSON.parse(JSON.stringify(a.toJSON())));
  const ra = run(a, () => a.cars[0].lap >= 9), rb = run(b, () => b.cars[0].lap >= 9);
  assert.deepEqual(rb, ra, 'same events after a save and restore');
  assert.ok(a.wet > 0.2, 'the track gets wet');
});
