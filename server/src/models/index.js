import mongoose from 'mongoose';
import { config } from '../config.js';

const { Schema, model } = mongoose;

/* ---------- users ---------- */
const UserSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: String,
  role: { type: String, enum: ['race_control', 'engineer', 'crew', 'viewer'], required: true },
  team: { type: String, default: null }
}, { timestamps: true });
export const User = model('User', UserSchema);

/* ---------- sessions (one race = one session) ---------- */
const SessionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  type: { type: String, enum: ['practice', 'qualifying', 'race'], default: 'race' },
  name: String,
  track: String,
  totalLaps: Number,
  status: { type: String, enum: ['idle', 'running', 'paused', 'finished'], default: 'idle' },
  startedAt: Date,
  endedAt: Date,
  winner: String,
  fastestLap: { carId: String, lap: Number, timeMs: Number },
  grid: [String],
  results: [{ _id: false, pos: Number, carId: String, team: String, best: Number, laps: Number, gap: Number, status: String, grid: Number, knockedOut: String, stops: Number }]
}, { timestamps: true });
export const Session = model('Session', SessionSchema);

/* ---------- raw telemetry (hot store with TTL) ----------
 * A regular collection (not a time-series one) because we need a UNIQUE index on
 * (sessionId, carId, seq): that index makes every write idempotent, so duplicates
 * and retries can never create inconsistent history.
 */
const TelemetrySchema = new Schema({
  sessionId: { type: String, required: true },
  carId: { type: String, required: true },
  seq: { type: Number, required: true },
  ts: { type: Date, required: true },
  lap: Number, d: Number, v: Number, thr: Number, brk: Number, g: Number, rpm: Number,
  drs: Number, ers: Number, fuel: Number, tc: String, ta: Number, tw: Number,
  tt: [Number], tp: [Number], bt: [Number], et: Number, ot: Number, st: String
}, { versionKey: false });
TelemetrySchema.index({ sessionId: 1, carId: 1, seq: 1 }, { unique: true });
TelemetrySchema.index({ sessionId: 1, carId: 1, ts: 1 });
TelemetrySchema.index({ ts: 1 }, { expireAfterSeconds: config.telemetryTtlMin * 60 });
export const Telemetry = model('Telemetry', TelemetrySchema);

/* ---------- laps (cold store, kept forever, with a 25 m downsampled trace) ---------- */
const LapSchema = new Schema({
  sessionId: { type: String, required: true },
  carId: { type: String, required: true },
  team: String,
  lap: { type: Number, required: true },
  timeMs: Number,
  sectors: [Number],
  startTs: Date,
  endTs: Date,
  compound: String,
  tyreAge: Number,
  wetness: Number,
  trackStatus: String,
  valid: Boolean,
  pitIn: Boolean,
  pitOut: Boolean,
  pb: Boolean,
  fastest: Boolean,
  stats: { maxSpeed: Number, avgSpeed: Number, maxTyreTemp: Number, maxBrakeTemp: Number, minPsi: Number, fuelUsed: Number },
  startSeq: Number,
  endSeq: Number,
  position: Number,
  gapMs: Number,
  fuel: Number,
  segment: String,
  trace: { d: [Number], t: [Number], v: [Number], thr: [Number], brk: [Number], g: [Number] }
}, { versionKey: false, timestamps: { createdAt: true, updatedAt: false } });
LapSchema.index({ sessionId: 1, carId: 1, lap: 1 }, { unique: true });
LapSchema.index({ carId: 1, valid: 1, timeMs: 1 });
export const Lap = model('Lap', LapSchema);

/* ---------- alerts ---------- */
const AlertSchema = new Schema({
  sessionId: String,
  carId: String,
  team: String,
  type: String,
  severity: { type: String, enum: ['info', 'warn', 'crit'] },
  title: String,
  message: String,
  value: Number,
  threshold: Number,
  lap: Number,
  seq: Number,
  ts: Date,
  acknowledged: { type: Boolean, default: false },
  ackBy: String,
  ackAt: Date
}, { versionKey: false });
AlertSchema.index({ sessionId: 1, team: 1, ts: -1 });
AlertSchema.index({ acknowledged: 1, ts: -1 });
export const Alert = model('Alert', AlertSchema);

/* ---------- commands (audit log of pit calls / race control actions) ---------- */
const CommandSchema = new Schema({
  sessionId: String,
  type: String,
  carId: String,
  payload: Schema.Types.Mixed,
  by: String,
  role: String,
  ts: { type: Date, default: Date.now }
}, { versionKey: false });
CommandSchema.index({ sessionId: 1, ts: -1 });
export const Command = model('Command', CommandSchema);

/* ---------- pit stops (pit lane time + stationary time) ---------- */
const PitStopSchema = new Schema({
  sessionId: String, carId: String, team: String, lap: Number, stop: Number,
  from: String, to: String, enterTs: Date, exitTs: Date, laneMs: Number, stationaryMs: Number
}, { versionKey: false });
PitStopSchema.index({ sessionId: 1, carId: 1, lap: 1 });
export const PitStop = model('PitStop', PitStopSchema);

/* ---------- real-session replay (OpenF1) ---------- */
const ReplaySessionSchema = new Schema({
  key: { type: Number, unique: true }, v: Number, name: String, year: Number, circuit: String, country: String, location: String, type: String,
  meeting: Number, from: Date, to: Date, drivers: [Schema.Types.Mixed], stints: [Schema.Types.Mixed], track: [[Number]],
  complete: Boolean, chunks: [Number], chunkMs: Number, frames: Number, events: Number, importedAt: Date, lastUsed: Date
}, { versionKey: false });
export const ReplaySession = model('ReplaySession', ReplaySessionSchema);

// One 2-minute chunk of car data for a real session: every sample of every car,
// packed as Int32 columns and deflated (about 100 KB instead of ~9,000 documents).
const ReplayChunkSchema = new Schema({ s: Number, i: Number, count: Number, data: Buffer, ints: Schema.Types.Mixed }, { versionKey: false });
ReplayChunkSchema.index({ s: 1, i: 1 }, { unique: true });
export const ReplayChunk = model('ReplayChunk', ReplayChunkSchema);

const ReplayEventSchema = new Schema({ s: Number, t: Date, type: String, data: Schema.Types.Mixed }, { versionKey: false });
ReplayEventSchema.index({ s: 1, t: 1 });
export const ReplayEvent = model('ReplayEvent', ReplayEventSchema);

/* ---------- mock sessions: a crew rehearsing on a past session ----------
 * Private clock (its own replay channel), the crew's team, and every strategy call
 * they made with what the strategist advised at that moment. Debriefed against what
 * really happened. Kept for 60 days after last use. */
const MockSchema = new Schema({
  // crew: the real team whose crew owns this mock (only its signed-in crew can open it); null for a guest mock, open to anyone with the link
  _id: String, key: Number, name: String, team: String, crew: String, from: Number, to: Number, startAt: Number, t: Number,
  calls: [Schema.Types.Mixed], ended: Boolean, createdAt: Date, updatedAt: Date
}, { versionKey: false });
MockSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 86400 });
MockSchema.index({ crew: 1, updatedAt: -1 });
export const Mock = model('Mock', MockSchema);
