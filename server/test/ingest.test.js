import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequencer } from '../src/ingest/sequencer.js';
import { TokenBuckets } from '../src/ingest/tokenBucket.js';
import { validateFrame } from '../src/ingest/validate.js';
import { apiKeyFor, verifyApiKey } from '../src/lib/keys.js';

const frame = (seq, extra = {}) => ({
  carId: 'KAL', seq, ts: Date.now(), lap: 3, d: 1200.5, v: 287.4, thr: 1, brk: 0, g: 7, rpm: 11420, drs: 0,
  ers: 62.1, fuel: 38.4, tc: 'M', ta: 9, tw: 31.2, tt: new Array(12).fill(95), tp: [21.9, 22.1, 21.0, 21.1],
  bt: [612, 640, 498, 505], et: 104.2, ot: 115, st: 'RUN', ...extra
});

test('sequencer applies frames strictly in order and drops duplicates', () => {
  const s = new Sequencer({ windowMs: 100 });
  const applied = [];
  const t = 1000;
  for (const seq of [1, 2, 4, 3, 3, 5]) s.accept(frame(seq), t);
  s.drain('KAL', t, (f) => applied.push(f.seq));
  assert.deepEqual(applied, [1, 2, 3, 4, 5]);
  assert.equal(s.counters.duplicates, 1);
  assert.equal(s.counters.reordered, 1);
});

test('sequencer waits for a missing frame, then skips the gap after the window', () => {
  const s = new Sequencer({ windowMs: 100 });
  const applied = [];
  s.accept(frame(1), 0);
  s.accept(frame(3), 0);
  s.drain('KAL', 10, (f) => applied.push(f.seq));
  assert.deepEqual(applied, [1]);              // 3 is held, waiting for 2
  s.drain('KAL', 150, (f) => applied.push(f.seq));
  assert.deepEqual(applied, [1, 3]);           // gave up on 2
  assert.equal(s.counters.gaps, 1);
  assert.equal(s.accept(frame(2), 160), 'late'); // arrives late: stored but never rewinds state
  assert.equal(s.accept(frame(2), 161), 'dup');
});

test('sequencer treats a large backwards jump as a source restart', () => {
  const s = new Sequencer();
  s.accept(frame(10000), 0);
  s.drain('KAL', 0, () => {});
  assert.equal(s.accept(frame(1), 1), 'ok');
  assert.equal(s.counters.resets, 1);
});

test('token bucket allows a burst then refills at the configured rate', () => {
  const b = new TokenBuckets({ capacity: 10, refillPerSec: 5 });
  assert.equal(b.take('a', 8, 0), 8);
  assert.equal(b.take('a', 8, 0), 2);         // only 2 left in the burst
  assert.equal(b.take('a', 8, 1000), 5);      // 1 s later: 5 refilled
  assert.equal(b.take('b', 3, 1000), 3);      // buckets are per source
});

test('validation accepts a good frame and rejects malformed or spoofed ones', () => {
  assert.equal(validateFrame(frame(1), 'KAL').ok, true);
  assert.equal(validateFrame(frame(1, { v: 900 }), 'KAL').ok, false);
  assert.equal(validateFrame(frame(1, { tt: [1, 2] }), 'KAL').ok, false);
  assert.equal(validateFrame(frame(1, { extra: 1 }), 'KAL').ok, false);
  assert.equal(validateFrame(frame(1), 'VOS').reason, 'source-mismatch');
  assert.equal(validateFrame(frame(1, { ts: Date.now() - 3600_000 }), 'KAL').reason, 'clock-skew');
  assert.equal(validateFrame('nonsense', 'KAL').ok, false);
});

test('api keys bind a connection to exactly one source', () => {
  const key = apiKeyFor('KAL', 'secret');
  assert.equal(verifyApiKey(key, 'secret'), 'KAL');
  assert.equal(verifyApiKey(key, 'other-secret'), null);
  assert.equal(verifyApiKey(key.replace('KAL', 'VOS'), 'secret'), null);
  assert.equal(verifyApiKey('garbage', 'secret'), null);
});
