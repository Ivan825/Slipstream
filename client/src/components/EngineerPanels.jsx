import { useMemo } from 'react';
import { COMPOUNDS, formatLapTime } from '@slipstream/shared';
import { useCanvas, useAnimationFrame } from '../lib/hooks.js';
import { useUI } from '../store/stores.js';
import { speak } from '../lib/sound.js';
import { penaltyText } from '../lib/incidents.js';
import { FUEL_S_PER_LAP, COMP } from '../lib/realStrategy.js';
import { Tyre } from './TimingTower.jsx';

const TONE = { red: 'var(--red)', amber: '#ffb020', green: '#2bd94e', mu: 'var(--mu)', cyan: 'var(--cyan)' };
const lt = (s) => (s == null || !Number.isFinite(s) ? '—' : formatLapTime(s));
const sgn = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`);
const Drv = ({ d }) => <span className="drv"><i style={{ background: d?.color }} />{d?.code}</span>;

/* ---------------- targets, modes and tyre management ---------------- */
export function Targets({ eng, ex, drivers, data, state }) {
  if (!ex) return null;
  return (
    <div className={eng.focus.length > 1 ? 'two' : ''}>
      {eng.focus.map((n) => {
        const tg = ex.targets.get(n), md = ex.modes.get(n), inf = ex.inferred.get(n);
        const d = drivers.get(n);
        if (!tg) return null;
        const recent = (data?.laps || []).filter((l) => l.n === n && l.t <= state.t).slice(-10);
        return (
          <div key={n} className="tg-car" style={{ '--tc': d?.color }}>
            <div className="row" style={{ gap: 8 }}><Drv d={d} /><Tyre c={eng.proj.cars.get(n)?.pr.c} age={tg.age} /><span className="chip">{tg.age} / ~{tg.L} laps</span><span className="chip">{tg.stintLen} laps to the {eng.options.get(n)?.[0]?.stops.length ? 'stop' : 'flag'}</span></div>
            <div className="tg-top">
              <div><div className="lbl">Target lap</div><b className="tg-big">{lt(tg.target)}</b><div className="mu" style={{ fontSize: 11.5 }}>band {lt(tg.band?.[0])} – {lt(tg.band?.[1])}</div></div>
              <div><div className="lbl">Last lap</div><b className="tg-big" style={{ color: tg.delta == null ? undefined : Math.abs(tg.delta) <= 0.15 ? 'var(--grn)' : tg.delta > 0 ? '#ffb020' : 'var(--cyan)' }}>{lt(tg.last)}</b><div className="mu" style={{ fontSize: 11.5 }}>{tg.delta == null ? 'not a representative lap' : `${sgn(tg.delta)} s to target · ${Math.abs(tg.delta) <= 0.15 ? 'on target' : tg.delta > 0 ? 'too slow' : 'over-pushing'}`}</div></div>
              <div><div className="lbl">Tyre management</div><b className="tg-big" style={{ color: tg.m >= 0.15 ? '#ffb020' : 'var(--grn)' }}>{tg.m >= 0.05 ? `+${tg.m.toFixed(2)} s/lap` : 'none'}</b><div className="mu" style={{ fontSize: 11.5 }}>{tg.m >= 0.05 ? `stretches the set to the stop · costs ~${tg.cost.toFixed(1)} s` : 'the set reaches the plan at full pace'}</div></div>
            </div>
            <div className="tg-modes">
              <div className="tg-mode" style={{ borderColor: TONE[md?.tone] }}><span className="lbl">Ask for</span><b style={{ color: TONE[md?.tone] }}>{md?.mode}</b><span>Energy: {md?.energy} · Tyres: {md?.tyre}</span><span className="mu">{md?.why}</span></div>
              <div className="tg-mode"><span className="lbl">Running now (from telemetry)</span><b style={{ color: TONE[inf?.tone] }}>{inf?.mode || '—'}</b><span>{inf?.fullPct != null ? `${Math.round(inf.fullPct * 100)}% full throttle at speed` : 'collecting telemetry'}{inf?.lastSt ? ` · trap ${inf.lastSt} km/h (best ${inf.bestSt})` : ''}</span><span className="mu">{inf?.why}{inf?.lc ? ` · ${inf.lc} lift-and-coast` : ''}</span></div>
            </div>
            <table className="tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>Lap</th><th className="n">Target</th><th>Note</th></tr></thead>
              <tbody>{tg.laps.map((x) => <tr key={x.k}><td>{x.lap}</td><td className="n">{lt(x.t)}</td><td className="mu" style={{ fontSize: 11.5 }}>{x.note || (x.k === 1 && tg.conflict ? 'slower than the DRS limit: tyres and gap conflict' : tg.m >= 0.05 ? 'tyre-save pace' : 'natural pace')}</td></tr>)}</tbody>
            </table>
            <div className="tg-gaps">
              {tg.drsLimit != null && <span className={`chip ${tg.conflict ? 'risk-high' : ''}`}>keep {drivers.get(tg.behind)?.code} out of DRS: {lt(tg.drsLimit)} or faster</span>}
              {tg.freeStopShort != null && <span className="chip">{tg.freeStopShort <= 0 ? `free stop: ${drivers.get(tg.behind)?.code} is a pit loss back` : `free stop needs ${tg.freeStopShort.toFixed(1)} s more on ${drivers.get(tg.behind)?.code}${tg.freeStopPerLap ? ` (${tg.freeStopPerLap.toFixed(2)} s/lap)` : ''}`}</span>}
              {tg.catchIn != null && <span className="chip">in DRS of {drivers.get(tg.ahead)?.code} in ~{tg.catchIn} laps at target</span>}
            </div>
            <LapVsTarget laps={recent} target={tg.target} color={d?.color} />
          </div>
        );
      })}
      <div className="merge-note" style={{ gridColumn: '1 / -1' }}><span>Targets come from the chosen plan's projected laps; managing the tyres by 0.1 s/lap is taken to stretch their life by ~4%. Modes are inferred from public telemetry (lift-and-coast before braking zones, speed-trap loss, full-throttle share): teams' engine and energy maps aren't published.</span></div>
    </div>
  );
}

function LapVsTarget({ laps, target, color }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const ok = laps.filter((l) => !l.pitOut && (!target || Math.abs(l.time - target) < 4));
    if (!ok.length || !target) return;
    const vs = ok.map((l) => l.time).concat(target);
    const lo = Math.min(...vs) - 0.2, hi = Math.max(...vs) + 0.2;
    const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 18);
    const X = (i) => 30 + (i / Math.max(1, ok.length - 1)) * (w - 40);
    ctx.fillStyle = 'rgba(0,214,107,.12)'; ctx.fillRect(30, Y(target + 0.15), w - 40, Y(target - 0.15) - Y(target + 0.15));
    ctx.strokeStyle = '#00d66b'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(30, Y(target)); ctx.lineTo(w - 10, Y(target)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = color || '#fff'; ctx.lineWidth = 2; ctx.beginPath();
    ok.forEach((l, i) => (i ? ctx.lineTo(X(i), Y(l.time)) : ctx.moveTo(X(i), Y(l.time)))); ctx.stroke();
    ctx.fillStyle = '#9d9dad'; ctx.font = '600 9px "JetBrains Mono"'; ctx.textAlign = 'left';
    ok.forEach((l, i) => { ctx.beginPath(); ctx.arc(X(i), Y(l.time), 2.5, 0, 7); ctx.fillStyle = color || '#fff'; ctx.fill(); ctx.fillStyle = '#6c6c7c'; ctx.fillText(`L${l.lap}`, X(i) - 8, h - 2); });
  }, [laps, target, color]);
  return <div style={{ height: 90, marginTop: 6 }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="Last laps against the target band" /></div>;
}

/* ---------------- flags, penalties and incidents ---------------- */
export function Flags({ eng, ex, drivers, state }) {
  const { inc } = eng;
  const code = (n) => drivers.get(n)?.code || `#${n}`;
  const ours = new Set(eng.ours.map((d) => d.n));
  const pens = [...inc.penalties].flatMap(([n, ps]) => ps.map((p) => ({ n, ...p }))).sort((a, b) => b.t - a.t);
  const tls = [...inc.trackLimits].sort((a, b) => b[1].count - a[1].count);
  const FL = { GREEN: ['Green', 'var(--grn)'], YELLOW: ['Yellow', 'var(--yel)'], 'DOUBLE YELLOW': ['Double yellow', 'var(--yel)'], SC: ['Safety car', '#ffb020'], VSC: ['Virtual safety car', '#ffb020'], RED: ['Red flag', 'var(--red)'], CHEQUERED: ['Chequered', '#fff'] };
  const [fl, fc] = FL[eng.s.flag] || [eng.s.flag, '#fff'];
  return (
    <div className="deck-grid">
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="tag" style={{ background: fc, color: '#15151e' }}>{fl}</span>
          {inc.drs && <span className="chip" style={{ color: inc.drs.on ? 'var(--grn)' : undefined }}>DRS {inc.drs.on ? 'enabled' : 'disabled'}</span>}
          {state.yellows?.length > 0 && <span className="chip" style={{ color: 'var(--yel)', borderColor: 'var(--yel)' }}>yellow · sector {state.yellows.map((y) => y.sector).join(', ')}</span>}
          {inc.rainRisk && <span className="chip">stewards' rain risk {inc.rainRisk.pct}%</span>}
          <span className="chip">pit loss now ~{eng.s.lossNow.toFixed(0)} s</span>
        </div>
        <ul className="fc-list big">
          {!ex?.flags.length && <li><i style={{ background: 'var(--grn)' }} /><div><b>Nothing to act on</b><span>Penalties, investigations, track limits, blue flags, yellows, safety cars and red flags show up here with what they mean for the plan.</span></div></li>}
          {(ex?.flags || []).map((f, k) => <li key={k}><i style={{ background: TONE[f.tone] }} /><div><b>{f.title}</b><span>{f.text}</span></div>{f.voice && <button className="btn sm ghost" onClick={() => speak(f.voice)} title="Say it on the radio">▶</button>}</li>)}
        </ul>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="card"><div className="card-h"><b>Penalties</b><span className="chip">{pens.filter((p) => !p.served).length} outstanding</span></div>
          <div className="scroll" style={{ maxHeight: 180 }}><table className="tbl"><thead><tr><th>Car</th><th>Penalty</th><th>Reason</th><th>Status</th></tr></thead><tbody>
            {!pens.length && <tr><td colSpan="4" className="mu">None so far.</td></tr>}
            {pens.map((p, k) => <tr key={k} style={{ background: ours.has(p.n) ? 'rgba(0,200,255,.10)' : undefined }}><td>{code(p.n)}</td><td>{penaltyText([{ ...p, served: false }])}</td><td className="mu" style={{ fontSize: 11 }}>{p.reason?.toLowerCase()}</td><td style={{ color: p.served ? 'var(--grn)' : '#ffb020' }}>{p.served ? 'served at the stop' : `owed · ~${p.cost.toFixed(0)} s`}</td></tr>)}
          </tbody></table></div></div>
        <div className="card"><div className="card-h"><b>Under investigation</b><span className="chip">{inc.investigations.length} open</span></div>
          <ul className="fc-list" style={{ padding: '0 12px 10px' }}>
            {!inc.investigations.length && <li className="mu">No open investigations.</li>}
            {inc.investigations.map((i, k) => <li key={k}><i style={{ background: i.cars.some((n) => ours.has(n)) ? 'var(--red)' : '#ffb020' }} /><div><b>{i.cars.map(code).join(' & ')}{i.where ? ` · ${i.where.toLowerCase()}` : ''}</b><span>{i.reason?.toLowerCase() || 'incident'}</span></div></li>)}
          </ul></div>
        <div className="card"><div className="card-h"><b>Track limits</b><span className="chip">3 strikes: black-and-white flag · 4th: 5 s</span></div>
          <div className="row" style={{ gap: 6, padding: '8px 12px 12px' }}>
            {!tls.length && <span className="mu">No laps deleted.</span>}
            {tls.map(([n, tl]) => <span key={n} className="chip" style={{ borderColor: tl.count >= 3 ? 'var(--red)' : tl.count === 2 ? '#ffb020' : undefined, color: ours.has(n) ? '#fff' : undefined }}>{code(n)} · {tl.count}{tl.bw ? ' · B/W' : ''} · {[...tl.corners.keys()].join(', ').toLowerCase()}</span>)}
          </div></div>
      </div>
    </div>
  );
}

/* ---------------- weather ---------------- */
export function Weather({ ex }) {
  const wx = ex?.wx;
  if (!wx) return <div className="empty"><b>No weather data yet</b>The circuit weather station reports about once a minute.</div>;
  const c = wx.cur;
  const tr = (x, unit, d = 1) => (x == null ? '' : <small style={{ color: x > 0 ? '#ffb020' : 'var(--cyan)', marginLeft: 6 }}>{x > 0 ? '▲' : '▼'}{Math.abs(x).toFixed(d)}{unit}</small>);
  return (
    <div className="deck-grid">
      <div className="stack" style={{ gap: 12 }}>
        <div className="wx-grid">
          <div><span className="lbl">Air</span><b>{c.air?.toFixed(1)}°C{tr(wx.trend.air, '°')}</b></div>
          <div><span className="lbl">Track</span><b>{c.track?.toFixed(1)}°C{tr(wx.trend.track, '°')}</b></div>
          <div><span className="lbl">Humidity</span><b>{Math.round(c.humidity ?? 0)}%{tr(wx.trend.humidity, '%', 0)}</b></div>
          <div><span className="lbl">Pressure</span><b>{c.pressure != null ? `${c.pressure.toFixed(1)} hPa` : '—'}{tr(wx.trend.pressure, '', 1)}</b></div>
          <div><span className="lbl">Wind</span><b className="row" style={{ gap: 8 }}>{c.wind?.toFixed(1)} m/s {c.windDir != null && <span className="compass" title={`from ${c.windDir}°`}><i style={{ transform: `rotate(${c.windDir + 180}deg)` }}>↑</i></span>}<small className="mu">{wx.compass ? `from ${wx.compass}` : ''}</small></b></div>
          <div><span className="lbl">Rain</span><b style={{ color: c.rain ? 'var(--cyan)' : undefined }}>{c.rain ? 'RAINING' : 'dry'}</b></div>
        </div>
        <div className="card"><div className="card-h"><b>Rain risk</b><span className="chip">{wx.risk}%</span></div>
          <div className="card-b"><div className="bar" style={{ height: 8, background: '#1a1a22' }}><i style={{ display: 'block', height: '100%', width: `${wx.risk}%`, background: wx.risk >= 70 ? 'var(--cyan)' : wx.risk >= 40 ? '#ffb020' : 'var(--grn)' }} /></div>
            <div className="mu" style={{ fontSize: 12, marginTop: 6 }}>{wx.why.length ? wx.why.join(' · ') : 'no signs of rain'}</div></div></div>
        <ul className="fc-list big">{(wx.notes.length ? wx.notes : ['Conditions stable: no weather effect on the plan.']).map((t, k) => <li key={k}><i style={{ background: 'var(--cyan)' }} /><div><span style={{ color: '#fff', fontSize: 13 }}>{t}</span></div></li>)}</ul>
      </div>
      <WeatherChart series={wx.series} />
    </div>
  );
}

function WeatherChart({ series }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    if (series.length < 2) return;
    const t0 = series[0].t, t1 = series.at(-1).t;
    const X = (t) => 40 + ((t - t0) / (t1 - t0 || 1)) * (w - 50);
    const lines = [['track', '#ff7a1a', 'Track °C'], ['air', '#fff', 'Air °C'], ['humidity', '#38d8ff', 'Humidity %']];
    const vals = series.flatMap((s) => [s.track, s.air, s.humidity]).filter((v) => v != null);
    const lo = Math.min(...vals) - 2, hi = Math.max(...vals) + 2;
    const Y = (v) => 10 + (1 - (v - lo) / (hi - lo)) * (h - 34);
    ctx.fillStyle = '#6c6c7c'; ctx.font = '600 9px "JetBrains Mono"'; ctx.textAlign = 'right';
    for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4; ctx.fillText(v.toFixed(0), 34, Y(v) + 3); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(40, Y(v), w - 50, 1); ctx.fillStyle = '#6c6c7c'; }
    for (const s of series) if (s.rain) { ctx.fillStyle = 'rgba(56,216,255,.15)'; ctx.fillRect(X(s.t) - 2, 10, 4, h - 34); }
    lines.forEach(([k, col, label], j) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath();
      series.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s[k])) : ctx.moveTo(X(s.t), Y(s[k])))); ctx.stroke();
      ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(label, 44 + j * 90, h - 6);
    });
  }, [series.length]);
  return <div className="card"><div className="card-h"><b>Session weather</b><span className="chip">track · air · humidity · rain shaded</span></div><div style={{ height: 260, padding: 8 }}><canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="Track temperature, air temperature and humidity over the session" /></div></div>;
}

/* ---------------- driver ratings ---------------- */
export function Drivers({ eng, drivers }) {
  const ours = new Set(eng.ours.map((d) => d.n));
  const list = [...eng.skill].filter(([, r]) => r.overall != null).sort((a, b) => b[1].overall - a[1].overall);
  const Bar = ({ v }) => <span className="rbar"><i style={{ width: `${v ?? 0}%`, background: v >= 80 ? 'var(--grn)' : v >= 60 ? '#ffb020' : 'var(--red)' }} /><em>{v == null ? '—' : Math.round(v)}</em></span>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="scroll" style={{ maxHeight: 480 }}>
        <table className="tbl">
          <thead><tr><th>#</th><th>Driver</th><th>Rating</th><th>Pace</th><th className="n">to best</th><th>Consistency</th><th className="n">σ</th><th>Tyres</th><th className="n">deg vs field</th><th>Racecraft</th><th className="n">passes</th></tr></thead>
          <tbody>{list.map(([n, r], k) => (
            <tr key={n} style={{ background: ours.has(n) ? 'rgba(0,200,255,.10)' : undefined }}>
              <td>{k + 1}</td><td><Drv d={drivers.get(n)} /></td><td><Bar v={r.overall} /></td>
              <td><Bar v={r.pace} /></td><td className="n">{r.paceDelta != null ? `+${r.paceDelta.toFixed(2)}` : '—'}</td>
              <td><Bar v={r.cons} /></td><td className="n">{r.sd != null ? r.sd.toFixed(2) : '—'}</td>
              <td><Bar v={r.tyres} /></td><td className="n">{r.tyreDelta != null ? sgn(r.tyreDelta, 3) : '—'}</td>
              <td><Bar v={r.racecraft} /></td><td className="n">{r.made}/{r.lost}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <div className="merge-note"><span>From this session up to the clock: pace = best five fuel-corrected clean laps vs the field's best; consistency = spread around each stint's degradation line; tyres = degradation vs the field on the same compound; racecraft = on-track overtakes made and suffered (OpenF1). Racecraft feeds the pass probabilities in the battle forecast.</span></div>
    </div>
  );
}

/* ---------------- tyre degradation, properly ---------------- */
export function TyreField({ eng, rows, drivers, data, state }) {
  const ours = new Set(eng?.ours.map((d) => d.n) || []);
  const comps = useMemo(() => compoundSummary(data, eng?.model, state.t), [data, eng?.model, Math.floor((state.t || 0) / 10000)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!eng) return null;
  return (
    <div className="two">
      <div className="card">
        <div className="card-h"><b>Tyre life, whole field</b><span className="chip">age vs expected life · fuel-corrected deg</span></div>
        <div className="scroll" style={{ maxHeight: 300, padding: '4px 12px' }}>
          {rows.filter((r) => r.pos < 99 && eng.s.plans.has(r.n)).map((r) => {
            const p = eng.s.plans.get(r.n); const pr = eng.proj.cars.get(r.n)?.pr;
            const L = pr ? pr.life(pr.c) : p.L; const used = Math.min(1.3, (p.age || 0) / L);
            const st = used > 1 ? ['past life', 'var(--red)'] : used > 0.85 ? ['cliff near', '#ffb020'] : used > 0.6 ? ['managing', 'var(--yel)'] : ['fresh', 'var(--grn)'];
            return (
              <div key={r.n} className="sh-row" style={{ background: ours.has(r.n) ? 'rgba(0,200,255,.08)' : undefined }}>
                <span className="mono" style={{ width: 22 }}>{r.pos}</span><span style={{ width: 48 }}><Drv d={drivers.get(r.n)} /></span>
                {r.tc ? <Tyre c={r.tc} /> : <span style={{ width: 22 }} />}
                <div className="sh-bar"><i style={{ left: 0, width: `${Math.min(100, used * 100)}%`, background: st[1] }} /></div>
                <span className="mono" style={{ width: 60, textAlign: 'right' }}>{p.age}/{L}</span>
                <span className="mono" style={{ width: 62, textAlign: 'right' }}>{p.deg != null ? sgn(p.deg, 3) : '—'}</span>
                <span style={{ width: 70, color: st[1], fontSize: 10, fontWeight: 900, textTransform: 'uppercase' }}>{st[0]}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <div className="card-h"><b>Compounds in this race</b><span className="chip">from finished and current stints</span></div>
        <table className="tbl">
          <thead><tr><th>Compound</th><th className="n">Deg s/lap</th><th className="n">vs Medium</th><th className="n">Stints</th><th className="n">Longest</th><th className="n">Life (est.)</th></tr></thead>
          <tbody>{comps.map((c) => <tr key={c.c}><td><span className="row" style={{ gap: 6 }}><Tyre c={c.c} />{COMPOUNDS[c.c]?.name}</span></td><td className="n">{c.deg != null ? sgn(c.deg, 3) : '—'}</td><td className="n">{c.offset != null ? sgn(c.offset, 2) : '—'}</td><td className="n">{c.stints}</td><td className="n">{c.longest || '—'}</td><td className="n">{eng.model.life[c.c]?.laps}{eng.model.life[c.c]?.from ? '' : '*'}</td></tr>)}</tbody>
        </table>
        <div className="merge-note"><span>deg: median per-stint slope of fuel-corrected clean laps · vs Medium: median fuel-corrected lap on the compound minus on the Medium (negative is quicker) · * typical value until stints finish</span></div>
      </div>
    </div>
  );
}

function compoundSummary(data, model, t) {
  if (!data || !model) return [];
  const by = {};
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  for (const s of data.stints || []) {
    const c = COMP[s.compound]; if (!c) continue;
    const laps = (model.byDriver.get(s.n) || []).filter((l) => l.lap >= (s.from ?? 1) && l.lap <= (s.to ?? 999) && l.t <= t && model.clean(l));
    if (!laps.length) continue;
    const pts = laps.map((l) => [l.lap - (s.from ?? 1) + (s.age || 0), l.time + FUEL_S_PER_LAP * l.lap]);
    const o = (by[c] ||= { c, slopes: [], fc: [], stints: 0, longest: 0 });
    o.stints++; o.longest = Math.max(o.longest, laps.at(-1).lap - (s.from ?? 1) + 1);
    o.fc.push(...pts.map((p) => p[1]));
    if (pts.length >= 5) { const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n; let nu = 0, de = 0; for (const [x, y] of pts) { nu += (x - mx) * (y - my); de += (x - mx) ** 2; } if (de) o.slopes.push(nu / de); }
  }
  const mM = by.M ? med(by.M.fc) : null;
  return ['S', 'M', 'H', 'I', 'W'].filter((c) => by[c]).map((c) => ({ c, deg: med(by[c].slopes), offset: mM != null && c !== 'M' ? med(by[c].fc) - mM : c === 'M' ? 0 : null, stints: by[c].stints, longest: by[c].longest }));
}

/* ---------------- the engineer's radio calls ---------------- */
export function EngineerCalls({ ex }) {
  const sound = useUI((s) => s.sound);
  const calls = ex?.calls || [];
  return (
    <div className="card">
      <div className="card-h"><b>Engineer → driver</b><span className="chip">{sound ? 'spoken automatically when they change' : 'switch sound on to hear them'}</span></div>
      <ul className="fc-list" style={{ padding: '0 12px 10px', maxHeight: 300, overflow: 'auto' }}>
        {!calls.length && <li className="mu">Pick your team: the engineer's calls are for your two cars.</li>}
        {calls.map((c, k) => (
          <li key={k}><i style={{ background: c.prio === 0 ? 'var(--red)' : c.prio === 1 ? '#ffb020' : c.color || 'var(--cyan)' }} />
            <div><b>{c.code} · {c.kind === 'box' ? 'BOX' : c.kind}</b><span style={{ color: '#fff' }}>{c.text}</span></div>
            <button className="btn sm ghost" onClick={() => speak(c.voice)} title="Say it">▶ Say</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Monte Carlo summary for one option */
export function McCell({ m }) {
  if (!m) return null;
  const max = Math.max(...m.hist.map((h) => h[1]));
  return (
    <span className="mc" title={`Monte Carlo: expected P${m.exp.toFixed(1)}; 80% between P${m.p10} and P${m.p90}; podium ${Math.round(m.pPodium * 100)}%; a safety car or VSC in ${Math.round(m.scShare * 100)}% of runs`}>
      <span className="mc-h">{m.hist.slice(0, 12).map(([p, c]) => <i key={p} style={{ height: `${(c / max) * 100}%` }} title={`P${p}`} />)}</span>
      E[P{m.exp.toFixed(1)}] · P{m.p10}–{m.p90} · podium {Math.round(m.pPodium * 100)}%
    </span>
  );
}
