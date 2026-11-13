<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg">
    <img src="brand/logo-light.svg" alt="Slipstream" width="420">
  </picture>
</p>

<p align="center"><strong>The pit wall, live.</strong><br>
Twenty cars stream hundreds of channels twenty times a second. Slipstream ingests the data, makes sense of it and puts it in front of the right engineer within a tenth of a second. It also tells them when to pit.</p>

<p align="center">
  <a href="https://github.com/Ivan825/Slipstream/actions/workflows/ci.yml"><img src="https://github.com/Ivan825/Slipstream/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
  <img src="https://img.shields.io/badge/MongoDB-7-47A248" alt="MongoDB 7">
  <img src="https://img.shields.io/badge/Socket.IO-4-010101" alt="Socket.IO 4">
  <img src="https://img.shields.io/badge/React-18-61DAFB" alt="React 18">
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#run-it-locally">Run locally</a> ·
  <a href="#deploy-your-own">Deploy</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/STRESS_TEST.md">Stress test</a>
</p>

---

## The problem

Telemetry systems all hit the same walls once data arrives fast and many people need to watch it:

- **Data arrives faster than a browser can draw it.**
- **People need different slices of it.**
- **Networks duplicate and reorder events.**
- **History and the live stream have to line up**, with no gaps and no double-counting.

A race team is the extreme case. A car sends hundreds of channels at high frequency. Each team's engineers may only see their own cars, while race control sees everything. The decisions that matter most, such as *box now or stay out?* or *slicks or inters?*, are made in seconds from live data combined with history.

Slipstream is a working pit wall for a simulated race weekend: practice, qualifying and the race. It's built on MongoDB, Express, React, Node.js and Socket.IO.

## How it works

```
 20 cars ── /ingest ──► validate ─► rate-limit ─► dedupe + reorder ─► race state ─► anomalies ─► strategy
 (20 Hz each,           zod        token bucket   per-source seq       timing loops   EWMA, rates   plan search,
  100 ms batches)                                                       sectors, laps  thresholds    weather, rivals
                                        │                                    │
                                        ▼                                    ▼
                                 batch writer ─► MongoDB              broadcaster ─► /live rooms ─► dashboards
                                 (500 ms bulk,   (idempotent)         (10 Hz, deltas,  (ACL per role
                                  load shedding)                       backpressure)    and team)
```

| Stage | What happens |
|---|---|
| **Ingest** | Each car is its own data source on its own Socket.IO connection. It authenticates with an HMAC API key that binds the connection to exactly one car, so a source can't spoof another car. Every batch is acknowledged with what was accepted, rejected or rate-limited. |
| **Validate and limit** | A strict zod schema checks every frame (ranges, array shapes, no unknown fields, clock skew). A token bucket per source caps the rate. A source that keeps flooding is disconnected. |
| **Dedupe and reorder** | Every frame carries `carId`, a per-source `seq` and a timestamp. Duplicates are dropped. Frames that arrive out of order wait up to 100 ms in a reorder buffer. Frames that arrive too late are stored but never rewind live state. |
| **Race state** | 60 timing loops per lap give real time gaps, the same way circuits time cars, without scanning history. Sector and lap times are interpolated between frames, and every lap keeps a 25 m trace of speed, throttle, brake and gear. |
| **Store** | Raw frames are written with one unordered `insertMany` every 500 ms. A unique index on `(sessionId, carId, seq)` makes the writes idempotent. Raw telemetry expires after a TTL, while laps, traces, alerts and results are kept. |
| **Detect** | Detectors for tyre overheating, punctures (pressure rate of change), brake fade (EWMA z-score per braking event), engine temperature, slow cars and lost telemetry. |
| **Decide** | The strategy engine searches every no-stop, one-stop and two-stop plan, using the same tyre and weather model the cars obey, calibrated online from real lap times. |
| **Broadcast** | Compact 10 Hz position frames, delta-only timing updates, and full per-car telemetry, sent only to rooms someone is subscribed to. Slow clients are moved to a 2 Hz feed. |

## What you get

**A live pit wall.** The circuit is drawn on canvas and coloured by speed, with kerbs, corner numbers, DRS zones and a chequered start line. Cars glow and leave trails, and they're interpolated to 60 fps between 10 Hz updates. Beside the map:

- a timing tower that slides when positions change, with sector colours, tyre and stop count;
- the weather and its lap-by-lap rain forecast;
- a team-radio feed of alerts.

**Car telemetry.** Live speed, throttle, brake, gear and delta traces, with the car's best lap from MongoDB drawn as a **ghost** that the live lap races against. There are shift lights, pedal bars, DRS, ERS and fuel. A tyre heatmap shows inner, middle and outer temperatures for each corner, alongside pressures and glowing brake discs.

**A race weekend.** **Practice** has run plans, long-run pace and tyre degradation. **Qualifying** is a Q1/Q2/Q3 knockout with a live elimination line, gap to pole and the theoretical best lap. The **race** grid is set by qualifying.

**A live strategist.** Ranked options with predicted finishing position, rejoin position and traffic, risk and confidence, recomputed every few seconds. It also flags undercut chances and threats, cheap stops under a safety car, rain crossovers, the tyre cliff and the fuel margin. You can ask *what if it rains in four laps?*, *what if there's a safety car next lap?* or *what if my rival pits now?*, and apply a plan with one click. The pit call reaches the car.

**Post-session analysis.** Built from MongoDB aggregations:

- race trace, lap chart and tyre-strategy chart;
- lap-time scatter by compound;
- fuel-corrected degradation per stint;
- pit-stop summary and speed traps;
- theoretical best laps;
- a track-dominance map by mini-sector;
- a two-driver telemetry overlay with a delta trace.

**Alerts that stay in sync.** Alerts are stored, sent only to the team concerned and to race control, and rate-limited per car. Acknowledging one in one window clears it in every window.

**Race control.** Start, pause or end sessions. Set the track status (green, yellow, VSC, SC, red). Schedule rain. Inject punctures, brake fade, engine or tyre overheating. Change the stream rate or fire a 100 Hz burst.

**Numbers, not claims.** A Systems page shows live ingest rate, broadcast throughput, p50, p95 and p99 latency, duplicates, reordered and late frames, DB batch latency, back-pressured clients and event-loop lag. A load-testing tool drives many sources and headless clients and records the results.

**Roles.** Race control sees everything. An engineer sees full telemetry, alerts and strategy for their own team's two cars only, enforced on every REST call and every room join. Spectators get public timing at 2 Hz without signing in.

## Run it locally

Node 20 or newer (22 recommended) and MongoDB 6+. If you don't have MongoDB, `docker run -d -p 27017:27017 mongo:7` starts one.

```bash
git clone https://github.com/Ivan825/Slipstream.git && cd Slipstream
npm install
cp .env.example .env
npm run dev          # server :4000 + simulator + dashboard on http://localhost:5173
```

Sign in with a demo account. The password for every account is `slipstream`.

| Role | Username |
|---|---|
| Race control | `control` |
| Engineer | the team id: `kestrel`, `vortex`, `ardent`, `halcyon`, `solaris`, `monarch`, `nordwind`, `verdant`, `azzurra`, `basalt` |
| Spectator | no sign-in |

To get the full effect, open two windows: one as `control` and one as `kestrel`. Schedule rain from Race Control and watch Kestrel's strategy re-rank around an intermediate-tyre crossover. Then inject a puncture on car 17: the alert reaches both windows within about a tenth of a second.

```bash
npm test                                            # sequencer, rate limiter, validation, race timing, anomalies, strategy, weather, track model
npm run loadtest -- --clients 200 --duration 60     # many dashboards
npm run loadtest -- --sources 50 --hz 100           # many fast sources
```

## Deploy your own

| How | Notes |
|---|---|
| **One service** (Render, Railway, any VM) | `npm run build`, then `npm start` with `SERVE_CLIENT=true EMBED_SIMULATOR=true`. One Node process serves the API, the sockets, the simulator and the dashboard. `render.yaml` is included. |
| **Split** | Dashboard on Vercel (`client/vercel.json`, `VITE_API_URL` pointing at the API), server on Render or Railway. |
| **Docker** | `docker compose up --build` starts MongoDB, the server with the simulator, and the dashboard. |

You'll need a MongoDB connection string (Atlas free tier works) and two long random secrets, `JWT_SECRET` and `INGEST_SECRET`. Every setting is listed in [`.env.example`](.env.example).

## Real-time design

| Namespace / room | Who | Rate | Payload |
|---|---|---|---|
| `/ingest` | each car, plus the simulator controller | 20 Hz in 100 ms batches | frames, acknowledged |
| `race` | engineers, race control | 10 Hz | `[car, lap, distance_dm, km/h, status]` per car, ~400 B for the whole field |
| `race:2hz` | spectators, back-pressured clients | 2 Hz | same |
| `timing` | everyone | 2 Hz | changed fields only, full snapshot every 10 s |
| `car:<ID>` | that car's team, race control | 10 Hz | every 20 Hz frame since the last tick |
| `team:<id>` | that team, race control | on event | alerts, strategy, pit calls |
| `control` | race control | on event | everything |
| `metrics` | Systems page | 1 Hz | pipeline metrics |

**History merged with live data, without duplicates:**

1. The dashboard subscribes to a car first and buffers what arrives.
2. The subscribe acknowledgement returns a **cursor**: the last sequence number already broadcast to that room.
3. The dashboard fetches history up to that cursor. The server answers from MongoDB plus an in-memory hot cache, so frames still in the write batch aren't missed.
4. History and live frames are merged by sequence number, and duplicates are dropped.
5. Any gap that appears later, for example after back-pressure, is backfilled from the API.

Details, diagrams and the data model are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System and data-flow diagrams, the MongoDB schema, the socket protocol, and the performance techniques |
| [`docs/STRATEGY.md`](docs/STRATEGY.md) | How the strategy engine models tyres, weather, pit loss and rivals |
| [`docs/STRESS_TEST.md`](docs/STRESS_TEST.md) | Load-test method and results |
| [`.env.example`](.env.example) | Every setting |

## Status

Working end to end on one machine. The simulator, ingest pipeline, race timing, anomaly detection, strategy engine, REST API and live namespaces are covered by the unit and engine tests (`npm test`), which drive the real car model through the real engines offline. The dashboard is checked by hand in Chrome and Safari. Multi-instance scaling (a Socket.IO adapter over Redis) is designed for but not built.

## Limitations

- **The cars are simulated.** The physics is a believable model, not a vehicle dynamics package. Lap times, temperatures and degradation are realistic in shape, not calibrated to a real car.
- **One server process.** Rooms and the race state live in memory. Running several instances would need the Socket.IO Redis adapter and a shared state store.
- **Clocks.** End-to-end latency uses the source timestamp, so it's only exact when the sources and the server share a clock, which they do in the bundled setup.
- **The strategist is a model.** It's deterministic and explainable, and it's only as good as the tyre and weather model it shares with the simulator.

## Credits

Built with [Express](https://expressjs.com/), [Socket.IO](https://socket.io/), [Mongoose](https://mongoosejs.com/), [zod](https://zod.dev/), [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken), [bcryptjs](https://github.com/dcodeIO/bcrypt.js), [helmet](https://helmetjs.github.io/), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit), [React](https://react.dev/), [React Router](https://reactrouter.com/), [Vite](https://vitejs.dev/), [Zustand](https://github.com/pmndrs/zustand), [Framer Motion](https://www.framer.com/motion/) and [uPlot](https://github.com/leeoniya/uPlot), all MIT licensed. Fonts are [Titillium Web](https://fonts.google.com/specimen/Titillium+Web) and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) (SIL Open Font License).

The circuit is a Catmull–Rom spline. Anomaly baselines use exponentially weighted moving averages. Rate limiting is a token bucket. Team, driver and circuit names are fictional and not affiliated with any racing series. All telemetry is simulated.

## Licence

[MIT](LICENSE).
