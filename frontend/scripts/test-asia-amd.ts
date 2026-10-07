import assert from "node:assert/strict";
import { AsiaAmdMachine, computeAmdDays, type AmdDay, type AmdState } from "../src/lib/strategy/amd";
import type { Candle } from "../src/types/forex";

// EUR/USD-style pips. Every fixture day has the same Asian session:
// 28 M15 candles between 1.1000 and 1.1020 with 4-pip bodies, so the average
// body going into London is ~4 pips and a displacement needs a 4+ pip body.
const P = 0.0001;
const DAY = "2026-03-10";
const at = (day: string, h: number, m = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * 60_000).toISOString();

function c(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function asia(day = DAY): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 28; i += 1) {
    const up = i % 2 === 0;
    const open = up ? 1.1008 : 1.1012;
    const close = up ? 1.1012 : 1.1008;
    const high = i === 5 ? 1.1020 : 1.1015;
    const low = i === 12 ? 1.1000 : 1.1005;
    out.push(c(at(day, 0, i * 15), open, high, low, close));
  }
  return out;
}

/** London candles from 07:00, each [open, high, low, close]. */
function london(rows: Array<[number, number, number, number]>, day = DAY, fromMinute = 7 * 60): Candle[] {
  return rows.map(([o, h, l, cl], i) => c(at(day, 0, fromMinute + i * 15), o, h, l, cl));
}

/** Quiet inside-the-range candles to pad a session out. */
function quiet(n: number, day = DAY, fromMinute = 7 * 60): Candle[] {
  return london(Array.from({ length: n }, (_, i) => (i % 2 ? [1.1011, 1.1013, 1.1009, 1.1010] : [1.1010, 1.1012, 1.1008, 1.1011]) as [number, number, number, number]), day, fromMinute);
}

const run = (candles: Candle[], config = {}) => computeAmdDays(candles, "EUR_USD", { config });
const only = (days: AmdDay[]) => {
  assert.equal(days.length, 1);
  return days[0]!;
};
const path = (day: AmdDay) => day.transitions.map((t) => t.to).filter((s, i, all) => i === 0 || s !== all[i - 1]);

// ---- Accumulation ---------------------------------------------------------

{
  const building = only(run(asia().slice(0, 10)));
  assert.equal(building.state, "ASIA_BUILDING", "mid-Asia the range is still building");
  assert.equal(building.locked, false);
  assert.equal(building.asiaHigh, 1.1020);

  const locked = only(run(asia()));
  // The 06:45 candle closes at 07:00: Asia is over the moment it closes.
  assert.equal(locked.state, "WAITING_FOR_SWEEP", "Asia locks when its last candle closes");
  assert.deepEqual(path(locked), ["ASIA_BUILDING", "ASIA_LOCKED", "WAITING_FOR_SWEEP"]);
  assert.equal(locked.asiaHigh, 1.1020);
  assert.equal(locked.asiaLow, 1.1000);
  assert.ok(Math.abs(locked.asiaMidpoint - 1.1010) < 1e-9);
  assert.ok(Math.abs(locked.asiaRangePips - 20) < 1e-6);
  assert.equal(locked.asiaBars, 28);
  assert.ok(locked.quality && locked.quality.score > 0 && locked.quality.score <= 1, "Asia quality is recorded");
  assert.ok(locked.quality!.boundaryTouches >= 2);

  // Frozen: London trading far outside never moves the Asian levels.
  const after = only(run([...asia(), ...london([[1.1010, 1.1060, 1.0950, 1.1010]])]));
  assert.equal(after.asiaHigh, 1.1020, "Asia high is frozen after the lock");
  assert.equal(after.asiaLow, 1.1000, "Asia low is frozen after the lock");

  const thin = only(run(asia().filter((_, i) => i % 3 === 0)));
  assert.equal(thin.state, "INVALID", "too few Asian candles is not a range");

  // A still-forming candle is never read.
  const forming = only(run([...asia(), c(at(DAY, 7), 1.1010, 1.1012, 1.0980, 1.0985, false)]));
  assert.equal(forming.state, "WAITING_FOR_SWEEP", "an incomplete candle cannot start a sweep");
  assert.equal(forming.sweeps.length, 0);
}

// ---- Bullish AMD: sweep low → close back above → displacement up ------------

{
  const candles = [
    ...asia(),
    ...london([
      [1.1006, 1.1008, 1.0995, 1.0997], // 07:00 trades and closes below 1.1000: M?
      [1.0999, 1.1003, 1.0994, 1.1002], // 07:15 closes back above, small body: M
      [1.1002, 1.1012, 1.1001, 1.1011], // 07:30 9-pip bullish body: D
      [1.1011, 1.1018, 1.1009, 1.1016],
      [1.1016, 1.1026, 1.1014, 1.1024], // 08:00 reaches the Asian high
    ]),
  ];
  const day = only(run(candles));
  assert.equal(day.state, "DISTRIBUTION_CONFIRMED");
  assert.deepEqual(path(day), [
    "ASIA_BUILDING", "ASIA_LOCKED", "WAITING_FOR_SWEEP", "SWEEP_CANDIDATE",
    "RECLAIM_CONFIRMED", "WAITING_FOR_DISPLACEMENT", "DISTRIBUTION_CONFIRMED",
  ]);
  const sweep = day.sweeps[0]!;
  assert.equal(sweep.side, "low");
  assert.equal(sweep.startTime, at(DAY, 7));
  assert.equal(sweep.extreme, 1.0994, "the reclaim candle's deeper wick is the extreme");
  assert.ok(Math.abs(sweep.depthPips - 6) < 1e-6);
  assert.equal(sweep.barsToReclaim, 1);
  assert.equal(sweep.reclaimTime, at(DAY, 7, 30), "reclaim is known when the 07:15 candle closes");
  const d = day.distribution!;
  assert.equal(d.direction, "long", "a swept low points long");
  assert.equal(d.barTime, at(DAY, 7, 30));
  assert.equal(d.time, at(DAY, 7, 45));
  assert.equal(d.entry, 1.1011);
  assert.equal(d.stop, 1.0994);
  assert.equal(d.target, 1.1020, "the opposite Asian boundary is the structural target");
  assert.ok(Math.abs(d.riskPips - 17) < 1e-6 && Math.abs(d.rewardPips - 9) < 1e-6);
  assert.equal(d.midpointReached, "already");
  assert.equal(d.oppositeReached, "reached");
  assert.equal(d.minutesToOpposite, 30);
  assert.equal(d.structural.result, "win");
  assert.equal(d.endTime, at(DAY, 8, 15), "D follows the move until the target is hit, then stops");
  assert.equal(d.best, 1.1026);
  assert.equal(day.outcome!.race[5], "win");
  assert.ok(Math.abs(day.outcome!.mfePips - 15) < 1e-6, "MFE counts only candles after the entry candle");
  assert.equal(day.accepted, null);
  assert.equal(day.doubleSweep, false);
}

// ---- Bearish AMD: sweep high → close back below → displacement down ---------

{
  const day = only(run([
    ...asia(),
    ...london([
      [1.1014, 1.1027, 1.1013, 1.1024], // above 1.1020, closes outside
      [1.1023, 1.1025, 1.1016, 1.1018], // closes back below, 5-pip body
      [1.1018, 1.1019, 1.1006, 1.1008], // 10-pip bearish body
      [1.1008, 1.1009, 1.0996, 1.0998], // through the Asian low
    ]),
  ]));
  assert.equal(day.state, "DISTRIBUTION_CONFIRMED");
  assert.equal(day.sweeps[0]!.side, "high");
  assert.equal(day.distribution!.direction, "short", "a swept high points short");
  assert.equal(day.distribution!.target, 1.1000);
  assert.equal(day.distribution!.stop, 1.1027);
  assert.equal(day.distribution!.oppositeReached, "reached");
}

// ---- Breakout continuation: no reclaim = BREAKOUT_ACCEPTED, never M ---------

{
  const candles = [
    ...asia(),
    ...london([
      [1.1004, 1.1005, 1.0996, 1.0998], // close below: candidate
      [1.0998, 1.0999, 1.0988, 1.0990], // second close below: accepted
      [1.0990, 1.0991, 1.0980, 1.0982],
      // Later the price comes all the way back up through the Asian high.
      [1.0982, 1.1010, 1.0981, 1.1008],
      [1.1008, 1.1030, 1.1007, 1.1028],
    ]),
  ];
  const day = only(run(candles));
  assert.equal(day.state, "BREAKOUT_ACCEPTED", "two closes outside is acceptance");
  assert.equal(day.accepted!.reason, "closes");
  assert.equal(day.accepted!.direction, "short", "the continuation is the breakout's own way");
  assert.equal(day.accepted!.time, at(DAY, 7, 30));
  assert.equal(day.distribution, null, "a held break is never relabelled as manipulation later");
  assert.equal(day.sweeps[0]!.status, "accepted");
  assert.equal(day.continuationOutcome!.race[10], "loss", "it went 10 against the continuation first");
}

{
  // One close two ATR (≈ 20+ pips here) past the level is acceptance on its own.
  const day = only(run([...asia(), ...london([[1.1004, 1.1005, 1.0960, 1.0965]])]));
  assert.equal(day.state, "BREAKOUT_ACCEPTED");
  assert.equal(day.accepted!.reason, "distance");
}

{
  // Closes sitting exactly on the level are neither inside nor outside; the
  // reclaim window runs out.
  const day = only(run([
    ...asia(),
    ...london([
      [1.1004, 1.1005, 1.0996, 1.1000],
      [1.1000, 1.1002, 1.0997, 1.1000],
      [1.1000, 1.1002, 1.0997, 1.1000],
      [1.1000, 1.1002, 1.0997, 1.1000],
      [1.1000, 1.1002, 1.0997, 1.1000],
    ]),
  ]));
  assert.equal(day.state, "BREAKOUT_ACCEPTED");
  assert.equal(day.accepted!.reason, "timeout");
  assert.equal(day.accepted!.time, at(DAY, 8, 15), "four candles after the sweep candle");
}

// ---- Wick sweep + reclaim in one candle -------------------------------------

{
  const day = only(run([
    ...asia(),
    ...london([
      [1.1003, 1.1005, 1.0996, 1.1004], // wick to 1.0996, closes inside, 1-pip body
      [1.1004, 1.1006, 1.1002, 1.1005],
      [1.1005, 1.1016, 1.1004, 1.1015], // 10-pip bullish body
    ]),
  ]));
  assert.equal(day.sweeps[0]!.barsToReclaim, 0, "swept and reclaimed by the same candle's close");
  assert.equal(day.sweeps[0]!.outsideCloses, 0);
  assert.equal(day.distribution!.direction, "long");
  assert.equal(day.distribution!.barTime, at(DAY, 7, 30));
  const steps = day.transitions.filter((t) => t.barTime === at(DAY, 7)).map((t) => t.to);
  assert.deepEqual(steps, ["SWEEP_CANDIDATE", "RECLAIM_CONFIRMED", "WAITING_FOR_DISPLACEMENT"]);
}

{
  // A wick reclaim is not a reclaim: closed below, wick back above.
  const day = only(run([...asia(), ...london([[1.1004, 1.1005, 1.0996, 1.0998], [1.0998, 1.1004, 1.0995, 1.0997]])]));
  assert.equal(day.state, "BREAKOUT_ACCEPTED", "a wick back above the low does not reclaim it");
}

// ---- Reclaim without displacement ------------------------------------------

{
  const rows: Array<[number, number, number, number]> = [
    [1.1004, 1.1005, 1.0996, 1.0998],
    [1.0998, 1.1003, 1.0997, 1.1001], // reclaim, 3-pip body
    [1.1001, 1.1003, 1.1000, 1.1002],
    [1.1002, 1.1003, 1.1001, 1.1001],
    [1.1001, 1.1003, 1.1000, 1.1002],
    [1.1002, 1.1003, 1.1001, 1.1002], // 4th candle after the reclaim: timeout
  ];
  const partial = only(run([...asia(), ...london(rows.slice(0, 3))]));
  assert.equal(partial.state, "WAITING_FOR_DISPLACEMENT");
  const day = only(run([...asia(), ...london(rows)]));
  assert.equal(day.state, "WAITING_FOR_SWEEP", "no displacement in time: the attempt lapses and London is watched again");
  assert.equal(day.sweeps[0]!.status, "no-displacement");
  assert.equal(day.distribution, null);
  assert.ok(day.reclaimOutcome, "the reclaim is still measured for analytics");
  const full = only(run([...asia(), ...london(rows), ...quiet(18, DAY, 7 * 60 + rows.length * 15)]));
  assert.equal(full.state, "EXPIRED", "London closed with no valid sequence");

  // The same candles in CLOSE mode: the reclaim close completes it.
  const closeMode = only(run([...asia(), ...london(rows)], { reclaimMode: "CLOSE" }));
  assert.equal(closeMode.state, "DISTRIBUTION_CONFIRMED");
  assert.equal(closeMode.distribution!.barTime, at(DAY, 7, 15));
  assert.ok(!path(closeMode).includes("WAITING_FOR_DISPLACEMENT"));
}

{
  // Reclaimed, then closed back below before displacing: a new sweep of the
  // same side, which here is accepted.
  const day = only(run([
    ...asia(),
    ...london([
      [1.1004, 1.1005, 1.0996, 1.0998],
      [1.0998, 1.1003, 1.0997, 1.1001],
      [1.1001, 1.1002, 1.0993, 1.0995],
      [1.0995, 1.0996, 1.0988, 1.0990],
    ]),
  ]));
  assert.deepEqual(day.sweeps.map((s) => s.status), ["re-broken", "accepted"]);
  assert.equal(day.state, "BREAKOUT_ACCEPTED");
}

// ---- Double sweep ------------------------------------------------------------

{
  const day = only(run([
    ...asia(),
    ...london([
      [1.1004, 1.1005, 1.0996, 1.1002], // low swept and reclaimed (long candidate), small body
      [1.1003, 1.1006, 1.1001, 1.1004], // 1-pip body: no displacement yet
      [1.1005, 1.1024, 1.1004, 1.1006], // wick above the high, 1-pip body: no long displacement
      [1.1009, 1.1010, 1.1001, 1.1002], // 7-pip bearish body
    ]),
  ]));
  assert.equal(day.doubleSweep, true);
  assert.equal(day.sweeps.length, 2, "the first sweep is kept, not overwritten");
  const [first, second] = day.sweeps;
  assert.equal(first!.side, "low");
  assert.equal(first!.startTime, at(DAY, 7));
  assert.equal(first!.status, "superseded");
  assert.ok(Math.abs(first!.depthPips - 4) < 1e-6);
  assert.equal(second!.side, "high");
  assert.equal(second!.startTime, at(DAY, 7, 30));
  assert.equal(second!.barsToReclaim, 0);
  assert.ok(Math.abs(second!.depthPips - 4) < 1e-6);
  assert.equal(day.distribution!.direction, "short", "direction from the side that completed reclaim + displacement");
  assert.equal(day.distribution!.stop, 1.1024);
  assert.ok(day.transitions.some((t) => t.note.startsWith("DOUBLE_SWEEP")));
}

{
  // Both sides swept but neither completes: direction is never assumed.
  const day = only(run([
    ...asia(),
    ...london([
      [1.1004, 1.1005, 1.0996, 1.1002],
      [1.1019, 1.1024, 1.1016, 1.1018], // other side, back below, 1-pip body: no displacement either way
      [1.1018, 1.1019, 1.1016, 1.1017],
      [1.1017, 1.1018, 1.1015, 1.1016],
      [1.1016, 1.1018, 1.1015, 1.1017],
      [1.1017, 1.1018, 1.1015, 1.1016],
    ]),
    ...quiet(18, DAY, 7 * 60 + 6 * 15),
  ]));
  assert.equal(day.doubleSweep, true);
  assert.equal(day.distribution, null, "the second sweep does not decide direction by itself");
  assert.equal(day.state, "EXPIRED");
}

// ---- No-sweep day -------------------------------------------------------------

{
  const day = only(run([...asia(), ...quiet(24)]));
  assert.equal(day.state, "NO_SWEEP");
  assert.equal(day.transitions.at(-1)!.time, at(DAY, 13), "known when the 12:45 candle closes");
  assert.equal(day.sweeps.length, 0);
  // A break after London is not a sweep.
  const late = only(run([...asia(), ...quiet(24), ...london([[1.1004, 1.1005, 1.0980, 1.0985]], DAY, 13 * 60)]));
  assert.equal(late.state, "NO_SWEEP");
  assert.equal(late.sweeps.length, 0);
}

// ---- News and volatility are flags, never filters -------------------------------

{
  const candles = [...asia(), ...london([[1.1006, 1.1008, 1.0995, 1.0997], [1.0999, 1.1003, 1.0994, 1.1002], [1.1002, 1.1012, 1.1001, 1.1011]])];
  const withNews = only(computeAmdDays(candles, "EUR_USD", { news: [{ time: Date.parse(at(DAY, 7, 10)), currency: "USD" }] }));
  assert.equal(withNews.newsNearby, true);
  assert.equal(withNews.state, "DISTRIBUTION_CONFIRMED", "news flags the day; it does not drop it");
  const otherCurrency = only(computeAmdDays(candles, "EUR_USD", { news: [{ time: Date.parse(at(DAY, 7, 10)), currency: "JPY" }] }));
  assert.equal(otherCurrency.newsNearby, false);
  assert.equal(only(run(candles)).newsNearby, null, "unknown without a calendar");

  const spike = only(run([...asia(), ...london([[1.1006, 1.1008, 1.0940, 1.1004]])]));
  assert.equal(spike.abnormalVolatility, true);
  assert.ok(spike.maxRangeAtr > 3);
}

// ---- No lookahead: a replay cut at any candle equals the live view ---------------

/** Seeded random walk over several weeks of M15 candles. */
function randomCandles(seed: number, days: number): Candle[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: Candle[] = [];
  let price = 1.1;
  const start = Date.parse("2026-02-02T00:00:00Z");
  for (let i = 0; i < days * 96; i += 1) {
    const ms = start + i * 15 * 60_000;
    const dow = new Date(ms).getUTCDay();
    if (dow === 6 || dow === 0) continue;
    const hour = new Date(ms).getUTCHours();
    const vol = (hour < 7 ? 2 : 6) * P;
    const open = price;
    const close = open + (rand() - 0.5) * 2 * vol;
    const high = Math.max(open, close) + rand() * vol;
    const low = Math.min(open, close) - rand() * vol;
    price = close;
    out.push(c(new Date(ms).toISOString(), open, high, low, close));
  }
  return out;
}

/** Everything known at a cut must survive, unchanged, into every later view. */
function assertStable(earlier: AmdDay[], later: AmdDay[], label: string) {
  for (const before of earlier) {
    const after = later.find((day) => day.day === before.day);
    assert.ok(after, `${label}: day ${before.day} disappeared`);
    assert.deepEqual(after!.transitions.slice(0, before.transitions.length), before.transitions, `${label}: ${before.day} transitions rewritten`);
    if (before.locked) {
      assert.equal(after!.asiaHigh, before.asiaHigh, `${label}: Asia high moved`);
      assert.equal(after!.asiaLow, before.asiaLow, `${label}: Asia low moved`);
      assert.equal(after!.asiaMidpoint, before.asiaMidpoint);
      assert.equal(after!.asiaStart, before.asiaStart, `${label}: Asia box resized`);
    }
    before.sweeps.forEach((sweep, i) => {
      const same = after!.sweeps[i]!;
      assert.equal(same.side, sweep.side, `${label}: sweep side changed`);
      assert.equal(same.startTime, sweep.startTime, `${label}: sweep start moved`);
      if (sweep.reclaimTime) assert.equal(same.reclaimTime, sweep.reclaimTime, `${label}: reclaim moved`);
      if (sweep.status !== "candidate" && sweep.status !== "reclaimed") assert.equal(same.status, sweep.status, `${label}: resolved sweep relabelled`);
    });
    if (before.distribution) {
      for (const key of ["direction", "barTime", "time", "entry", "stop", "target", "riskPips"] as const) {
        assert.equal(after!.distribution![key], before.distribution[key], `${label}: distribution ${key} changed`);
      }
    }
    if (before.accepted) assert.deepEqual(after!.accepted, before.accepted, `${label}: acceptance changed`);
    if (["DISTRIBUTION_CONFIRMED", "BREAKOUT_ACCEPTED", "NO_SWEEP", "EXPIRED", "INVALID"].includes(before.state)) {
      assert.equal(after!.state, before.state, `${label}: terminal state ${before.state} changed`);
    }
  }
}

const seen = new Set<AmdState>();
for (const seed of [7, 11, 23, 101]) {
  const candles = randomCandles(seed, 42);
  const full = computeAmdDays(candles, "EUR_USD");
  const machine = new AsiaAmdMachine("EUR_USD");
  for (let n = 0; n < candles.length; n += 1) {
    machine.push(candles[n]!);
    const live = machine.snapshot();
    const closed = Date.parse(candles[n]!.time) + 15 * 60_000;
    for (const day of live) {
      seen.add(day.state);
      // The D box grows with the candles; it never reaches past the last one.
      if (day.distribution) assert.ok(Date.parse(day.distribution.endTime) <= closed, "D drawn ahead of the candles");
    }
    // The candle-by-candle view is identical to a fresh run on the cut series…
    if (n % 37 === 0) assert.deepEqual(computeAmdDays(candles.slice(0, n + 1), "EUR_USD"), live, `replay at ${n} differs from live`);
    // …and nothing it knew is rewritten by the candles still to come.
    assertStable(live, full, `seed ${seed} cut ${n}`);
  }

  // Changing the future changes nothing about the past.
  const cut = Math.floor(candles.length / 2);
  const altered = candles.map((candle, i) => (i <= cut ? candle : { ...candle, high: candle.high + 0.003, low: candle.low - 0.003 }));
  const a = computeAmdDays(candles.slice(0, cut + 1), "EUR_USD");
  assertStable(a, computeAmdDays(altered, "EUR_USD"), "altered future");
}
// EXPIRED, NO_SWEEP and INVALID are covered by the fixtures above (a random walk sweeps and displaces too easily).
for (const state of ["WAITING_FOR_DISPLACEMENT", "SWEEP_CANDIDATE", "DISTRIBUTION_CONFIRMED", "BREAKOUT_ACCEPTED"] as AmdState[]) {
  assert.ok(seen.has(state), `the random walks reach ${state} (saw ${[...seen].join(", ")})`);
}

console.log("asia AMD state machine tests passed");
