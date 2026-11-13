# Race engineering reference

The views in Slipstream are modelled on what race engineers and strategists actually use in professional data systems and official timing documents. This page maps each one to the screen where it lives, and explains the terminology the UI uses.

## Where the ideas come from

- **Professional data systems** such as Bosch WinDarab, MoTeC i2, McLaren Applied ATLAS and Cosworth Pi Toolbox provide:
  - lap overlays against distance;
  - a time-variance (delta-T) channel;
  - track maps coloured by a channel;
  - histograms, outing reports and segment (corner) analysis;
  - math channels.
- **Official timing documents** supply the naming used here: classification, fastest laps, the race history chart, the lap chart, the pit stop summary, best sector times and maximum speeds.
- **Public analysis tools** popularised these views: lap-time scatter by compound, team pace box plots, tyre strategy charts, the speed-trace overlay and track dominance by mini-sector.

## Practice

| What engineers use | In Slipstream |
|---|---|
| Run plan: out-lap, push laps, cool-down, in-lap; installation, set-up and quali-sim runs; long runs | The simulator runs each car through programmes from the garage. The **Run monitor** on the pit wall tags every lap OUT / PUSH / COOL / IN |
| Long-run pace (fuel-corrected) and degradation (s/lap) | The Run monitor computes both live for the latest stint. Analysis → Degradation fits every stint in MongoDB |
| Classification by best lap, session clock | Timing tower in practice mode; countdown in the session bar |
| Track evolution | The simulator's grip improves as the field completes laps (up to 0.6 s) |

## Qualifying

| What engineers use | In Slipstream |
|---|---|
| Knockout format (Q1 / Q2 / Q3), with the slowest cars eliminated in each | Session clock with configurable segment lengths. The bottom five go after Q1 and again after Q2. The race grid comes from the final order |
| Drop zone / cut-off line | A red **DROP ZONE** line under the last advancing position in the timing tower |
| Margin to safety, cut-off time | The **Qualifying panel** shows the cut-off lap and the selected car's margin |
| Theoretical best (ideal lap = sum of best sectors), potential position | The Qualifying panel and Analysis → Classification ("Ideal", "Lost") |
| Purple / green / yellow sectors | Sector flags in the timing tower and on the track map: purple is the session best, green a personal best, yellow slower |
| Chequered flag: a lap started before the flag counts | Cars on a push lap finish it. Cars on an out-lap return to the garage |

## Race

| What engineers use | In Slipstream |
|---|---|
| Live gap and interval | 60 timing loops per lap |
| Pit window, undercut / overcut, safety-car stops, rain crossover | **Strategy** page and the pit-wall strategist (see [STRATEGY.md](STRATEGY.md)) |
| Team radio, alarms | Anomaly alerts with acknowledgement, plus "BOX BOX" toasts |
| Tyre temperatures (inner / middle / outer), pressures, brake temperatures | Telemetry → Tyres & brakes |

## Post-session analysis

| View | How it's computed |
|---|---|
| **Classification** | Session results stored at the chequered flag: grid, positions gained, stops, knockout segment |
| **Best sectors & ideal laps** | `$min` of each sector per driver. Ideal = S1 + S2 + S3. Lost = best − ideal |
| **Race history chart** | Gap to the winner's average pace: `L × avg − Σ lap times`. Pit stops show as drops |
| **Lap chart** | Position at each line crossing, stored on every lap |
| **Tyre strategy** | Stints from compound and tyre age (`lap − tyreAge` is constant within a stint) |
| **Pit stop summary** | Pit-lane and stationary time measured from telemetry. Net loss = lane time − time to cover the same distance at racing speed |
| **Lap times by compound** | Clean laps within 107% of the fastest, coloured by compound |
| **Team pace ranking** | Box plot of clean laps per team, ordered by median |
| **Consistency** | Standard deviation of valid laps (`$stdDevSamp`) |
| **Degradation** | Least-squares fit of fuel-corrected lap time (`t − 0.032 s/kg × fuel`) on tyre age, per stint, inside a MongoDB aggregation pipeline. Compound crossover where two fitted lines meet |
| **Telemetry overlay** | Two drivers' fastest laps against distance: speed, throttle, brake and gear, plus **Delta-T** = t₂(d) − t₁(d). A track map shows who gains in each of 25 mini-sectors |
| **Track dominance** | The fastest driver through each of 25 equal-length mini-sectors on their best lap, coloured by team |
| **Maximum speeds** | V max per lap from lap statistics |

## Glossary

| Term | Meaning |
|---|---|
| **Out lap / in lap** | Leaving or returning to the pits. Slow, and never counted as a timed lap |
| **Push lap** | A timed lap at full attack |
| **Cool-down** | A slow lap between push laps |
| **Stint** | Laps on one set of tyres |
| **Cliff** | The age at which a compound's grip falls away sharply |
| **Fuel-corrected** | The lap time with the fuel-weight effect removed, so laps at different fuel loads compare fairly |
| **Deg** | Degradation: lap time lost per lap of tyre age |
| **Undercut** | Pitting before a rival so your fresh-tyre laps make up the gap |
| **Overcut** | Staying out longer than a rival to gain track position |
| **Pit loss** | Time lost by making a stop compared with staying on track |
| **SC / VSC** | Safety car / virtual safety car. The field is neutralised and pit loss is lower |
| **DRS** | Drag reduction system. Allowed within 1 s of the car ahead in a DRS zone |
| **Delta-T** | Time difference to a reference lap at the same distance |
| **Ideal lap** | The sum of a driver's best sectors |
| **Drop zone** | Positions that would be knocked out of a qualifying segment if it ended now |
| **Mini-sector** | One of 25 equal-length slices of the lap |
