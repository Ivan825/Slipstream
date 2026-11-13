import { useEffect, useRef, useState } from 'react';

/** Run `draw(now)` every animation frame while mounted (and the tab is visible). */
export function useAnimationFrame(draw, deps = []) {
  const ref = useRef(draw);
  ref.current = draw;
  useEffect(() => {
    let id;
    const loop = (t) => { ref.current(t); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Re-render at most `hz` times per second (for numbers fed by mutable buffers). */
export function useTicker(hz = 4) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
}

/** Size a canvas to its CSS box at device pixel ratio; returns a stable context getter. */
export function useCanvas() {
  const ref = useRef(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      size.current = { w, h, dpr, v: (size.current.v || 0) + 1 };
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  const get = () => {
    const c = ref.current;
    if (!c) return null;
    const ctx = c.getContext('2d');
    const { w, h, dpr } = size.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h, dpr, v: size.current.v };
  };
  return [ref, get];
}

export function useNow(ms = 1000) {
  const [now, set] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
