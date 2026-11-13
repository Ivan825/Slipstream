import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useRooms } from './live.js';
import { useReplay } from '../store/replay.js';
import { useUI } from '../store/stores.js';

/**
 * Keep a real-session channel open and its room joined while mounted.
 * Used by the shell (so every page follows the chosen real session) and by the
 * Real Data channel view. Opening is idempotent on the server.
 */
let pending = null; // { key, p, at }: one open request shared by every caller
const openOnce = (key) => {
  if (pending && pending.key === key && Date.now() - pending.at < 10_000) return pending.p;
  const body = { key: key === 'live' || String(key).startsWith('m-') ? String(key) : Number(key) };
  const p = api('/replay/open', { method: 'POST', body });
  pending = { key, p, at: Date.now() };
  return p;
};

export function useRealChannel(key) {
  const [opened, setOpened] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!key) { setOpened(null); return; }
    let alive = true;
    setError(null);
    const cur = useReplay.getState().key;
    if (cur !== String(key) && !(key === 'live' && useReplay.getState().meta?.live)) useReplay.getState().open(key);
    openOnce(String(key))
      .then((snap) => {
        if (!alive) return;
        useReplay.getState().snapshot(snap);
        setOpened(String(snap.meta.ch ?? snap.meta.key));
        const src = useUI.getState().source;
        const mock = !!snap.meta.mock;
        if (src.kind !== 'real' || String(src.key) !== String(key) || !!src.mock !== mock || src.name !== snap.meta.name) useUI.getState().setSource({ kind: 'real', key: String(key), name: snap.meta.name, mock, live: !!snap.meta.live });
        if (mock && snap.meta.mock.team && !useUI.getState().realTeam) useUI.getState().setRealTeam(snap.meta.mock.team);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [key]);
  useRooms(opened ? [`replay:${opened}`] : []);
  return { opened, error };
}
