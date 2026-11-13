import { EV, NS, ROOMS, CAR_BY_ID, TEAM_BY_ID, CARS } from '@slipstream/shared';
import { verifyToken, VIEWER, canSeeCar, canSeeTeam } from '../auth.js';
import { Alert } from '../models/index.js';
import { log } from '../lib/log.js';

/**
 * /live namespace for dashboards.
 *
 * Auth: optional JWT in the handshake (spectators connect without one).
 * Clients ask to join rooms with `subscribe`; every room is checked against
 * the user's role and team. The ack carries a snapshot (and, for car rooms, a
 * sequence cursor used to merge history with live data without duplicates).
 */
export function attachLive(io, hub, broadcaster) {
  const nsp = io.of(NS.LIVE);

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.user = (token && verifyToken(token)) || VIEWER;
    next();
  });

  const roleCount = () => {
    const roles = {};
    for (const s of nsp.sockets.values()) roles[s.data.user.role] = (roles[s.data.user.role] || 0) + 1;
    hub.metrics.g.clients = nsp.sockets.size;
    hub.metrics.g.roles = roles;
  };

  nsp.on('connection', (socket) => {
    const user = socket.data.user;
    roleCount();
    socket.emit(EV.SESSION, hub.publicSession());
    if (user.role === 'race_control') socket.join(ROOMS.CONTROL);

    socket.on(EV.SUBSCRIBE, async (payload, ack) => {
      const rooms = Array.isArray(payload?.rooms) ? payload.rooms.slice(0, 20) : [];
      const joined = [], denied = [], cursors = {};
      let timing = null, alerts = null;
      for (const room of rooms) {
        if (typeof room !== 'string') continue;
        if (room === ROOMS.RACE) {
          // spectators and back-pressured clients get the 2 Hz feed
          const target = user.role === 'viewer' || socket.data.degraded ? ROOMS.RACE_2HZ : ROOMS.RACE;
          socket.join(target); joined.push(target);
        } else if (room === ROOMS.TIMING || room === ROOMS.METRICS) {
          socket.join(room); joined.push(room);
          if (room === ROOMS.TIMING) timing = broadcaster.timingSnapshot();
        } else if (room.startsWith('car:')) {
          const id = room.slice(4);
          if (CAR_BY_ID[id] && canSeeCar(user, id)) {
            socket.join(room); joined.push(room);
            // cursor: every frame broadcast to this room after now has seq > cursor
            cursors[id] = hub.race.cars.get(id)?.lastBroadcastSeq ?? 0;
          } else denied.push(room);
        } else if (room.startsWith('team:')) {
          const id = room.slice(5);
          if (TEAM_BY_ID[id] && canSeeTeam(user, id)) { socket.join(room); joined.push(room); } else denied.push(room);
        } else denied.push(room);
      }
      const teamRooms = joined.filter((r) => r.startsWith('team:')).map((r) => r.slice(5));
      if (teamRooms.length || user.role === 'race_control') {
        const q = { sessionId: hub.session.sessionId, acknowledged: false };
        if (user.role !== 'race_control') q.team = { $in: teamRooms };
        alerts = await Alert.find(q).sort({ ts: -1 }).limit(30).lean().catch(() => []);
      }
      const strategy = {};
      for (const t of teamRooms) {
        for (const c of CARS.filter((x) => x.team === t)) {
          const s = hub.strategy.latest.get(c.id);
          if (s) strategy[c.id] = s;
        }
      }
      if (typeof ack === 'function') ack({ joined, denied, cursors, timing, alerts, strategy, session: hub.publicSession(), user: { username: user.username, role: user.role, team: user.team } });
    });

    socket.on(EV.UNSUBSCRIBE, (payload) => {
      const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
      for (const r of rooms) if (typeof r === 'string' && r !== ROOMS.CONTROL) socket.leave(r);
    });

    socket.on(EV.ALERT_ACK, async (payload, ack) => {
      try {
        const alert = await Alert.findById(payload?.id).lean();
        if (!alert) return ack?.({ ok: false, error: 'not found' });
        if (!canSeeTeam(user, alert.team)) return ack?.({ ok: false, error: 'forbidden' });
        const updated = await hub.ackAlert(payload.id, user);
        ack?.({ ok: !!updated });
      } catch (e) {
        log.warn('ack failed', e.message);
        ack?.({ ok: false, error: 'bad id' });
      }
    });

    socket.on('ping:latency', (t, ack) => typeof ack === 'function' && ack(Date.now()));
    socket.on('disconnect', roleCount);
  });

  // event fan-out with per-team scoping
  hub.on('session', (s) => nsp.emit(EV.SESSION, s));
  hub.on('lap', (lap) => {
    nsp.to(ROOMS.TIMING).emit(EV.LAP, { carId: lap.carId, lap: lap.lap, timeMs: lap.timeMs, sectors: lap.sectors, pb: lap.pb, fastest: lap.fastest, valid: lap.valid, compound: lap.compound });
  });
  hub.on('alert', (a) => {
    const payload = { ...a, _id: String(a._id) };
    nsp.to(ROOMS.team(a.team)).to(ROOMS.CONTROL).emit(EV.ALERT, payload);
  });
  hub.on('alert:acked', (a) => nsp.to(ROOMS.team(a.team)).to(ROOMS.CONTROL).emit(EV.ALERT_ACKED, a));
  hub.on('command', (c) => {
    const target = c.team ? nsp.to(ROOMS.team(c.team)).to(ROOMS.CONTROL) : nsp.to(ROOMS.CONTROL);
    target.emit(EV.COMMAND, c);
  });
  hub.on('strategy', (s) => {
    const team = CAR_BY_ID[s.carId]?.team;
    nsp.to(ROOMS.team(team)).to(ROOMS.CONTROL).emit(EV.STRATEGY, s);
  });
  return nsp;
}
