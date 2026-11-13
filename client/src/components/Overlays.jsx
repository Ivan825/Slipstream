import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CARS, TEAM_BY_ID } from '@slipstream/shared';
import { useToasts, useUI, colorOf } from '../store/stores.js';
import { useAuth } from '../store/auth.js';
import { beep } from '../lib/sound.js';

/** Five red lights, then lights out: plays when a session goes green. */
function StartLights() {
  const [state, setState] = useState(null); // null | 1..5 | 'go'
  useEffect(() => {
    const onEv = (e) => {
      if (e.detail?.event !== 'start') return;
      let n = 0;
      setState(0);
      const step = () => {
        n++;
        if (n <= 5) { setState(n); if (useUI.getState().sound) beep('lights'); setTimeout(step, 700); }
        else setTimeout(() => {
          setState('go');
          if (useUI.getState().sound) beep('go');
          setTimeout(() => setState(null), 1300);
        }, 600 + Math.random() * 900);
      };
      setTimeout(step, 300);
    };
    window.addEventListener('slipstream:session', onEv);
    return () => window.removeEventListener('slipstream:session', onEv);
  }, []);
  return (
    <AnimatePresence>
      {state !== null && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setState(null)}>
          <div>
            <div className={`gantry ${state === 'go' ? 'go' : ''}`}>
              {[1, 2, 3, 4, 5].map((k) => (
                <div key={k}><i className={state !== 'go' && state >= k ? 'on' : ''} /><i className={state !== 'go' && state >= k ? 'on' : ''} /></div>
              ))}
            </div>
            <div className="lights-msg" style={{ color: state === 'go' ? 'var(--grn)' : '#fff' }}>{state === 'go' ? 'Lights out' : 'Session starting'}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Chequered-flag wipe at the end of a session. */
function Chequered() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const onEv = (e) => {
      if (e.detail?.event === 'chequered' || e.detail?.event === 'finish') { setOn(true); setTimeout(() => setOn(false), 1400); }
    };
    window.addEventListener('slipstream:session', onEv);
    return () => window.removeEventListener('slipstream:session', onEv);
  }, []);
  return (
    <AnimatePresence>
      {on && (
        <motion.div className="chequer-wipe" initial={{ clipPath: 'inset(0 100% 0 0)' }} animate={{ clipPath: ['inset(0 100% 0 0)', 'inset(0 0% 0 0)', 'inset(0 0 0 100%)'] }} transition={{ duration: 1.3, times: [0, 0.45, 1], ease: 'easeInOut' }} />
      )}
    </AnimatePresence>
  );
}

function Palette() {
  const open = useUI((s) => s.palette);
  const setOpen = useUI((s) => s.setPalette);
  const select = useUI((s) => s.select);
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(!useUI.getState().palette); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 20); } }, [open]);
  const role = user?.role || 'viewer';
  const items = useMemo(() => {
    const pages = [
      { label: 'Home: choose what to watch', go: '/', hint: 'page' },
      { label: 'Pit wall', go: '/pitwall', hint: 'page' },
      { label: 'Strategy', go: '/strategy', hint: 'page', need: 'eng' },
      { label: 'Analysis', go: '/analysis', hint: 'page' },
      { label: 'F1 sessions (OpenF1)', go: '/real', hint: 'page' },
      { label: 'Race control', go: '/control', hint: 'page', need: 'rc' },
      { label: 'Systems', go: '/systems', hint: 'page' }
    ].filter((p) => !p.need || (p.need === 'rc' ? role === 'race_control' : role !== 'viewer'));
    const cars = CARS.filter((c) => role === 'race_control' || (role === 'engineer' && c.team === user.team) || role === 'viewer')
      .map((c) => ({ label: `${c.number} ${c.first} ${c.last}`, car: c.id, hint: TEAM_BY_ID[c.team].name, go: role === 'viewer' ? null : `/car/${c.id}` }));
    const all = pages.concat(cars);
    const n = q.trim().toLowerCase();
    return n ? all.filter((x) => (x.label + ' ' + x.hint + ' ' + (x.car || '')).toLowerCase().includes(n)) : all;
  }, [q, role, user]);
  const run = (it) => {
    if (it.car) select(it.car);
    if (it.go) nav(it.go);
    setOpen(false);
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" style={{ alignItems: 'start', paddingTop: '12vh' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <motion.div className="palette" initial={{ y: -10 }} animate={{ y: 0 }}>
            <input ref={input} id="palette-q" value={q} placeholder="Jump to a car, driver or page…" onChange={(e) => { setQ(e.target.value); setI(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
                if (e.key === 'Enter' && items[i]) run(items[i]);
              }} />
            <ul>
              {items.map((it, k) => (
                <li key={it.label} className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => run(it)}>
                  {it.car && <i style={{ width: 4, height: 16, background: colorOf(it.car), borderRadius: 1 }} />}
                  {it.label}<small>{it.hint}</small>
                </li>
              ))}
              {!items.length && <li className="mu">No matches</li>}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Toasts() {
  const list = useToasts((s) => s.list);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {list.map((t) => (
          <motion.div key={t.id} className={`toast ${t.kind || ''}`} initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }}>
            <b>{t.title}</b>{t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function Overlays() {
  return (<><StartLights /><Chequered /><Palette /><Toasts /></>);
}
