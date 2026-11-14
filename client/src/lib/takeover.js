import { api } from './api.js';
import { rememberMock } from './crew.js';
import { useReplay } from '../store/replay.js';
import { useToasts } from '../store/stores.js';

/**
 * Takeover: a real race (live, past or a mock) forked at a moment and run on by
 * the server's race model. From there the crew's calls change what happens.
 */
export async function startTakeover({ from, lap, team }) {
  const body = { from: typeof from === 'number' || /^\d+$/.test(String(from)) ? Number(from) : String(from) };
  if (lap) body.lap = Number(lap);
  if (team) body.team = team;
  const r = await api('/mocks/fork', { method: 'POST', body });
  rememberMock(r.id);
  return r;
}

/** the open takeover, if the session is one: its fork point and the race model's status (modes, calls in hand, flags, rain) */
export function useTakeover() {
  const meta = useReplay((s) => s.meta);
  const status = useReplay((s) => s.state.fork);
  const ch = useReplay((s) => s.key);
  if (!meta?.fork) return null;
  return { ch, id: String(ch).replace(/^m-/, ''), fork: meta.fork, status: status || null, car: (n) => status?.cars?.find((c) => c.n === n) || null };
}

const LABEL = {
  box: (c) => `Box${c.compound ? ` for ${({ S: 'softs', M: 'mediums', H: 'hards', I: 'inters', W: 'wets' })[c.compound]}` : ''}${c.lap ? ` at the end of lap ${c.lap}` : ' this lap'}`,
  'cancel-box': () => 'Box call cancelled: stay out',
  mode: (c) => `Mode: ${c.mode}`,
  order: (c) => (c.order === 'swap' ? 'Swap the cars' : c.order === 'hold' ? 'Hold position' : 'Free to race'),
  auto: (c) => (c.on ? 'Strategy autopilot on' : 'Strategy autopilot off'),
  sc: () => 'Safety car deployed', vsc: () => 'Virtual safety car deployed', 'end-sc': () => 'Safety car in this lap',
  red: () => 'Red flag', resume: () => 'Race resumes behind the safety car',
  rain: (c) => `${c.level === 'heavy' ? 'Heavy' : 'Light'} rain coming`, dry: () => 'Rain stops',
  penalty: (c) => (c.kind === 'drive-through' ? 'Drive-through penalty' : `${c.secs || 5} s penalty`),
  puncture: () => 'Puncture', failure: () => 'Car failure', random: (c) => (c.on ? 'Random race events on' : 'Random race events off')
};

/** send a call or race-control action to the takeover; returns true when the race took it */
export async function takeoverCommand(ch, cmd, { quiet = false } = {}) {
  const toast = useToasts.getState().push;
  const id = String(ch).replace(/^m-/, '');
  try {
    const r = await api(`/mocks/${id}/command`, { method: 'POST', body: cmd });
    if (r.status) useReplay.setState((s) => ({ state: { ...s.state, fork: r.status } }));
    if (!quiet) toast({ kind: 'cyan', title: LABEL[cmd.type]?.(cmd) || cmd.type, text: cmd.n ? `Car ${cmd.n}` : 'Race control', ms: 2200 });
    return true;
  } catch (e) {
    toast({ kind: '', title: 'Not done', text: e.message });
    return false;
  }
}
