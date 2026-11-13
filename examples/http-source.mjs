#!/usr/bin/env node
/**
 * A minimal "real" data source: streams telemetry for one car over plain HTTP
 * (no Socket.IO client needed). Any device or script can do the same.
 *
 *   INGEST_SECRET=... node examples/http-source.mjs --id DEV-1 --hz 10
 *
 * The API key is derived from INGEST_SECRET; in production you would hand a
 * device only its own key: `<id>.<hmac>` (see server/src/lib/keys.js).
 */
import { createHmac } from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const url = (arg('url', process.env.INGEST_URL || 'http://localhost:4000')).replace(/\/$/, '');
const id = arg('id', 'DEV-1');
const hz = Number(arg('hz', 10));
const secret = process.env.INGEST_SECRET || 'change-me-ingest-secret';
const key = `${id}.${createHmac('sha256', secret).update(id).digest('hex').slice(0, 32)}`;

let seq = 0, d = 0;
setInterval(async () => {
  const frames = [];
  for (let k = 0; k < Math.max(1, hz / 2); k++) {
    seq++; d = (d + 30) % 5218;
    const v = 180 + 80 * Math.sin(seq / 20);
    frames.push({
      carId: id, seq, ts: Date.now(), lap: 1 + Math.floor(seq / 300), d, v: Math.round(v * 10) / 10, thr: v > 200 ? 1 : 0.4, brk: 0,
      g: Math.min(8, Math.max(1, Math.round(v / 42))), rpm: 10500, drs: 0, ers: 60, fuel: 40, tc: 'M', ta: 4, tw: 12,
      tt: new Array(12).fill(92 + Math.round(Math.random() * 4)), tp: [21.6, 21.7, 20.9, 20.9], bt: [520, 530, 430, 430], et: 103, ot: 114, st: 'RUN'
    });
  }
  try {
    const r = await fetch(`${url}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(frames) });
    const ack = await r.json();
    process.stdout.write(`\r${id} seq ${seq} → HTTP ${r.status} accepted ${ack.accepted} limited ${ack.limited} rejected ${ack.rejected}   `);
  } catch (e) {
    process.stdout.write(`\r${id}: ${e.message}   `);
  }
}, 500);
