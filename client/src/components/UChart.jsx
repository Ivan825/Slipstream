import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

const AXIS = { stroke: '#9d9dad', grid: { stroke: 'rgba(255,255,255,.06)', width: 1 }, ticks: { stroke: 'rgba(255,255,255,.12)', width: 1 }, font: '11px "JetBrains Mono", monospace' };

/**
 * Thin React wrapper around uPlot (canvas, ~45 KB, handles 100k+ points).
 * `opts` is rebuilt only when `optsKey` changes; data updates are cheap setData calls.
 */
export default function UChart({ data, series, axes, scales, optsKey = '', className = 'chart-box', legend = true, cursor, hooks, bands }) {
  const box = useRef(null);
  const plot = useRef(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const opts = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 300,
      legend: { show: legend, live: true },
      cursor: cursor || { drag: { x: true, y: false }, points: { size: 6 } },
      scales: scales || { x: { time: false } },
      axes: (axes || [{}, {}]).map((a) => ({ ...AXIS, ...a })),
      series: [{}, ...series],
      bands,
      hooks
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => {
      if (!plot.current) return;
      const legendH = plot.current.root.querySelector('.u-legend')?.offsetHeight || 0;
      plot.current.setSize({ width: el.clientWidth, height: Math.max(120, el.clientHeight - legendH) });
    });
    ro.observe(el);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optsKey]);
  useEffect(() => { if (plot.current && data) plot.current.setData(data); }, [data]);
  return <div ref={box} className={className} />;
}

export { uPlot };
