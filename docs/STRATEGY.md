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
