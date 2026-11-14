# Takeover: run a real race yourself

A **takeover** forks a real Formula 1 race at any moment and runs it on from there as a simulation that you drive from the pit wall. Up to the fork, everything is the real session from OpenF1. After it, the server generates the race: car positions, speed, throttle, brake, gear, DRS, lap and sector times, gaps, positions, pit stops, overtakes, race control and weather. The crew's calls change what happens.

You can fork from three places:

- **a past race, at any lap**: on the launcher, pick the race and lap, then **Take over from lap N**;
- **the race you are watching** (replay or mock): **Take over from here** on the pit wall or Strategy page;
- **the live race**: **Take over the live race** on the launcher while a race is running. The fork starts from the live state at that moment.

Because the generated data has the same shape as real timing, every pit-wall tool works on it unchanged: the battle forecast, strategies and Monte Carlo, targets and modes, flags, tyres, weather, driver ratings, engineer calls and voice alerts, and the team watcher.

## What the crew controls

For each of its own cars:

| Call | Effect |
|---|---|
| **Box this lap** on S / M / H / I / W | the car takes the pit lane at the end of the lap and fits that set |
| **Box at lap N** | same, at the end of lap N |
| **Stay out** | cancels a box call that hasn't been taken |
| **Mode** | *Push* −0.25 s/lap, tyres wear 1.3× · *Standard* · *Tyre save* +0.35 s/lap, wear 0.65× · *Lift & coast* +0.45 s/lap, lower top speed, lifts before braking (visible in the telemetry) |
| **Team order** | *Let [team-mate] by* swaps the cars in the next zone · *Hold* stops them racing · *Race* |
| **Autopilot stops** | the strategist makes this car's stops when the crew hasn't called one |

A signed-in crew can command only its own team's cars. Without a team, any selected car can be run.

Race control is open to everyone on the takeover:

- **Flags:** safety car (bunches the field, no passing, cheap stops), VSC, end it, red flag (cars stop, free tyre change), resume (behind the safety car);
- **Weather:** light or heavy rain, or dry. The track gets wetter over a few minutes and dries more slowly;
- **Stewards:** 5 s penalty (served at the next stop or added at the flag), drive-through, puncture, mechanical failure;
- **Random race events:** safety cars, VSCs, punctures, failures and track-limits deletions at realistic rates.

## How the race is modelled

Everything is calibrated on the session itself (`server/src/fork/sim.js`):

- **The circuit:** the outline and speed profile of one clean lap (OpenF1 location and car data). A car's speed at each point is the reference speed scaled to its current lap time, so its lap takes exactly that long and it slows where the real cars slowed. DRS zones are where the reference car opened its flap.
- **Each driver's pace:** a median of their recent clean laps, with tyre age, compound and fuel taken out.
- **Tyres:** degradation per compound is the slope of fuel-corrected lap times against tyre age, fitted per stint. Life per compound comes from the stints teams chose to end. Past its life, a set loses time quadratically (the cliff). Wet and intermediate tyres use the shared crossover model.
- **Fuel:** 0.06 s per lap of fuel burnt.
- **Pit stops:** the pit loss is fitted from in-laps and out-laps. The lane is speed-limited, so under a safety car it costs the same time while the others lose more, which is what makes a cheap stop.
- **Traffic:** a car can't get closer than 0.3 s to the one ahead. It passes only in a DRS zone (or the fastest straights), with a probability that depends on pace difference, DRS and tyres. Otherwise it sits in dirty air, which wears its tyres faster. Backmarkers let the leaders through.
- **Rivals:** they make the stops their teams really made, on the same tyres, until the race changes. Then a strategy model takes over: cheap stops under a safety car, the rain crossover, the end of tyre life, and the second compound the rules require. In a live fork the future isn't known, so rivals use the model from the start.
- **Noise:** each lap gets a little random variation, seeded so a takeover is reproducible.

## Data flow

```
 real session (OpenF1, cached in MongoDB) ─► fork at t0 ─► ForkSim (10 steps / s of race time, ×1–16)
                                                              │
                         crew calls / race control (REST) ───►│
                                                              ▼
            frames 5 Hz · timing 2 Hz · events as they happen  ──►  Socket.IO room replay:m-<id>  ──►  pit wall
                                                              │
                         ForkEvent (batched every 8 s) + saved sim state ──► MongoDB
```

- **Storage.** The real events up to the fork and every generated event are written to the `ForkEvent` collection in batches. The sim's state is saved with them at the same moment. A takeover that is closed, or a server that restarts, picks up exactly where it was. Events saved after the last state save are deleted on reopen and generated again, so nothing is doubled.
- **History plus live.** The dashboard loads the takeover's history from MongoDB once (`/api/replay/m-<id>/analysis`). It then merges the laps, stops, tyre changes, overtakes, race control and weather that stream in, deduplicated by car and lap (or by time), at most every 2 s so the engines aren't rerun on every message. A full refetch every 20 s keeps it consistent with the server.
- **Validation and limits.** Commands are validated with zod and rate-limited (120 a minute). A crew can only command its own cars. Starting a takeover shares the mock limit (8 a minute).
- **Debrief.** The debrief compares your race with the real one for every car: finishing position, places gained or lost, stops and tyre sequences.

## API

| | |
|---|---|
| `POST /api/mocks/fork` `{ from, lap?, team? }` | fork `from` (a session key, `"live"` or a mock `m-…`) at the start of `lap`, or at that channel's clock. Returns the new takeover's channel and snapshot |
| `POST /api/mocks/:id/command` `{ type, n?, compound?, lap?, mode?, order?, on?, level?, kind?, secs? }` | `box`, `cancel-box`, `mode`, `order`, `auto`, `sc`, `vsc`, `end-sc`, `red`, `resume`, `rain`, `dry`, `penalty`, `puncture`, `failure`, `random` |
| `POST /api/replay/m-:id/control` `{ action: play \| pause \| speed }` | the takeover's clock. It only runs forward: no seeking |

## Limits

It is a model, calibrated on public timing: no team's fuel loads, tyre temperatures or engine maps. Overtaking is a probability, not a simulation of a pass. A red flag stops the cars where they are rather than in the pit lane. Starting a takeover from lap 1 begins from the first racing lap, not from the grid.
