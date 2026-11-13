#!/usr/bin/env node
/** npm run openf1:import -w server -- --session 9636 --minutes 15 */
import mongoose from 'mongoose';
import { config } from '../config.js';
import { importSession } from './importer.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
await mongoose.connect(config.mongoUri);
const started = Date.now();
const doc = await importSession(arg('session', process.env.REPLAY_SESSION || 9636), {
  minutes: Number(arg('minutes', 15)), offsetS: Number(arg('offset', -20)), onProgress: (m) => console.log('  ' + m)
});
console.log(`Imported ${doc.name}: ${doc.frames} frames, ${doc.events} events, track ${doc.track.length} points in ${Math.round((Date.now() - started) / 1000)} s`);
await mongoose.disconnect();
