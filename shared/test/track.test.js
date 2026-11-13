import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTrack, positionAt, indexAt, inDrsZone, predictLapTime, bestCompoundFor, encodeRaceRow, decodeRaceRow, formatLapTime } from '../src/index.js';

test('track is the right length and the reference lap is calibrated', () => {
  const t = getTrack();
  assert.ok(Math.abs(t.L - 5218) < 0.5);
  let lap = 0;
  for (let i = 0; i < t.N; i++) lap += (t.cum[i + 1] - t.cum[i]) / t.vRef[i];
  assert.ok(Math.abs(lap - 91) < 0.05);
  const kmh = [...t.vRef].map((v) => v * 3.6);
  assert.ok(Math.min(...kmh) > 60 && Math.max(...kmh) < 350);
  assert.ok(t.corners.length >= 8);
  assert.equal(t.drs.length, 2);
});

test('positions interpolate and wrap around the lap', () => {
  const t = getTrack();
  const a = positionAt(t, 0), b = positionAt(t, t.L);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
  assert.equal(indexAt(t, -1), t.N - 1);
  assert.equal(inDrsZone(t, t.drs[0].from + 5), true);
});

test('tyre model: softs are faster when new, wet tyres win in the rain', () => {
  const s = predictLapTime({ compound: 'S', age: 1 }), h = predictLapTime({ compound: 'H', age: 1 });
  assert.ok(s < h);
  assert.ok(predictLapTime({ compound: 'S', age: 25 }) > predictLapTime({ compound: 'H', age: 25 }), 'softs fall off the cliff');
  assert.equal(bestCompoundFor(0), 'S');
  assert.equal(bestCompoundFor(0.5), 'I');
  assert.equal(bestCompoundFor(0.95), 'W');
});

test('race rows round-trip through the compact wire format', () => {
  const row = encodeRaceRow(4, 12, 2210.47, 287.4, 'PIT');
  assert.deepEqual(row, [4, 12, 22105, 287, 1]);
  assert.deepEqual(decodeRaceRow(row), { index: 4, lap: 12, d: 2210.5, v: 287, status: 'PIT' });
  assert.equal(formatLapTime(91.402), '1:31.402');
});
