import { useMemo } from 'react';
import { useRooms, race } from '../lib/live.js';
import { useMetrics, useSession } from '../store/stores.js';
import UChart from '../components/UChart.jsx';

const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));

export default function Systems() {
  useRooms(['metrics', 'race', 'timing']);
  const snap = useMetrics((s) => s.snap);
  const latency = useSession((s) => s.latencyMs);
  const hist = snap?.history || [];
  const t0 = hist[0]?.t || 0;
  const xs = hist.map((p) => (p.t - t0) / 1000);
  const tput = useMemo(() => [xs, hist.map((p) => p.ingest), hist.map((p) => p.dbWritten), hist.map((p) => p.bcMessages)], [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  const lat = useMemo(() => [xs, hist.map((p) => p.p95), hist.map((p) => p.loopLag)], [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <div className="card"><div className="empty"><b>Waiting for metrics</b>The server publishes pipeline metrics to the <span className="mono">metrics</span> room once a second.</div></div>;
  const r = snap.rates || {}, tot = snap.totals || {}, g = snap.gauges || {}, L = snap.latency || {};
  const K = ({ label, value, unit, color }) => <div className="card kpi"><small>{label}</small><b style={{ color }}>{value}{unit && <em>{unit}</em>}</b></div>;
  return (
    <div className="stack">
      <div className="page-title">
        <div><h1>Systems</h1><p>The ingest pipeline, live, measured by the server itself. Rates are per second over the last second. Latencies are measured from server receipt to broadcast (processing) and from the source timestamp to broadcast (end to end).</p></div>
        <span className="chip">uptime {Math.floor(snap.uptimeS / 60)} min · {snap.memoryMB} MB rss · heap {snap.heapMB} MB</span>
      </div>
      <div className="four">
        <K label="Ingest" value={n(r.received)} unit="ev/s" />
        <K label="Accepted" value={n(r.accepted)} unit="ev/s" color="var(--grn)" />
        <K label="Written to MongoDB" value={n(r.dbWritten)} unit="docs/s" />
        <K label="Broadcast" value={n(r.bcMessages)} unit={`msg/s · ${n(Math.round((r.bcBytes || 0) / 1024))} KB/s`} />
        <K label="Processing latency p50 / p95" value={`${L.procP50} / ${L.procP95}`} unit="ms" />
        <K label="End-to-end p95 / p99" value={`${L.e2eP95} / ${L.e2eP99}`} unit="ms" />
        <K label="Your round trip" value={latency ?? '—'} unit="ms" />
        <K label="Event-loop lag p99" value={hist[hist.length - 1]?.loopLag ?? '—'} unit="ms" />
      </div>
      <div className="two">
        <div className="card"><div className="card-h"><b>Throughput · last 60 s</b></div>
          <div className="card-b"><UChart optsKey="tput" data={tput} series={[
            { label: 'ingest ev/s', stroke: '#e10600', width: 2, fill: 'rgba(225,6,0,.12)' },
            { label: 'db docs/s', stroke: '#38d8ff', width: 1.5 },
            { label: 'broadcast msg/s', stroke: '#00d66b', width: 1.5 }
          ]} axes={[{ label: 'seconds' }, {}]} /></div></div>
        <div className="card"><div className="card-h"><b>Latency · last 60 s</b></div>
          <div className="card-b"><UChart optsKey="lat" data={lat} series={[
            { label: 'processing p95 ms', stroke: '#b84dff', width: 2 },
            { label: 'event-loop lag p99 ms', stroke: '#ffd60a', width: 1.5 }
          ]} axes={[{ label: 'seconds' }, {}]} /></div></div>
      </div>
      <div className="three">
        <div className="card"><div className="card-h"><b>Data quality</b><span className="chip">since start</span></div>
          <table className="tbl"><tbody>
            <tr><td>Frames received</td><td className="n">{n(tot.received)}</td></tr>
            <tr><td>Rejected by validation</td><td className="n">{n(tot.rejected)}</td></tr>
            <tr><td>Rate-limited (token bucket)</td><td className="n">{n(tot.limited)}</td></tr>
            <tr><td>Duplicates dropped</td><td className="n">{n(tot.duplicates)}</td></tr>
            <tr><td>Out of order, fixed by reorder buffer</td><td className="n">{n(tot.reordered)}</td></tr>
            <tr><td>Late (stored, not applied)</td><td className="n">{n(tot.late)}</td></tr>
            <tr><td>Gaps skipped</td><td className="n">{n(tot.gaps)}</td></tr>
            {Object.entries(snap.rejections || {}).map(([k, v]) => <tr key={k}><td className="mu">reject · {k}</td><td className="n">{n(v)}</td></tr>)}
          </tbody></table></div>
        <div className="card"><div className="card-h"><b>Storage</b><span className="chip">batch writer</span></div>
          <table className="tbl"><tbody>
            <tr><td>Documents written</td><td className="n">{n(tot.dbWritten)}</td></tr>
            <tr><td>Batches</td><td className="n">{n(tot.dbBatches)}</td></tr>
            <tr><td>Last batch</td><td className="n">{g.dbLastBatchSize} docs · {g.dbLastBatchMs} ms</td></tr>
            <tr><td>Queue (backpressure)</td><td className="n">{n(g.dbBuffer)}</td></tr>
            <tr><td>Duplicate keys absorbed</td><td className="n">{n(tot.dbDupKeys)}</td></tr>
            <tr><td>Shed under overload</td><td className="n">{n(tot.dbDropped)}</td></tr>
            <tr><td>Write errors</td><td className="n">{n(tot.dbErrors)}</td></tr>
          </tbody></table></div>
        <div className="card"><div className="card-h"><b>Clients</b><span className="chip">/live namespace</span></div>
          <table className="tbl"><tbody>
            <tr><td>Connected dashboards</td><td className="n">{n(g.clients)} (peak {n(snap.peak?.clients)})</td></tr>
            {Object.entries(g.roles || {}).map(([k, v]) => <tr key={k}><td className="mu">role · {k}</td><td className="n">{v}</td></tr>)}
            <tr><td>Back-pressured (moved to 2 Hz)</td><td className="n">{n(g.slowClients)}</td></tr>
            <tr><td>Data sources connected</td><td className="n">{n(g.sources)}</td></tr>
            <tr><td>Alerts raised</td><td className="n">{n(tot.alerts)}</td></tr>
            <tr><td>Strategy runs</td><td className="n">{n(tot.strategyRuns)}</td></tr>
            <tr><td>Peak ingest</td><td className="n">{n(snap.peak?.ingestPerSec)} ev/s</td></tr>
            <tr><td>This browser · race frames</td><td className="n">{n(race.rx)} · every {Math.round(race.frameEvery)} ms</td></tr>
          </tbody></table></div>
      </div>
    </div>
  );
}
