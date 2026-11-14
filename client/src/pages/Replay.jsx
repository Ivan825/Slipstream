import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRooms } from '../lib/live.js';
import { useRealChannel } from '../lib/realChannel.js';
import { api } from '../lib/api.js';
import { useCanvas, useAnimationFrame, useTicker } from '../lib/hooks.js';
import { useReplay, replayCars, replayPos, replayTrace, replayClock } from '../store/replay.js';
import { useAuth } from '../store/auth.js';
import { useToasts, useUI } from '../store/stores.js';
import { Tyre } from '../components/TimingTower.jsx';
import { TeamPicker } from '../components/TeamPicker.jsx';
import { sameTeam, teamDrivers } from '../lib/teams.js';
import { useRealAnalysis } from './RealTelemetry.jsx';
import { TeamAlerts } from './RealStrategy.jsx';
import { formatLapTime } from '@slipstream/shared';
import RealTrack from '../components/RealTrack.jsx';
import RaceDeck from '../components/RaceDeck.jsx';
import { TakeoverDeck, TakeoverButton } from '../components/TakeoverPanels.jsx';
import { raceEngine } from '../lib/raceEngine.js';
import { circuitOf } from '../lib/circuit.js';

export { RealTrack, DriverPanel, FLAG, clock, gapText };

const lt = (s) => (s == null ? '—' : formatLapTime(s));
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const gapText = (g) => (g == null ? '' : typeof g === 'number' ? '+' + g.toFixed(3) : String(g));
const FLAG = { GREEN: ['TRACK CLEAR', 'GREEN'], YELLOW: ['YELLOW FLAG', 'YELLOW'], 'DOUBLE YELLOW': ['DOUBLE YELLOW', 'YELLOW'], RED: ['RED FLAG', 'RED'], SC: ['SAFETY CAR', 'SC'], VSC: ['VIRTUAL SAFETY CAR', 'VSC'], CHEQUERED: ['CHEQUERED FLAG', 'CHQ'], BLUE: ['TRACK CLEAR', 'GREEN'] };

export default function RealData() {
  const { key } = useParams();
  return key ? <Channel channelKey={key} key={key} /> : <Browser />;
}

/* ---------------- session browser ---------------- */
/** Year tabs + every meeting of that year, each session a button. Shared by Home and the browser page. */
export function SessionGrid({ onPick, title = 'Every session', subtitle }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    setList(null); setErr(null);
    api(`/replay/catalog?year=${year}`).then((d) => alive && setList(d.sessions)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [year]);
  const meetings = useMemo(() => {
    const m = new Map();
    for (const s of list || []) {
      const g = m.get(s.meeting) || { meeting: s.meeting, country: s.country, circuit: s.circuit, start: s.start, sessions: [] };
      g.sessions.push(s);
      m.set(s.meeting, g);
    }
    return [...m.values()].sort((a, b) => b.start.localeCompare(a.start));
  }, [list]);
  const now = Date.now();
  return (
    <div className="stack">
      <div className="page-title">
        <div><h2 style={{ margin: 0 }}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <div className="seg">{Array.from({ length: thisYear - 2022 }, (_, i) => 2023 + i).reverse().map((y) => <button key={y} className={y === year ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}</div>
      </div>
      {err && <div className="card"><div className="empty"><b>Could not reach OpenF1</b>{err}</div></div>}
      {!list && !err && <div className="shimmer" style={{ height: 240 }} />}
      {list && !meetings.length && <div className="card"><div className="empty"><b>No sessions yet</b>OpenF1 has nothing for {year} so far.</div></div>}
      {list && (
        <div className="three">
          {meetings.map((m) => {
            const future = Date.parse(m.start) > now;
            return (
              <div key={m.meeting} className="card" style={{ opacity: future ? 0.5 : 1 }}>
                <div className="card-h"><b>{m.country}</b><span className="chip">{new Date(m.start).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></div>
                <div className="card-b">
                  <div className="mu" style={{ fontSize: 12, marginBottom: 8 }}>{m.circuit}</div>
                  <div className="row" style={{ gap: 6 }}>
                    {m.sessions.map((s) => {
                      const ended = Date.parse(s.end) < now;
                      return <button key={s.key} className={`btn sm ${/^Race$/.test(s.name) ? 'red' : ''}`} disabled={!ended} title={ended ? `Open ${s.name}` : 'Not run yet'} onClick={() => onPick(s.key)}>{s.name}</button>;
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mu" style={{ fontSize: 12, margin: 0 }}>Data: <a href="https://openf1.org" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>OpenF1</a>, an unofficial open API, used for non-commercial demonstration. Not associated with Formula 1 companies.</p>
    </div>
  );
}

function Browser() {
  const nav = useNavigate();
  const [channels, setChannels] = useState({ channels: [], cached: [], live: false });
  useEffect(() => {
    const load = () => api('/replay/channels').then(setChannels).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Archive</h1><p>Every Formula 1 session since 2023, from OpenF1. Open one to review it on a shared clock with anyone else looking at it. To rehearse a race with your own clock, call log and debrief, start a mock session from the launcher.</p></div>
      </div>
      <div className="three">
        <div className={`card ${channels.live ? 'hl' : ''}`}>
          <div className="card-h"><b>Live feed</b><span className={`live-pill ${channels.live ? '' : 'off'}`} style={{ fontSize: 10, padding: '2px 8px' }}><i />{channels.live ? 'AVAILABLE' : 'NEEDS KEY'}</span></div>
          <div className="card-b stack" style={{ gap: 8 }}>
            <p className="mu" style={{ margin: 0, fontSize: 13 }}>Follows the session that is running right now, a few seconds behind real time, and records it to MongoDB so it can be replayed afterwards.</p>
            {channels.live
              ? <button className="btn red" onClick={() => nav('/real/live')}>Open the live session</button>
              : <p className="mu" style={{ margin: 0, fontSize: 12 }}>OpenF1 real-time data needs a subscription. Set <span className="mono">OPENF1_TOKEN</span> (or <span className="mono">OPENF1_USERNAME</span> / <span className="mono">OPENF1_PASSWORD</span>) on the server to enable it. Past sessions are free.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Open right now</b><span className="chip">{channels.channels.length} shared sessions</span></div>
          <div className="card-b stack" style={{ gap: 6 }}>
            {!channels.channels.length && <span className="mu" style={{ fontSize: 13 }}>No shared session is open. Pick one below.</span>}
            {channels.channels.map((c) => (
              <button key={c.key} className="row" style={{ background: 'var(--bg-2)', border: 0, padding: '8px 10px', textAlign: 'left' }} onClick={() => nav(`/real/${c.live ? 'live' : c.key}`)}>
                <b style={{ flex: 1 }}>{c.name}</b><span className="chip">{c.viewers} connected</span><span className="chip">{c.live ? 'LIVE' : `${clock(c.t - c.from)} · ${c.speed}×`}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><b>Stored in MongoDB</b><span className="chip">downloaded once</span></div>
          <div className="card-b stack" style={{ gap: 6 }}>
            {!channels.cached.length && <span className="mu" style={{ fontSize: 13 }}>Sessions are cached chunk by chunk as they are watched.</span>}
            {channels.cached.slice(0, 6).map((c) => (
              <button key={c.key} className="row" style={{ background: 'var(--bg-2)', border: 0, padding: '8px 10px', textAlign: 'left' }} onClick={() => nav(`/real/${c.key}`)}>
                <b style={{ flex: 1 }}>{c.name}</b><span className="chip">{c.recorded} / {c.minutes} min stored</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <SessionGrid onPick={(k) => nav(`/real/${k}`)} />
    </div>
  );
}

/* ---------------- one session, on a shared clock ---------------- */
export function Channel({ channelKey }) {
  const { opened, error: openErr } = useRealChannel(channelKey);
  useTicker(4);
  const { meta, state, rows, rc, feed, selected, select, key: ch } = useReplay();
  const role = useAuth((s) => s.user?.role);
  const toast = useToasts((s) => s.push);
  const team = useUI((s) => s.realTeam);
  const analysis = useRealAnalysis(opened ? ch : null);
  const [lapTo, setLapTo] = useState('');
  const drivers = useMemo(() => new Map((meta?.drivers || []).map((d) => [d.n, d])), [meta]);
  const eng = opened && meta && state.loaded ? raceEngine({ meta, state, rows, data: analysis, team, circuit: circuitOf(meta), focus: selected }) : null;
  // focus the crew's lead car when the session opens
  const ours = useMemo(() => teamDrivers(meta, team), [meta, team]);
  const focused = useRef(null);
  useEffect(() => {
    if (!meta || !ours.length || focused.current === ch) return;
    focused.current = ch;
    const lead = rows.filter((r) => ours.some((d) => d.n === r.n)).sort((a, b) => a.pos - b.pos)[0];
    if (lead) select(lead.n);
  }, [meta, ours, ch, rows, select]);

  if (openErr) return <div className="card"><div className="empty"><b>Could not open this session</b>{openErr}<Link to="/real" className="btn sm" style={{ marginTop: 8 }}>Back to sessions</Link></div></div>;
  if (!opened || !meta || !state.loaded) {
    return <div className="card"><div className="empty"><b>Opening the session</b>Fetching drivers, laps, positions, race control and the circuit from OpenF1. The first open takes a few seconds; after that it is cached in MongoDB.<div className="shimmer" style={{ height: 8, width: 240, marginTop: 10 }} /></div></div>;
  }

  const elapsed = state.t - state.from, total = state.to - state.from;
  const leaderLap = rows[0]?.lap || 0;
  const [flagText, flagCls] = FLAG[state.flag] || [state.flag || 'TRACK CLEAR', 'GREEN'];
  const fork = meta.fork;
  const canControl = !state.live;
  const canSeek = canControl && !fork;
  const mock = meta.mock;
  const ctl = async (body) => {
    try { await api(`/replay/${ch}/control`, { method: 'POST', body }); } catch (e) { toast({ kind: '', title: 'Playback', text: e.message }); }
  };
  // lap N starts when the leader completes lap N-1
  const jump = (n) => {
    if (!analysis || !n) return;
    const ends = analysis.laps.filter((l) => l.lap === n - 1).map((l) => l.t);
    const t = n <= 1 ? state.from : ends.length ? Math.min(...ends) - 3000 : null;
    if (t == null) return toast({ kind: 'yel', title: 'No such lap', text: `This session has no lap ${n}` });
    ctl({ action: 'seek', t: Math.max(0, t - state.from) });
  };
  const share = () => {
    navigator.clipboard?.writeText(`${location.origin}/mock/${mock.id}`);
    toast({ kind: 'cyan', title: 'Link copied', text: 'Anyone with the link joins this mock on the same clock', ms: 3500 });
  };
  const sel = drivers.get(selected) || drivers.get(rows[0]?.n);
  const w = state.weather;
  const isRace = /Race|Sprint$/.test(meta.type);
  const totalLaps = eng?.total.laps ?? meta.totalLaps ?? null;
  const plan = isRace && sel ? eng?.s.plans.get(sel.n) : null;
  const ghost = plan?.rejoin && state.flag !== 'RED' && (state.t - state.from) > 120_000 ? { pos: plan.rejoin.pos, ahead: plan.rejoin.ahead?.n, gapAhead: plan.rejoin.gapAhead, behind: plan.rejoin.behind?.n, gapBehind: plan.rejoin.gapBehind, refLap: eng.model.ref.get(sel.n) || eng.model.fieldRef } : null;
  const yellows = state.yellows || [];

  return (
    <div className="stack">
      <div className="card carbon" style={{ borderTopRightRadius: 14 }}>
        <div className="row" style={{ padding: '12px 16px', gap: 18 }}>
          <Link to={mock ? '/' : '/real'} className="chip">← {mock ? 'Launcher' : 'Archive'}</Link>
          <span className="tag" style={{ background: fork ? 'var(--org)' : state.live ? 'var(--red)' : mock ? 'var(--cyan)' : '#fff', color: state.live || fork ? '#fff' : 'var(--bg)' }}>{fork ? `Takeover · real to lap ${fork.lap0}, simulated since` : `${state.live ? 'Live feed' : mock ? 'Mock session' : 'Replay'} · OpenF1`}</span>
          <div><div className="lbl">{meta.circuit} · {meta.type}</div><b style={{ fontSize: 22, fontWeight: 900, fontStyle: 'italic', textTransform: 'uppercase' }}>{meta.year} {meta.country}</b></div>
          <div className="kv"><small>{state.live ? 'Session time' : 'Clock'}</small><b className="mono">{clock(elapsed)} <span className="mu" style={{ fontSize: 13 }}>/ {clock(total)}</span></b></div>
          {isRace && <div className="kv"><small>Lap</small><b>{leaderLap}<span className="mu" style={{ fontSize: 14 }}> / {totalLaps ?? '—'}{eng?.total.est ? '*' : ''}</span></b></div>}
          {isRace && totalLaps && <div className="kv"><small>To go</small><b>{Math.max(0, totalLaps - leaderLap)}</b></div>}
          {yellows.length > 0 && <span className="chip" style={{ borderColor: 'var(--yel)', color: 'var(--yel)' }}>YELLOW · sector{yellows.length > 1 ? 's' : ''} {yellows.map((y) => y.sector).join(', ')}</span>}
          <span className={`track-status ts-${flagCls}`} style={{ margin: 0 }}>{flagText}</span>
          {w && <div className="kv"><small>Air · track · rain</small><b style={{ fontSize: 15 }}>{w.air}° · {w.track}° · <span style={{ color: w.rain ? 'var(--cyan)' : undefined }}>{w.rain ? 'RAIN' : 'dry'}</span></b></div>}
          {state.bestLap && <div className="kv"><small>Fastest lap</small><b style={{ fontSize: 15, color: 'var(--pur)' }}>{drivers.get(state.bestLap.n)?.code} {lt(state.bestLap.time)}</b></div>}
          {state.buffering && <span className="chip" style={{ borderColor: 'var(--yel)', color: 'var(--yel)' }}>buffering from OpenF1…</span>}
          <span className="spacer" />
          <div className="kv"><small>Recorded</small><b className="mono" style={{ fontSize: 13 }}>{new Date(state.t).toISOString().slice(0, 19).replace('T', ' ')} UTC</b></div>
        </div>
        <div style={{ padding: '0 16px 12px' }}>
          <div className="row" style={{ gap: 8 }}>
            {canControl && (
              <>
                <button className="btn sm" onClick={() => ctl({ action: state.playing ? 'pause' : 'play' })}>{state.playing ? 'Pause' : 'Play'}</button>
                <div className="seg">{[1, 2, 4, 8, 16].map((s) => <button key={s} className={state.speed === s ? 'on' : ''} onClick={() => ctl({ action: 'speed', speed: s })}>{s}×</button>)}</div>
                {!fork && <button className="btn sm ghost" onClick={() => ctl({ action: 'restart' })}>{mock ? 'Back to start' : 'Restart'}</button>}
                {/Race|Sprint$/.test(meta.type) && !fork && (
                  <form className="row" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); jump(Number(lapTo)); }}>
                    <input className="input" aria-label="Jump to lap" placeholder="lap" inputMode="numeric" value={lapTo} onChange={(e) => setLapTo(e.target.value.replace(/\D/g, ''))} style={{ width: 56, height: 30 }} />
                    <button className="btn sm ghost" disabled={!analysis || !lapTo}>Jump</button>
                  </form>
                )}
              </>
            )}
            {fork
              ? <span className="mu" style={{ flex: 1, minWidth: 160, fontSize: 12.5 }}>{state.fork?.ended ? 'The race is over: the debrief sets your result against what really happened.' : 'From the fork on, the server runs the race on a model calibrated on this session, and your calls below change what happens. It only runs forward.'}</span>
              : <input aria-label="Session position" type="range" min="0" max={total} step="1000" value={Math.min(total, elapsed)} disabled={!canSeek} style={{ flex: 1, minWidth: 160 }}
                onChange={(e) => canSeek && ctl({ action: 'seek', t: Number(e.target.value) })} />}
            <span className="chip">{state.live ? 'following real time' : state.playing ? `playing ${state.speed}×` : 'paused'} · {fork ? 'simulated' : mock ? "your crew's own clock" : 'shared clock for everyone in this session'}</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <TeamPicker meta={meta} />
            {mock && <button className="btn sm" onClick={share}>Share with crew</button>}
            {mock && <Link to="/strategy" className={`btn sm ${fork ? 'ghost' : 'red'}`}>Strategy and calls</Link>}
            {mock && <Link to="/debrief" className="btn sm ghost">Debrief</Link>}
            {isRace && !fork && <TakeoverButton />}
            {isRace && !fork && <span className="mu" style={{ fontSize: 12 }}>Fork the race at this moment and run it yourself: your calls change the result.</span>}
            {!mock && !state.live && !isRace && <span className="mu" style={{ fontSize: 12 }}>Want your own clock and a call log? Start a mock session of this race from the launcher.</span>}
          </div>
        </div>
      </div>

      <div className="grid-pit" style={{ gridTemplateColumns: '330px minmax(0,1fr) 340px', height: 'calc(100vh - 54px - 60px - 36px - 118px)', minHeight: 600 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="card-h"><b>Live timing</b><span className="chip">{rows.length} cars</span></div>
          <div className="scroll" style={{ flex: 1 }}>
            {rows.map((r, i) => {
              const d = drivers.get(r.n);
              if (!d) return null;
              return (
                <div key={r.n} className={`tw ${r.n === sel?.n ? 'sel' : ''} ${i === 0 ? 'p1' : ''}`} style={{ '--tc': d.color, gridTemplateColumns: '26px 4px minmax(0,1fr) 74px 22px 30px', background: team && sameTeam(d.team, team) && r.n !== sel?.n ? 'rgba(56,216,255,.08)' : undefined }} onClick={() => select(r.n)} title={`${d.name} · ${d.team}`}>
                  <span className="p">{r.pos < 99 ? r.pos : '–'}</span>
                  <span className="tb" style={{ background: d.color }} />
                  <span className="c">{d.code}<small>{r.n}</small>{r.pits > 0 && <small style={{ color: 'var(--yel)' }}>{r.pits} PIT</small>}</span>
                  <span className="g">{i === 0 ? (r.lap ? `LAP ${r.lap}` : 'LEADER') : gapText(r.gap) || gapText(r.int) || '—'}</span>
                  {r.tc ? <Tyre c={r.tc} age={r.ta} /> : <span />}
                  <ProjCell n={r.n} pos={r.pos} eng={eng} />
                </div>
              );
            })}
          </div>
          <div className="tw-foot"><span>{fork ? 'real timing to the fork, simulated since' : 'positions, intervals and laps from OpenF1'}{eng && isRace ? ' · last column: projected finish' : ''}</span><span className="mono">room · replay</span></div>
        </div>

        <div className="card mapcard"><RealTrack meta={meta} drivers={drivers} selected={sel?.n} onSelect={select} rows={rows} yellows={yellows} ghost={ghost} lap={isRace ? leaderLap : null} total={totalLaps} /></div>

        <div className="rcol" style={{ gridTemplateRows: ours.length ? 'auto auto auto minmax(0,1fr)' : 'auto auto minmax(0,1fr)' }}>
          {sel && <DriverPanel d={sel} row={rows.find((r) => r.n === sel.n)} />}
          <div className="card">
            <div className="card-h"><b>Speed · throttle · brake</b><span className="chip">last 60 s</span></div>
            <div style={{ height: ours.length ? 110 : 150, padding: '6px 10px' }}><TraceStrip n={sel?.n} color={sel?.color} /></div>
          </div>
          {ours.length > 0 && <TeamAlerts compact />}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 200 }}>
            <div className="card-h"><b>Race control</b><span className="chip">{rc.length} messages</span></div>
            <ul className="feed" style={{ flex: 1 }}>
              {feed.slice(0, 4).map((e, k) => (
                <li key={'f' + k + e.t}>
                  <i style={{ background: e.type === 'pit' ? 'var(--yel)' : 'var(--pur)' }} />
                  <div><div className="t"><span>{e.type === 'pit' ? 'PIT STOP' : 'FASTEST LAP'} · {drivers.get(e.n)?.code}</span><span>{new Date(e.t).toISOString().slice(11, 19)}</span></div>
                    <div className="m">{e.type === 'pit' ? `Lap ${e.lap} · ${e.duration ? e.duration.toFixed(1) + ' s in the pit lane' : 'in the pits'}` : `${lt(e.time)} on lap ${e.lap}`}</div></div>
                </li>
              ))}
              {rc.map((m, k) => (
                <li key={k + '-' + m.t}>
                  <i style={{ background: /RED/.test(m.flag || '') ? 'var(--red)' : /YELLOW/.test(m.flag || '') ? 'var(--yel)' : m.category === 'SafetyCar' ? 'var(--org)' : /GREEN|CLEAR/.test(m.flag || '') ? 'var(--grn)' : 'var(--cyan)' }} />
                  <div><div className="t"><span>{m.category?.toUpperCase()}{m.lap ? ` · LAP ${m.lap}` : ''}</span><span>{new Date(m.t).toISOString().slice(11, 19)}</span></div><div className="m">{m.message}</div></div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      {fork && <TakeoverDeck selected={sel?.n} />}
      <RaceDeck />
      <p className="mu" style={{ fontSize: 12, margin: 0 }}>
        Real timing and telemetry from <a href="https://openf1.org" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>OpenF1</a>, an unofficial open API, used here for non-commercial demonstration. Not associated with Formula 1 companies. Car data is sampled at about 3.7 Hz and fed through the same real-time path a live feed uses, on one shared clock for every viewer in the session's <span className="mono">replay:{meta.key}</span> room.
      </p>
    </div>
  );
}

/** projected finishing position in the timing tower: ▲ gains, ▼ losses */
function ProjCell({ n, pos, eng }) {
  const c = eng?.s.isRace ? eng.proj.cars.get(n) : null;
  if (!c || pos >= 99) return <span />;
  const dp = pos - c.projPos;
  return <span className="proj" title={`Projected to finish P${c.projPos}`} style={{ color: dp > 0 ? 'var(--grn)' : dp < 0 ? 'var(--red)' : 'var(--mu)' }}>{dp > 0 ? '▲' : dp < 0 ? '▼' : '·'}{c.projPos}</span>;
}

function DriverPanel({ d, row }) {
  const c = replayCars.get(d.n);
  return (
    <div className="card carcard" style={{ '--tc': d.color }}>
      <div className="cc-top stripes">
        <span className="n">{d.n}</span>
        <small>{(d.team || '').toUpperCase()} · P{row?.pos ?? '–'}</small>
        <h3>{d.first} <b>{d.last}</b></h3>
      </div>
      <div className="cc-body" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="kv"><small>km/h</small><b>{c ? Math.round(c.v) : '—'}</b></div>
        <div className="kv"><small>Gear</small><b>{c?.g || 'N'}</b></div>
        <div className="kv"><small>RPM</small><b style={{ fontSize: 15 }}>{c?.rpm != null ? c.rpm.toLocaleString() : '—'}</b></div>
        <div className="kv"><small>DRS</small><b style={{ fontSize: 15, color: c?.drs ? 'var(--grn)' : 'var(--mu)' }}>{c?.drs ? 'OPEN' : 'off'}</b></div>
      </div>
      <div className="ped" style={{ padding: '10px 14px', borderBottom: '1px solid var(--ln)' }}>
        <div><span>THROTTLE</span><span className="trk"><i style={{ width: `${c?.thr ?? 0}%`, background: 'var(--grn)' }} /></span><span>{c?.thr ?? 0}</span></div>
        <div><span>BRAKE</span><span className="trk"><i style={{ width: c?.brk ? '100%' : 0, background: 'var(--red)' }} /></span><span>{c?.brk ? 'ON' : '0'}</span></div>
      </div>
      <div className="cc-body" style={{ border: 0 }}>
        <div className="kv"><small>Last lap</small><b style={{ fontSize: 15 }}>{lt(row?.last)}</b></div>
        <div className="kv"><small>Best</small><b style={{ fontSize: 15 }}>{lt(row?.best)}</b></div>
        <div className="kv"><small>Tyre</small><b style={{ fontSize: 15 }}>{row?.tc ? `${row.tc} · ${row.ta}` : '—'}</b></div>
      </div>
    </div>
  );
}

function TraceStrip({ n, color = '#fff' }) {
  const [ref, get] = useCanvas();
  useAnimationFrame(() => {
    const g = get();
    if (!g || !g.w) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    const tr = replayTrace.get(n) || [];
    if (tr.length < 2) return;
    const t1 = replayClock.t, t0 = t1 - 60_000;
    const X = (t) => ((t - t0) / 60_000) * w;
    const Y = (v) => h - 4 - (v / 350) * (h * 0.7);
    ctx.fillStyle = 'rgba(0,214,107,.18)';
    for (const p of tr) if (p.thr > 0) ctx.fillRect(X(p.t), h - 4 - (p.thr / 100) * h * 0.25, 2, (p.thr / 100) * h * 0.25);
    ctx.fillStyle = 'rgba(225,6,0,.8)';
    for (const p of tr) if (p.brk) ctx.fillRect(X(p.t), 0, 2, 6);
    ctx.beginPath(); tr.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
    const last = tr[tr.length - 1];
    ctx.fillStyle = '#fff'; ctx.font = '700 11px "JetBrains Mono"'; ctx.textAlign = 'right'; ctx.fillText(`${Math.round(last.v)} km/h`, w - 4, 14);
  }, [n, color]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="Speed trace, throttle and brake for the last 60 seconds" />;
}
