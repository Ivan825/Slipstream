import { useMemo, useState } from 'react';
import { COMPOUNDS, formatLapTime } from '@slipstream/shared';
import { useReplay } from '../store/replay.js';
import { useUI } from '../store/stores.js';
import { useTicker, useCanvas, useAnimationFrame } from '../lib/hooks.js';
import { useRealAnalysis } from '../pages/RealTelemetry.jsx';
import { raceEngine } from '../lib/raceEngine.js';
import { circuitOf } from '../lib/circuit.js';
import { tyreView, tempColour } from '../lib/tyreModel.js';
import { useRadio, playRadio, stopRadio } from '../lib/sound.js';
import { teamDrivers } from '../lib/teams.js';
import { Tyre } from './TimingTower.jsx';
import { engineer } from '../lib/engineer.js';
import { Targets, Flags, Weather, Drivers, TyreField, EngineerCalls, McCell } from './EngineerPanels.jsx';

export const TONE = { red: 'var(--red)', amber: '#ffb020', green: '#2bd94e', mu: 'var(--mu)', cyan: 'var(--cyan)' };
const sec = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(d)} s`);
const lt = (s) => (s == null ? '—' : formatLapTime(s));

/** the race engine for this moment of the real session, shared by every panel */
export function useEngine() {
  useTicker(1);
  const { meta, state, rows, key, selected } = useReplay();
  const data = useRealAnalysis(key);
  const team = useUI((s) => s.realTeam);
  const circuit = useMemo(() => circuitOf(meta), [meta]);
  const drivers = useMemo(() => new Map((meta?.drivers || []).map((d) => [d.n, d])), [meta]);
  const eng = raceEngine({ meta, state, rows, data, team, circuit, focus: selected });
  const ex = eng ? engineer(eng, drivers) : null;
  return { meta, state, rows, data, team, circuit, drivers, eng, ex, selected };
}

const TABS = [['forecast', 'Battle forecast'], ['strategy', 'Strategies'], ['targets', 'Targets & modes'], ['priority', 'Driver priority'], ['flags', 'Flags & incidents'], ['tyres', 'Tyres'], ['weather', 'Weather'], ['drivers', 'Drivers'], ['radio', 'Radio']];

/** the race engineer's deck under the pit wall: forecast, strategies, priority, tyres and radio */
export default function RaceDeck() {
  const tab = useUI((s) => s.deckTab);
  const setTab = useUI((s) => s.setDeckTab);
  const ctx = useEngine();
  const { meta, eng, team } = ctx;
  const isRace = /Race|Sprint/.test(meta?.type || '');
  const liveRadio = useReplay((s) => s.radio.length);
  if (!meta) return null;
  const tabs = TABS.filter(([k]) => isRace || ['tyres', 'radio', 'weather', 'drivers', 'flags'].includes(k));
  const nFlags = ctx.ex?.flags.filter((f) => f.tone === 'red' || f.tone === 'amber').length || 0;
  const cur = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  return (
    <div className="card deck">
      <div className="card-h">
        <div className="seg deck-tabs">{tabs.map(([k, l]) => <button key={k} className={cur === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'radio' && (ctx.data?.radio || liveRadio) ? ` · ${(ctx.data?.radio || []).filter((r) => r.t <= (ctx.state.t || 0) + 1000).length || liveRadio}` : ''}{k === 'flags' && nFlags ? ` · ${nFlags}` : ''}</button>)}</div>
        <span className="chip">{team ? `${team} · ${eng?.ours.length || 0} cars` : 'pick your team to focus the engineer'}{eng?.total.laps ? ` · ${eng.R} laps to go of ${eng.total.laps}${eng.total.est ? ' (est.)' : ''}` : ''}</span>
      </div>
      <div className="deck-b">
        {!eng && cur !== 'radio' && cur !== 'tyres' && <div className="shimmer" style={{ height: 160 }} />}
        {eng && cur === 'forecast' && <Forecast {...ctx} />}
        {eng && cur === 'strategy' && <Strategies {...ctx} />}
        {eng && cur === 'priority' && <Priority {...ctx} />}
        {eng && cur === 'targets' && <Targets {...ctx} />}
        {eng && cur === 'flags' && <Flags {...ctx} />}
        {cur === 'weather' && <Weather {...ctx} />}
        {eng && cur === 'drivers' && <Drivers {...ctx} />}
        {cur === 'tyres' && <Tyres {...ctx} />}
        {cur === 'radio' && <Radio {...ctx} />}
      </div>
    </div>
  );
}

/** the deck's panels as standalone cards (the Strategy page) */
export function EngineCards() {
  const ctx = useEngine();
  if (!ctx.eng || !ctx.eng.s.isRace) return null;
  return (
    <>
      <div className="card"><div className="card-h"><b>Strategy options</b><span className="chip">switch plans as the race changes · alerts on a switch</span></div><div className="deck-b"><Strategies {...ctx} /></div></div>
      <div className="card"><div className="card-h"><b>Driver priority &amp; team orders</b><span className="chip">{ctx.team || 'no team picked'}</span></div><div className="deck-b"><Priority {...ctx} /></div></div>
      <div className="card"><div className="card-h"><b>Battle forecast &amp; projections</b><span className="chip">who, when and where</span></div><div className="deck-b"><Forecast {...ctx} /></div></div>
    </>
  );
}

/* ---------------- battle forecast ---------------- */
function battleText(b, me, rv, total0) {
  const lapOf = (k) => (k == null ? null : (b.ourLap || 0) + k);
  const where = b.zone ? b.zone.label : 'the main straight';
  switch (b.kind) {
    case 'pass-us': return { tone: b.prob > 0.5 ? 'red' : 'amber', head: `${rv} passes ${me} on lap ${lapOf(b.swapLap)}`, sub: `${b.catchLap ? `in DRS range from lap ${lapOf(b.catchLap)} · ` : ''}${Math.round(b.prob * 100)}% on track · most likely ${where}${b.alt ? `, else ${b.alt.label}` : ''}` };
    case 'we-pass': return { tone: 'green', head: `${me} passes ${rv} on lap ${lapOf(b.swapLap)}`, sub: `${b.catchLap ? `in range from lap ${lapOf(b.catchLap)} · ` : ''}${Math.round(b.prob * 100)}% · ${where}` };
    case 'undercut': return { tone: 'red', head: `${rv} undercuts ${me} through their stop`, sub: `jumps ahead on lap ${lapOf(b.swapLap)} on fresher tyres unless we cover` };
    case 'lose-at-stop': return { tone: 'amber', head: `Our stop drops ${me} behind ${rv}`, sub: `on lap ${lapOf(b.swapLap)} with the current plan: ${rv} is ${sec(Math.abs(b.gapNow))} back` };
    case 'gain-at-stop': return { tone: 'green', head: `${me} gets ahead of ${rv} when they stop`, sub: `lap ${lapOf(b.swapLap)}` };
    default: return {
      tone: b.behind ? 'amber' : 'cyan',
      head: b.behind ? `${rv} within ${sec(Math.abs(b.gapNow))} of ${me}` : `${me} within ${sec(Math.abs(b.gapNow))} of ${rv}`,
      sub: b.held ? `pace too close to pass (${Math.abs(b.paceNow).toFixed(2)} s/lap): ${b.behind ? 'they stay behind' : 'stuck behind'}` : `${b.paceNow > 0 ? `${rv} ${b.paceNow.toFixed(2)} s/lap quicker` : `${me} ${(-b.paceNow).toFixed(2)} s/lap quicker`}`
    };
  }
  void total0;
}

function Forecast({ eng, drivers }) {
  const code = (n) => drivers.get(n)?.code || n;
  return (
    <div className="deck-grid">
      <div className="stack" style={{ gap: 10 }}>
        {eng.focus.map((n) => {
          const me = eng.proj.cars.get(n);
          const list = eng.battles.get(n) || [];
          return (
            <div key={n} className="fc-car">
              <div className="row" style={{ gap: 8 }}>
                <span className="drv"><i style={{ background: drivers.get(n)?.color }} />{code(n)}</span>
                <span className="chip">P{me?.r.pos} now</span>
                <span className="chip" style={{ color: me?.projPos < me?.r.pos ? 'var(--grn)' : me?.projPos > me?.r.pos ? 'var(--red)' : undefined }}>P{me?.projPos} projected</span>
                {me?.stops[0] && <span className="chip">stop lap {(me.r.lap || 0) + me.stops[0].lap} → <Tyre c={me.stops[0].c} /></span>}
              </div>
              <ul className="fc-list">
                {!list.length && <li className="mu">Clean air: nobody within reach either way before the flag.</li>}
                {list.slice(0, 5).map((b) => { const t = battleText(b, code(n), code(b.rival)); return (
                  <li key={b.rival}><i style={{ background: TONE[t.tone] }} /><div><b>{t.head}{b.inRange && b.kind !== 'range' && <span className="chip" style={{ marginLeft: 6, color: '#ffb020', borderColor: '#ffb020' }}>{b.behind ? 'in DRS range now' : 'within a second'}</span>}</b><span>{t.sub}</span></div>
                    <span className="mono mu" style={{ fontSize: 11 }}>{b.behind ? '+' : '−'}{Math.abs(b.gapNow).toFixed(1)}</span></li>
                ); })}
              </ul>
              <GapChart n={n} eng={eng} drivers={drivers} rivals={list.slice(0, 4).map((b) => b.rival)} />
            </div>
          );
        })}
      </div>
      <div className="scroll" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead><tr><th className="n">Now</th><th>Driver</th><th className="n">Proj</th><th className="n">Pace</th><th>Next stop</th><th className="n">At flag</th></tr></thead>
          <tbody>
            {eng.proj.order.map((c) => {
              const d = drivers.get(c.r.n); const dp = c.r.pos - c.projPos;
              const pace = Array.from(c.sim.lap).slice(1, 7).filter((_, k) => !c.stops.some((x) => x.lap === k + 1)).slice(0, 5); const avg = pace.length ? pace.reduce((a, b) => a + b, 0) / pace.length : null;
              const mine = eng.ours.some((o) => o.n === c.r.n);
              return (
                <tr key={c.r.n} style={{ background: mine ? 'rgba(0,200,255,.10)' : undefined }}>
                  <td className="n">{c.r.pos}</td>
                  <td><span className="drv"><i style={{ background: d?.color }} />{d?.code}</span></td>
                  <td className="n"><b>P{c.projPos}</b> <span style={{ color: dp > 0 ? 'var(--grn)' : dp < 0 ? 'var(--red)' : 'var(--mu)', fontSize: 11 }}>{dp > 0 ? `▲${dp}` : dp < 0 ? `▼${-dp}` : '='}</span></td>
                  <td className="n">{avg ? lt(avg) : '—'}</td>
                  <td>{c.stops.length ? <span className="row" style={{ gap: 4 }}>lap {(c.r.lap || 0) + c.stops[0].lap}<Tyre c={c.stops[0].c} /></span> : <span className="mu">to the flag</span>}</td>
                  <td className="n">{c.projPos === 1 ? 'winner' : `+${(c.sim.total - eng.proj.order[0].sim.total).toFixed(1)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="merge-note"><span>projection: pace now + degradation on the set − {0.06} s/lap fuel + a tyre cliff past its life, with each car's likely stop. On-track passes need a pace edge that depends on the overtaking zones here.</span></div>
      </div>
    </div>
  );
}

/** projected gap to our car over the remaining laps, one line per rival (above: ahead of us) */
function GapChart({ n, eng, drivers, rivals }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const me = eng.proj.cars.get(n);
    if (!me || eng.R < 1) return;
    const R = eng.R, padL = 34, padR = 8, padT = 8, padB = 16;
    const series = rivals.map((r) => eng.proj.cars.get(r)).filter(Boolean).map((o) => ({ o, g: Array.from({ length: R + 1 }, (_, k) => me.sim.cum[k] - o.sim.cum[k]) }));
    let mx = 3;
    for (const s of series) for (const v of s.g) mx = Math.max(mx, Math.min(30, Math.abs(v)));
    const X = (k) => padL + (k / R) * (w - padL - padR);
    const Y = (v) => padT + (h - padT - padB) / 2 - (Math.max(-mx, Math.min(mx, v)) / mx) * ((h - padT - padB) / 2);
    ctx.fillStyle = 'rgba(0,214,107,.08)'; ctx.fillRect(padL, Y(1), w - padL - padR, Y(-1) - Y(1));
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke();
    ctx.fillStyle = '#6c6c7c'; ctx.font = '600 9px "JetBrains Mono"'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(`+${mx.toFixed(0)}s`, padL - 4, Y(mx)); ctx.fillText(`−${mx.toFixed(0)}s`, padL - 4, Y(-mx)); ctx.fillText(drivers.get(n)?.code || '', padL - 4, Y(0));
    ctx.textAlign = 'center';
    for (let k = 0; k <= R; k += Math.max(1, Math.round(R / 6))) ctx.fillText(`L${(me.r.lap || 0) + k}`, X(k), h - 5);
    for (const s of series) {
      const col = drivers.get(s.o.r.n)?.color || '#888';
      ctx.beginPath(); s.g.forEach((v, k) => (k ? ctx.lineTo(X(k), Y(v)) : ctx.moveTo(X(k), Y(v))));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      for (const st of s.o.stops) { ctx.fillStyle = COMPOUNDS[st.c]?.color || '#fff'; ctx.fillRect(X(st.lap) - 2, Y(s.g[st.lap]) - 2, 4, 4); }
      ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.font = '700 10px "Titillium Web"';
      ctx.fillText(drivers.get(s.o.r.n)?.code || '', X(R) - 26, Y(s.g[R]) - 7);
    }
    for (const st of me.stops) { ctx.strokeStyle = COMPOUNDS[st.c]?.color || '#fff'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(st.lap), padT); ctx.lineTo(X(st.lap), h - padB); ctx.stroke(); ctx.setLineDash([]); }
  }, [eng, n, rivals.join(',')]);
  return <div className="gapchart"><canvas ref={ref} aria-label="Projected gap to the rivals around this car, lap by lap; above the line is ahead of us" /></div>;
}

/* ---------------- strategy options ---------------- */
function Strategies({ eng, ex, drivers }) {
  const total = eng.total.laps;
  return (
    <div className={eng.focus.length > 1 ? 'two' : ''}>
      {eng.focus.map((n) => {
        const opts = eng.options.get(n) || [];
        const me = eng.proj.cars.get(n);
        const mc = ex?.mc.get(n) || [];
        const mcBest = mc.length ? mc.slice().sort((a, b) => a.exp - b.exp)[0] : null;
        const from = (me?.r.lap || 0);
        return (
          <div key={n} className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="drv"><i style={{ background: drivers.get(n)?.color }} />{drivers.get(n)?.code}</span>
              <span className="chip">P{me?.r.pos}</span>{me?.pr.c && <Tyre c={me.pr.c} age={me.pr.age} />}<span className="chip">{me?.pr.age} / ~{me?.pr.life(me.pr.c)} laps</span>
            </div>
            {!opts.length && <div className="mu">No options: the race is about to finish.</div>}
            {mcBest && opts[0] && mcBest.id !== opts[0].id && <div className="insight"><i style={{ background: '#ffb020' }} /><div><b>Safer under uncertainty: Plan {mcBest.letter}</b><p>With random safety cars, VSCs and pace noise, "{mcBest.title}" averages P{mcBest.exp.toFixed(1)} against P{mc.find((m) => m.id === opts[0].id)?.exp.toFixed(1)} for Plan A.</p></div></div>}
            {opts.map((o) => (
              <div key={o.id} className={`opt ${o.letter === 'A' ? 'rec' : ''}`}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="tag" style={{ background: o.letter === 'A' ? 'var(--grn)' : '#2c2c38', color: o.letter === 'A' ? '#15151e' : '#fff' }}>Plan {o.letter}</span>
                  <b style={{ flex: 1 }}>{o.title}</b>
                  {o.isBase && <span className="chip">strategist's plan</span>}
                  <span className="chip">P{o.pos}</span>
                  <span className={`chip risk-${o.risk}`}>{o.risk} risk</span>
                  <span className="mono" style={{ minWidth: 54, textAlign: 'right', color: o.delta < 0.05 ? 'var(--grn)' : undefined }} title="projected race time against the fastest option">{o.delta < 0.05 ? (o.letter === 'A' ? 'best' : 'fastest') : `+${o.delta.toFixed(1)} s`}</span>
                </div>
                <PlanBar from={from} total={total} cur={me?.pr.c} stops={o.stops} />
                {o.notes.length > 0 && <div className="mu" style={{ fontSize: 11.5 }}>{o.notes.join(' · ')}</div>}
                <McCell m={mc.find((m) => m.id === o.id)} />
              </div>
            ))}
          </div>
        );
      })}
      <div className="merge-note" style={{ gridColumn: '1 / -1' }}><span>every no-stop, one-stop (any lap, any compound) and two-stop plan simulated to the flag against the field's likely plans · ranked by time with a margin for risk · rule: two dry compounds in a dry race · the top four also run 160 times each with random safety cars (1.2%/lap), VSCs (0.8%/lap) and pace noise for a distribution of finishing positions · outstanding penalties are counted</span></div>
    </div>
  );
}

function PlanBar({ from, total, cur, stops }) {
  if (!total) return null;
  const segs = [];
  let a = from, c = cur;
  for (const s of stops) { segs.push({ a, b: from + s.lap, c }); a = from + s.lap; c = s.c; }
  segs.push({ a, b: total, c });
  const span = Math.max(1, total - from);
  return (
    <div className="stint-bar" style={{ marginTop: 6 }}>
      {segs.map((s, k) => <div key={k} style={{ flex: Math.max(0.01, (s.b - s.a) / span), background: COMPOUNDS[s.c]?.color || '#555' }} title={`${COMPOUNDS[s.c]?.name || s.c}: laps ${s.a + 1}–${s.b}`}>{s.b - s.a > 3 ? `${s.c} · ${s.b - s.a}` : ''}</div>)}
    </div>
  );
}

/* ---------------- driver priority ---------------- */
function Priority({ eng, drivers, team }) {
  if (!eng.priority) return <div className="empty"><b>Pick your team</b>Driver priority compares your two cars: who to look after first, who stops first, double stacks and team orders.{team ? ` ${team} has no cars in this session.` : ''}</div>;
  const { calls, cars } = eng.priority;
  return (
    <div className="deck-grid">
      <ul className="fc-list big">
        {calls.map((c, k) => <li key={k}><i style={{ background: TONE[c.tone] }} /><div><b>{c.title}</b><span>{c.text}</span></div></li>)}
      </ul>
      <div className="two">
        {cars.map((x) => (
          <div key={x.d.n} className="card" style={{ borderTop: `3px solid ${x.d.color}` }}>
            <div className="card-h"><b>{x.d.code} · P{x.c.r.pos}</b><span className="chip">stake {x.stake.toFixed(1)}</span></div>
            <div className="card-b stack" style={{ gap: 6, fontSize: 12.5 }}>
              <div><span className="lbl">Threats</span> {x.threats.length ? x.threats.map((t) => drivers.get(t.rival)?.code).join(', ') : 'none'}</div>
              <div><span className="lbl">Chances</span> {x.chances.length ? x.chances.map((t) => drivers.get(t.rival)?.code).join(', ') : 'none'}</div>
              <div><span className="lbl">Best plan</span> {x.o[0]?.title || '—'}{x.swing ? <b style={{ color: 'var(--grn)' }}> · +{x.swing} pos</b> : ''}</div>
              <div><span className="lbl">Tyre wear</span>
                <div className="bar" style={{ height: 6, background: '#1a1a22', marginTop: 4 }}><i style={{ display: 'block', height: '100%', width: `${Math.min(100, x.wear * 100)}%`, background: x.wear > 0.9 ? 'var(--red)' : x.wear > 0.7 ? '#ffb020' : '#2bd94e' }} /></div></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- tyres ---------------- */
function Tyres({ eng, rows, drivers, meta, team, selected, data, state }) {
  const ours = teamDrivers(meta, team).map((d) => d.n);
  const focus = ours.length ? ours : [selected ?? rows[0]?.n].filter(Boolean);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="tyre-cars">
        {focus.map((n) => {
          const r = rows.find((x) => x.n === n);
          const p = eng?.s.plans.get(n);
          const v = tyreView(n, { compound: r?.tc, age: r?.ta, life: p?.L, deg: p?.deg });
          return <TyreCar key={n} d={drivers.get(n)} r={r} v={v} />;
        })}
      </div>
      <div className="two">
        <DegChart data={data} drivers={drivers} focus={focus} rows={rows} t={state.t} />
        <StintHistory data={data} rows={rows} drivers={drivers} total={eng?.total.laps} ours={ours} />
      </div>
      <TyreField eng={eng} rows={rows} drivers={drivers} data={data} state={state} />
      <div className="merge-note"><span>Temperatures and per-corner wear are estimates: a thermal model run on each car's live speed, cornering, braking and traction (public timing has no tyre sensors). Age, compounds, stints and lap times are real.</span></div>
    </div>
  );
}

function TyreCar({ d, r, v }) {
  const pos = ['FL', 'FR', 'RL', 'RR'];
  return (
    <div className="tyre-car" style={{ '--tc': d?.color }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className="drv"><i style={{ background: d?.color }} />{d?.code}</span>
        {r?.tc && <Tyre c={r.tc} age={r.ta} />}<span className="chip">{r?.ta ?? '—'} laps · life ~{v.life ?? '—'}</span>
        <span className="chip">window {v.win[0]}–{v.win[1]}°C</span>
      </div>
      <div className="tc-body">
        {[0, 1, 2, 3].map((k) => (
          <div key={k} className={`tc-tyre tc-${pos[k]}`} style={{ background: tempColour(v.surf?.[k], v.win) }}>
            <small>{pos[k]}</small>
            <b>{v.surf ? `${v.surf[k]}°` : '—'}</b>
            <span>core {v.core ? `${v.core[k]}°` : '—'}</span>
            <span className="tc-wear"><i style={{ width: `${v.wear[k]}%` }} /></span>
            <span>{v.wear[k]}% worn</span>
          </div>
        ))}
        <div className="tc-chassis" />
      </div>
      <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 12 }}>
        <span><span className="lbl">Deg</span> <b className="mono">{v.deg == null ? '—' : `${v.deg >= 0 ? '+' : ''}${v.deg.toFixed(3)} s/lap`}</b></span>
        <span><span className="lbl">Cliff</span> <b className="mono" style={{ color: v.cliffIn != null && v.cliffIn <= 3 ? 'var(--red)' : undefined }}>{v.cliffIn == null ? '—' : v.cliffIn <= 0 ? 'past it' : `in ~${v.cliffIn} laps`}</b></span>
      </div>
    </div>
  );
}

/** lap times on the current set, against tyre age, with the fitted degradation line */
function DegChart({ data, drivers, focus, rows, t }) {
  const [ref, get] = useCanvas();
  const series = useMemo(() => {
    if (!data) return [];
    const near = new Set(focus);
    for (const n of focus) { const r = rows.find((x) => x.n === n); if (!r) continue; for (const o of rows) if (Math.abs(o.pos - r.pos) === 1) near.add(o.n); }
    return [...near].slice(0, 5).map((n) => {
      const r = rows.find((x) => x.n === n);
      const st = (data.stints || []).filter((s) => s.n === n && (s.from ?? 1) <= (r?.lap || 1)).at(-1);
      if (!st) return null;
      // fuel-corrected: the time the burnt fuel gave is added back, so the slope is the tyre alone
      const laps = data.laps.filter((l) => l.n === n && l.t <= t && l.lap >= (st.from ?? 1) && !l.pitOut).map((l) => ({ age: (st.age || 0) + l.lap - (st.from ?? 1), time: l.time + 0.06 * l.lap }));
      const best = Math.min(...laps.map((l) => l.time), Infinity);
      return { n, c: st.compound?.[0], laps: laps.filter((l) => l.time < best * 1.05), mine: focus.includes(n) };
    }).filter((s) => s && s.laps.length);
  }, [data, focus.join(','), rows, Math.floor(t / 5000)]); // eslint-disable-line react-hooks/exhaustive-deps
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const all = series.flatMap((s) => s.laps);
    if (all.length < 2) { ctx.fillStyle = '#9d9dad'; ctx.font = '600 12px "Titillium Web"'; ctx.textAlign = 'center'; ctx.fillText('Degradation appears after a few clean laps on the set', w / 2, h / 2); return; }
    const padL = 54, padB = 20, padT = 10, padR = 10;
    const a0 = Math.min(...all.map((l) => l.age)), a1 = Math.max(...all.map((l) => l.age), a0 + 1);
    const t0 = Math.min(...all.map((l) => l.time)), t1 = Math.max(...all.map((l) => l.time), t0 + 0.5);
    const X = (a) => padL + ((a - a0) / (a1 - a0)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - t0) / (t1 - t0)) * (h - padT - padB);
    ctx.fillStyle = '#6c6c7c'; ctx.font = '600 9px "JetBrains Mono"'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let k = 0; k <= 3; k++) { const v = t0 + ((t1 - t0) * k) / 3; ctx.fillText(lt(v), padL - 4, Y(v)); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(padL, Y(v), w - padL - padR, 1); ctx.fillStyle = '#6c6c7c'; }
    ctx.textAlign = 'center';
    for (let a = Math.ceil(a0); a <= a1; a += Math.max(1, Math.round((a1 - a0) / 8))) ctx.fillText(`${a}`, X(a), h - 6);
    ctx.textAlign = 'left'; ctx.fillText('tyre age (laps) →', padL, h - 6);
    for (const s of series) {
      const col = drivers.get(s.n)?.color || '#888';
      ctx.fillStyle = col; ctx.globalAlpha = s.mine ? 1 : 0.55;
      for (const l of s.laps) { ctx.beginPath(); ctx.arc(X(l.age), Y(l.time), s.mine ? 3 : 2.2, 0, Math.PI * 2); ctx.fill(); }
      if (s.laps.length >= 3) {
        const n = s.laps.length, mx = s.laps.reduce((p, l) => p + l.age, 0) / n, my = s.laps.reduce((p, l) => p + l.time, 0) / n;
        let num = 0, den = 0; for (const l of s.laps) { num += (l.age - mx) * (l.time - my); den += (l.age - mx) ** 2; }
        const k = den ? num / den : 0;
        const aa = Math.min(...s.laps.map((l) => l.age)), ab = Math.max(...s.laps.map((l) => l.age));
        ctx.strokeStyle = col; ctx.lineWidth = s.mine ? 2 : 1.2; ctx.beginPath(); ctx.moveTo(X(aa), Y(my + k * (aa - mx))); ctx.lineTo(X(ab), Y(my + k * (ab - mx))); ctx.stroke();
        ctx.font = '700 10px "Titillium Web"'; ctx.fillText(`${drivers.get(s.n)?.code} ${k >= 0 ? '+' : ''}${k.toFixed(3)}/lap`, X(ab) + 4 > w - 70 ? w - 70 : X(ab) + 4, Y(my + k * (ab - mx)));
      }
      ctx.globalAlpha = 1;
    }
  }, [series]);
  return (
    <div className="card">
      <div className="card-h"><b>Degradation on the current set</b><span className="chip">fuel-corrected lap time vs tyre age · slope = tyre deg s/lap</span></div>
      <div style={{ height: 230, padding: '6px 10px' }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="Lap time against tyre age for our cars and the cars around them" /></div>
    </div>
  );
}

/** every driver's stints so far, compound by compound, like the broadcast tyre graphic */
function StintHistory({ data, rows, drivers, total, ours }) {
  const L = total || Math.max(1, ...rows.map((r) => r.lap || 0));
  return (
    <div className="card">
      <div className="card-h"><b>Tyre history</b><span className="chip">stints to now · lap {Math.max(0, ...rows.map((r) => r.lap || 0))}{total ? ` / ${total}` : ''}</span></div>
      <div className="scroll" style={{ maxHeight: 230, padding: '6px 12px' }}>
        {rows.filter((r) => r.pos < 99).map((r) => {
          const st = (data?.stints || []).filter((s) => s.n === r.n && (s.from ?? 1) <= (r.lap || 1));
          return (
            <div key={r.n} className="sh-row" style={{ background: ours.includes(r.n) ? 'rgba(0,200,255,.08)' : undefined }}>
              <span className="mono" style={{ width: 22 }}>{r.pos}</span>
              <span className="drv" style={{ width: 48 }}><i style={{ background: drivers.get(r.n)?.color }} />{drivers.get(r.n)?.code}</span>
              <div className="sh-bar">
                {st.map((s, k) => {
                  const a = (s.from ?? 1) - 1, b = Math.min(r.lap || 1, s.to ?? r.lap ?? 1);
                  const c = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' }[s.compound] || '?';
                  return <i key={k} style={{ left: `${(a / L) * 100}%`, width: `${(Math.max(0.5, b - a) / L) * 100}%`, background: COMPOUNDS[c]?.color || '#555' }} title={`${s.compound}: laps ${a + 1}–${b}${s.age ? ` (${s.age} laps old at fitting)` : ''}`}>{b - a >= 4 ? c : ''}</i>;
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- team radio ---------------- */
function Radio({ drivers, meta, team, selected, state, ex, data }) {
  const radio = useReplay((s) => s.radio);
  const { now, queue, error } = useRadio();
  const sound = useUI((s) => s.sound);
  const auto = useUI((s) => s.radioAuto);
  const setAuto = useUI((s) => s.setRadioAuto);
  const ours = new Set(teamDrivers(meta, team).map((d) => d.n));
  const [who, setWho] = useState('all');
  // every clip of the session up to the clock: the full list from the session data, plus any that arrived live since
  const list = useMemo(() => {
    const m = new Map();
    for (const r of [...(data?.radio || []), ...radio]) if (r.t <= state.t + 1000) m.set(r.url + r.t, r);
    return [...m.values()].sort((a, b) => b.t - a.t);
  }, [data?.radio, radio, Math.floor((state.t || 0) / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = list.filter((r) => who === 'all' || (who === 'ours' ? ours.has(r.n) : r.n === selected));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <EngineerCalls ex={ex} />
      <div className="row" style={{ gap: 10 }}>
        <span className="lbl" style={{ margin: 0 }}>Driver radio · play by itself</span>
        <div className="seg">{[['ours', ours.size ? 'Our cars' : 'Selected car'], ['all', 'Every car'], ['off', 'Off']].map(([k, l]) => <button key={k} className={auto === k ? 'on' : ''} onClick={() => setAuto(k)}>{l}</button>)}</div>
        {!sound && <span className="chip" style={{ borderColor: '#ffb020', color: '#ffb020' }}>sound is off: switch it on in the top bar</span>}
        {sound && state.speed > 2 && <span className="chip">clips play by themselves at 2× or slower</span>}
        {now && <span className="chip radio-now"><span className="radio"><s /><s /><s /><s /></span>{now.code} on the radio <button className="link-btn" onClick={stopRadio}>stop</button></span>}
        {queue.length > 0 && <span className="chip">{queue.length} waiting</span>}
        {error && <span className="chip" style={{ color: '#ffb020' }}>{error}</span>}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span className="lbl" style={{ margin: 0 }}>Show</span>
        <div className="seg">{[['all', `Every car · ${list.length}`], ['ours', `Our cars · ${list.filter((r) => ours.has(r.n)).length}`], ['sel', `Selected · ${list.filter((r) => r.n === selected).length}`]].map(([k, l]) => <button key={k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}</div>
        <span className="chip">{(data?.radio || []).length} clips in the session · {list.length} up to now</span>
      </div>
      <ul className="feed radio-list" style={{ maxHeight: 420 }}>
        {!shown.length && <li><i style={{ background: 'transparent' }} /><div className="m mu">No team radio yet at this point of the session. Clips appear as they were broadcast, with the drivers' own audio.</div></li>}
        {shown.map((r) => {
          const d = drivers.get(r.n);
          const playing = now?.url === r.url;
          return (
            <li key={r.url + r.t} className={ours.has(r.n) ? 'ours' : r.n === selected ? 'sel' : ''}>
              <i style={{ background: d?.color || '#888' }} />
              <div className="row" style={{ gap: 10 }}>
                <button className={`btn sm ${playing ? 'red' : ''}`} onClick={() => (playing ? stopRadio() : playRadio({ ...r, code: d?.code }))}>{playing ? '■ Stop' : '▶ Play'}</button>
                <div style={{ flex: 1 }}><div className="t"><span>{d?.code} · {d?.team}{ours.has(r.n) ? ' · OURS' : ''}</span><span>{new Date(r.t).toISOString().slice(11, 19)}</span></div><div className="m">{d?.name}</div></div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="merge-note"><span>Team radio as broadcast, from OpenF1 (audio hosted by Formula 1's live timing). The clips are the drivers' own; there is no transcript.</span></div>
    </div>
  );
}
