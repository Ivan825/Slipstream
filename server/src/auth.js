import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { TEAMS, CAR_BY_ID } from '@slipstream/shared';
import { config } from './config.js';
import { User } from './models/index.js';
import { log } from './lib/log.js';

export const DEMO_PASSWORD = 'slipstream';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), username: user.username, role: user.role, team: user.team, name: user.displayName }, config.jwtSecret, { expiresIn: config.jwtTtl });
}

export function verifyToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { id: p.sub, username: p.username, role: p.role, team: p.team || null, name: p.name };
  } catch {
    return null;
  }
}

export const VIEWER = Object.freeze({ id: null, username: 'spectator', role: 'viewer', team: null, name: 'Spectator' });

/** Express: attach req.user (viewer when no/invalid token) */
export function authOptional(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  req.user = (token && verifyToken(token)) || VIEWER;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(req.user?.role === 'viewer' ? 401 : 403).json({ error: 'forbidden', need: roles });
    next();
  };
}

/** Can this user see full telemetry / alerts / strategy for a car? */
export function canSeeCar(user, carId) {
  if (user.role === 'race_control') return true;
  if (user.role === 'engineer') return CAR_BY_ID[carId]?.team === user.team;
  return false;
}

export function canSeeTeam(user, teamId) {
  return user.role === 'race_control' || (user.role === 'engineer' && user.team === teamId);
}

/** Idempotent demo accounts: race control + one engineer per team. */
export async function ensureDemoUsers() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = [
    { username: 'control', displayName: 'Race Control', role: 'race_control', team: null },
    ...TEAMS.map((t) => ({ username: t.id, displayName: `${t.name} engineer`, role: 'engineer', team: t.id }))
  ];
  let created = 0;
  for (const u of users) {
    const r = await User.updateOne({ username: u.username }, { $setOnInsert: { ...u, passwordHash: hash } }, { upsert: true });
    created += r.upsertedCount || 0;
  }
  if (created) log.info(`created ${created} demo users (password "${DEMO_PASSWORD}")`);
}

export async function login(username, password) {
  const user = await User.findOne({ username: String(username || '').toLowerCase().trim() });
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  return ok ? user : null;
}
