import { CARS } from '@slipstream/shared';
import { log } from '../lib/log.js';

/**
 * Demo director: plays a race storyline so anyone who opens the dashboard sees
 * the system react in real time without touching race control. Every beat goes
 * through the same command path as a human race controller (simulator control
 * channel + audit log); the anomaly and strategy engines still have to detect
 * and react on their own from the telemetry.
 */
const BEATS = [
  { lap: 3, run: (d) => d.incident('tyre-overheat', d.pick(0, 8)), note: 'tyre overheating' },
  { lap: 5, run: (d) => d.rain(2, 7, 0.65), note: 'rain forecast in 2 laps' },
  { lap: 9, run: (d) => d.incident('puncture', d.pick(2, 12)), note: 'puncture' },
  { lap: 11, run: (d) => d.track('SC'), note: 'safety car' },
  { lap: 13, run: (d) => d.track('GREEN'), note: 'green flag' },
  { lap: 16, run: (d) => d.incident('brake-fade', d.pick(0, 10)), note: 'brake fade' },
  { lap: 20, run: (d) => d.track('VSC'), note: 'virtual safety car' },
  { lap: 21, run: (d) => d.track('GREEN'), note: 'green flag' },
  { lap: 24, run: (d) => d.incident('engine', d.pick(4, 16)), note: 'engine overheating' },
  { lap: 27, run: (d) => d.rain(1, 4, 0.45), note: 'second shower' }
];

export class Director {
  constructor(hub, { enabled = false } = {}) {
    this.hub = hub;
    this.enabled = enabled;
    this.done = new Set();
    this.sessionId = null;
    this.timer = setInterval(() => this.tick(), 2000);
  }

  stop() { clearInterval(this.timer); }

  set(enabled) {
    this.enabled = !!enabled;
    log.info(`demo director ${this.enabled ? 'on' : 'off'}`);
  }

  user() { return { username: 'director', role: 'race_control' }; }

  pick(from, to) {
    const order = this.hub.race.order().map((c) => c.id);
    const pool = order.slice(from, to).filter((id) => !this.hub.race.cars.get(id)?.finished);
    return pool[Math.floor(Math.random() * pool.length)] || CARS[0].id;
  }

  incident(type, carId) { this.hub.simCommand({ type, carId }, this.user()); }

  track(status) {
    this.hub.setTrackStatus(status);
    this.hub.simCommand({ type: 'track-status', status }, this.user());
  }

  rain(inLaps, durationLaps, intensity) {
    const lapSec = 95;
    this.hub.weather.schedule({ inSec: inLaps * lapSec, durationSec: durationLaps * lapSec, intensity });
    this.hub.simCommand({ type: 'weather', action: 'shower', inLaps, durationLaps, intensity }, this.user());
    this.hub.broadcastSession({ event: 'weather' });
  }

  tick() {
    const s = this.hub.session;
    if (!this.enabled || s.status !== 'running' || s.type !== 'race') return;
    if (s.sessionId !== this.sessionId) { this.sessionId = s.sessionId; this.done.clear(); }
    const lap = this.hub.race.order()[0]?.lap || 0;
    const remaining = s.totalLaps - lap;
    for (const beat of BEATS) {
      if (lap >= beat.lap && !this.done.has(beat.lap) && remaining > 2) {
        this.done.add(beat.lap);
        log.info(`director: lap ${lap} · ${beat.note}`);
        try { beat.run(this); } catch (e) { log.warn('director beat failed', e.message); }
      }
    }
  }
}
