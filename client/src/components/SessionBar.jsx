import { useEffect, useRef, useState } from 'react';
import { useSession, useMetrics, useUI } from '../store/stores.js';
import { useReplay } from '../store/replay.js';
import { formatLapTime } from '@slipstream/shared';
import { useNow } from '../lib/hooks.js';
import { race } from '../lib/live.js';
import { SESSION_LABEL } from '@slipstream/shared';

function Sparkline({ values, w = 110, h = 30 }) {
  if (!values.length) return <svg width={w} height={h} />;
  const mx = Math.max(...values, 1), mn = Math.min(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * w},${h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill="rgba(225,6,0,.25)" stroke="none" />
      <polyline points={pts} fill="none" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

export const clockText = (ms) => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const REAL_FLAG = { GREEN: ['TRACK CLEAR', 'GREEN'], YELLOW: ['YELLOW FLAG', 'YELLOW'], 'DOUBLE YELLOW': ['DOUBLE YELLOW', 'YELLOW'], RED: ['RED FLAG', 'RED'], SC: ['SAFETY CAR', 'SC'], VSC: ['VIRTUAL SAFETY CAR', 'VSC'], CHEQUERED: ['CHEQUERED FLAG', 'CHQ'] };

/** the session bar when the app follows a real session (OpenF1) */
function RealSessionBar() {
  const { meta, state, rows } = useReplay();
  const snap = useMetrics((m) => m.snap);
  useNow(500);
  if (!meta || !state.loaded) return <div className="sessbar"><div><small>Real session</small><b className="shimmer" style={{ width: 200, height: 18 }} /></div></div>;
  const [flagText, flagCls] = REAL_FLAG[state.flag] || [state.flag || 'TRACK CLEAR', 'GREEN'];
  const w = state.weather;
  const leaderLap = rows?.[0]?.lap || 0;
  const best = state.bestLap ? meta.drivers.find((d) => d.n === state.bestLap.n) : null;
  return (
    <div className="sessbar">
      <div className="sb-gp"><span className="tag" style={{ background: state.live ? 'var(--red)' : meta.mock ? 'var(--cyan)' : '#fff', color: state.live ? '#fff' : 'var(--bg)' }}>{state.live ? 'LIVE' : meta.mock ? 'MOCK' : 'REPLAY'}</span><div><small>{meta.circuit} · {state.live ? 'OpenF1 live feed' : meta.mock ? 'mock session · your own clock' : 'OpenF1 historical feed · shared clock'}</small><b>{meta.year} {meta.country} · {meta.type}</b></div></div>
      {/Race|Sprint$/.test(meta.type)
        ? <div className="sb-lap"><small>Lap</small><b>{leaderLap}</b></div>
        : <div className="sb-lap"><small>Session clock</small><b className="clock">{clockText(state.t - state.from)}</b></div>}
      <span className={`track-status ts-${flagCls}`}>{flagText}</span>
      {w && <div className="sb-wx"><span><small>Air</small><b>{w.air}°C</b></span><span><small>Track</small><b>{w.track}°C</b></span><span><small>Rain</small><b style={{ color: w.rain ? 'var(--cyan)' : undefined }}>{w.rain ? 'YES' : 'NO'}</b></span></div>}
      {best && <div><small>Fastest lap</small><b className="mono" style={{ color: 'var(--pur)', fontSize: 15 }}>{best.code} {formatLapTime(state.bestLap.time)}</b></div>}
      <div><small>{state.buffering ? 'Buffering' : state.live ? 'Following live' : state.playing ? `Playing ${state.speed}×` : 'Paused'}</small><b className="mono" style={{ fontSize: 15 }}>{new Date(state.t).toISOString().slice(11, 19)} UTC</b></div>
      <div className="sb-eps"><span><small>Events in / s</small><br /><b>{snap?.rates?.received ?? 0}</b></span></div>
    </div>
  );
}

export default function SessionBar() {
  const source = useUI((x) => x.source);
  if (source.kind === 'real') return <RealSessionBar />;
  return <SimSessionBar />;
}

function SimSessionBar() {
  const s = useSession((x) => x.session);
  const snap = useMetrics((m) => m.snap);
  const now = useNow(500);
  const [rate, setRate] = useState([]);
  const lastRx = useRef(race.rx);
  useEffect(() => {
    // client-side receive rate (frames/s) when the metrics room isn't joined
    const id = setInterval(() => {
      setRate((r) => [...r, (race.rx - lastRx.current) * 1].slice(-30));
      lastRx.current = race.rx;
    }, 1000);
    return () => clearInterval(id);
  }, []);
  if (!s) return <div className="sessbar"><div><small>Connecting</small><b className="shimmer" style={{ width: 160, height: 18 }} /></div></div>;
  const w = s.weather || {};
  const skew = useSession.getState().skew || 0;
  const left = s.endsAt ? s.endsAt - (now + skew) : null;
  const ingest = snap?.history?.map((p) => p.ingest) || [];
  const status = s.chequered ? 'CHQ' : s.status === 'finished' ? 'CHQ' : s.trackStatus;
  const statusText = s.chequered || s.status === 'finished' ? 'CHEQUERED FLAG' : s.status === 'paused' ? 'SESSION PAUSED' : { GREEN: 'TRACK CLEAR', YELLOW: 'YELLOW FLAG', VSC: 'VIRTUAL SAFETY CAR', SC: 'SAFETY CAR', RED: 'RED FLAG' }[s.trackStatus];
  return (
    <div className="sessbar">
      <div className="sb-gp"><span className="flag-strip" /><div><small>Round 18 · Marina Ridge International</small><b>{SESSION_LABEL[s.type] || 'Session'}{s.segment ? ` · ${s.segment.name}` : ''}</b></div></div>
      {s.type === 'race' ? (
        <div className="sb-lap"><small>Lap</small><b>{s.lap || 0} <span>/ {s.totalLaps}</span></b></div>
      ) : (
        <div className="sb-lap"><small>{s.chequered ? 'Session over' : 'Time remaining'}</small><b className="clock">{clockText(left)}</b></div>
      )}
      <span className={`track-status ts-${status}`}>{statusText}</span>
      <div className="sb-wx">
        <span><small>Air</small><b>{w.airTemp ?? '—'}°C</b></span>
        <span><small>Track</small><b>{w.trackTemp ?? '—'}°C</b></span>
        <span><small>Rain</small><b style={{ color: w.rain > 0.05 ? 'var(--cyan)' : undefined }}>{Math.round((w.rain || 0) * 100)}%</b></span>
        <span><small>Wetness</small><b>{(w.wetness ?? 0).toFixed(2)}</b></span>
      </div>
      {s.fastest && <div><small>Fastest lap</small><b className="mono" style={{ color: 'var(--pur)', fontSize: 15 }}>{s.fastest.carId} {fmt(s.fastest.timeMs)}</b></div>}
      <div className="sb-eps">
        <span><small>{snap ? 'Events in / s' : 'Frames rx / s'}</small><br /><b>{snap ? snap.rates?.received ?? 0 : rate[rate.length - 1] ?? 0}</b></span>
        <Sparkline values={snap ? ingest : rate} />
      </div>
    </div>
  );
}

const fmt = (ms) => {
  if (ms == null) return '—';
  const s = ms / 1000, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};
