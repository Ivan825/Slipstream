import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayEngine } from '../src/openf1/replay.js';

function engine() {
  const sent = [];
  const e = new ReplayEngine({ emit: (ev, p) => sent.push([ev, p]), hasViewers: () => true });
  const t0 = 1_000_000;
  e.meta = {
    key: 1, name: 'Test', drivers: [{ n: 1, code: 'AAA', color: '#f00' }, { n: 2, code: 'BBB', color: '#00f' }],
    stints: [{ n: 1, from: 1, to: 20, compound: 'INTERMEDIATE', age: 0 }, { n: 2, from: 1, to: 20, compound: 'SOFT', age: 2 }], track: []
  };
  e.cars = new Map([
    [1, [{ t: t0, x: 0, y: 0, v: 100 }, { t: t0 + 1000, x: 100, y: 0, v: 200 }]],
    [2, [{ t: t0, x: 0, y: 50, v: 90 }, { t: t0 + 1000, x: 80, y: 50, v: 180 }]]
  ]);
  e.events = [
    { t: t0 - 10, type: 'position', data: { n: 2, pos: 1 } },
    { t: t0 - 10, type: 'position', data: { n: 1, pos: 2 } },
    { t: t0 + 100, type: 'lapstart', data: { n: 1, lap: 1 } },
    { t: t0 + 400, type: 'position', data: { n: 1, pos: 1 } },
    { t: t0 + 400, type: 'position', data: { n: 2, pos: 2 } },
    { t: t0 + 500, type: 'interval', data: { n: 2, gap: 1.234, int: 1.234 } },
    { t: t0 + 600, type: 'rc', data: { category: 'Flag', flag: 'RED', message: 'RED FLAG', scope: 'Track' } },
    { t: t0 + 700, type: 'lap', data: { n: 1, lap: 1, time: 90.5, s: [30, 30, 30.5] } }
  ];
  e.from = t0; e.to = t0 + 1000;
  e.seek(t0);
  return { e, sent, t0 };
}

test('replay seek applies only past events and builds standings', () => {
  const { e, t0 } = engine();
  assert.deepEqual(e.standings().map((r) => r.n), [2, 1], 'grid order before the start');
  e.seek(t0 + 800);
  const rows = e.standings();
  assert.deepEqual(rows.map((r) => r.n), [1, 2]);
  assert.equal(rows[1].gap, 1.234);
  assert.equal(rows[0].last, 90.5);
  assert.equal(rows[0].tc, 'I');
  assert.equal(rows[1].tc, 'S');
  assert.equal(e.st.flag, 'RED');
  e.seek(t0);
  assert.equal(e.st.flag, 'GREEN', 'seeking back resets state');
});

test('replay frames interpolate between samples and events stream as they happen', () => {
  const { e, sent, t0 } = engine();
  e.advance(500);
  const f = e.frame();
  const car1 = f.cars.find((c) => c[0] === 1);
  assert.equal(car1[1], 50, 'x interpolated halfway');
  assert.equal(car1[3], 150, 'speed interpolated');
  e.advance(300);
  const evs = sent.filter(([ev]) => ev === 'replay:events').flatMap(([, p]) => p);
  assert.ok(evs.some((x) => x.type === 'rc' && x.flag === 'RED'));
  assert.ok(evs.some((x) => x.type === 'lap' && x.fastest));
  void t0;
});
