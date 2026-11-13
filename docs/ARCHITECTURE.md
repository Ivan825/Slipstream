# Architecture

Slipstream is one Node.js server, one MongoDB database and any number of browsers. The data sources (simulated cars) connect to the server over Socket.IO exactly like real ones would. In development and on single-service hosting, the simulator runs inside the server process but still talks to it through the `/ingest` namespace.

## System

```mermaid
flowchart LR
  subgraph Sources["Data sources"]
    direction TB
    C1[Car 1]:::src
    C2[Car 2]:::src
    CN[… Car 20]:::src
    CTRL[Simulator controller]:::src
  end

  subgraph Server["Node.js · Express · Socket.IO"]
    direction TB
    ING["/ingest namespace<br/>HMAC API key → one source id"]
    VAL[validate · zod]
    TB[token bucket<br/>per source]
    SEQ[sequencer<br/>dedupe + reorder buffer]
    RS[race state<br/>timing loops · sectors · laps · pit stops]
    AN[anomaly engine]
    ST[strategy engine]
    WX[weather engine]
    SES[session clock<br/>practice · Q1/Q2/Q3 · race]
    BW[batch writer<br/>500 ms insertMany]
    BC[broadcaster<br/>10 Hz · deltas · backpressure]
    LIVE["/live namespace<br/>JWT · room ACL"]
    REST[REST API · rate limited]
  end

  DB[(MongoDB)]

  subgraph Browsers["React dashboards"]
    RC[Race control]
    EN[Team engineers]
    SP[Spectators]
  end

  C1 & C2 & CN -->|telemetry batches, ack| ING
  ING --> VAL --> TB --> SEQ
  SEQ -->|in order| RS
  SEQ -->|accepted + late| BW --> DB
  RS --> AN & BC
  ST --- RS
  WX --> ST
  SES --> RS
  AN -->|alerts| DB
  RS -->|laps · pit stops| DB
  BC --> LIVE --> RC & EN & SP
  REST <--> DB
  RC & EN & SP -->|history, analysis, strategy, control| REST
  CTRL <-->|session · weather · pit calls · incidents| ING
  classDef src fill:#1f1f29,stroke:#e10600,color:#fff
```

## Data flow of one telemetry frame

```mermaid
sequenceDiagram
  autonumber
  participant Car as Car source
  participant Ing as /ingest
  participant Seq as Sequencer
  participant RS as Race state
  participant An as Anomaly
  participant BW as Batch writer
  participant DB as MongoDB
  participant BC as Broadcaster
  participant UI as Dashboard

  Car->>Ing: telemetry [frames…] (100 ms batch)
  Ing->>Ing: zod schema, carId == key's source, clock skew
  Ing->>Ing: token bucket (150/s, burst 300)
  Ing->>Seq: accept(frame)
  alt seq already seen
    Seq-->>Ing: dup (dropped, counted)
  else seq ≤ last applied
    Seq-->>BW: late (stored, never rewinds state)
  else new
    Seq->>BW: queue for storage
    Seq->>RS: apply in seq order (waits ≤100 ms for a missing seq)
    RS->>An: thresholds, rates, EWMA z-score
    RS->>BC: pending frames for car:<id>
  end
  Ing-->>Car: ack {accepted, rejected, limited, duplicates, late}
  BC->>UI: car:<id> batch (immediately), race (10 Hz), timing deltas (2 Hz)
  BW->>DB: insertMany(ordered:false) every 500 ms
```

## Real-time protocol

Two Socket.IO namespaces keep data sources and dashboards apart: they have different authentication, different payload limits and different event sets.

| Namespace | Auth | Events in | Events out |
|---|---|---|---|
| `/ingest` | `apiKey = <sourceId>.<HMAC(secret, sourceId)>` | `telemetry` (≤ 50 frames, acknowledged) | `sim:state`, `sim:command` to the controller |
| `/live` | optional JWT (no token = public viewer) | `subscribe`, `unsubscribe`, `alert:ack` | `race`, `timing`, `car`, `lap`, `alert`, `alert:acked`, `strategy`, `command`, `pitstop`, `session`, `metrics` |

Rooms on `/live`, and who may join them:

| Room | Race control | Engineer | Spectator | Rate |
|---|---|---|---|---|
| `race` | ✓ | ✓ | redirected to `race:2hz` | 10 Hz |
| `race:2hz` | | | ✓ | 2 Hz |
| `timing` | ✓ | ✓ | ✓ | 2 Hz, changed fields only |
| `car:<ID>` | ✓ | own team only | ✗ | every frame, per ingest batch |
| `team:<id>` | ✓ (via `control`) | own team only | ✗ | on event |
| `control` | joined automatically | ✗ | ✗ | on event |
| `metrics` | ✓ | ✓ | ✓ | 1 Hz |

**Payloads**

- Position frames are integer arrays: `[carIndex, lap, distance_dm, km/h, status]`. That's about 400 bytes for the whole field. The client rebuilds x/y from the shared track model.
- Timing sends only the fields that changed since the last update, plus a full snapshot every 10 seconds.
- Position frames use volatile emits, so a client that can't keep up drops frames instead of building a queue.
- A room with no members is never serialised.

**Backpressure**

- Once a second, the broadcaster checks each socket's outgoing buffer.
- A socket that falls behind is moved from `race` to `race:2hz` and excluded from car rooms.
- It's restored after 5 seconds with an empty buffer.
- When it comes back, the client sees a sequence gap in its car stream and backfills it from the REST API.

## History merged with live data, without duplicates

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant L as /live
  participant API as REST
  participant DB as MongoDB
  participant Hot as hot cache (60 s in memory)

  UI->>L: subscribe car:KAL
  L-->>UI: ack { cursor: lastBroadcastSeq = 18442 }
  Note over UI: live frames with seq > 18442 start arriving and are buffered
  UI->>API: GET /telemetry/KAL?toSeq=18442
  API->>DB: find seq ≤ 18442 (unique index on sessionId, carId, seq)
  API->>Hot: frames ≤ 18442 not yet flushed by the batch writer
  API-->>UI: merged, sorted, deduped by seq
  Note over UI: insert by seq into a ring buffer, drop duplicates, show the seam
```

The cursor is read in the same event-loop turn as the room join. Every frame broadcast afterwards therefore has a higher sequence number than the cursor. The hot cache closes the window where a frame has been broadcast but not yet written by the 500 ms batch writer.

The ghost lap works the same way: the best lap's 25 m trace is read from `laps`, and the live lap's time-at-distance is built from the merged buffer.

## Real sessions: live and historical feeds (OpenF1)

```mermaid
flowchart LR
  subgraph Feeds
    H[Historical feed<br/>any past session, free]
    LV[Live feed<br/>current session, subscription key]
  end
  OF[(OpenF1 REST)] --> H & LV
  H & LV -->|2-minute chunks: car_data + location + intervals<br/>metadata: drivers, laps, positions, race control, weather, pits, stints| SRC[SessionSource]
  SRC <-->|cache / record every settled chunk| DB[(MongoDB<br/>ReplaySession · ReplayFrame · ReplayEvent)]
  SRC --> CH[ReplayChannel<br/>shared clock · seek · speed · buffering]
  CH -->|replay:frame 5 Hz · volatile| ROOM[/live room replay:&lt;session&gt;/]
  CH -->|replay:timing 2 Hz| ROOM
  CH -->|replay:events as they happen| ROOM
  ROOM --> UI[Pit wall, telemetry, analysis]
  M[ReplayManager<br/>open on demand · share · close idle] --- CH
```

- **One path for both feeds.** A channel doesn't know whether it's fed live or from the past.
  - The historical feed releases data on a real-time clock that can be paused, sought or sped up.
  - The live feed follows the current session 8 s behind real time and refreshes the newest chunk every 3 s.
- **Streaming, not bulk import.**
  - Car data for all cars is fetched in 2-minute chunks, two or three chunks ahead of the clock. A chunk takes about 4.5 s to fetch, which is fast enough for 16× playback.
  - While a chunk is missing, the clock waits and the UI shows "buffering".
  - Requests to OpenF1 go through one shared, spaced queue that retries on 429.
- **Cache and recording.** Every settled chunk is written to MongoDB, so a session is downloaded once. A live session is recorded as it happens and becomes replayable afterwards.
- **Channels.**
  - Each session is a Socket.IO room with its own clock. Everyone in that room sees the same moment.
  - Anyone can open a channel (rate-limited). Signed-in users can control its clock.
  - Channels with no viewers for 3 minutes close.
  - Joining mid-session returns an exact snapshot: position, gaps, laps, sectors, tyres, flag and weather, rebuilt by re-applying events up to the clock.

## Data model

```mermaid
erDiagram
  SESSION ||--o{ TELEMETRY : "raw frames (TTL)"
  SESSION ||--o{ LAP : "laps with traces"
  SESSION ||--o{ PITSTOP : ""
  SESSION ||--o{ ALERT : ""
  SESSION ||--o{ COMMAND : "audit log"
  USER ||--o{ COMMAND : "issued by"

  SESSION {
    string sessionId PK "R-/Q-/P- + timestamp"
    string type "practice | qualifying | race"
    string status "running | paused | finished"
    int totalLaps
    string[] grid "race grid from qualifying"
    object[] results "pos, carId, best, laps, gap, grid, knockedOut, stops"
    object fastestLap
  }
  TELEMETRY {
    string sessionId "unique (sessionId, carId, seq)"
    string carId
    int seq
    date ts "TTL index"
    float d "distance into lap (m)"
    float v "km/h"
    float thr
    float brk
    int g
    int rpm
    float[] tt "12 tyre surface temps"
    float[] tp "4 pressures"
    int[] bt "4 brake temps"
    string tc "compound"
    int ta "tyre age"
    string st "RUN | PIT | OUT | SLOW | GARAGE"
  }
  LAP {
    string sessionId "unique (sessionId, carId, lap)"
    string carId
    int lap
    int timeMs
    int[] sectors
    string compound
    int tyreAge
    float fuel
    int position
    int gapMs
    bool valid
    bool pitIn
    bool pitOut
    bool pb
    bool fastest
    object stats "vmax, avg speed, max tyre/brake temp, min psi, fuel used"
    object trace "25 m: d, t, v, thr, brk, g"
  }
  PITSTOP {
    string carId
    int lap
    string from
    string to
    int laneMs
    int stationaryMs
  }
  ALERT {
    string carId
    string team
    string type
    string severity
    string message
    bool acknowledged
    string ackBy
  }
  COMMAND {
    string type "pit | incident | track-status | weather | session"
    string carId
    object payload
    string by
  }
  USER {
    string username
    string passwordHash "bcrypt"
    string role "race_control | engineer | viewer"
    string team
  }
```

**Why a regular collection for telemetry, not a time-series one?**

- MongoDB time-series collections don't support unique indexes.
- The unique `(sessionId, carId, seq)` index is what makes every write idempotent. Retries, duplicates and replays can never create two copies of the same frame.
- Raw frames expire through a TTL index (30 minutes by default). Laps, traces, pit stops, alerts and results are kept.

**Analysis happens inside MongoDB:**

- **Degradation per stint:** a least-squares regression done with `$group` sums (Σx, Σy, Σxy, Σx²).
- **Per-driver medians:** the `$median` accumulator.
- **Consistency:** `$stdDevSamp`.
- **Theoretical best laps:** sector minima per driver.
- **Time-bucketed telemetry:** `$dateTrunc`.

## Timing

- **Lap and sector times** are interpolated between the two frames on either side of the line, so they're accurate to the millisecond even though frames arrive every 50 ms.
- **Gaps** use 60 timing loops per lap, the way real circuits time cars. Each car's crossing time at every loop is recorded. The gap to the leader is the difference to the first car's crossing at the same loop, and the interval is the difference to the car directly ahead. Gaps update 60 times a lap without scanning any history.

## Performance techniques

| Where | Technique |
|---|---|
| Ingest | Source-side 100 ms batching; one ack per batch; zod schema compiled once; O(1) token bucket |
| Ordering | Per-source sequencer with a 100 ms reorder window; bounded seen-set for dedupe |
| Storage | One unordered `insertMany` per 500 ms; one flush in flight; bounded queue with load shedding; idempotent unique index |
| Fan-out | Car frames pushed per ingest batch; positions at 10 Hz; timing deltas at 2 Hz; rooms with no members skipped; volatile emits; `perMessageDeflate` above 1 KB |
| Backpressure | Per-socket buffer check; slow clients degraded to 2 Hz and excluded from car rooms; client-side gap backfill |
| Strategy | Computed only for cars someone is watching, staggered one car per event-loop turn |
| Client | Socket handlers write into ring buffers and mutable maps, not React state. One `requestAnimationFrame` loop per canvas. Positions interpolated from 10 Hz to 60 fps. Static circuit pre-rendered offscreen. Tables re-render at ≤ 4 Hz. uPlot for large series |
| Observability | Counters, normalised rates, latency reservoirs (p50/p95/p99) and event-loop delay, streamed to the Systems page |

## Security

- **Data sources:** HMAC API keys bind each connection to one source id, and a frame whose `carId` doesn't match is rejected. Sources that keep flooding are disconnected.
- **Dashboards:**
  - JWT authentication; passwords hashed with bcrypt.
  - Every REST route and every room join is checked against the user's role and team.
  - Live telemetry, alerts and strategy are team-scoped.
- **HTTP:** helmet, CORS restricted to configured origins, JSON body limit, a global API rate limit, and a login limiter that counts failed attempts.
- **Validation:** every write endpoint validates its body with zod.
