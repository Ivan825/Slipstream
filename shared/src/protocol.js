/**
 * Wire protocol shared by server, simulator, client and load tester.
 *
 * Namespaces
 *   /ingest  data sources (cars) and the simulator controller. API-key auth.
 *   /live    dashboards. JWT auth (spectators may connect without a token).
 *
 * Rooms on /live
 *   race          10 Hz compact position frames for every car
 *   race:2hz      2 Hz version of the same (spectators + slow/back-pressured clients)
 *   timing        2 Hz delta-only timing tower updates
 *   car:<ID>      full 20 Hz telemetry for one car, delivered in 10 Hz batches
 *   team:<id>     alerts, laps and strategy for one team
 *   control       everything (race control only)
 *   metrics       1 Hz pipeline metrics (systems page)
 */

export const NS = { INGEST: '/ingest', LIVE: '/live' };

export const EV = {
  // ingest
  TELEMETRY: 'telemetry',          // car -> server: Frame[] (ack: IngestAck)
  SIM_STATE: 'sim:state',          // server -> controller: session + weather + track status
  SIM_COMMAND: 'sim:command',      // server -> controller: { type, carId?, ... }
  // live, client -> server
  SUBSCRIBE: 'subscribe',          // { rooms: string[] } (ack: { joined, denied, snapshot })
  UNSUBSCRIBE: 'unsubscribe',
  ALERT_ACK: 'alert:ack',          // { id }
  // live, server -> client
  RACE: 'race',                    // RaceFrame
  TIMING: 'timing',                // { t, full?, rows: Partial<TimingRow>[] }
  CAR: 'car',                      // { c, f: Frame[] }
  ALERT: 'alert',
  ALERT_ACKED: 'alert:acked',
  LAP: 'lap',
  SESSION: 'session',
  STRATEGY: 'strategy',
  METRICS: 'metrics',
  COMMAND: 'command'               // audit of commands (pit calls etc.)
};

export const ROOMS = {
  RACE: 'race',
  RACE_2HZ: 'race:2hz',
  TIMING: 'timing',
  CONTROL: 'control',
  METRICS: 'metrics',
  car: (id) => `car:${id}`,
  team: (id) => `team:${id}`
};

export const ROLES = { CONTROL: 'race_control', ENGINEER: 'engineer', VIEWER: 'viewer' };

export const TRACK_STATUS = ['GREEN', 'YELLOW', 'VSC', 'SC', 'RED'];
export const CAR_STATUS = ['RUN', 'PIT', 'OUT', 'SLOW', 'DNF'];

/**
 * RaceFrame: { t: serverTimeMs, s: tickSeq, f: [[carIndex, lap, distDm, speedKmh, statusCode], ...] }
 * Distance is sent in decimetres as an integer to keep the payload tiny.
 */
export const STATUS_CODE = { RUN: 0, PIT: 1, OUT: 2, SLOW: 3, DNF: 4 };
export const STATUS_FROM_CODE = ['RUN', 'PIT', 'OUT', 'SLOW', 'DNF'];

export function encodeRaceRow(index, lap, d, v, status) {
  return [index, lap, Math.round(d * 10), Math.round(v), STATUS_CODE[status] ?? 0];
}
export function decodeRaceRow(row) {
  return { index: row[0], lap: row[1], d: row[2] / 10, v: row[3], status: STATUS_FROM_CODE[row[4]] ?? 'RUN' };
}

/** HMAC-derived API keys for data sources: `<sourceId>.<hex>` */
export const KEY_ALGO = 'sha256';
