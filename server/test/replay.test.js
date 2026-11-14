import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayChannel } from '../src/openf1/replay.js';

function engine() {
  const sent = [];
  const e = new ReplayChannel({ key: 1, emit: (room, ev, p) => sent.push([ev, p]), viewers: () => 1 });
  e.ensure = () => {}; // no network in tests: frames are injected below
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
  e.intervals = [];
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
  e.advanceTo(e.t + 500);
  const f = e.frame();
  const car1 = f.cars.find((c) => c[0] === 1);
  assert.equal(car1[1], 50, 'x interpolated halfway');
  assert.equal(car1[3], 150, 'speed interpolated');
  e.advanceTo(e.t + 300);
  const evs = sent.filter(([ev]) => ev === 'replay:events').flatMap(([, p]) => p.events);
  assert.ok(evs.some((x) => x.type === 'rc' && x.flag === 'RED'));
  assert.ok(evs.some((x) => x.type === 'lap' && x.fastest));
  void t0;
});

test('a mock channel has its own id and room, and restarts to where the mock began', () => {
  const sent = [];
  const e = new ReplayChannel({ key: 1, mock: { id: 'abc123def456', startAt: 1_000_500, team: 'McLaren' }, emit: (room, ev, p) => sent.push([room, ev, p]), viewers: () => 1 });
  e.ensure = () => {};
  e.meta = { key: 1, name: 'Test', drivers: [{ n: 1, code: 'AAA' }], stints: [], track: [] };
  e.events = []; e.intervals = []; e.cars = new Map();
  e.from = 1_000_000; e.to = 1_010_000;
  e.seek(e.mock.startAt);
  assert.equal(e.ch(), 'm-abc123def456');
  assert.equal(e.room(), 'replay:m-abc123def456');
  assert.equal(e.loop, false, 'a mock never loops');
  e.control({ action: 'seek', t: 5000 });
  assert.equal(e.t, 1_005_000);
  e.control({ action: 'restart' });
  assert.equal(e.t, 1_000_500, 'restart returns to the mock start');
  assert.equal(e.playing, false, 'and waits for the crew');
  assert.ok(sent.every(([room, , p]) => room === 'replay:m-abc123def456' && p.k === 'm-abc123def456'));
  assert.equal(e.snapshot().meta.mock.team, 'McLaren');
});

test('a crew mock is private to that crew; a guest mock is open to its link', async () => {
  const { canUseMock } = await import('../src/auth.js');
  const mcl = { role: 'crew', team: 'McLaren' }, fer = { role: 'crew', team: 'Ferrari' }, guest = { role: 'viewer', team: null };
  const crewMock = { crew: 'McLaren' }, guestMock = { crew: null };
  assert.equal(canUseMock(mcl, crewMock), true);
  assert.equal(canUseMock(fer, crewMock), false);
  assert.equal(canUseMock(guest, crewMock), false);
  assert.equal(canUseMock({ role: 'engineer', team: 'McLaren' }, crewMock), false, 'a simulator engineer is not a crew');
  assert.equal(canUseMock(guest, guestMock), true);
  assert.equal(canUseMock(fer, guestMock), true);
});

test('replay tracks marshal-sector yellows and streams team radio', () => {
  const { e, sent, t0 } = engine();
  e.events.push(
    { t: t0 + 710, type: 'rc', data: { category: 'Flag', flag: 'YELLOW', message: 'YELLOW IN TRACK SECTOR 7', scope: 'Sector', sector: 7 } },
    { t: t0 + 720, type: 'radio', data: { n: 1, url: 'https://example.test/a.mp3' } },
    { t: t0 + 900, type: 'rc', data: { category: 'Flag', flag: 'CLEAR', message: 'CLEAR IN TRACK SECTOR 7', scope: 'Sector', sector: 7 } }
  );
  e.events.sort((a, b) => a.t - b.t);
  e.seek(t0 + 800);
  assert.deepEqual(e.state().yellows, [{ sector: 7, flag: 'YELLOW' }]);
  assert.equal(e.snapshot().radio[0].url, 'https://example.test/a.mp3');
  e.advanceTo(t0 + 950);
  assert.deepEqual(e.state().yellows, [], 'cleared sector');
  e.seek(t0);
  e.advanceTo(t0 + 750);
  const evs = sent.filter(([ev]) => ev === 'replay:events').flatMap(([, p]) => p.events);
  assert.ok(evs.some((x) => x.type === 'radio' && x.n === 1));
});
