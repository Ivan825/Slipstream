import { useEffect, useRef, useState } from 'react';
import { useSession, useMetrics } from '../store/stores.js';
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

export default function SessionBar() {
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
