import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CAR_BY_ID, COMPOUNDS, formatLapTime } from '@slipstream/shared';
import { useTiming, useUI, useSession, colorOf } from '../store/stores.js';
import { useAuth } from '../store/auth.js';
import { canOpen } from './TrackMap.jsx';
import { useNow } from '../lib/hooks.js';

export function Tyre({ c, age }) {
  const col = COMPOUNDS[c]?.color || '#888';
  return <span className="tyre" style={{ borderColor: col, color: col }} title={`${COMPOUNDS[c]?.name || c}${age != null ? ` · ${age} laps` : ''}`}>{c}</span>;
}

export function SectorFlags({ sf = '' }) {
  return <span className="sf">{[0, 1, 2].map((k) => <i key={k} className={sf[k] || ''} />)}</span>;
}

const lt = (ms) => (ms == null ? '—' : formatLapTime(ms / 1000));
const sec = (x, d = 3) => (x == null ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d));

export default function TimingTower() {
  const { rows, order, changedAt, prevPos } = useTiming();
  const session = useSession((s) => s.session);
  const sel = useUI((s) => s.selected);
  const select = useUI((s) => s.select);
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const now = useNow(1000);
  const type = session?.type || 'race';
  const [col, setCol] = useState('gap');
  const cols = type === 'race' ? [['gap', 'Gap'], ['int', 'Int'], ['last', 'Last'], ['best', 'Best']] : [['gap', 'Gap'], ['best', 'Best'], ['ideal', 'Ideal'], ['laps', 'Laps']];
  const advance = session?.segment?.advance;
  const activeCount = order.filter((id) => !rows[id]?.ko).length;

  const value = (r) => {
    if (type === 'race') {
      if (r.st === 'FIN' && r.pos === 1) return 'WINNER';
      if (col === 'gap') return r.pos === 1 ? 'LEADER' : r.down ? `+${r.down} LAP${r.down > 1 ? 'S' : ''}` : r.gap != null ? '+' + r.gap.toFixed(3) : '—';
      if (col === 'int') return r.pos === 1 ? 'INTERVAL' : r.down ? `+${r.down}L` : r.int != null ? '+' + r.int.toFixed(3) : '—';
      if (col === 'last') return lt(r.last);
      return lt(r.best);
    }
    if (r.ko) return lt(r.best);
    if (col === 'gap') return r.pos === 1 ? lt(r.best) : r.gap != null ? '+' + r.gap.toFixed(3) : 'NO TIME';
    if (col === 'best') return lt(r.best ?? r.pb);
    if (col === 'ideal') return lt(r.ideal);
    return String(r.laps ?? 0);
  };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="card-h">
        <b>{type === 'race' ? 'Timing' : type === 'qualifying' ? `Qualifying${session?.segment ? ' · ' + session.segment.name : ''}` : 'Practice classification'}</b>
        <div className="seg">{cols.map(([k, l]) => <button key={k} className={col === k ? 'on' : ''} onClick={() => setCol(k)}>{l}</button>)}</div>
      </div>
      <div className="tower scroll" style={{ flex: 1, minHeight: 0 }}>
        {!order.length && <div className="empty"><b>Waiting for timing</b>Cars appear as soon as their first frames arrive.</div>}
        {order.map((id, i) => {
          const r = rows[id];
          if (!r) return null;
          const meta = CAR_BY_ID[id];
          const mine = user?.role === 'engineer' && meta.team === user.team;
          const recent = changedAt[id] && now - changedAt[id] < 3000;
          const up = recent && prevPos[id] > r.pos;
          const cls = ['tw', mine && 'me', id === sel && 'sel', r.fl && 'fl', r.pos === 1 && 'p1', r.ko && 'ko', r.st === 'PIT' && 'pit', r.st === 'GARAGE' && 'gar', r.st === 'OUT' && type !== 'race' && 'out'].filter(Boolean).join(' ');
          const showDrop = type === 'qualifying' && advance && !r.ko && i === advance - 1 && activeCount > advance;
          return (
            <motion.div key={id} layout transition={{ type: 'spring', stiffness: 380, damping: 34 }}>
              <div className={cls} style={{ '--tc': colorOf(id) }}
                onClick={() => select(id)}
                onDoubleClick={() => canOpen(user, id) && nav(`/car/${id}`)}
                title={`${meta.first} ${meta.last} · ${meta.number}`}>
                <span className="p">{r.pos}</span>
                <span className="tb" style={{ background: colorOf(id) }} />
                <span className="c">{id}<small>{meta.number}</small>{type !== 'race' && <SectorFlags sf={r.sf} />}</span>
                <span className={`ch ${recent ? (up ? 'up' : 'dn') : ''}`}>{recent ? (up ? '▲' : '▼') : ''}</span>
                <span className="g">{value(r)}</span>
                <Tyre c={r.tc} age={r.ta} />
              </div>
              {showDrop && <div className="drop-line"><span>DROP ZONE</span></div>}
            </motion.div>
          );
        })}
      </div>
      <div className="tw-foot"><span>{type === 'race' ? 'Gaps from 60 timing loops per lap' : type === 'qualifying' ? `Top ${advance || 10} advance` : 'Best lap per driver'}</span><span className="mono">room · timing</span></div>
    </div>
  );
}

export { lt, sec };
