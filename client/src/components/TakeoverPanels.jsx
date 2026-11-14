import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReplay } from '../store/replay.js';
import { useUI, useToasts } from '../store/stores.js';
import { useTakeover, takeoverCommand, startTakeover } from '../lib/takeover.js';
import { teamDrivers } from '../lib/teams.js';
import { Tyre } from './TimingTower.jsx';

const MODES = [['push', 'Push'], ['standard', 'Standard'], ['manage', 'Tyre save'], ['save', 'Lift & coast']];
const COMPS = ['S', 'M', 'H', 'I', 'W'];

/** one car's controls in a takeover: box (now or at a lap, on which tyres), cancel, engine mode, team orders, autopilot */
export function CarCommand({ n, compact = false }) {
  const tk = useTakeover();
  const meta = useReplay((s) => s.meta);
  const row = useReplay((s) => s.rows.find((r) => r.n === n));
  const [busy, setBusy] = useState(false);
  const [lap, setLap] = useState('');
  if (!tk || !row) return null;
  const st = tk.car(n) || { mode: 'standard' };
  const d = meta.drivers.find((x) => x.n === n);
  const mate = meta.drivers.find((x) => x.team === d?.team && x.n !== n);
  const go = async (cmd) => { setBusy(true); await takeoverCommand(tk.ch, { n, ...cmd }); setBusy(false); };
  const ended = tk.status?.chequered || tk.status?.ended;
  const red = tk.status?.red;
  return (
    <div className="tk-car" style={{ '--tc': d?.color }}>
      <div className="row" style={{ gap: 8 }}>
        <b style={{ color: d?.color }}>{d?.code}</b><span className="mu">P{row.pos} · lap {row.lap}</span>{row.tc && <Tyre c={row.tc} age={row.ta} />}
        <span className="spacer" />
        {st.lane ? <span className="chip tk-hot">IN THE PIT LANE</span>
          : st.box ? <span className="chip tk-hot">BOX {st.box.compound ? `· ${st.box.compound}` : ''} {st.box.lap ? `· end of lap ${st.box.lap}` : '· this lap'}</span>
          : <span className="chip">staying out</span>}
        {st.owed > 0 && <span className="chip" style={{ color: 'var(--yel)', borderColor: 'var(--yel)' }}>+{st.owed} s owed</span>}
        {st.puncture && <span className="chip" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>PUNCTURE</span>}
      </div>
      {!ended && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <span className="lbl" style={{ margin: 0, minWidth: 64 }}>{red ? 'Red flag: free change' : lap ? `Box lap ${lap}` : 'Box this lap'}</span>
            {COMPS.map((c) => <button key={c} className="btn sm tk-tyre" disabled={busy || st.lane} onClick={() => go({ type: 'box', compound: c, ...(lap && !red ? { lap: Number(lap) } : {}) })} title={`Box for ${c}`}><Tyre c={c} /></button>)}
            <input className="input" aria-label="Box at the end of lap" placeholder="lap" inputMode="numeric" value={lap} onChange={(e) => setLap(e.target.value.replace(/\D/g, '').slice(0, 2))} style={{ width: 50, height: 28 }} />
            <button className="btn sm ghost" disabled={busy || !st.box || st.lane} onClick={() => go({ type: 'cancel-box' })}>Stay out</button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="lbl" style={{ margin: 0, minWidth: 64 }}>Mode</span>
            <div className="seg">{MODES.map(([k, l]) => <button key={k} className={st.mode === k ? 'on' : ''} disabled={busy} onClick={() => go({ type: 'mode', mode: k })}>{l}</button>)}</div>
          </div>
          {!compact && (
            <div className="row" style={{ gap: 6 }}>
              {mate && <>
                <span className="lbl" style={{ margin: 0, minWidth: 64 }}>Team order</span>
                <div className="seg">{[['swap', `Let ${mate.code} by`], ['hold', 'Hold'], ['race', 'Race']].map(([k, l]) => <button key={k} className={(st.order || 'race') === k ? 'on' : ''} disabled={busy} onClick={() => go({ type: 'order', order: k })}>{l}</button>)}</div>
              </>}
              <span className="spacer" />
              <label className="row" style={{ gap: 6, fontSize: 12 }} title="Let the strategist make this car's stops when you haven't called one">
                <input type="checkbox" checked={!!st.auto} onChange={(e) => go({ type: 'auto', on: e.target.checked })} /> autopilot stops
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** race control for a takeover: flags, weather, stewards, random incidents */
export function RaceControlPanel({ selected }) {
  const tk = useTakeover();
  const meta = useReplay((s) => s.meta);
  const [busy, setBusy] = useState(false);
  if (!tk) return null;
  const s = tk.status || {};
  const go = async (cmd) => { setBusy(true); await takeoverCommand(tk.ch, cmd); setBusy(false); };
  const d = meta.drivers.find((x) => x.n === selected);
  const neutral = s.flag === 'SC' || s.flag === 'VSC';
  const done = s.chequered || s.ended;
  return (
    <div className="tk-rc">
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ margin: 0, minWidth: 74 }}>Flags</span>
        <button className="btn sm tk-sc" disabled={busy || done || neutral || s.red} onClick={() => go({ type: 'sc' })}>Safety car</button>
        <button className="btn sm tk-sc" disabled={busy || done || neutral || s.red} onClick={() => go({ type: 'vsc' })}>VSC</button>
        <button className="btn sm ghost" disabled={busy || !neutral || s.sc?.ending} onClick={() => go({ type: 'end-sc' })}>{s.flag === 'VSC' ? 'End VSC' : 'SC in this lap'}</button>
        {s.red ? <button className="btn sm red" disabled={busy} onClick={() => go({ type: 'resume' })}>Resume race</button>
          : <button className="btn sm red" disabled={busy || done} onClick={() => go({ type: 'red' })}>Red flag</button>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ margin: 0, minWidth: 74 }}>Weather</span>
        <div className="seg">{[['dry', 'Dry'], ['light', 'Light rain'], ['heavy', 'Heavy rain']].map(([k, l]) => (
          <button key={k} className={(k === 'dry' ? !s.rain : k === 'light' ? s.rain > 0 && s.rain < 0.6 : s.rain >= 0.6) ? 'on' : ''} disabled={busy || done} onClick={() => go(k === 'dry' ? { type: 'dry' } : { type: 'rain', level: k })}>{l}</button>
        ))}</div>
        <span className="mu" style={{ fontSize: 12 }}>track wetness <b className="mono">{Math.round((s.wet || 0) * 100)}%</b></span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ margin: 0, minWidth: 74 }}>{d ? `Stewards · ${d.code}` : 'Stewards'}</span>
        <button className="btn sm ghost" disabled={busy || !d || done} onClick={() => go({ type: 'penalty', n: d.n, kind: 'time', secs: 5 })}>5 s penalty</button>
        <button className="btn sm ghost" disabled={busy || !d || done} onClick={() => go({ type: 'penalty', n: d.n, kind: 'drive-through' })}>Drive-through</button>
        <button className="btn sm ghost" disabled={busy || !d || done} onClick={() => go({ type: 'puncture', n: d.n })}>Puncture</button>
        <button className="btn sm ghost" disabled={busy || !d || done} onClick={() => go({ type: 'failure', n: d.n })}>Failure</button>
        {!d && <span className="mu" style={{ fontSize: 12 }}>select a car on the timing tower</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={!!s.random} disabled={done} onChange={(e) => go({ type: 'random', on: e.target.checked })} /> random race events (safety cars, punctures, failures, track limits)</label>
      </div>
    </div>
  );
}

/** the takeover's own pit wall: the crew's cars and race control, under the timing and map */
export function TakeoverDeck({ selected }) {
  const tk = useTakeover();
  const meta = useReplay((s) => s.meta);
  const team = useUI((s) => s.realTeam);
  if (!tk) return null;
  const ours = teamDrivers(meta, team).map((d) => d.n);
  const cars = ours.length ? ours : selected ? [selected] : [];
  const s = tk.status || {};
  return (
    <div className="card tk-deck">
      <div className="card-h">
        <b>Takeover · your pit wall</b>
        <span className="chip">real race to lap {tk.fork.lap0}, simulated since</span>
        {s.pitLoss && <span className="chip" title="calibrated on this session's own stops and laps">pit loss {s.pitLoss} s · life S {s.life?.S} / M {s.life?.M} / H {s.life?.H} laps</span>}
        {s.ended && <span className="chip tk-hot">FINISHED</span>}
      </div>
      <div className="card-b tk-grid">
        <div className="stack" style={{ gap: 12 }}>
          {cars.length ? cars.map((n) => <CarCommand key={n} n={n} />) : <div className="mu">Pick your team at the top (or select a car) to run its strategy.</div>}
          {!ours.length && <div className="mu" style={{ fontSize: 12 }}>No team picked: you can run whichever car you select.</div>}
        </div>
        <RaceControlPanel selected={selected} />
      </div>
    </div>
  );
}

/** "take over from here": fork the open session at its clock */
export function TakeoverButton({ label = 'Take over from here', className = 'btn sm red' }) {
  const meta = useReplay((s) => s.meta);
  const ch = useReplay((s) => s.key);
  const state = useReplay((s) => s.state);
  const team = useUI((s) => s.realTeam);
  const setSource = useUI((s) => s.setSource);
  const toast = useToasts((s) => s.push);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!meta || meta.fork || !/Race|Sprint$/.test(meta.type || '')) return null;
  const go = async () => {
    setBusy(true);
    try {
      const r = await startTakeover({ from: state.live ? 'live' : ch, team });
      setSource({ kind: 'real', key: r.ch, name: r.snapshot.meta.name, mock: true });
      toast({ kind: 'cyan', title: 'You have the pit wall', text: `Forked at lap ${r.snapshot.meta.fork.lap0}. From here the race is simulated and your calls change it. Press play.`, ms: 6000 });
      nav('/pitwall');
    } catch (e) { toast({ kind: '', title: 'Could not take over', text: e.message }); }
    setBusy(false);
  };
  return <button className={className} disabled={busy} onClick={go} title="Fork this race at the current moment: from there the server simulates it and your calls change the outcome">{busy ? 'Forking…' : label}</button>;
}
