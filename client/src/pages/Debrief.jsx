import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useReplay } from '../store/replay.js';
import { useUI } from '../store/stores.js';
import { useRealAnalysis } from './RealTelemetry.jsx';
import { useMock } from '../lib/crew.js';
import { COMP, COMP_NAME } from '../lib/realStrategy.js';
import { teamDrivers } from '../lib/teams.js';
import { Tyre } from '../components/TimingTower.jsx';

const TYRE_COL = { S: '#ff3b3b', M: '#ffd400', H: '#f2f2f2', I: '#2bd94e', W: '#2a8cff' };

/**
 * After a mock: every call the crew made, set against what the real team did
 * (when they actually stopped, on which tyres) and where the car finished.
 */
export default function Debrief() {
  const { meta, key, state } = useReplay();
  const doc = useMock((s) => s.doc);
  const error = useMock((s) => s.error);
  const team = useUI((s) => s.realTeam);
  const data = useRealAnalysis(key);

  const clockT = meta?.mock && doc && String(meta.mock.id) === String(doc.id) ? Math.max(doc.t, state.t || 0) : doc?.t;
  const clockLap = Math.floor((clockT || 0) / 60_000); // re-derive the covered laps about once a minute of session time
  const rep = useMemo(() => {
    if (!doc || !data) return null;
    const pitsBy = new Map();
    for (const p of data.pits) { let a = pitsBy.get(p.n); if (!a) pitsBy.set(p.n, a = []); a.push(p); }
    for (const a of pitsBy.values()) a.sort((x, y) => x.t - y.t);
    const lastLap = new Map();
    for (const l of data.laps) if (l.pos != null && (!lastLap.get(l.n) || l.lap > lastLap.get(l.n).lap)) lastLap.set(l.n, l);
    const fitted = (n, pitLap) => COMP[(data.stints.find((s) => s.n === n && s.from === pitLap + 1) || {}).compound];
    const rows = doc.calls.map((c) => {
      const next = (pitsBy.get(c.n) || []).find((p) => p.t >= c.t - 30_000 && p.lap >= c.lap - 1);
      const real = next ? { lap: next.lap, tyre: fitted(c.n, next.lap) } : null;
      let verdict, ok;
      if (c.kind === 'box') {
        if (!real) { verdict = 'The team did not stop again'; ok = false; }
        else if (Math.abs(real.lap - c.lap) <= 1) { verdict = `Matched: the team stopped on lap ${real.lap}`; ok = true; }
        else { const k = real.lap - c.lap; verdict = `The team stopped ${Math.abs(k)} lap${Math.abs(k) === 1 ? '' : 's'} ${k > 0 ? 'later' : 'earlier'} (lap ${real.lap})`; ok = false; }
      } else if (c.kind === 'stay') {
        if (real && real.lap <= c.lap + 1) { verdict = `The team boxed on lap ${real.lap}`; ok = false; }
        else { verdict = real ? `Matched: the team stayed out until lap ${real.lap}` : 'Matched: the team stayed out'; ok = true; }
      } else { verdict = ''; ok = null; }
      const tyreOk = c.kind === 'box' && real?.tyre ? real.tyre === c.compound : null;
      const fin = lastLap.get(c.n);
      return { ...c, real, verdict, ok, tyreOk, finish: fin?.pos ?? null };
    });
    const judged = rows.filter((r) => r.ok != null);
    const agree = judged.filter((r) => r.ok).length;
    const total = Math.max(0, ...data.laps.map((l) => l.lap));
    // the lap the leader is on at time t
    const leaderLapAt = (t) => Math.min(total, Math.max(0, ...data.laps.filter((l) => l.t <= t).map((l) => l.lap)) + 1);
    return { rows, judged: judged.length, agree, total, reached: leaderLapAt(clockT), started: leaderLapAt(doc.startAt) };
  }, [doc, data, clockLap]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="card"><div className="empty"><b>No debrief</b>{error}<Link to="/" className="btn sm" style={{ marginTop: 8 }}>Back to the launcher</Link></div></div>;
  if (!meta?.mock) return <div className="card"><div className="empty"><b>Debriefs are for mock sessions</b>Start a mock from the launcher: pick a past race, run it on your own clock, make your calls, then come back here.<Link to="/" className="btn sm red" style={{ marginTop: 8 }}>Open the launcher</Link></div></div>;
  if (!doc || !data || !rep) return <div className="shimmer" style={{ height: 300 }} />;
  const drivers = new Map((meta.drivers || []).map((d) => [d.n, d]));
  const ours = teamDrivers(meta, team);
  const timeline = [...new Set([...ours.map((d) => d.n), ...doc.calls.map((c) => c.n)])];

  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Debrief</h1><p>{doc.name}{doc.team ? ` · ${doc.team}` : ''}. Your calls from this mock, set against what the real team did and where the car finished.</p></div>
        <div className="row" style={{ gap: 8 }}>
          <Link to="/strategy" className="btn sm ghost">Back to strategy</Link>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(location.origin + `/mock/${doc.id}/debrief`)}>Copy debrief link</button>
        </div>
      </div>

      <div className="four">
        <div className="card"><div className="card-b"><div className="lbl">Calls made</div><b className="big mono">{doc.calls.length}</b></div></div>
        <div className="card"><div className="card-b"><div className="lbl">Matched the real team</div><b className="big mono" style={{ color: rep.judged && rep.agree / rep.judged >= 0.6 ? '#2bd94e' : undefined }}>{rep.judged ? `${Math.round((rep.agree / rep.judged) * 100)}%` : '—'}</b><div className="mu" style={{ fontSize: 12 }}>{rep.agree} of {rep.judged} box / stay calls within a lap</div></div></div>
        <div className="card"><div className="card-b"><div className="lbl">Laps covered</div><b className="big mono">{rep.started}–{rep.reached}</b><div className="mu" style={{ fontSize: 12 }}>of {rep.total}</div></div></div>
        <div className="card"><div className="card-b"><div className="lbl">Team</div><b style={{ fontSize: 18 }}>{doc.team || team || 'not set'}</b><div className="mu" style={{ fontSize: 12 }}>{ours.map((d) => d.code).join(' · ')}</div></div></div>
      </div>

      {timeline.length > 0 && (
        <div className="card">
          <div className="card-h"><b>Real strategy vs your calls</b><span className="chip">bars: the tyres each car really ran · markers: your box calls</span></div>
          <div className="card-b stack" style={{ gap: 14 }}>
            {timeline.map((n) => {
              const d = drivers.get(n);
              const stints = data.stints.filter((s) => s.n === n);
              const calls = doc.calls.filter((c) => c.n === n && c.kind === 'box');
              const W = (lap) => `${((lap - 1) / rep.total) * 100}%`;
              return (
                <div key={n} className="row" style={{ gap: 12, alignItems: 'center' }}>
                  <span className="drv" style={{ width: 70 }}><i style={{ background: d?.color }} />{d?.code}</span>
                  <div style={{ position: 'relative', flex: 1, height: 26 }}>
                    <div style={{ position: 'absolute', left: W(rep.started), width: `${((rep.reached - rep.started + 1) / rep.total) * 100}%`, top: -3, bottom: -3, background: 'rgba(0,200,255,.08)', border: '1px dashed rgba(0,200,255,.4)' }} title="the part of the race this mock covered" />
                    {stints.map((s) => { const c = COMP[s.compound]; const to = s.to ?? rep.total; return (
                      <div key={s.from} title={`${COMP_NAME[c] || s.compound}: laps ${s.from}–${to}`} style={{ position: 'absolute', left: W(s.from), width: `${((to - s.from + 1) / rep.total) * 100}%`, top: 8, height: 10, background: TYRE_COL[c] || '#666', opacity: 0.85, borderRight: '2px solid var(--bg)' }} />
                    ); })}
                    {calls.map((c) => (
                      <div key={c.id} title={`You: box for ${c.compound} on lap ${c.lap}`} style={{ position: 'absolute', left: `calc(${W(c.lap + 1)} - 6px)`, top: -2, width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `9px solid ${TYRE_COL[c.compound]}`, filter: 'drop-shadow(0 0 2px #000)' }} />
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="row mu" style={{ gap: 14, fontSize: 12 }}>{Object.entries(TYRE_COL).map(([c, col]) => <span key={c} className="row" style={{ gap: 5 }}><i style={{ display: 'inline-block', width: 14, height: 6, background: col }} />{COMP_NAME[c]}</span>)}<span>▼ your box call</span><span style={{ color: 'var(--cyan)' }}>dashed: laps this mock covered</span></div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h"><b>Every call</b><span className="chip">in the order you made them</span></div>
        {!rep.rows.length
          ? <div className="empty"><b>No calls logged yet</b>Open Strategy during the mock and use "Your call" on the strategist cards.</div>
          : <div className="scroll"><table className="tbl">
              <thead><tr><th>Car</th><th className="n">Lap</th><th className="n">Pos</th><th>Your call</th><th>Strategist said</th><th>What the team did</th><th>Tyres</th><th className="n">Finished</th></tr></thead>
              <tbody>
                {rep.rows.map((r) => { const d = drivers.get(r.n); return (
                  <tr key={r.id}>
                    <td><span className="drv"><i style={{ background: d?.color }} />{d?.code}</span></td>
                    <td className="n">{r.lap}</td><td className="n">P{r.pos}</td>
                    <td><span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><b>{r.kind === 'box' ? 'BOX' : r.kind === 'stay' ? 'STAY OUT' : 'NOTE'}</b>{r.kind === 'box' && <Tyre c={r.compound} />}{r.by && <span className="mu">· {r.by}</span>}</span></td>
                    <td className="mu" style={{ fontSize: 12 }}>{r.advice || '—'}</td>
                    <td style={{ color: r.ok == null ? undefined : r.ok ? '#2bd94e' : '#ffb020', fontWeight: 700, fontSize: 12.5 }}>{r.verdict}</td>
                    <td>{r.real?.tyre ? <span className="row" style={{ gap: 6 }}><Tyre c={r.real.tyre} />{r.tyreOk != null && <span className="mu" style={{ fontSize: 12 }}>{r.tyreOk ? 'same' : 'different'}</span>}</span> : '—'}</td>
                    <td className="n">{r.finish ? `P${r.finish}` : '—'}</td>
                  </tr>
                ); })}
              </tbody>
            </table></div>}
        <div className="merge-note"><span>matched = the real team stopped within a lap of your box call, or stayed out at least two laps after your stay-out call · finishing positions from the official timing</span></div>
      </div>
    </div>
  );
}
