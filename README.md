<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg">
    <img src="brand/logo-light.svg" alt="Slipstream" width="420">
  </picture>
</p>

<p align="center"><strong>The pit wall, live.</strong><br>
Twenty cars stream hundreds of channels twenty times a second. Slipstream ingests the data, makes sense of it and puts it in front of the right engineer within a few milliseconds. It runs a whole race weekend and tells you when to pit.</p>

<p align="center">
  <a href="https://github.com/Ivan825/Slipstream/actions/workflows/ci.yml"><img src="https://github.com/Ivan825/Slipstream/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/MongoDB-7-47A248" alt="MongoDB 7">
  <img src="https://img.shields.io/badge/Socket.IO-4-010101" alt="Socket.IO 4">
  <img src="https://img.shields.io/badge/React-18-61DAFB" alt="React 18">
  <img src="https://img.shields.io/badge/tested-5%2C359%20events%2Fs%20%C2%B7%20500%20clients-e10600" alt="5,359 events/s with 500 clients">
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#see-it">See it</a> ·
  <a href="#run-it-locally">Run locally</a> ·
  <a href="#deploy-your-own">Deploy</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/STRESS_TEST.md">Stress test</a> ·
  <a href="docs/STRATEGY.md">Strategy engine</a>
</p>

---

<p align="center">
  <img src="docs/images/pitwall.png" alt="The live pit wall during a race: timing tower with gaps from timing loops, the circuit coloured by speed with every car moving live, Kestrel's strategist recommending intermediates ahead of incoming rain, and a critical tyre-overheating alert" width="100%">
</p>

## The problem

Telemetry systems all hit the same walls once data arrives fast and many people need to watch it:

- **Data arrives faster than a browser can draw it.**
- **People need different slices of it.**
- **Networks duplicate and reorder events.**
- **History and the live stream have to line up**, with no gaps and no double-counting.

A race team is the extreme case. A car sends hundreds of channels at high frequency. Each team's engineers may only see their own cars, while race control sees everything. The decisions that matter most, such as *box now or stay out?* or *slicks or inters?*, are made in seconds from live data combined with history.

Slipstream is a working pit wall for a simulated race weekend (practice, knockout qualifying and the race), built on MongoDB, Express, React, Node.js and Socket.IO.

## How it works

```
 20 cars ── /ingest ──► validate ─► rate-limit ─► dedupe + reorder ─► race state ─► anomalies ─► strategy
 (20 Hz each,           zod        token bucket   per-source seq       timing loops   EWMA, rates   plan search,
  100 ms batches)                                                       sectors, laps  thresholds    weather, rivals
                                        │                                    │
                                        ▼                                    ▼
                                 batch writer ─► MongoDB              broadcaster ─► /live rooms ─► dashboards
                                 (500 ms bulk,   (idempotent)         (per batch, 10 Hz,  (ACL per role
                                  load shedding)                       deltas, backpressure) and team)
```

| Stage | What happens |
|---|---|
| **Ingest** | Each car is its own data source on its own Socket.IO connection. It authenticates with an HMAC API key that binds the connection to exactly one car, so a source can't spoof another car. Every batch is acknowledged with what was accepted, rejected or rate-limited. |
| **Validate and limit** | A strict zod schema checks every frame (ranges, array shapes, no unknown fields, clock skew). A token bucket per source caps the rate. A source that keeps flooding is disconnected. |
| **Dedupe and reorder** | Every frame carries `carId`, a per-source `seq` and a timestamp. Duplicates are dropped. Frames that arrive out of order wait up to 100 ms in a reorder buffer. Frames that arrive too late are stored but never rewind live state. |
| **Race state** | 60 timing loops per lap give real time gaps without scanning history. Sector and lap times are interpolated between frames. Every lap keeps a 25 m trace, its position and its gap to the leader. Pit-lane and stationary times are measured from telemetry. |
| **Store** | Raw frames are written with one unordered `insertMany` every 500 ms. A unique index on `(sessionId, carId, seq)` makes writes idempotent. Raw telemetry expires after a TTL, while laps, traces, pit stops, alerts and results are kept. |
| **Detect** | Detectors for tyre overheating (sustained threshold), punctures (pressure rate of change), brake fade (EWMA z-score per braking event), engine temperature, slow cars and lost telemetry. |
| **Decide** | The strategy engine searches every no-stop, one-stop and two-stop plan, using the same tyre and weather model the cars obey, calibrated online from real lap times. |
| **Broadcast** | A car's frames go out as soon as its batch is applied. Positions go out as compact 10 Hz frames, and timing as changed fields only. Nothing is sent to a room with no subscribers. Slow clients are moved to a 2 Hz feed. |

## Tech stack

| Layer | Technology | Used for |
|---|---|---|
| Database | **MongoDB 7** with Mongoose | Raw telemetry (unique-indexed, TTL hot store); laps with 25 m traces, pit stops, alerts, sessions, users and the command audit log (cold store); aggregation pipelines for analysis |
| Backend | **Node.js 22 + Express 4** | REST API for auth, history, analysis, strategy, race control and HTTP ingest; helmet, CORS, compression, express-rate-limit |
| Real time | **Socket.IO 4** | `/ingest` namespace for data sources (acknowledged batches); `/live` namespace for dashboards (JWT, rooms, volatile emits, backpressure) |
| Frontend | **React 18 + Vite**, React Router, Zustand | Single-page dashboard. High-frequency data lives in mutable ring buffers outside React's render cycle |
| Visualisation | **Canvas 2D**, **uPlot**, Framer Motion | Track map, traces and tyre heatmap on canvas; time-series and analysis charts in uPlot; animated timing tower and transitions |
| Validation and auth | **zod**, **jsonwebtoken**, **bcryptjs** | Strict frame and request schemas; role-based access (race control, engineer, spectator) |
| Tooling | node:test, GitHub Actions, Docker | Unit and engine tests, CI on every push, single-image deployment |

## Data generation and ingestion

**The simulator** (`simulator/`) generates the data. It models a full race weekend on a fictional 5.218 km circuit built from a closed Catmull–Rom spline.

- A reference speed profile comes from the track's curvature and is calibrated to a 91 s lap.
- Each car follows that profile, scaled by a pace factor from the shared tyre and weather model: compound, tyre age and cliff, track wetness, fuel load, driver skill and track evolution.
- Throttle, brake, gear, RPM, DRS and ERS follow from the car's acceleration.
- Tyre surface temperatures (inner, middle and outer for each corner) respond to cornering load, braking, traction, track temperature and rain. Pressures follow temperature. Brake temperatures spike under braking.
- AI teams pit before their tyres' cliff, switch to intermediates in the rain and take cheap stops under the safety car. In practice and qualifying, cars run programmes from the garage.
- Race control can inject punctures, brake fade, engine or tyre overheating, rain, safety cars and stream-rate bursts.

**Ingestion**

- Every car is an independent source on its own Socket.IO connection to `/ingest`, using an HMAC-derived API key.
- It produces frames at 20 Hz and sends them in 100 ms batches. Each batch is acknowledged.
- The simulator deliberately duplicates about 0.4% of frames and reorders another 0.4%, so the dedupe and reorder logic is always exercised.

**Real recorded data** comes from OpenF1. `npm run openf1:import -w server -- --session <session_key> --minutes 15` imports any session from 2023 onwards; see [Real data](#what-you-get).

**Real devices** can push the same frames over plain HTTP: `POST /api/ingest` with an `x-api-key` header. [`examples/http-source.mjs`](examples/http-source.mjs) is a 50-line source that does exactly that.

Every frame identifies its source, sequence number and timestamp:

```json
{ "carId": "KAL", "seq": 18442, "ts": 1763030000123, "lap": 14, "d": 2210.4, "v": 287.4,
  "thr": 1, "brk": 0, "g": 7, "rpm": 11420, "drs": 1, "ers": 62.1, "fuel": 38.4, "tc": "M", "ta": 9, "tw": 31.2,
  "tt": [96.1, 92.4, 89.0, 101.2, 97.3, 93.1, 94.0, 90.2, 87.7, 95.6, 91.8, 88.3],
  "tp": [21.9, 22.1, 21.0, 21.1], "bt": [612, 640, 498, 505], "et": 104.2, "ot": 115.0, "st": "RUN" }
```

## What you get

**A live pit wall.** The circuit is drawn on canvas and coloured by speed, by sector or by **live track dominance**. It shows kerbs, corner numbers, DRS zones, a radar sweep when it rains, and glowing cars with trails, interpolated to 60 fps between 10 Hz updates. Beside the map are a timing tower that slides as positions change, sector colours, tyres and stops, the car card, a weather forecast and a team-radio feed of alerts.

**Car telemetry.** Live speed, throttle, brake, gear and **Delta-T** traces. The car's best lap from MongoDB is drawn as a **ghost** for the live lap to race against. There are shift lights, pedal bars, DRS, ERS, fuel and coolant. A tyre heatmap shows inner, middle and outer temperatures for each corner, alongside pressures and glowing brake discs. The history/live merge seam is shown on screen: frames from the database, from the hot cache and from the live stream, plus duplicates dropped and gaps backfilled.

**A race weekend.**

- **Practice:** cars run programmes from the garage (installation, set-up, quali sims, long runs), each with out, push, cool and in laps. A run monitor computes fuel-corrected long-run pace and degradation live.
- **Qualifying:** a Q1/Q2/Q3 knockout with a red drop-zone line, the cut-off time, the margin to safety, the ideal lap and potential position. Cars that get knocked out stay in the garage.
- **The race:** the grid comes from qualifying.

**A live strategist.** Ranked options with the predicted finishing position, rejoin position and traffic, risk and confidence, recomputed every few seconds. It flags undercut chances and threats, cheap stops under the safety car, rain crossovers, the tyre cliff, fuel margin and DRS battles.

**What-if scenarios.** Ask *what if it rains in four laps?*, *what if there's a safety car next lap?*, *what if the tyres degrade 20% faster?* or *what if my rival pits now?*, then apply a plan with one click. The pit call goes to the car and the audit log. [How it works →](docs/STRATEGY.md)

**Post-session analysis.** Modelled on what race engineers use, built from MongoDB aggregation pipelines:

- classification with grid and positions gained
- best sectors and ideal laps
- race history chart and lap chart
- tyre strategy and pit-stop summary (pit-lane, stationary and net loss)
- lap times by compound and team pace box plots
- consistency (σ)
- **fuel-corrected degradation** fitted per stint inside the database, with compound crossover laps
- a two-driver **telemetry overlay with Delta-T** and a gain/loss map
- **track dominance** by mini-sector
- maximum speeds

[The engineering reference →](docs/RACE_ENGINEERING.md)

**Real data, replayed live.** A **Real Data** page replays a real Grand Prix (by default the first 15 minutes of the wet 2024 Brazilian GP) from [OpenF1](https://openf1.org), with real drivers, teams and colours. The importer stores per-driver car data (speed, RPM, gear, throttle, brake, DRS) merged with on-track coordinates, plus laps, positions, intervals, race-control messages, weather and pit stops, in MongoDB. A replay engine plays it back on one shared clock, like a broadcast, through a Socket.IO room:

- positions interpolated at 5 Hz;
- live timing at 2 Hz;
- flags and race-control messages as they happen.

Every viewer sees the same moment. Race control can pause it, scrub through it or play it at up to 16×.

**A demo director.** An optional scripted storyline plays out during the race through the normal race-control path, so a dashboard left open always has something happening: overheating, rain, a puncture, a safety car, brake fade, a VSC.

**Alerts that stay in sync.** Alerts are stored, sent only to the team concerned and to race control, and rate-limited per car. Acknowledging one in one window clears it in every window.

**Race control.**

- Start practice, qualifying or a race; pause or end a session.
- Set the track status: green, yellow, VSC, SC or red.
- Schedule rain.
- Inject punctures, tyre overheating, brake fade or engine overheating. The anomaly engine has to find each one in the data on its own.
- Change the stream rate or fire a 200 Hz burst.

**Numbers, not claims.** A Systems page shows live ingest and broadcast rates, latency percentiles, duplicates, reordered and late frames, DB batch timing, back-pressured clients and event-loop lag. The [stress test](docs/STRESS_TEST.md) records **5,359 events/s from 120 sources with 500 dashboards connected, at a position-frame latency of 11 ms p50 and 23 ms p95**, with nothing shed.

**Roles.** Race control sees everything. An engineer sees full telemetry, alerts and strategy for their own team's two cars only, enforced on every REST call and every room join. Spectators get public timing at 2 Hz without signing in.

## See it

<table>
  <tr>
    <td width="50%"><img src="docs/images/telemetry.png" alt="Car telemetry: driver banner, live delta to the ghost lap, shift lights, pedal bars, speed/throttle/brake/gear traces against lap distance, tyre heatmap with brake glow"><br><sub>Car telemetry: live traces against the ghost lap, shift lights, tyre heatmap, and the history/live merge seam.</sub></td>
    <td width="50%"><img src="docs/images/strategy.png" alt="Strategy page: recommended plan with projected position and stint bar, alternatives with reasons, race situation insights, what-if form"><br><sub>The strategist: ranked plans with reasons, insights and the what-if form.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/overlay.png" alt="Telemetry overlay of two drivers' fastest laps with a delta-T trace and a gain/loss track map"><br><sub>Post-session telemetry overlay with Delta-T and where each driver gains.</sub></td>
    <td width="50%"><img src="docs/images/dominance.png" alt="Track dominance map coloured by the fastest driver in each mini-sector, with speed-trap ranking"><br><sub>Track dominance by mini-sector, plus the speed trap.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/race-history.png" alt="Race history chart of gap to the winner's average pace per lap for all twenty cars"><br><sub>Race history chart and lap chart.</sub></td>
    <td width="50%"><img src="docs/images/pace.png" alt="Lap-time scatter coloured by compound, team pace box plots and consistency table"><br><sub>Lap times by compound, team pace ranking and consistency.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/real-data.png" alt="Real data replay of the 2024 Brazilian Grand Prix: live timing with real drivers on intermediates, the Interlagos circuit drawn from car coordinates, George Russell's live telemetry and the race-control message feed"><br><sub>Real data: the wet 2024 Brazilian GP replayed from OpenF1, with live timing, every car on the circuit, live driver telemetry and race-control messages.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/race-control.png" alt="Race control: session start for practice, qualifying and race, track status, stream rate and burst, weather scheduling, incident injection, audit log"><br><sub>Race control: sessions, flags, weather, incidents and the stream rate.</sub></td>
    <td width="50%"><img src="docs/images/systems.png" alt="Systems page: ingest, accepted, stored and broadcast rates, latency percentiles, data quality and storage tables"><br><sub>Systems: the pipeline measured live by the server itself.</sub></td>
  </tr>
</table>

The screenshots are real. They were captured from a running server on a laptop.

## Run it locally

Node 20 or newer (22 recommended) and MongoDB 6+. If you don't have MongoDB, `docker run -d -p 27017:27017 mongo:7` starts one.

```bash
git clone https://github.com/Ivan825/Slipstream.git && cd Slipstream
npm install
cp .env.example .env
npm run dev          # server :4000 + simulator + dashboard on http://localhost:5173
```

Or start everything with one command: `docker compose up --build`, then open http://localhost:4000.

Sign in with a demo account. The password for every account is `slipstream`.

| Role | Username |
|---|---|
| Race control | `control` |
| Engineer | the team id: `kestrel`, `vortex`, `ardent`, `halcyon`, `solaris`, `monarch`, `nordwind`, `verdant`, `azzurra`, `basalt` |
| Spectator | no sign-in |

A race starts on its own. **For a demo:**

1. Open two windows, one as `control` and one as `kestrel`.
2. In Race Control, schedule rain in 3 laps. Kestrel's strategist re-ranks its plans around an intermediate crossover.
3. Inject a puncture on car 17. The alert reaches both windows within a tenth of a second, and the strategist switches to *box now*.
4. Acknowledge the alert in one window. It clears in the other.
5. Start a qualifying session to watch the knockout, then a race, which takes its grid from qualifying.

```bash
npm test                                            # sequencer, rate limiter, validation, keys, race timing, anomalies, strategy, weather, track model
npm run loadtest -- --clients 200 --sources 50 --hz 50 --duration 30
```

## Deploy your own

| How | Notes |
|---|---|
| **Docker** | `docker compose up --build` starts MongoDB and Slipstream (API, sockets, simulator and dashboard) on port 4000 |
| **Render** | [`render.yaml`](render.yaml) is a one-service blueprint. Set `MONGO_URI` to a MongoDB Atlas connection string; the secrets are generated for you |
| **Any VM or PaaS** | `npm ci && npm run build`, then `SERVE_CLIENT=true EMBED_SIMULATOR=true npm start` |
| **Split** | Dashboard on Vercel ([`client/vercel.json`](client/vercel.json), with `VITE_API_URL` set to the API), server elsewhere |

You need a MongoDB connection string and two long random secrets, `JWT_SECRET` and `INGEST_SECRET`. Every setting, including practice length, qualifying scale, race laps and telemetry TTL, is listed in [`.env.example`](.env.example) and [`server/src/config.js`](server/src/config.js).

## Real-time design

| Namespace / room | Who | Rate | Payload |
|---|---|---|---|
| `/ingest` | each car, plus the simulator controller | 20 Hz in 100 ms batches | frames, acknowledged |
| `race` | engineers, race control | 10 Hz | `[car, lap, distance_dm, km/h, status]` per car, ~400 B for the whole field |
| `race:2hz` | spectators, back-pressured clients | 2 Hz | same |
| `timing` | everyone | 2 Hz | changed fields only, full snapshot every 10 s |
| `car:<ID>` | that car's team, race control | per ingest batch | every 20 Hz frame |
| `team:<id>` | that team, race control | on event | alerts, strategy, pit calls |
| `control` | race control | on event | everything |
| `metrics` | everyone | 1 Hz | pipeline metrics |

**History merged with live data, without duplicates:**

1. The dashboard subscribes to a car first and buffers what arrives.
2. The subscribe acknowledgement returns a **cursor**: the last sequence number already broadcast to that room.
3. The dashboard fetches history up to that cursor. The server answers from MongoDB plus an in-memory hot cache, so frames still in the write batch aren't missed.
4. History and live frames are merged by sequence number, and duplicates are dropped.
5. Any gap that appears later, for example after back-pressure, is backfilled from the API.

Diagrams, the data model and every performance technique are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System and data-flow diagrams, the socket protocol, the history merge, the MongoDB schema, timing, performance and security |
| [`docs/STRATEGY.md`](docs/STRATEGY.md) | How the strategy engine models tyres, weather, pit loss and rivals, and the what-if API |
| [`docs/RACE_ENGINEERING.md`](docs/RACE_ENGINEERING.md) | The practice, qualifying, race and analysis views, mapped to what race engineers use, with a glossary |
| [`docs/STRESS_TEST.md`](docs/STRESS_TEST.md) | Load-test method and results |
| [`.env.example`](.env.example) | Every setting |

## Status

Working end to end on one machine and in Docker:

- the simulator for all three session types;
- the ingest pipeline;
- race timing and the knockout qualifying flow;
- anomaly detection and the strategy engine;
- the analysis API;
- the REST and live namespaces;
- every dashboard page;
- the real-data replay from OpenF1.

**What's tested, and how:**

- `npm test` drives the real car model through the real engines offline: sequencing, rate limiting, validation, keys, lap and sector timing, anomaly detection of injected faults, strategy decisions under rain and the safety car, the weather forecast and the track model. CI runs it on every push.
- The dashboard was checked in headless Chrome with no console errors.
- The stress test was run on an M2 laptop.

**Not built yet:** multi-instance scaling, which would need the Socket.IO Redis adapter and a shared state store.

## Limitations

- **The cars are simulated.** The physics is a believable model, not a vehicle-dynamics package. Lap times, temperatures and degradation are realistic in shape but not calibrated to a real car. Real devices can already stream through `POST /api/ingest`, but only race cars defined in `shared/` take part in timing.
- **One server process.** Rooms and race state live in memory. One process sustains more than 5,000 events/s with 500 dashboards on a laptop. Going further would mean splitting into a single ingest/compute node plus fan-out nodes joined by the Socket.IO Redis adapter. That's designed for but not built.
- **Clocks.** Source-to-dashboard latency uses the source timestamp, so it's exact only when the sources and the server share a clock, which they do in the bundled setup. Round-trip latency on the Systems page and the session countdown are corrected for clock offset.
- **The strategist is a model.** It's deterministic and explainable, and only as good as the tyre and weather model it shares with the simulator.

## Credits

Built with [Express](https://expressjs.com/), [Socket.IO](https://socket.io/), [Mongoose](https://mongoosejs.com/), [zod](https://zod.dev/), [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken), [bcryptjs](https://github.com/dcodeIO/bcrypt.js), [helmet](https://helmetjs.github.io/), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit), [cors](https://github.com/expressjs/cors), [compression](https://github.com/expressjs/compression), [React](https://react.dev/), [React Router](https://reactrouter.com/), [Vite](https://vitejs.dev/), [Zustand](https://github.com/pmndrs/zustand), [Framer Motion](https://www.framer.com/motion/) and [uPlot](https://github.com/leeoniya/uPlot), all MIT licensed. Real session data comes from [OpenF1](https://openf1.org), an unofficial open API (free historical data, for non-commercial use). Slipstream isn't associated with Formula 1 companies, and F1, FORMULA 1 and related marks belong to their owners. Fonts are [Titillium Web](https://fonts.google.com/specimen/Titillium+Web) and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) (SIL Open Font License).

The circuit is a Catmull–Rom spline. Anomaly baselines use exponentially weighted moving averages. Rate limiting is a token bucket. The analysis views follow the conventions of professional motorsport data systems and official timing documents, as described in [`docs/RACE_ENGINEERING.md`](docs/RACE_ENGINEERING.md). In the simulated weekend, team, driver and circuit names are fictional. The Real Data page shows real, recorded session data from OpenF1.

## Licence

[MIT](LICENSE).
