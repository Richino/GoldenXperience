import assert from "node:assert/strict";
import { evaluateConfirmation, planTimeframes, type Confirmation, type ConfirmationInput, type PlanForConfirmation } from "../src/trade-plan-confirmation.js";
import type { Candle } from "../../frontend/src/types/forex.js";

/**
 * Confirmation engine on hand-built candles: every scenario is a short M15
 * sequence (H1 is aggregated from it), so each rule can be read off the
 * numbers. Asserts behaviour, not profitability.
 */

const M15 = 900_000;
/** Wednesday 2026-10-14 10:00 UTC: market open. */
const T0 = Date.parse("2026-10-14T10:00:00Z");
type Ohlc = [number, number, number, number];

function m15(rows: Ohlc[], start = T0, incompleteLast = false): Candle[] {
  return rows.map(([open, high, low, close], i) => ({
    time: new Date(start + i * M15).toISOString(), open, high, low, close, volume: 1,
    complete: !(incompleteLast && i === rows.length - 1),
  }));
}
/** H1 from complete groups of four M15 candles aligned to the hour. */
function h1(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const group = candles.slice(i, i + 4);
    if (Date.parse(group[0]!.time) % 3_600_000 !== 0 || group.some((c) => !c.complete)) continue;
    out.push({ time: group[0]!.time, open: group[0]!.open, close: group[3]!.close, high: Math.max(...group.map((c) => c.high)), low: Math.min(...group.map((c) => c.low)), volume: 4, complete: true });
  }
  return out;
}
const after = (candles: Candle[]) => Date.parse(candles.at(-1)!.time) + M15 + 1000;

const limits = { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 };
const breakoutPlan: PlanForConfirmation = {
  instrument: "EUR_USD", direction: "BUY", setupType: "BREAKOUT_RETEST",
  entryZoneLow: 1.0997, entryZoneHigh: 1.1003, stopLoss: 1.0985, takeProfit: 1.105,
  createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 48 * 3_600_000).toISOString(),
  plan: {
    breakoutLevel: 1.1, breakoutAlreadyClosed: false,
    invalidation: { failLevel: 1.09975, zoneFarEdge: 1.099 },
    rules: { atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, breakoutCloseH1Atr: 0.25, retestToleranceH1Atr: 0.3, retestFailH1Atr: 0.25 },
  },
};
const BREAKOUT: Ohlc[] = [
  [1.0995, 1.0998, 1.0994, 1.0997],
  [1.0997, 1.1001, 1.0996, 1.1],
  [1.1, 1.1003, 1.0999, 1.1002],
  [1.1002, 1.1006, 1.1001, 1.1004], // H1 closes 1.1004 > 1.10025
];
const RETEST: Ohlc[] = [
  [1.1004, 1.1006, 1.1001, 1.1002], // retest: low 1.1001 within 0.3 ATR of 1.1000
  [1.1002, 1.1004, 1.1, 1.1003], // deeper retest, high 1.1004
];
const CONTINUATION: Ohlc = [1.1003, 1.1009, 1.1002, 1.1008]; // closes above 1.1004

function run(plan: PlanForConfirmation, rows: Ohlc[], patch: Partial<ConfirmationInput> = {}, incompleteLast = false): Confirmation {
  const candles = m15(rows, T0, incompleteLast);
  const now = patch.now ?? after(candles);
  return evaluateConfirmation({
    plan,
    candles: { H1: h1(candles), M15: candles },
    quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 1000).toISOString() },
    news: [],
    now,
    limits,
    ...patch,
  });
}
const condition = (result: Confirmation, key: string) => result.conditions.find((item) => item.key === key)!;

/** Reflect a scenario through 1.1 so a SELL plan sees the BUY scenario's mirror image. */
const M = 2.2;
const mirrorRows = (rows: Ohlc[]): Ohlc[] => rows.map(([o, h, l, c]) => [M - o, M - l, M - h, M - c]);
function mirrorPlan(plan: PlanForConfirmation): PlanForConfirmation {
  const inv = plan.plan.invalidation as Record<string, number>;
  const zone = plan.plan.zone as Record<string, number> | undefined;
  return {
    ...plan,
    direction: "SELL",
    entryZoneLow: M - plan.entryZoneHigh, entryZoneHigh: M - plan.entryZoneLow,
    stopLoss: M - plan.stopLoss, takeProfit: M - plan.takeProfit,
    plan: {
      ...plan.plan,
      ...(typeof plan.plan.breakoutLevel === "number" ? { breakoutLevel: M - plan.plan.breakoutLevel } : {}),
      ...(zone ? { zone: { low: M - zone.high, high: M - zone.low } } : {}),
      invalidation: Object.fromEntries(Object.entries(inv).map(([key, value]) => [key, M - value])),
    },
  };
}

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

// ── Breakout and retest ─────────────────────────────────────────────
test("breakout, retest, hold and continuation confirm", () => {
  const result = run(breakoutPlan, [...BREAKOUT, ...RETEST, CONTINUATION]);
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
  for (const item of result.conditions) assert.equal(item.status, "PASSED", item.key);
  assert.equal(result.proposal?.entry, 1.1009);
  assert.equal(result.proposal?.stopLoss, 1.0985);
  assert.ok((result.proposal?.rewardRisk ?? 0) >= 1.5);
  assert.deepEqual(result.events.map((event) => event.type), ["BREAKOUT_DETECTED", "RETEST_DETECTED", "CONDITIONS_MET", "SETUP_CONFIRMED"]);
});

test("a breakout without a retest stays unconfirmed", () => {
  const result = run(breakoutPlan, [...BREAKOUT, [1.1004, 1.1012, 1.1005, 1.1011], [1.1011, 1.1016, 1.101, 1.1015]]);
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.stage, "WAITING_FOR_RETEST");
  assert.equal(condition(result, "breakout_close").status, "PASSED");
  assert.equal(condition(result, "retest").status, "PENDING");
});

test("a false breakout invalidates the plan", () => {
  const result = run(breakoutPlan, [...BREAKOUT, [1.1004, 1.1005, 1.0995, 1.0996]]);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /breakout failed/);
});

test("a close above the level that is inside the noise threshold is not a breakout", () => {
  const result = run(breakoutPlan, [...BREAKOUT.slice(0, 3), [1.1002, 1.1003, 1.1001, 1.1002]]);
  assert.equal(result.stage, "WAITING_FOR_BREAKOUT");
  assert.equal(condition(result, "breakout_close").status, "PASSED");
  assert.equal(condition(result, "breakout_size").status, "PENDING");
});

test("an H1 close through the far side of the zone before a breakout invalidates", () => {
  const result = run(breakoutPlan, [[1.0995, 1.0996, 1.0988, 1.0989], [1.0989, 1.099, 1.0987, 1.0988], [1.0988, 1.0989, 1.0986, 1.0987], [1.0987, 1.0989, 1.0986, 1.0988]]);
  assert.equal(result.outcome, "INVALIDATED");
});

test("an incomplete candle cannot confirm", () => {
  const result = run(breakoutPlan, [...BREAKOUT, ...RETEST, CONTINUATION], {}, true);
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.stage, "WAITING_FOR_CONTINUATION");
  // Nor can a candle marked complete whose close time has not passed.
  const candles = m15([...BREAKOUT, ...RETEST, CONTINUATION]);
  const early = run(breakoutPlan, [...BREAKOUT, ...RETEST, CONTINUATION], { now: Date.parse(candles.at(-1)!.time) + 60_000 });
  assert.equal(early.stage, "WAITING_FOR_CONTINUATION");
});

test("a pre-plan breakout is not counted", () => {
  const plan = { ...breakoutPlan, createdAt: new Date(T0 + 4 * M15).toISOString() };
  const result = run(plan, [...BREAKOUT, ...RETEST, CONTINUATION]);
  assert.equal(result.stage, "WAITING_FOR_BREAKOUT");
});

test("a retest that trades through the approved stop invalidates", () => {
  const result = run(breakoutPlan, [...BREAKOUT, [1.1004, 1.1005, 1.0984, 1.1001]]);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /approved stop/);
});

test("price running too far before confirming is MISSED (never chased)", () => {
  const result = run({ ...breakoutPlan, takeProfit: 1.102 }, [...BREAKOUT, ...RETEST, CONTINUATION]);
  assert.equal(result.outcome, "MISSED");
  assert.equal(condition(result, "reward_risk").status, "FAILED");
});

test("news blackout blocks the order, not the confirmation (it stays confirmed)", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const now = after(m15(rows));
  const result = run(breakoutPlan, rows, { news: [{ title: "CPI", currency: "USD", impact: 3, timestamp: new Date(now + 10 * 60_000).toISOString() }] });
  assert.equal(result.outcome, "CONFIRMED", "confirmation is final; safety is reported separately");
  assert.equal(result.safety?.ok, false);
  assert.match(result.safety!.blocks.join(" "), /News blackout/);
  assert.equal(result.stage, "CONFIRMED_BLOCKED");
  assert.equal(condition(result, "execution_safety").status, "BLOCKED");
  assert.match(condition(result, "execution_safety").detail, /News blackout/);
  assert.ok(result.proposal, "the proposal is still shown");
  // Medium-impact news does not block.
  const medium = run(breakoutPlan, rows, { news: [{ title: "PMI", currency: "USD", impact: 2, timestamp: new Date(now + 10 * 60_000).toISOString() }] });
  assert.equal(medium.outcome, "CONFIRMED");
});

test("an excessive spread blocks", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const now = after(m15(rows));
  const result = run(breakoutPlan, rows, { quote: { bid: 1.1005, ask: 1.1011, time: new Date(now - 1000).toISOString() } });
  assert.equal(result.stage, "CONFIRMED_BLOCKED");
  assert.match(condition(result, "execution_safety").detail, /Spread/);
});

test("a stale quote, a missing quote or an unreadable calendar blocks", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const now = after(m15(rows));
  assert.match(condition(run(breakoutPlan, rows, { quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 60_000).toISOString() } }), "execution_safety").detail, /old/);
  assert.match(condition(run(breakoutPlan, rows, { quote: null }), "execution_safety").detail, /No live quote/);
  assert.match(condition(run(breakoutPlan, rows, { news: null }), "execution_safety").detail, /calendar/);
});

test("a confirmation still blocked after the approved entry window is MISSED", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const now = after(m15(rows)) + 61 * 60_000;
  const result = run(breakoutPlan, rows, { now, news: null, quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 1000).toISOString() } });
  assert.equal(result.outcome, "MISSED");
});

test("expiry wins over a late or unfinished sequence", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const expiresEarly = { ...breakoutPlan, expiresAt: new Date(T0 + 5 * M15).toISOString() };
  assert.equal(run(expiresEarly, rows).outcome, "EXPIRED");
  assert.equal(run(expiresEarly, BREAKOUT.concat(RETEST)).outcome, "EXPIRED");
});

test("re-evaluating the same history gives the same answer (restart-safe)", () => {
  const rows = [...BREAKOUT, ...RETEST];
  assert.deepEqual(run(breakoutPlan, rows), run(breakoutPlan, rows));
});

test("a SELL breakout is the exact mirror of the BUY", () => {
  const rows = [...BREAKOUT, ...RETEST, CONTINUATION];
  const now = after(m15(rows));
  const buy = run(breakoutPlan, rows);
  const sell = run(mirrorPlan(breakoutPlan), mirrorRows(rows), { quote: { bid: M - 1.1009, ask: M - 1.1008, time: new Date(now - 1000).toISOString() } });
  assert.equal(sell.outcome, "CONFIRMED", sell.notTriggeredReason ?? "");
  assert.deepEqual(sell.conditions.map((item) => item.status), buy.conditions.map((item) => item.status));
  assert.ok(Math.abs(sell.proposal!.entry - (M - buy.proposal!.entry)) < 1e-9);
  assert.equal(sell.proposal!.rewardRisk, buy.proposal!.rewardRisk);
  // And a mirrored false breakout fails the same way.
  assert.equal(run(mirrorPlan(breakoutPlan), mirrorRows([...BREAKOUT, [1.1004, 1.1005, 1.0995, 1.0996]])).outcome, "INVALIDATED");
});

// ── Support/resistance reversal ─────────────────────────────────────
const PRE: Ohlc[] = [ // eight candles before the plan, falling toward support
  [1.1016, 1.1017, 1.1013, 1.1014], [1.1014, 1.1015, 1.1011, 1.1012], [1.1012, 1.1013, 1.1009, 1.101], [1.101, 1.1012, 1.1008, 1.1009],
  [1.1009, 1.101, 1.1006, 1.1007], [1.1007, 1.1008, 1.1004, 1.1005], [1.1005, 1.1006, 1.1002, 1.1003], [1.1003, 1.1004, 1.1001, 1.1002],
];
const reversalPlan: PlanForConfirmation = {
  instrument: "EUR_USD", direction: "BUY", setupType: "SR_REVERSAL",
  entryZoneLow: 1.099, entryZoneHigh: 1.1, stopLoss: 1.0982, takeProfit: 1.108,
  createdAt: new Date(T0 + 8 * M15).toISOString(), expiresAt: new Date(T0 + 24 * 3_600_000).toISOString(),
  plan: {
    zone: { low: 1.099, high: 1.1 },
    invalidation: { failLevel: 1.09875, sweepLimit: 1.0984 },
    rules: { atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, reclaimBars: 3, rejectionWickShare: 0.5, structureLookbackBars: 8, structureBreakBars: 16 },
  },
};
const SWEEP: Ohlc[] = [
  [1.1002, 1.1003, 1.0996, 1.0997], // approach
  [1.0997, 1.0998, 1.0986, 1.0993], // sweeps below 1.0990, closes back inside
];
const BREAK: Ohlc[] = [[1.0993, 1.1002, 1.0992, 1.1001], [1.1001, 1.1008, 1.1, 1.1007], [1.1007, 1.1017, 1.1006, 1.1016]]; // last close > pivot 1.1015 (highest high of the 8 candles before the sweep)
const reversalQuote = (rows: Ohlc[]) => ({ bid: 1.1016, ask: 1.1017, time: new Date(after(m15(rows)) - 1000).toISOString() });
const runReversal = (rows: Ohlc[], patch: Partial<ConfirmationInput> = {}, plan = reversalPlan) =>
  run(plan, rows, { quote: reversalQuote(rows), ...patch });

test("sweep, reclaim and an M15 structure break confirm", () => {
  const rows = [...PRE, ...SWEEP, ...BREAK];
  const result = runReversal(rows);
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
  for (const item of result.conditions) assert.equal(item.status, "PASSED", item.key);
  assert.ok(result.events.some((event) => event.type === "SWEEP_DETECTED"));
});

test("a liquidity sweep alone never triggers", () => {
  const rows: Ohlc[] = [...PRE, SWEEP[0]!, [1.0997, 1.0998, 1.0986, 1.0988]]; // closes below the zone
  const result = runReversal(rows);
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.stage, "WAITING_FOR_RECLAIM");
  assert.equal(condition(result, "reclaim").status, "PENDING");
  // Even a reclaim without the structure break is not enough.
  const reclaimed = runReversal([...PRE, ...SWEEP]);
  assert.equal(reclaimed.stage, "WAITING_FOR_STRUCTURE");
});

test("a rejection without a sweep confirms after the structure break", () => {
  const rows: Ohlc[] = [...PRE, [1.1002, 1.1003, 1.0996, 1.0997], [1.0997, 1.1001, 1.0991, 1.0999], ...BREAK];
  const result = runReversal(rows);
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
  assert.match(condition(result, "reclaim").detail, /No sweep/);
});

test("a sweep past the allowed depth invalidates", () => {
  const result = runReversal([...PRE, SWEEP[0]!, [1.0997, 1.0998, 1.0983, 1.0991]]);
  assert.equal(result.outcome, "INVALIDATED");
});

test("a close through the zone invalidates", () => {
  const result = runReversal([...PRE, SWEEP[0]!, [1.0997, 1.0998, 1.0985, 1.0986]]);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /gave way/);
});

test("price above the zone is still waiting for the approach", () => {
  const result = runReversal([...PRE]);
  assert.equal(result.stage, "WAITING_FOR_ZONE");
});

test("a turn that never breaks structure is dropped", () => {
  const flat: Ohlc[] = Array.from({ length: 18 }, () => [1.0995, 1.0999, 1.0994, 1.0996]);
  const result = runReversal([...PRE, ...SWEEP, ...flat]);
  assert.equal(result.outcome, "WAITING");
  assert.notEqual(result.stage, "WAITING_FOR_STRUCTURE");
});

test("Test 10 — attempts are bounded: with one approved attempt, a turn that never breaks structure ends the plan", () => {
  const flat: Ohlc[] = Array.from({ length: 18 }, () => [1.0995, 1.0999, 1.0994, 1.0996]);
  const bounded = { ...reversalPlan, plan: { ...reversalPlan.plan, rules: { ...(reversalPlan.plan.rules as object), maxAttempts: 1 } } };
  const result = runReversal([...PRE, ...SWEEP, ...flat], {}, bounded);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /approved attempts failed/);
  assert.equal(result.progress.attempt, 1);
  assert.equal(result.progress.maxAttempts, 1);
  // Two approved attempts: the first failure is reported and watching continues.
  const two = runReversal([...PRE, ...SWEEP, ...flat], {}, { ...bounded, plan: { ...bounded.plan, rules: { ...(bounded.plan.rules as object), maxAttempts: 2 } } });
  assert.equal(two.outcome, "WAITING");
  assert.ok(two.events.some((event) => event.type === "ATTEMPT_FAILED"));
});

test("a SELL reversal is the exact mirror of the BUY", () => {
  const rows = [...PRE, ...SWEEP, ...BREAK];
  const buy = runReversal(rows);
  const q = reversalQuote(rows);
  const sell = runReversal(mirrorRows(rows), { quote: { bid: M - q.ask, ask: M - q.bid, time: q.time } }, mirrorPlan(reversalPlan));
  assert.equal(sell.outcome, "CONFIRMED", sell.notTriggeredReason ?? "");
  assert.deepEqual(sell.conditions.map((item) => item.status), buy.conditions.map((item) => item.status));
  assert.equal(sell.proposal!.rewardRisk, buy.proposal!.rewardRisk);
});

test("a plan with no frozen ATR is refused rather than guessed", () => {
  const result = run({ ...breakoutPlan, plan: { ...breakoutPlan.plan, rules: {} } }, [...BREAKOUT]);
  assert.equal(result.outcome, "INVALIDATED");
});

// ── Swing plans: H4 breakout candles, H1 retest/continuation, H4 ATR ──
const H1 = 3_600_000;
/** 08:00 UTC Wednesday: an H4 boundary, market open. */
const S0 = Date.parse("2026-10-14T08:00:00Z");
function hourly(rows: Ohlc[], incompleteLast = false): Candle[] {
  return rows.map(([open, high, low, close], i) => ({
    time: new Date(S0 + i * H1).toISOString(), open, high, low, close, volume: 1, complete: !(incompleteLast && i === rows.length - 1),
  }));
}
function fourHourly(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const group = candles.slice(i, i + 4);
    if (group.some((c) => !c.complete)) continue;
    out.push({ time: group[0]!.time, open: group[0]!.open, close: group[3]!.close, high: Math.max(...group.map((c) => c.high)), low: Math.min(...group.map((c) => c.low)), volume: 4, complete: true });
  }
  return out;
}
const swingPlan: PlanForConfirmation = {
  ...breakoutPlan,
  createdAt: new Date(S0).toISOString(),
  expiresAt: new Date(S0 + 72 * H1).toISOString(),
  plan: {
    ...breakoutPlan.plan,
    rules: { atr: 0.001, atrTimeframe: "H4", minRewardRisk: 1.5, confirmationValidMinutes: 240, breakoutTimeframe: "H4", breakoutCloseAtr: 0.25, retestTimeframe: "H1", retestToleranceAtr: 0.3, retestFailAtr: 0.3 },
  },
};
function runSwing(rows: Ohlc[], patch: Partial<ConfirmationInput> = {}, incompleteLast = false): Confirmation {
  const h1 = hourly(rows, incompleteLast);
  const now = patch.now ?? Date.parse(h1.at(-1)!.time) + H1 + 1000;
  return evaluateConfirmation({
    plan: swingPlan,
    candles: { H4: fourHourly(h1), H1: h1 },
    quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 1000).toISOString() },
    news: [], now, limits, ...patch,
  });
}

test("swing: an H4 close breaks out, then an H1 retest and continuation confirm", () => {
  const result = runSwing([...BREAKOUT, ...RETEST, CONTINUATION]);
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
  assert.match(condition(result, "breakout_close").detail, /^H4 closed at/);
  assert.match(condition(result, "continuation").detail, /^H1 closed at/);
  assert.ok(result.evaluatedThrough.H4 && result.evaluatedThrough.H1);
});

test("swing: hourly closes above the level are not a breakout until the H4 candle closes", () => {
  const result = runSwing(BREAKOUT.slice(0, 3));
  assert.equal(result.stage, "WAITING_FOR_BREAKOUT");
  assert.match(result.notTriggeredReason ?? "", /H4 close/);
});

test("swing: an H1 close back through the fail level after the H4 breakout fails it", () => {
  const result = runSwing([...BREAKOUT, [1.1004, 1.1005, 1.0995, 1.0996]]);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /^H1 closed at/);
});

test("each plan names the candles it is judged on", () => {
  assert.deepEqual(planTimeframes(swingPlan), ["H4", "H1"]);
  assert.deepEqual(planTimeframes(breakoutPlan), ["H1", "M15"], "plans made before swing mode keep H1/M15");
  assert.deepEqual(planTimeframes({ ...reversalPlan, plan: { ...reversalPlan.plan, rules: { confirmTimeframe: "H1" } } }), ["H1"]);
  assert.deepEqual(planTimeframes(reversalPlan), ["M15"]);
});

test("future breakout scenarios wait for approach; legacy approved rules stay unchanged", () => {
  const farBelow: Ohlc[] = Array.from({ length: 4 }, () => [1.097, 1.0974, 1.0968, 1.0972]);
  const conditional = { ...breakoutPlan, plan: { ...breakoutPlan.plan, rules: { ...(breakoutPlan.plan.rules as object), waitForApproach: true } } };
  assert.equal(run(conditional, farBelow).outcome, "WAITING", "being below future resistance is not a failed breakout");
  assert.equal(run(breakoutPlan, farBelow).outcome, "INVALIDATED", "older approvals retain their frozen rule");
  const failedApproach: Ohlc[] = [[1.0991, 1.0994, 1.0986, 1.0988], [1.0988, 1.0989, 1.0985, 1.0987], [1.0987, 1.0988, 1.0985, 1.0986], [1.0986, 1.0987, 1.0984, 1.0985]];
  assert.equal(run(conditional, failedApproach).outcome, "INVALIDATED", "a failed approach still ends this side");
});

test("a visible conditional scenario cannot confirm below its frozen reward/risk threshold", () => {
  const blocked = { ...breakoutPlan, plan: { ...breakoutPlan.plan, entryReadiness: { status: "WAITING_FOR_RISK_REWARD" }, rules: { ...(breakoutPlan.plan.rules as object), minRewardRisk: 50 } } };
  const result = run(blocked, [...BREAKOUT, ...RETEST, CONTINUATION]);
  assert.notEqual(result.outcome, "CONFIRMED");
  assert.equal(result.proposal, null);
});

console.log(`trade plan confirmation: ${passed} checks passed`);
