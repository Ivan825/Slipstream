import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from './api.js';
import { useReplay } from '../store/replay.js';
import { useUI, useToasts } from '../store/stores.js';
import { useRealAnalysis } from '../pages/RealTelemetry.jsx';
import { sessionModel, plansFor } from './realStrategy.js';
import { teamDrivers } from './teams.js';

/* ---------- mock sessions this browser has started or been sent ---------- */
const MOCKS_KEY = 'slipstream.mocks';
export const myMockIds = () => { try { return JSON.parse(localStorage.getItem(MOCKS_KEY)) || []; } catch { return []; } };
export const rememberMock = (id) => {
  try { localStorage.setItem(MOCKS_KEY, JSON.stringify([id, ...myMockIds().filter((x) => x !== id)].slice(0, 40))); } catch { /* private mode */ }
};
export const forgetMock = (id) => {
  try { localStorage.setItem(MOCKS_KEY, JSON.stringify(myMockIds().filter((x) => x !== id))); } catch { /* ignore */ }
};

/** start a mock: a private copy of a past session on its own clock */
export async function startMock({ key, lap, team }) {
  const body = { key: Number(key) };
  if (lap > 1) body.lap = Number(lap);
  if (team) body.team = team;
  const r = await api('/mocks', { method: 'POST', body });
  rememberMock(r.id);
  return r;
}

/** the open mock's record: its call log */
export const useMock = create((set, get) => ({
  id: null,
  doc: null,
  error: null,
  async load(id) {
    if (!id) return set({ id: null, doc: null, error: null });
    if (get().id !== id) set({ id, doc: null, error: null });
    try { const doc = await api(`/mocks/${id}`); if (get().id === id) set({ doc }); rememberMock(id); } catch (e) { set({ error: e.message }); }
  },
  async call(body) {
    const id = get().id;
    const c = await api(`/mocks/${id}/calls`, { method: 'POST', body });
    if (get().id === id && get().doc) set({ doc: { ...get().doc, calls: [...get().doc.calls, c] } });
    return c;
  },
  async remove(cid) {
    const id = get().id;
    await api(`/mocks/${id}/calls/${cid}`, { method: 'DELETE' });
    if (get().doc) set({ doc: { ...get().doc, calls: get().doc.calls.filter((c) => c.id !== cid) } });
  },
  async setTeam(team) {
    const id = get().id;
    if (!id) return;
    await api(`/mocks/${id}`, { method: 'PATCH', body: { team } }).catch(() => {});
    if (get().doc) set({ doc: { ...get().doc, team } });
  }
}));

/* ---------- the crew's alert feed ---------- */
export const useTeamFeed = create((set, get) => ({
  list: [],
  push(a) { set({ list: [{ id: `${a.t}-${a.n ?? ''}-${a.title}`, ...a }, ...get().list].slice(0, 60) }); },
  clear: () => set({ list: [] })
}));

/**
 * Watches the crew's cars in a real session and raises what a race engineer
 * needs to hear: the strategist's call changing to a stop, an undercut threat,
 * a rival around them pitting, flags and rain. Runs on the session clock, so it
 * behaves the same live, in a mock, or in a replay; seeking resets it quietly.
 */
export function useTeamWatch() {
  const source = useUI((s) => s.source);
  const team = useUI((s) => s.realTeam);
  const key = useReplay((s) => s.key);
  const data = useRealAnalysis(source.kind === 'real' ? key : null);
  const prev = useRef({ t: 0, calls: new Map(), flag: null, rain: null, pitT: 0, key: null });
  const push = useTeamFeed((s) => s.push);
  const toast = useToasts((s) => s.push);

  useEffect(() => {
    if (source.kind !== 'real' || !data) return;
    const tick = () => {
      const { meta, state, rows, feed } = useReplay.getState();
      if (!meta || !state.loaded || !rows.length || !/Race|Sprint/.test(meta.type || '')) return;
      const p = prev.current;
      const t = state.t;
      const ours = teamDrivers(meta, useUI.getState().realTeam);
      // seeking, restarting or a new session: take stock silently
      const quiet = p.key !== key || t < p.t - 1000 || t - p.t > 120_000 * Math.max(1, state.speed || 1);
      if (p.key !== key) useTeamFeed.getState().clear();
      const model = sessionModel(data, t, meta.live);
      const s = plansFor({ meta, state, rows, data, model });
      const say = (a) => {
        if (quiet) return;
        const alert = { t, at: Date.now(), ...a };
        push(alert);
        if (a.level !== 'info') toast({ kind: a.level === 'red' ? '' : 'yel', title: a.title, text: a.text, ms: 7000 });
      };
      for (const d of ours) {
        const plan = s.plans.get(d.n);
        if (!plan) continue;
        const was = p.calls.get(d.n);
        if (plan.kind === 'box' && was?.call !== plan.call) say({ n: d.n, code: d.code, color: d.color, level: plan.tone === 'red' ? 'red' : 'amber', title: `${d.code}: ${plan.call}`, text: `Rejoin P${plan.rejoin?.pos ?? '?'} · fit ${plan.fit} · tyres ${plan.age}/${plan.L} laps` });
        p.calls.set(d.n, plan);
      }
      // rivals stopping around our cars: the undercut is on
      const pits = feed.filter((e) => e.type === 'pit' && e.t > p.pitT && e.t <= t);
      if (p.key === key) {
        for (const e of pits) {
          for (const d of ours) {
            const me = rows.find((r) => r.n === d.n), them = rows.find((r) => r.n === e.n);
            if (!me || !them || e.n === d.n || Math.abs(me.pos - them.pos) > 2) continue;
            const rival = s.drivers.get(e.n);
            say({ n: d.n, code: d.code, color: d.color, level: 'amber', title: `${rival?.code} pitted, P${them.pos} (${them.pos < me.pos ? 'ahead of' : 'behind'} ${d.code})`, text: them.pos > me.pos ? 'Undercut attempt: cover or extend?' : 'Track position chance: stay out and push?' });
          }
        }
      }
      p.pitT = quiet ? t : Math.max(p.pitT, ...pits.map((e) => e.t));
      if (p.flag && s.flag !== p.flag && s.flag !== 'GREEN') say({ level: s.flag === 'RED' ? 'red' : 'amber', title: s.flag === 'RED' ? 'Red flag' : `${s.flag === 'SC' ? 'Safety car' : s.flag === 'VSC' ? 'Virtual safety car' : s.flag} deployed`, text: s.flag === 'RED' ? 'Free tyre change in the pit lane' : `Pit loss now ~${s.lossNow.toFixed(0)} s: check the cheap stop` });
      if (p.rain === false && s.rain) say({ level: 'red', title: 'Rain on track', text: 'Intermediates window: watch the lap times' });
      p.flag = s.flag; p.rain = s.rain; p.t = t; p.key = key;
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [source.kind, key, data, team, push, toast]);
}
