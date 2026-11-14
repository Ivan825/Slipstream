/**
 * Race control, read like a race engineer reads it: penalties (and whether they
 * have been served), investigations still open, track-limits strikes, blue
 * flags, the stewards' rain risk, DRS status, restarts and suspensions.
 * Everything up to the session clock `t`.
 */
const carsIn = (m) => [...m.matchAll(/(\d+) \([A-Z]{3}\)/g)].map((x) => Number(x[1]));
const reasonOf = (m) => (m.includes(' - ') ? m.slice(m.lastIndexOf(' - ') + 3).trim() : '');
const whereOf = (m) => (/(TURN \d+|PIT LANE|PIT ENTRY|PIT EXIT|LAP 1|START)/.exec(m) || [])[1] || null;

export function incidents(rc = [], t = Infinity, pits = [], { laneTime = 20, pitLoss = 22 } = {}) {
  const out = {
    penalties: new Map(), // n -> [{ kind, secs, t, reason, served }]
    investigations: [], // open: { cars, reason, where, t }
    noted: [], // incidents noted, not yet under investigation
    trackLimits: new Map(), // n -> { count, corners: Map(corner -> count), bw }
    blue: new Map(), // n -> last blue-flag time
    rainRisk: null, drs: null, restart: null, scEnding: null, suspended: null, lastMsg: null
  };
  const list = rc.filter((r) => r.t <= t).sort((a, b) => a.t - b.t);
  const sameCars = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  for (const r of list) {
    const m = String(r.message || '').toUpperCase();
    out.lastMsg = r;
    let x;
    if ((x = /(\d+) SECOND TIME PENALTY FOR CAR (\d+)/.exec(m))) {
      add(out.penalties, Number(x[2]), { kind: 'time', secs: Number(x[1]), t: r.t, reason: reasonOf(m) });
      out.investigations = out.investigations.filter((i) => !i.cars.includes(Number(x[2])) || i.reason !== reasonOf(m));
    } else if ((x = /(\d+) SECOND STOP AND GO PENALTY FOR CAR (\d+)/.exec(m))) {
      add(out.penalties, Number(x[2]), { kind: 'stop-go', secs: Number(x[1]), t: r.t, reason: reasonOf(m) });
    } else if ((x = /DRIVE THROUGH PENALTY FOR CAR (\d+)/.exec(m))) {
      add(out.penalties, Number(x[1]), { kind: 'drive-through', secs: 0, t: r.t, reason: reasonOf(m) });
    } else if (/UNDER INVESTIGATION/.test(m)) {
      const cars = carsIn(m);
      if (!out.investigations.some((i) => sameCars(i.cars, cars) && i.reason === reasonOf(m))) out.investigations.push({ cars, reason: reasonOf(m), where: whereOf(m), t: r.t });
      out.noted = out.noted.filter((i) => !sameCars(i.cars, cars));
    } else if (/NO FURTHER (ACTION|INVESTIGATION)|REVIEWED NO FURTHER/.test(m)) {
      const cars = carsIn(m);
      out.investigations = out.investigations.filter((i) => !(cars.length ? sameCars(i.cars, cars) : i.where === whereOf(m)));
      out.noted = out.noted.filter((i) => !(cars.length ? sameCars(i.cars, cars) : i.where === whereOf(m)));
    } else if (/ NOTED/.test(m)) {
      out.noted.push({ cars: carsIn(m), reason: reasonOf(m), where: whereOf(m), t: r.t });
      if (out.noted.length > 12) out.noted.shift();
    } else if ((x = /CAR (\d+) \([A-Z]{3}\) (?:TIME [\d:.]+|LAP) DELETED - TRACK LIMITS AT (TURN \d+)/.exec(m))) {
      const n = Number(x[1]);
      const tl = out.trackLimits.get(n) || { count: 0, corners: new Map(), bw: false };
      tl.count++; tl.corners.set(x[2], (tl.corners.get(x[2]) || 0) + 1); tl.last = r.t;
      out.trackLimits.set(n, tl);
    } else if ((x = /BLACK AND WHITE FLAG FOR CAR (\d+)/.exec(m))) {
      const n = Number(x[1]);
      const tl = out.trackLimits.get(n) || { count: 0, corners: new Map(), bw: false };
      tl.bw = true; out.trackLimits.set(n, tl);
    } else if ((x = /BLUE FLAG FOR CAR (\d+)/.exec(m))) {
      out.blue.set(Number(x[1]), r.t);
    } else if ((x = /RISK OF RAIN .*? (\d+)\s?%/.exec(m))) {
      out.rainRisk = { pct: Number(x[1]), t: r.t };
    } else if (/DRS ENABLED/.test(m)) out.drs = { on: true, t: r.t };
    else if (/DRS DISABLED/.test(m)) out.drs = { on: false, t: r.t };
    else if (/SAFETY CAR IN THIS LAP|VSC ENDING|VIRTUAL SAFETY CAR ENDING/.test(m)) out.scEnding = { t: r.t, vsc: /VSC|VIRTUAL/.test(m) };
    else if (/SESSION ABORTED|SESSION SUSPENDED/.test(m) || r.flag === 'RED') out.suspended = { t: r.t };
    else if ((x = /RACE WILL RESUME AT ([\d:]+)/.exec(m))) out.restart = { at: x[1], standing: /STANDING/.test(m), rolling: /ROLLING/.test(m), t: r.t };
    else if (/STANDING START|ROLLING START/.test(m)) out.restart = { ...(out.restart || {}), standing: /STANDING/.test(m), rolling: /ROLLING/.test(m), t: r.t };
    if (r.category === 'SafetyCar' && /DEPLOYED/.test(m)) out.scEnding = null;
    if (/GREEN|CLEAR/.test(r.flag || '') && r.scope === 'Track') out.suspended = null;
  }
  // a time penalty is served at the car's next stop; a drive-through or stop-and-go is its own visit to the pit lane
  const owed = new Map();
  for (const [n, ps] of out.penalties) {
    for (const p of ps) {
      p.served = pits.some((s) => s.n === n && s.t > p.t + 3000 && s.t <= t);
      p.cost = p.kind === 'time' ? p.secs : p.kind === 'stop-go' ? p.secs + laneTime : Math.max(laneTime, pitLoss - 2.5);
      if (!p.served) owed.set(n, (owed.get(n) || 0) + p.cost);
    }
  }
  out.owed = owed;
  return out;
}

function add(map, n, p) { const a = map.get(n) || []; a.push(p); map.set(n, a); }

/** a sentence for a car's open penalties */
export function penaltyText(ps = []) {
  const open = ps.filter((p) => !p.served);
  if (!open.length) return null;
  return open.map((p) => (p.kind === 'time' ? `${p.secs} s time penalty` : p.kind === 'stop-go' ? `${p.secs} s stop-and-go` : 'drive-through')).join(' + ');
}
