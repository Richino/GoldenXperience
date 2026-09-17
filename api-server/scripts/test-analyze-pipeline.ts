/**
 * Stage 7 deterministic test suite for the Analyze pipeline (Stages 1–6).
 *
 * Uses fixed candle fixtures — no network, no OANDA, no randomness. Run with:
 *   npm run analyze:test
 * It asserts BEHAVIOUR (labels + numbers), not profitability.
 */
import assert from "node:assert/strict";
import { assessMarketCondition } from "../../frontend/src/lib/strategy/market-condition.js";
import { analyzeSrStructure, classifyRangeWidth } from "../../frontend/src/lib/strategy/sr-structure.js";
import { analyzePriceReaction, detectImpulse } from "../../frontend/src/lib/strategy/price-reaction.js";
import { buildTradeProposal, validateProposal, type TradeProposal } from "../../frontend/src/lib/strategy/trade-proposal.js";
import { monitorTrade, freezeTradeContext } from "../../frontend/src/lib/strategy/trade-monitor.js";
import { profileFor } from "../../frontend/src/lib/strategy/timeframe-profiles.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const PIP = 0.0001;
let clock = Date.parse("2026-09-16T00:00:00Z");
function bar(o: number, h: number, l: number, c: number): Candle {
  clock += 15 * 60 * 1000;
  return { time: new Date(clock).toISOString(), open: o, high: h, low: l, close: c, volume: 100, complete: true };
}
function leg(from: number, to: number, steps: number, out: Candle[], wick = 1.5): number {
  let prev = from;
  for (let i = 1; i <= steps; i += 1) {
    const c = from + ((to - from) * i) / steps;
    out.push(bar(prev, Math.max(prev, c) + wick * PIP, Math.min(prev, c) - wick * PIP, c));
    prev = c;
  }
  return prev;
}
/** Reflect candles about a center price → turns a long setup into its short mirror. */
function mirror(candles: Candle[], center: number): Candle[] {
  return candles.map((k) => ({
    ...k,
    open: 2 * center - k.open,
    close: 2 * center - k.close,
    high: 2 * center - k.low,
    low: 2 * center - k.high,
  }));
}
const INS = "EUR_USD";
const P15 = profileFor("M15");
const assess = (candles: Candle[], tf = "M15") => {
  const p = profileFor(tf);
  return assessMarketCondition({ candles, instrument: INS, timeframe: p.timeframe, windows: p.windows, thresholds: p.marketCondition });
};
const srOf = (candles: Candle[], tf = "M15") => {
  const p = profileFor(tf);
  return analyzeSrStructure({ candles, instrument: INS, timeframe: p.timeframe, migrationStepBars: p.migrationStepBars, thresholds: p.sr })!;
};
const reactOf = (candles: Candle[], tf = "M15") =>
  analyzePriceReaction({ candles, instrument: INS, sr: srOf(candles, tf), thresholds: profileFor(tf).reaction });
const proposeOf = (candles: Candle[], spreadPips: number, tf = "M15"): TradeProposal => {
  const p = profileFor(tf);
  const assessment = assess(candles, tf);
  const sr = srOf(candles, tf);
  const reaction = analyzePriceReaction({ candles, instrument: INS, sr, thresholds: p.reaction });
  const mid = candles.at(-1)!.close;
  const half = (spreadPips * PIP) / 2;
  return buildTradeProposal({ instrument: INS, candles, quote: { bid: mid - half, ask: mid + half, mid }, assessment, sr, reaction, timeframe: p.timeframe, thresholds: p.proposal });
};

// ---- Fixtures ----
const uptrend = Array.from({ length: 16 }, (_, i) => 1.1 + i * 4 * PIP).reduce<Candle[]>((o, c, i, a) => { o.push(bar(i ? a[i - 1]! : c - 3 * PIP, c + 1 * PIP, (i ? a[i - 1]! : c) - 1 * PIP, c)); return o; }, []);
const downtrend = Array.from({ length: 16 }, (_, i) => 1.1 - i * 4 * PIP).reduce<Candle[]>((o, c, i, a) => { o.push(bar(i ? a[i - 1]! : c + 3 * PIP, (i ? a[i - 1]! : c) + 1 * PIP, c - 1 * PIP, c)); return o; }, []);
function structuredRange(): Candle[] {
  const b = 1.1; const o: Candle[] = [];
  const path = [b, b + 18 * PIP, b, b + 18 * PIP, b, b + 18 * PIP, b, b + 18 * PIP];
  let px = path[0]!;
  for (let i = 1; i < path.length; i += 1) px = leg(px, path[i]!, 3, o, 2);
  return o;
}
function messyChop(): Candle[] {
  const b = 1.1; const o: Candle[] = [];
  for (let i = 0; i < 20; i += 1) { const up = i % 2 === 0; const op = b + (up ? -1 : 1) * PIP; const cl = b + (up ? 1 : -1) * PIP; o.push(bar(op, Math.max(op, cl) + 7 * PIP, Math.min(op, cl) - 7 * PIP, cl)); }
  return o;
}
function bearishImpulse(): Candle[] { const o: Candle[] = []; leg(1.1, 1.1 - 20 * PIP, 5, o, 1); return o; }
/** Support fakeout + reclaim range with an internal resistance swing (long setup). */
function supportFakeout(): Candle[] {
  const o: Candle[] = []; const S = 1.1; let px = S + 30 * PIP;
  px = leg(px, px, 20, o); px = leg(px, S + 2 * PIP, 8, o); px = leg(px, S + 45 * PIP, 8, o);
  px = leg(px, S + 10 * PIP, 8, o); px = leg(px, S + 45 * PIP, 8, o); px = leg(px, S + 4 * PIP, 8, o);
  o.push(bar(S + 4 * PIP, S + 5 * PIP, S - 3 * PIP, S + 1 * PIP));
  o.push(bar(S + 1 * PIP, S + 11 * PIP, S - 1 * PIP, S + 9 * PIP));
  return o;
}
function acceptedBreakdown(): Candle[] {
  const o: Candle[] = []; const S = 1.1; let px = S + 30 * PIP;
  px = leg(px, px, 24, o); px = leg(px, S + 2 * PIP, 10, o);
  o.push(bar(S, S + 1 * PIP, S - 16 * PIP, S - 14 * PIP));
  o.push(bar(S - 14 * PIP, S - 13 * PIP, S - 28 * PIP, S - 26 * PIP));
  o.push(bar(S - 26 * PIP, S - 25 * PIP, S - 40 * PIP, S - 38 * PIP));
  o.push(bar(S - 38 * PIP, S - 37 * PIP, S - 48 * PIP, S - 44 * PIP));
  return o;
}

// ---- Runner ----
let pass = 0; const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(`${name}: ${(error as Error).message}`); console.log(`  FAIL  ${name}: ${(error as Error).message}`); }
}

console.log("Stage 1 — market condition");
check("bullish trend", () => assert.equal(assess(uptrend).condition, "TRENDING_BULLISH"));
check("bearish trend", () => assert.equal(assess(downtrend).condition, "TRENDING_BEARISH"));
check("structured range", () => assert.equal(assess(structuredRange()).condition, "STRUCTURED_RANGE"));
check("messy chop", () => { const a = assess(messyChop()); assert.equal(a.condition, "MESSY_CHOP"); assert.equal(a.gate, "WAIT"); });
check("structured != messy (overlap gap)", () => {
  assert.ok(assess(messyChop()).debug.candleOverlap > assess(structuredRange()).debug.candleOverlap);
});

console.log("Stage 3 — price action");
check("bearish impulse", () => assert.equal(detectImpulse(bearishImpulse(), 0.0005, PIP).direction, "BEARISH_IMPULSE"));
check("no impulse on chop", () => assert.equal(detectImpulse(messyChop(), 0.0007, PIP).direction, "NO_IMPULSE"));
check("support fakeout + reclaim", () => {
  const r = reactOf(supportFakeout());
  assert.equal(r.support.fakeout, "SUPPORT_FALSE_BREAK");
  assert.equal(r.support.reclaimed, true);
  assert.equal(r.confirmationState, "ENTER_CONDITION_MET");
});
check("resistance fakeout + reclaim (mirror)", () => {
  const r = reactOf(mirror(supportFakeout(), 1.1));
  assert.equal(r.resistance.fakeout, "RESISTANCE_FALSE_BREAK");
  assert.equal(r.confirmationState, "ENTER_CONDITION_MET");
});
check("accepted support breakdown", () => {
  const r = reactOf(acceptedBreakdown());
  assert.equal(r.support.acceptanceState, "ACCEPTED");
  assert.equal(r.confirmationState, "INVALIDATED");
});
check("small wick is not acceptance", () => {
  const r = reactOf(supportFakeout());
  assert.notEqual(r.support.acceptanceState, "ACCEPTED");
});

console.log("Stage 4 — proposals");
check("LONG proposal (structural)", () => {
  const p = proposeOf(supportFakeout(), 1);
  assert.equal(p.action, "LONG"); assert.equal(p.status, "READY");
  assert.ok(p.stopLoss! < p.structuralExtreme!, "SL below fakeout extreme");
  assert.ok(p.takeProfit! > p.entryPrice! && p.stopLoss! < p.entryPrice!, "geometry");
  assert.equal(p.targetType, "RESISTANCE_SWING");
});
check("SHORT proposal (mirror)", () => {
  const p = proposeOf(mirror(supportFakeout(), 1.1), 1);
  assert.equal(p.action, "SHORT"); assert.equal(p.status, "READY");
  assert.ok(p.takeProfit! < p.entryPrice! && p.stopLoss! > p.entryPrice!, "geometry");
});
check("R:R is mathematically correct", () => {
  const p = proposeOf(supportFakeout(), 1);
  assert.ok(Math.abs(p.rewardPips! / p.riskPips! - p.riskReward!) <= 0.05);
});
check("NO_TRADE on accepted breakdown", () => assert.equal(proposeOf(acceptedBreakdown(), 1).action, "NO_TRADE"));
check("WAIT mid-range (no interaction)", () => {
  const o: Candle[] = []; let px = leg(1.1, 1.1, 20, o); px = leg(px, 1.104, 8, o); leg(px, 1.102, 8, o);
  assert.equal(proposeOf(o, 1).action, "WAIT");
});
check("spread rejection", () => assert.equal(proposeOf(supportFakeout(), 9).action, "NO_TRADE"));
check("does not fudge SL/TP for R:R (structure fixed)", () => {
  const a = proposeOf(supportFakeout(), 1); const b = proposeOf(supportFakeout(), 1);
  assert.equal(a.stopLoss, b.stopLoss); assert.equal(a.takeProfit, b.takeProfit);
});

console.log("Stage 2 / 6 — ranges & timeframe");
check("range class boundaries", () => {
  assert.equal(classifyRangeWidth(1.0), "TOO_TIGHT");
  assert.equal(classifyRangeWidth(2.0), "TIGHT");
  assert.equal(classifyRangeWidth(4.0), "NORMAL");
  assert.equal(classifyRangeWidth(7.0), "WIDE");
  assert.equal(classifyRangeWidth(12.0), "EXTREME");
});
check("wide range prefers swing target (not outer)", () => {
  const p = proposeOf(supportFakeout(), 1);
  assert.equal(p.rangeWidthClass, "WIDE");
  assert.equal(p.targetType, "RESISTANCE_SWING");
});
check("timeframe isolation (sr + windows)", () => {
  assert.equal(srOf(supportFakeout(), "M5").timeframe, "M5");
  assert.deepEqual(assess(supportFakeout(), "M5").windowSizes, profileFor("M5").windows);
  assert.notDeepEqual(profileFor("M1").windows, profileFor("H1").windows);
});
check("proposal records analysisTimeframe", () => assert.equal(proposeOf(supportFakeout(), 1, "M5").analysisTimeframe, "M5"));

console.log("Stage 2 / 5 — frozen vs live + monitoring");
const entry = supportFakeout();
const frozenSr = srOf(entry);
const context = freezeTradeContext({
  instrument: INS, timeframe: "M15", direction: "long", entry: 1.1009, stopLoss: 1.0995, takeProfit: 1.10315,
  setupType: "SUPPORT_FALSE_BREAK_RECLAIM", marketConditionAtEntry: "STRUCTURED_RANGE", migrationAtEntry: frozenSr.overallMigration,
  frozen: frozenSr.frozen, reactionAtEntry: { interactionState: "RECLAIMED", fakeout: "SUPPORT_FALSE_BREAK", rejectionStrength: "STRONG", confirmation: "SUPPORT_RECLAIM_CONFIRMED", structureShift: "NONE" },
});
const monitorAt = (extra: Candle[]) => {
  const candles = [...entry, ...extra]; const mid = candles.at(-1)!.close;
  return monitorTrade({ context, candles, quote: { bid: mid - 0.00005, ask: mid + 0.00005, mid }, tradeId: "t1" });
};
check("frozen S/R stays frozen; live can differ", () => {
  const drop: Candle[] = []; leg(1.1009, 1.0985, 6, drop);
  const h = monitorAt(drop);
  assert.equal(h.debug.originalSupport, frozenSr.frozen.supportRange);
  assert.equal(context.frozen.supportRange, frozenSr.frozen.supportRange); // never mutated
});
check("HOLD when thesis intact", () => { const up: Candle[] = []; leg(1.1009, 1.1024, 6, up); assert.equal(monitorAt(up).status, "HOLD"); });
check("WARNING on new opposing resistance", () => {
  const o: Candle[] = [];
  let px = leg(1.1009, 1.103, 7, o);   // ascend to a peak ~1.1030 (new resistance)
  px = leg(px, 1.1018, 3, o); px = leg(px, 1.1026, 3, o); px = leg(px, 1.1018, 3, o);
  px = leg(px, 1.1024, 3, o); leg(px, 1.102, 2, o);       // fail under it repeatedly
  const h = monitorAt(o);
  assert.equal(h.status, "WARNING");
  assert.ok(h.events.some((e) => e.type === "NEW_RESISTANCE"), "expected NEW_RESISTANCE event");
});
check("EXIT_SUGGESTED on structure failure", () => {
  const brk: Candle[] = [];
  brk.push(bar(1.1009, 1.101, 1.0996, 1.0998)); brk.push(bar(1.0998, 1.0999, 1.0984, 1.0986));
  brk.push(bar(1.0986, 1.0987, 1.0972, 1.0976)); brk.push(bar(1.0976, 1.0978, 1.0968, 1.0972));
  const h = monitorAt(brk);
  assert.equal(h.status, "EXIT_SUGGESTED"); assert.equal(h.debug.structureFailed, true);
});
check("alert dedupe keys are stable", () => {
  const brk: Candle[] = []; brk.push(bar(1.1009, 1.101, 1.0996, 1.0998)); brk.push(bar(1.0998, 1.0999, 1.0984, 1.0986)); brk.push(bar(1.0986, 1.0987, 1.0972, 1.0976)); brk.push(bar(1.0976, 1.0978, 1.0968, 1.0972));
  const keys = monitorAt(brk).events.map((e) => e.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, "dedupe keys unique within a run");
});

console.log("Stage 8 — range planner (plan before confirmation)");
// Structured range that ENDS approaching a boundary, with NO fakeout/reclaim yet.
function rangeEndingAt(endPx: number): Candle[] {
  const S = 1.1, R = 1.104; const o: Candle[] = [];
  const path = [S, R, S, R, S, R, S, endPx];
  let px = path[0]!;
  // Finer legs → realistic average candle range (~4 pips) vs the 40-pip range.
  for (let i = 1; i < path.length; i += 1) px = leg(px, path[i]!, 10, o, 1.2);
  return o;
}
const nearResistance = () => rangeEndingAt(1.1038);   // just below R, approaching
const nearSupport = () => rangeEndingAt(1.1002);      // just above S
const slightlyAboveR = () => rangeEndingAt(1.1043);   // small penetration above R (not accepted)

check("near resistance → PLANNED_SHORT with full plan", () => {
  const p = proposeOf(nearResistance(), 1);
  assert.equal(p.action, "SHORT");
  assert.equal(p.status, "PLANNED");
  assert.ok(p.entryPrice !== null && p.stopLoss !== null && p.takeProfit !== null, "Entry/SL/TP present before confirmation");
  assert.ok(p.stopLoss! > p.entryPrice! && p.takeProfit! < p.entryPrice!, "SHORT geometry");
  assert.equal(p.setupFamily, "RESISTANCE_REVERSION");
});
check("near support → PLANNED_LONG with full plan", () => {
  const p = proposeOf(nearSupport(), 1);
  assert.equal(p.action, "LONG");
  assert.equal(p.status, "PLANNED");
  assert.ok(p.entryPrice !== null && p.stopLoss !== null && p.takeProfit !== null);
  assert.ok(p.stopLoss! < p.entryPrice! && p.takeProfit! > p.entryPrice!, "LONG geometry");
});
check("middle of range → WAIT (no manufactured trade)", () => {
  const p = proposeOf(rangeEndingAt(1.102), 1); // ends mid-range
  assert.equal(p.action, "WAIT"); assert.equal(p.status, "WAIT");
  assert.equal(p.entryPrice, null);
});
check("fakeout is NOT mandatory (rejection-less approach still plans)", () => {
  const p = proposeOf(nearResistance(), 1);
  assert.notEqual(p.action, "WAIT"); assert.equal(p.status, "PLANNED");
});
check("entry zone allows penetration beyond S/R (fakeout entry possible)", () => {
  const p = proposeOf(slightlyAboveR(), 1);
  assert.equal(p.action, "SHORT");
  // The SHORT entry zone extends ABOVE the boundary by the expected penetration,
  // so a slightly-above-resistance (fakeout) fill is structurally allowed.
  assert.ok(p.expectedPenetrationPips! > 0, "expected penetration computed");
  assert.ok(p.entryZoneHigh! > p.entryZoneLow!, "entry zone spans the boundary + penetration");
  assert.ok(p.preferredEntry! >= p.entryZoneLow! && p.preferredEntry! <= p.entryZoneHigh!, "preferred entry inside its zone");
});
check("resistance accepted breakout → INVALIDATED, never LONG", () => {
  const p = proposeOf(mirror(acceptedBreakdown(), 1.1), 1);
  assert.equal(p.status, "INVALIDATED");
  assert.notEqual(p.action, "LONG");
});
check("support accepted breakdown → INVALIDATED, never SHORT", () => {
  const p = proposeOf(acceptedBreakdown(), 1);
  assert.equal(p.status, "INVALIDATED");
  assert.notEqual(p.action, "SHORT");
});
check("confirmed fakeout+reclaim → READY (early confirmation)", () => {
  const p = proposeOf(supportFakeout(), 1);
  assert.equal(p.action, "LONG"); assert.equal(p.status, "READY");
});
check("SL has volatility breathing room (not unrealistically tight)", () => {
  const p = proposeOf(nearResistance(), 1);
  assert.ok(p.avgMovePips !== null && p.riskPips !== null);
  assert.ok(p.riskPips! > p.avgMovePips!, "SL distance exceeds one average candle");
  assert.ok(p.riskPips! >= p.avgMovePips! * 2, "SL distance is at least ~2x the average move");
});
check("R:R is an output; TP is structural and spread-independent", () => {
  const a = proposeOf(nearResistance(), 1);
  const b = proposeOf(nearResistance(), 3);
  assert.equal(a.takeProfit, b.takeProfit, "TP does not move with spread");
  assert.ok(Math.abs(a.rewardPips! / a.riskPips! - a.riskReward!) <= 0.05, "R:R = reward / risk");
});
check("trigger + invalidation strings are set", () => {
  const p = proposeOf(nearResistance(), 1);
  assert.match(p.trigger, /rejection|reclaim/i);
  assert.match(p.invalidation, /Accepted breakout/i);
});

console.log("Stage 7 — contradiction validator");
check("valid LONG has no violations", () => {
  const p = proposeOf(supportFakeout(), 1);
  const v = validateProposal(p, srOf(supportFakeout()), reactOf(supportFakeout()));
  assert.equal(v.length, 0, v.map((x) => x.code).join(","));
});
check("LONG with TP below entry is caught", () => {
  const good = proposeOf(supportFakeout(), 1);
  const bad: TradeProposal = { ...good, takeProfit: good.entryPrice! - 5 * PIP, rewardPips: -5 };
  const v = validateProposal(bad, srOf(supportFakeout()), reactOf(supportFakeout()));
  assert.ok(v.some((x) => x.code === "TP_SIDE"), "TP_SIDE expected");
});
check("R:R mismatch is caught", () => {
  const good = proposeOf(supportFakeout(), 1);
  const bad: TradeProposal = { ...good, riskReward: (good.riskReward ?? 1) + 1 };
  assert.ok(validateProposal(bad, srOf(supportFakeout()), reactOf(supportFakeout())).some((x) => x.code === "RR_MISMATCH"));
});
check("timeframe mismatch is caught", () => {
  const good = proposeOf(supportFakeout(), 1);
  const bad: TradeProposal = { ...good, analysisTimeframe: "H1" };
  assert.ok(validateProposal(bad, srOf(supportFakeout()), reactOf(supportFakeout())).some((x) => x.code === "TIMEFRAME_MISMATCH"));
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
