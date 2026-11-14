import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from './api.js';
import { useReplay } from '../store/replay.js';
import { useUI, useToasts } from '../store/stores.js';
import { useRealAnalysis } from '../pages/RealTelemetry.jsx';
import { sessionModel, plansFor } from './realStrategy.js';
import { teamDrivers } from './teams.js';
import { raceEngine } from './raceEngine.js';
import { circuitOf } from './circuit.js';
import { beep, speak, queueRadio } from './sound.js';

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
  const prev = useRef({ t: 0, calls: new Map(), best: new Map(), battles: new Map(), flag: null, rain: null, pitT: 0, key: null });
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
      if (p.key !== key) { useTeamFeed.getState().clear(); p.best.clear(); p.battles.clear(); p.calls.clear(); }
      const model = sessionModel(data, t, meta.live);
      const s = plansFor({ meta, state, rows, data, model });
      const say = (a) => {
        if (quiet) return;
        const alert = { t, at: Date.now(), ...a };
        push(alert);
        if (a.level !== 'info') toast({ kind: a.level === 'red' ? '' : 'yel', title: a.title, text: a.text, ms: 7000 });
        // the engineer on the radio: a beep, then the call spoken (only at speeds a person could follow)
        if (useUI.getState().sound && (state.speed || 1) <= 4) {
          beep(a.level === 'red' ? 'alert' : 'info');
          if (a.voice && a.level !== 'info') speak(a.voice);
        }
      };
      const first = (d) => (d.last || d.name || d.code || '').split(' ').pop();
      for (const d of ours) {
        const plan = s.plans.get(d.n);
        if (!plan) continue;
        const was = p.calls.get(d.n);
        if (plan.kind === 'box' && was?.call !== plan.call) say({ n: d.n, code: d.code, color: d.color, level: plan.tone === 'red' ? 'red' : 'amber', title: `${d.code}: ${plan.call}`, text: `Rejoin P${plan.rejoin?.pos ?? '?'} · fit ${plan.fit} · tyres ${plan.age}/${plan.L} laps`, voice: plan.tone === 'red' ? `${first(d)}, box, box. ${plan.call.split(':')[0]}.` : `${first(d)}: ${plan.call}` });
        p.calls.set(d.n, plan);
      }
      // the forward look: strategy switches and battles coming up
      const eng = raceEngine({ meta, state, rows, data, team: useUI.getState().realTeam, circuit: circuitOf(meta) });
      for (const d of ours) {
        const opts = eng?.options.get(d.n) || [];
        const best = opts[0];
        const sig = (o) => o && o.stops.map((x) => `${x.c}${(rows.find((r) => r.n === d.n)?.lap || 0) + x.lap}`).join('|');
        const was = p.best.get(d.n);
        if (best && was && sig(best) !== was.sig) {
          const old = opts.find((o) => sig(o) === was.sig);
          const sameShape = was.stops === best.stops.length && was.c === best.stops[0]?.c;
          const gain = old ? old.total - best.total : null;
          if (!sameShape && (gain == null || gain > 1)) say({ n: d.n, code: d.code, color: d.color, level: 'amber', title: `${d.code} strategy switch: ${best.title}`, text: `${gain != null ? `Now ${gain.toFixed(1)} s better than ${old.title.toLowerCase()}` : 'The previous plan is no longer viable'} · projected P${best.pos}`, voice: `${first(d)}, we're switching to plan ${best.letter}. ${best.title}.` });
        }
        if (best) p.best.set(d.n, { sig: sig(best), stops: best.stops.length, c: best.stops[0]?.c });
        for (const b of eng?.battles.get(d.n) || []) {
          const rival = s.drivers.get(b.rival);
          const k = `${d.n}:${b.rival}`;
          const soon = b.kind === 'pass-us' && b.swapLap != null && b.swapLap <= 3;
          const range = b.behind && b.inRange;
          const state2 = soon ? 'soon' : range ? 'range' : 'none';
          const last = p.battles.get(k);
          if (state2 !== 'none' && state2 !== last && rival) {
            say({ n: d.n, code: d.code, color: d.color, level: soon ? 'red' : 'amber', title: soon ? `${rival.code} projected to pass ${d.code} in ${b.swapLap} lap${b.swapLap === 1 ? '' : 's'}` : `${rival.code} within ${b.gapNow.toFixed(1)} s of ${d.code}`, text: `${b.via === 'on track' ? `${Math.round(b.prob * 100)}% on-track chance · ` : ''}attack most likely ${b.zone ? b.zone.label : 'on the main straight'} · ${b.paceNow > 0.05 ? `${rival.code} ${b.paceNow.toFixed(2)} s/lap quicker` : `${d.code} has the pace to hold`}`, voice: soon ? `${first(d)}, ${rival.last || rival.code} is coming, ${b.paceNow > 0 ? `${b.paceNow.toFixed(1)} a lap quicker` : 'defend'}.` : null });
          }
          p.battles.set(k, state2);
        }
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

/**
 * Team radio as it is broadcast in the session: with sound on, our cars' clips
 * (or the selected driver's when no team is picked, or every car) play as they
 * come in, one at a time. Skipped at high replay speeds.
 */
export function useRadioWatch() {
  const radio = useReplay((s) => s.radio);
  const seen = useRef(new Map()); // clip -> session time it was broadcast
  const lastT = useRef(0);
  const toast = useToasts((s) => s.push);
  useEffect(() => {
    // seeking back: clips after the new clock time can be heard again
    const now = useReplay.getState().state.t || 0;
    if (now < lastT.current - 1000) for (const [k, t] of seen.current) if (t > now) seen.current.delete(k);
    lastT.current = now;
    const fresh = radio.filter((r) => r.fresh && !seen.current.has(r.url + r.t));
    for (const r of radio) seen.current.set(r.url + r.t, r.t);
    if (!fresh.length) return;
    const { meta, state, selected } = useReplay.getState();
    const ui = useUI.getState();
    if (!meta || ui.radioAuto === 'off') return;
    const ours = teamDrivers(meta, ui.realTeam).map((d) => d.n);
    const want = ui.radioAuto === 'all' ? null : new Set(ours.length ? ours : [selected]);
    const drivers = new Map(meta.drivers.map((d) => [d.n, d]));
    for (const r of fresh.slice().reverse()) {
      if (want && !want.has(r.n)) continue;
      const d = drivers.get(r.n);
      toast({ kind: 'cyan', title: `Team radio · ${d?.code || r.n}`, text: ui.sound ? (state.speed > 2 ? 'Slow the replay to 2× or less to hear it live' : 'Playing') : 'Switch sound on to hear team radio', ms: 3500 });
      if (ui.sound && (state.speed || 1) <= 2 && state.playing !== false) queueRadio({ ...r, code: d?.code, color: d?.color });
    }
  }, [radio, toast]);
}
