# Stress test

How much telemetry one Slipstream server can take in, store and fan out, and how quickly it reaches the dashboards.

## Setup

| | |
|---|---|
| Machine | Apple M2, 8 cores, 8 GB, one laptop running everything |
| Software | Node.js 22.23, MongoDB 7.0 (Docker), one Slipstream server process with the simulator embedded |
| Load generator | `loadtest/` on the same machine, so every number here includes the load generator competing for the same CPU |
| Race traffic | 20 simulated cars at 20 Hz (400 events/s), with 0.4% duplicated and 0.4% out-of-order frames injected on purpose |
| Extra traffic | `N` additional data sources, each streaming schema-valid frames at `H` Hz in 100 ms batches. They go through validation, rate limiting, dedupe and MongoDB storage like the cars, but are not part of the race |
| Dashboards | `K` headless Socket.IO clients. Half are spectators on the 2 Hz public feed. The other half are team engineers subscribed to `race` (10 Hz), `timing`, their team room and both of their cars' full 20 Hz telemetry rooms |

Each scenario warms up for 3 s and then measures for 30 s. Throughput comes from the server's own counters over the measured wall-clock window. Latency is measured by the clients:

- **Race frame latency:** the client's receive time minus the server's emit timestamp on each 10 Hz position frame.
- **Car end-to-end latency:** the client's receive time minus the *source* timestamp on each telemetry frame. This includes the source's own 100 ms batching, so roughly 50 ms of it is spent before the frame reaches the network.

Reproduce with:

```bash
npm run loadtest -- --clients 100 --duration 30 --name baseline
npm run loadtest -- --clients 200 --sources 50  --hz 50  --duration 30 --name heavy
npm run loadtest -- --clients 500 --sources 100 --hz 50  --duration 30 --name extreme
npm run loadtest -- --clients 20  --sources 5   --hz 500 --duration 15 --name flood
```

Results are written to `loadtest/results/*.json`.

## Results

| Scenario | Dashboards | Extra sources | Events in /s | Stored /s | Broadcast msg/s | Race frame p50 / p95 / p99 | Car end-to-end p50 / p95 / p99 | Event-loop lag p99 | Server RSS |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 100 | none | **397** | 391 | 1,776 (0.9 MB/s) | 7 / 15 / 27 ms | 65 / 111 / 139 ms | 17.5 ms | 444 MB |
| heavy | 200 | 50 × 50 Hz | **2,886** | 2,913 | 3,578 (1.9 MB/s) | 8 / 19 / 30 ms | 64 / 112 / 133 ms | 17.8 ms | 505 MB |
| extreme | 500 | 100 × 50 Hz | **5,359** | 5,363 | 8,923 (4.8 MB/s) | 11 / 23 / 36 ms | 87 / 138 / 157 ms | 21.7 ms | 631 MB |
| flood | 20 | 5 × 500 Hz | 1,822 offered | 827 | 357 | 3 / 8 / 17 ms | 55 / 99 / 117 ms | 25.9 ms | 486 MB |

In every scenario:

- **No client was back-pressured.** Every socket kept up with the full rate.
- **Nothing was shed by the database writer.** The write queue peaked at 1,450 frames, well under its 60,000 limit.
- **Every injected duplicate was caught by the sequencer:** 46 to 51 per run.

## What the flood run shows

Five sources each tried to send 500 frames/s, more than three times the per-source token bucket of 150 frames/s with a burst of 300:

- 28,250 frames were offered.
- 10,159 were accepted.
- **18,091 were rate-limited** and counted. Each source's acknowledgement told it so.
- After about 10 s of sustained flooding, the server **disconnected all five sources** (`source X… disconnected for flooding`).
- The race cars on the same server were unaffected. Their dashboards saw a p95 of 8 ms throughout.

## Reading the numbers

- **Latency stays flat as load grows.** From 100 to 500 dashboards and from 400 to 5,400 events/s, p95 position-frame latency went from 15 ms to 23 ms.
- **MongoDB keeps up.** Storage tracks ingest one-for-one. Each 500 ms `insertMany` carries up to 2,700 documents and takes 20–60 ms.
- **Payloads stay small.** A 10 Hz position frame for all 20 cars is about 400 bytes. Full telemetry goes only to rooms that have subscribers, and spectators get the 2 Hz feed.
- **The ceiling isn't reached here.** In the extreme run the server's event loop was still idle most of the time (lag p99 22 ms). The load generator itself (600 sockets in one Node process) was competing for the same 8 cores. A separate machine for the load generator, or more server instances behind the Socket.IO Redis adapter, would push the numbers higher. We haven't measured that.
