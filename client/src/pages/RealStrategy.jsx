import { useMemo } from 'react';
import { formatLapTime } from '@slipstream/shared';
import { useReplay } from '../store/replay.js';
import { useUI } from '../store/stores.js';
import { useTicker } from '../lib/hooks.js';
import { Tyre } from '../components/TimingTower.jsx';
import { useRealAnalysis } from './RealTelemetry.jsx';

const COMP = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const NAME = { S: 'Soft', M: 'Medium', H: 'Hard', I: 'Intermediate', W: 'Wet' };
const DRY = new Set(['S', 'M', 'H']);
// typical stint lengths, used until this session has finished stints of its own on a compound
const LIFE_FALLBACK = { S: 20, M: 30, H: 40, I: 28, W: 35 };
const FUEL_S_PER_LAP = 0.06; // a lap's worth of fuel burnt makes the car about this much faster
const SC_FACTOR = { SC: 0.55, VSC: 0.65 };
const lt = (s) => (s == null ? '—' : formatLapTime(s));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sec = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(d)} s`);

/** least-squares slope of y on x */
function slope(pts) {
  if (pts.length < 4) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : null;
}

/**
 * A race strategist on real timing. Real public data has no tyre temperatures or
 * fuel loads, so everything here is estimated from the session itself: pit loss
 * from the stops already made, degradation from each driver's lap times on the
 * current set, tyre life from finished stints, and where a car would rejoin from
 * the live gaps. Only what has happened up to the replay clock is used.
 */
export default function RealStrategy() {
  useTicker(1);
  const { meta, state, rows } = useReplay();
  const data = useRealAnalysis(meta?.key);
  const realDriver = useUI((s) => s.realDriver);
  const setRealDriver = useUI((s) => s.setRealDriver);
  const t = state.t || 0;
  const tSec = Math.floor(t / 2000); // recompute every two seconds of session time

  const model = useMemo(() => {
    if (!data) return null;
    const laps = data.laps.filter((l) => l.t <= t);
    const byDriver = new Map();
    for (const l of laps) { let a = byDriver.get(l.n); if (!a) byDriver.set(l.n, a = []); a.push(l); }
    for (const a of byDriver.values()) a.sort((x, y) => x.lap - y.lap);
    const pits = data.pits.filter((p) => p.t <= t);
    const pitLaps = new Set(pits.map((p) => `${p.n}:${p.lap}`));
    const best = Math.min(...laps.filter((l) => !l.pitOut).map((l) => l.time), Infinity);
    const clean = (l) => !l.pitOut && !pitLaps.has(`${l.n}:${l.lap}`) && l.time < best * 1.07;

    // reference green-flag pace per driver: median of the last 5 clean laps
    const ref = new Map();
    for (const [n, a] of byDriver) { const c = a.filter(clean).slice(-5).map((l) => l.time); if (c.length) ref.set(n, median(c)); }
    const fieldRef = median([...ref.values()]) || 90;

    // pit loss: in-lap + out-lap minus two green laps, over every stop made so far
    const losses = [];
    for (const p of pits) {
      const a = byDriver.get(p.n) || [];
      const inLap = a.find((l) => l.lap === p.lap), outLap = a.find((l) => l.lap === p.lap + 1);
      const r = ref.get(p.n);
      if (inLap && outLap && r) { const loss = inLap.time + outLap.time - 2 * r; if (loss > 8 && loss < 45) losses.push(loss); }
    }
    const pitLoss = median(losses) ?? 22;
    const laneTime = median(pits.map((p) => p.duration).filter(Boolean));

    // tyre life per compound from stints that have finished
    const curLap = new Map([...byDriver].map(([n, a]) => [n, a.at(-1).lap]));
    const lengths = {};
    for (const s of data.stints) {
      const done = curLap.get(s.n) || 0;
      if (s.to != null && s.to < done) { const c = COMP[s.compound]; if (c) (lengths[c] ||= []).push(s.to - (s.from ?? 1) + 1 + (s.age || 0)); }
    }
    const life = {};
    for (const c of Object.keys(LIFE_FALLBACK)) {
      const L = lengths[c] || [];
      // stints usually end by choice before the tyre is finished, so use the upper quartile
      const q = L.slice().sort((x, y) => x - y)[Math.floor(L.length * 0.75)];
      life[c] = L.length >= 2 ? { laps: q, from: L.length } : { laps: LIFE_FALLBACK[c], from: 0 };
    }

    const totalLaps = meta?.live ? null : Math.max(0, ...data.laps.map((l) => l.lap));
    const lapEnd = new Map(laps.map((l) => [`${l.n}:${l.lap}`, l.t]));
    return { lapEnd, byDriver, ref, fieldRef, pitLoss, losses, laneTime, life, totalLaps, curLap, clean, pits };
  }, [data, tSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta || !data || !model) return <div className="shimmer" style={{ height: 300 }} />;
  const isRace = /Race|Sprint/.test(meta.type || meta.name);
  const drivers = new Map((meta.drivers || []).map((d) => [d.n, d]));
  const flag = state.flag || 'GREEN';
  const rain = !!state.weather?.rain;
  const leaderLap = Math.max(0, ...rows.map((r) => r.lap || 0));
  const remaining = model.totalLaps ? Math.max(0, model.totalLaps - leaderLap) : null;
  // under a red flag teams may change tyres in the pit lane at no cost
  const lossNow = flag === 'RED' ? 0 : model.pitLoss * (SC_FACTOR[flag] || 1);

  // numeric gap to the leader for everyone (lapped cars: laps × reference lap). When the
  // timing feed has no gaps (e.g. under a safety car, or just after a seek), fall back to
  // the gap at the line: when each car finished its last lap versus the leader on that lap.
  const leader = rows.find((r) => r.pos === 1);
  const gapOf = (r) => {
    if (r.pos === 1) return 0;
    if (typeof r.gap === 'number') return r.gap;
    const m = /(\d+)\s*LAP/i.exec(String(r.gap || ''));
    if (m) return Number(m[1]) * (model.ref.get(r.n) || model.fieldRef);
    const L = model.curLap.get(r.n), tn = model.lapEnd.get(`${r.n}:${L}`), tl = leader && model.lapEnd.get(`${leader.n}:${L}`);
    return tn && tl ? Math.max(0, (tn - tl) / 1000) : null;
  };
  const field0 = rows.filter((r) => r.pos < 99).map((r) => ({ ...r, g: gapOf(r) }));
  const field = field0.map((r, i) => ({ ...r, int: typeof r.int === 'number' || i === 0 || r.g == null || field0[i - 1].g == null ? r.int : Math.max(0, r.g - field0[i - 1].g) }));

  const plan = (r) => {
    const a = model.byDriver.get(r.n) || [];
    const c = r.tc, age = r.ta ?? 0;
    const stint = (data.stints || []).filter((s) => s.n === r.n && (s.from ?? 1) <= (r.lap || 1));
    const cur = stint.at(-1);
    const stintLaps = cur ? a.filter((l) => l.lap >= (cur.from ?? 1) && model.clean(l)) : [];
    const raw = slope(stintLaps.map((l) => [l.lap, l.time]));
    const deg = raw == null ? null : raw + FUEL_S_PER_LAP;
    const L = model.life[c]?.laps ?? 30;
    const usedDry = new Set(stint.map((s) => COMP[s.compound]).filter((x) => DRY.has(x)));
    const wetRace = stint.some((s) => !DRY.has(COMP[s.compound]));
    const needStop = isRace && !wetRace && usedDry.size < 2 && remaining != null && remaining > 0;

    // where would they rejoin if they boxed this lap?
    let rejoin = null;
    if (r.g != null) {
      const ng = r.g + lossNow;
      const others = field.filter((o) => o.n !== r.n && o.g != null).sort((x, y) => x.g - y.g);
      const ahead = others.filter((o) => o.g <= ng).at(-1), behind = others.find((o) => o.g > ng);
      rejoin = { pos: others.filter((o) => o.g <= ng).length + 1, ahead, behind, gapAhead: ahead ? ng - ahead.g : null, gapBehind: behind ? behind.g - ng : null };
    }
    const freshGain = Math.min(3, Math.max(0.6, (deg ?? 0.08) * age));
    const behindCar = field.find((o) => o.pos === r.pos + 1);
    const intBehind = behindCar && typeof behindCar.int === 'number' ? behindCar.int : null;
    const intAhead = typeof r.int === 'number' ? r.int : null;
    const undercutThreat = intBehind != null && intBehind < freshGain + 0.8 && (behindCar.ta ?? 0) >= 6;
    const undercutChance = intAhead != null && r.pos > 1 && intAhead < freshGain + 0.5 && age >= 6;

    let call, tone;
    if (!isRace) { call = 'Practice or qualifying: tyre data only'; tone = 'mu'; }
    else if (flag === 'RED') { call = rain && DRY.has(c) ? 'Red flag: fit intermediates for free' : 'Red flag: free tyre change in the pit lane'; tone = 'amber'; }
    else if (rain && DRY.has(c)) { call = 'Box for intermediates: rain on track'; tone = 'red'; }
    else if (!rain && !DRY.has(c) && c && state.weather && !wetRace) { call = 'Watch the crossover to slicks'; tone = 'amber'; }
    else if (remaining != null && remaining <= 1) { call = 'Stay out to the flag'; tone = 'green'; }
    else if (SC_FACTOR[flag] && age >= L * 0.35 && (needStop || age + (remaining ?? 0) > L)) { call = `Box now: cheap stop under ${flag}`; tone = 'red'; }
    else if (age >= L * 0.95 && (remaining == null || age + remaining > L * 1.05)) { call = 'Box this lap: tyres at the end of their life'; tone = 'red'; }
    else if (undercutThreat && age >= L * 0.6) { call = `Cover the undercut from ${drivers.get(behindCar.n)?.code}`; tone = 'amber'; }
    else if (undercutChance && age >= L * 0.6 && rejoin?.gapAhead > 1.5) { call = `Undercut ${drivers.get(field.find((o) => o.pos === r.pos - 1)?.n)?.code}: box now`; tone = 'amber'; }
    else if (remaining != null && !needStop && age + remaining <= L * 1.1) { call = 'Stay out: the tyres reach the flag'; tone = 'green'; }
    else { const k = Math.max(1, Math.round(L * 0.8 - age)); call = `Stay out: window opens in ~${k} lap${k === 1 ? '' : 's'}`; tone = 'green'; }
    return { c, age, L, deg, rejoin, needStop, undercutThreat, undercutChance, freshGain, call, tone, behindCar, stintLaps: stintLaps.length };
  };

  const plans = new Map(field.map((r) => [r.n, plan(r)]));
  const sel = field.find((r) => r.n === realDriver) || field[0];
  const p = sel && plans.get(sel.n);
  const d = sel && drivers.get(sel.n);
  const Drv = ({ n }) => { const x = drivers.get(n); return <span className="drv"><i style={{ background: x?.color }} />{x?.code}<span className="mu" style={{ fontWeight: 400 }}>{x?.last}</span></span>; };
  const toneCol = { red: 'var(--red)', amber: '#ffb020', green: '#2bd94e', mu: 'var(--mu)' };

  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Strategy</h1><p>{meta.name}: a live strategist on real timing. Public data has no tyre temperatures or fuel loads, so pit loss, degradation and tyre life are estimated from this session's own laps and stops, up to the replay clock.</p></div>
        <span className="tag" style={{ background: '#fff', color: 'var(--bg)' }}>Real data</span>
      </div>

      <div className="three">
        <div className="card">
          <div className="card-h"><b>Pit loss</b><span className="chip">{model.losses.length ? `from ${model.losses.length} stops` : 'estimate'}</span></div>
          <div className="card-b row" style={{ gap: 22 }}>
            <div><div className="lbl">Green flag</div><b className="big mono">{sec(model.pitLoss)}</b></div>
            <div><div className="lbl">Under VSC</div><b className="mono">{sec(model.pitLoss * SC_FACTOR.VSC)}</b></div>
            <div><div className="lbl">Under SC</div><b className="mono">{sec(model.pitLoss * SC_FACTOR.SC)}</b></div>
            {model.laneTime && <div><div className="lbl">Pit lane</div><b className="mono">{sec(model.laneTime)}</b></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Race</b><span className="chip" style={{ color: flag === 'GREEN' ? undefined : '#ffb020' }}>{flag === 'GREEN' ? 'green flag' : flag}</span></div>
          <div className="card-b row" style={{ gap: 22 }}>
            <div><div className="lbl">Lap</div><b className="big mono">{leaderLap}{model.totalLaps ? ` / ${model.totalLaps}` : ''}</b></div>
            {remaining != null && <div><div className="lbl">To go</div><b className="mono">{remaining}</b></div>}
            <div><div className="lbl">Rain</div><b className="mono">{rain ? 'YES' : 'no'}</b></div>
            {state.weather?.track != null && <div><div className="lbl">Track</div><b className="mono">{state.weather.track}°</b></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Tyre life</b><span className="chip">laps per set</span></div>
          <div className="card-b row" style={{ gap: 14 }}>
            {['S', 'M', 'H', 'I', 'W'].map((c) => <span key={c} className="row" style={{ gap: 6 }} title={model.life[c].from ? `from ${model.life[c].from} finished stints` : 'typical value until stints finish'}><Tyre c={c} /><b className="mono">{model.life[c].laps}</b>{!model.life[c].from && <span className="mu" style={{ fontSize: 11 }}>est.</span>}</span>)}
          </div>
        </div>
      </div>

      {!isRace && <div className="card"><div className="empty"><b>Pit strategy is for races and sprints</b>This is {meta.type || 'a non-race session'}. The table below still shows each driver's tyres and degradation on the current set.</div></div>}

      {sel && p && isRace && (
        <div className="card hl">
          <div className="card-h">
            <b>Strategist · <span style={{ color: d?.color }}>{d?.name || d?.code}</span></b>
            <select className="input" style={{ height: 30 }} value={sel.n} onChange={(e) => setRealDriver(Number(e.target.value))}>
              {field.map((r) => <option key={r.n} value={r.n}>P{r.pos} · {drivers.get(r.n)?.code} · {drivers.get(r.n)?.last}</option>)}
            </select>
          </div>
          <div className="card-b stack" style={{ gap: 14 }}>
            <div style={{ fontSize: 24, fontWeight: 900, textTransform: 'uppercase', color: toneCol[p.tone] }}>{p.call}</div>
            <div className="four">
              <div><div className="lbl">Tyres</div><div className="row" style={{ gap: 8 }}>{p.c && <Tyre c={p.c} />}<b className="mono">{p.age} laps</b><span className="mu">of ~{p.L}</span></div>
                <div className="bar" style={{ marginTop: 6, height: 6, background: '#1a1a22' }}><i style={{ display: 'block', height: '100%', width: `${Math.min(100, (p.age / p.L) * 100)}%`, background: p.age > p.L * 0.9 ? 'var(--red)' : p.age > p.L * 0.7 ? '#ffb020' : '#2bd94e' }} /></div></div>
              <div><div className="lbl">Degradation (fuel-corrected)</div><b className="mono">{p.deg == null ? '—' : `${p.deg >= 0 ? '+' : ''}${p.deg.toFixed(3)} s/lap`}</b><div className="mu" style={{ fontSize: 12 }}>{p.stintLaps} clean laps on this set</div></div>
              <div><div className="lbl">If they box now</div><b className="mono">rejoin P{p.rejoin?.pos ?? '—'}</b><div className="mu" style={{ fontSize: 12 }}>
                {p.rejoin?.ahead && <>{sec(p.rejoin.gapAhead)} behind {drivers.get(p.rejoin.ahead.n)?.code}</>}
                {p.rejoin?.ahead && p.rejoin?.behind && ' · '}
                {p.rejoin?.behind && <>{sec(p.rejoin.gapBehind)} ahead of {drivers.get(p.rejoin.behind.n)?.code}</>}
                {p.rejoin && ((p.rejoin.gapAhead ?? 9) < 1.5 || (p.rejoin.gapBehind ?? 9) < 1.5) && <b style={{ color: '#ffb020' }}> · traffic</b>}
              </div></div>
              <div><div className="lbl">Fresh-tyre gain, first lap</div><b className="mono">~{sec(p.freshGain)}</b><div className="mu" style={{ fontSize: 12 }}>
                {p.undercutThreat ? <span style={{ color: '#ffb020' }}>{drivers.get(p.behindCar.n)?.code} is in undercut range</span> : p.undercutChance ? <span style={{ color: '#2bd94e' }}>undercut on the car ahead is on</span> : 'no undercut in play'}
              </div></div>
            </div>
            {p.needStop && <div className="mu" style={{ fontSize: 12.5 }}>Still has to use a second dry compound before the flag.</div>}
            <div className="mu" style={{ fontSize: 12.5 }}>Last lap {lt(sel.last)} · best {lt(sel.best)} · {sel.pits} stop{sel.pits === 1 ? '' : 's'} · gap {sel.g == null ? '—' : sel.pos === 1 ? 'leader' : `+${sel.g.toFixed(1)} s`}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h"><b>The field</b><span className="chip">pick a row to focus the strategist</span></div>
        <div className="scroll"><table className="tbl">
          <thead><tr><th className="n">Pos</th><th>Driver</th><th>Tyre</th><th className="n">Age</th><th className="n">Stops</th><th className="n">Gap</th><th className="n">Int</th><th className="n">Deg s/lap</th>{isRace && <th className="n">Box now → P</th>}{isRace && <th>Call</th>}</tr></thead>
          <tbody>
            {field.map((r) => { const q = plans.get(r.n); return (
              <tr key={r.n} onClick={() => setRealDriver(r.n)} style={{ cursor: 'pointer', background: r.n === sel?.n ? 'rgba(225,6,0,.12)' : undefined }}>
                <td className="n">{r.pos}</td><td><Drv n={r.n} /></td><td>{r.tc && <Tyre c={r.tc} />}</td><td className="n">{r.ta ?? '—'}</td><td className="n">{r.pits}</td>
                <td className="n">{r.pos === 1 ? '—' : r.g == null ? '—' : `+${r.g.toFixed(1)}`}</td><td className="n">{typeof r.int === 'number' ? `+${r.int.toFixed(1)}` : r.int || '—'}</td>
                <td className="n">{q.deg == null ? '—' : q.deg.toFixed(3)}</td>
                {isRace && <td className="n">{q.rejoin?.pos ?? '—'}</td>}
                {isRace && <td style={{ color: toneCol[q.tone], fontWeight: 700, fontSize: 12 }}>{q.call}</td>}
              </tr>
            ); })}
          </tbody>
        </table></div>
        <div className="merge-note"><span>pit loss = in-lap + out-lap − 2 green laps, median over stops so far · SC/VSC stops cost ~55% / 65% · degradation = lap-time slope on the current set + {FUEL_S_PER_LAP} s/lap fuel effect</span></div>
      </div>
    </div>
  );
}
