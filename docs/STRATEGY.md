# The strategy engine

`server/src/core/strategy.js` answers the question every race engineer asks a few hundred times a race: *what should we do next, and what happens if we don't?*

## Model

The cars and the strategist share one model in `shared/src/tyres.js`, so the predictions match how the cars actually behave:

```
lap time = base + compound offset + degradation(age) + wet penalty(wetness) + fuel × 0.032 s/kg + driver pace
```

| Term | Value |
|---|---|
| Compound offset | Soft −0.65 s, Medium 0, Hard +0.55 s |
| Degradation | Linear per lap (S 0.085, M 0.055, H 0.035 s/lap). Past the compound's cliff (S 13, M 22, H 32 laps) it grows quadratically |
| Wet penalty | Slicks lose about 15 s per unit of wetness. Intermediates beat slicks above about 0.25 wetness and full wets above about 0.85 |
| Base | 91 s plus a per-car residual learned online from that car's clean laps (lap 1, in/out laps and wet laps are excluded). The residual is shrunk towards the field average until the car has a few laps of evidence |

**Pit loss** depends on track status: 21.0 s under green, 13.5 s under the virtual safety car, 10.5 s under the safety car. Each stop adds 1.2 s for cold tyres on the out-lap.

**Weather** comes from the weather engine's forecast. Each scheduled shower has a timing error and a confidence. The engine integrates the same wetness dynamics forward (tracks get wet fast and dry slowly) to predict track wetness at the middle of every remaining lap.

## Search

For the selected car, the engine evaluates every plan for the rest of the race:

- **no stop**
- **one stop:** every stop lap in the next 26 laps × every compound
- **two stops:** every first-stop lap in the next 16 laps × every second-stop lap × every compound pair

Wet compounds are only considered when rain is forecast or the track is already wet.

**Constraints:** in a dry race a car must use two different dry compounds.

**Output per plan:** remaining race time, the worst tyre-cliff overrun, and the fuel left. A typical search covers 1,500 to 9,000 plans and takes 5 to 35 ms.

**Rivals:** every other car is projected with a cheaper single-stop search. Projected finishing positions come from each car's current gap plus its best remaining time.

## Options and insights

The engine returns up to four distinct options:

- the optimal plan
- the best plan that boxes now
- the best plan that extends the stint
- the best weather call, if rain is a factor
- an aggressive soft-tyre plan

**Each option carries:**

- predicted race time and the delta to the best option
- projected finishing position
- rejoin position and whether the car rejoins in traffic
- risk, from tyre-cliff overrun, traffic and the rain gamble
- confidence, which falls with forecast uncertainty and laps remaining
- plain-language reasons

**Insights** are tactical flags computed from the same model:

- **Undercut opportunity:** fresh tyres would gain more over two laps than the interval to the car ahead.
- **Undercut threat:** the car behind could do the same to us.
- **Neutralised stop:** the safety car or VSC makes a stop cheap.
- **Tyres:** the car is approaching or past the cliff.
- **Rain crossover:** rain is coming, and the lap when it arrives.
- **Track drying:** a wet track is drying, and the lap when slicks become viable.
- **Fuel tight:** the projected fuel margin is low, with a lift-and-coast distance.
- **DRS range:** attack the car ahead, or defend from the car behind.
- **Damage:** a puncture or a slow car forces a stop this lap.

## What-if scenarios

`POST /api/strategy/:carId/whatif` recomputes everything under a hypothetical:

```json
{
  "rain": { "inLaps": 3, "durationLaps": 8, "intensity": 0.7 },
  "noRain": false,
  "safetyCar": { "inLaps": 1, "laps": 3, "type": "SC" },
  "degMultiplier": 1.2,
  "rivalPit": { "carId": "MER", "inLaps": 0, "compound": "H" }
}
```

## Acting on it

`POST /api/strategy/:carId/apply { compound, lap? }` issues a pit call:

- **No lap, or the current lap:** the call goes straight to the car over the simulator's control channel, and the car pits at the next pit entry.
- **A later lap:** the call is scheduled and fires when the car starts that lap.
- **Every call** is written to the `commands` audit collection and broadcast to the team and race control.

## Limits

The engine is deterministic and explainable, not a learned model:

- It assumes gaps between rivals hold while it projects the race.
- It doesn't model overtaking difficulty beyond the traffic flag.
- It shares the simulator's tyre model, so in a real deployment the model parameters would need fitting to real tyre data.


## Real sessions: the race engineer's forward look

On real timing (`client/src/lib/realStrategy.js` and `client/src/lib/raceEngine.js`) the strategist has no tyre or fuel model to share with the cars, so everything comes from the session itself, up to the clock.

**Session model.** Pit loss is the median over stops so far of in-lap + out-lap − two green laps (×0.65 under a VSC, ×0.55 under a safety car, free under a red flag). Tyre life per compound is the upper quartile of finished stints, never far below a typical value, since early stops say little about how long a set lasts. Degradation is the least-squares slope of clean lap times on the current set plus the fuel effect (0.06 s per lap).

**Projection.** Each car runs lap by lap to the flag:

```
lap time = pace on a fresh medium now + compound offset + degradation × age + cliff(age − life) − 0.06 s × laps from now
```

with a quadratic cliff past the set's life (linear after eight laps over). Rivals follow their likely plan: box now if the strategist says so, otherwise a stop at about 85% of the set's life when the tyres won't reach the flag.

**Battles.** For each of our cars and the three cars either side, the engine finds the lap the gap comes within a second (DRS range) and the lap the cars swap, and whether the swap is on track or through a stop. An on-track pass needs a pace edge that depends on the circuit (long DRS zones make it easier); the probability is a logistic on the pace difference at that lap. The place is the circuit's main overtaking zone.

**Options.** Every no-stop plan, every one-stop lap per compound, the best two-stop pair per compound combination (on a two-lap grid), box now, and extend five laps past the best window, simulated against the field. Ranking adds 4 s for a set past its life and 0.8 s for a rejoin within 1.5 s of another car. A switch alert fires when the best plan changes shape (stops or compound) and gains more than a second over the old one.

**Priority.** Each car gets a stake: threats and chances in the next eight laps, positions a change of plan would win, tyre wear and track position. Two cars stopping within a lap of each other get a pit order and a double-stack cost (a typical stop of 2.6 s, less any gap between them); a faster car within 2.5 s behind its team-mate gets a swap call.

**Incidents.** `client/src/lib/incidents.js` parses race control: time penalties, drive-throughs and stop-and-goes (a time penalty counts as served once the car has stopped after it; a drive-through costs about a pit loss less the stop, a stop-and-go that plus its seconds), investigations opened and closed, track-limits deletions per corner, black-and-white and blue flags, the stewards' rain risk, DRS status, safety-car endings, suspensions and restarts. Outstanding penalties are added to each car's projected race time.

**Targets.** Managing the tyres by *m* s/lap is taken to stretch a set's life by 40% per second, so the management needed to reach the planned stop is `m = (age + laps to stop) / life − 1) / 0.4`, capped at 1.2 s. The target for each of the next laps is the plan's projected lap plus *m*. The DRS limit is the car behind's projected lap plus (interval − 1 s) / 5.

**Monte Carlo.** Per lap a safety car with probability 1.2% and a VSC with 0.8% (generic rates: the circuit's own history isn't in the data). Under one, stops cost 55% / 65% and any car due within eight laps stops then; a safety car re-forms the field 0.7 s apart in order. Each car also gets 0.3 s/lap of Gaussian noise. 160 runs per option, seeded by the clock so the numbers don't flicker.

**Driver ratings.** Pace 100 − 22 × (best-five fuel-corrected median − field best); consistency from the residual spread around each stint's line; tyres from the per-stint slope against the field median on that compound; racecraft 55 + 7 × (overtakes made − suffered). Overall: 45% pace, 20% consistency, 20% tyres, 15% racecraft. In a battle, the attacker's racecraft minus the defender's shifts the pass threshold by up to ±0.2 s.
