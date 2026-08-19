import assert from "node:assert/strict";
import type { Candle, MajorInstrument } from "../src/types/forex";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import { classifyRegime } from "../src/lib/strategy/regime";
import { evaluateEma, DEFAULT_EMA_CONFIG } from "../src/lib/strategy/strategies/ema";
import { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG } from "../src/lib/strategy/strategies/breakout";
import { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } from "../src/lib/strategy/strategies/momentum";
import { evaluateMeanReversion, DEFAULT_MEANREV_CONFIG } from "../src/lib/strategy/strategies/meanrev";
import { evaluateAllStrategies } from "../src/lib/strategy/strategies";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const EVAL_AT = "2026-08-17T14:00:00.000Z"; // Monday London/NY overlap
const N = 260;
const iso = (i: number, step = 15) => new Date(Date.parse(EVAL_AT) - (N - 1 - i) * step * 60_000).toISOString();

function series(closes: number[], wick: number, step = 15): Candle[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1]! : close;
    return { time: iso(i, step), open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 100, complete: true };
  });
}
const fillers = (step: number) => series(Array.from({ length: N }, () => 1.1), 0.0004, step);

function input(m15: Candle[], instrument: MajorInstrument = "EUR_USD", over: Partial<StrategyEvaluationInput> = {}): StrategyEvaluationInput {
  const close = m15.at(-1)!.close;
  const half = pipSizeFor(instrument) * 0.6;
  return {
    instrument, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
    candles15m: m15, candles1h: fillers(60), candles4h: fillers(240),
    bid: close - half, ask: close + half, spreadPips: 1.2, marketOpen: true,
    calendarConnected: true, highImpactNewsWithinMinutes: null, newsRequired: true,
    evaluatedAt: EVAL_AT, evaluationMode: "live", ...over,
  };
}
const regimeOf = (m15: Candle[], instrument: MajorInstrument = "EUR_USD") => classifyRegime(instrument, m15, EVAL_AT);

// ---- Generators (mirror the ones proven in test-multistrategy) ----
function emaTrend(direction: "long" | "short", base = 1.10, pip = 0.0001): Candle[] {
  const sign = direction === "long" ? 1 : -1;
  const u = pip * 10; // one "unit" ~10 pips
  const closes: number[] = [];
  for (let i = 0; i < N - 4; i += 1) closes.push(base + sign * i * u * 0.25 + Math.sin(i / 6) * u * 0.4);
  const peak = closes.at(-1)!;
  closes.push(peak - sign * u * 2.5, peak - sign * u * 4.0, peak - sign * u * 4.8, peak - sign * u * 3.5);
  const bars = series(closes, u * 0.6);
  const last = bars.at(-1)!;
  if (direction === "long") { last.open = peak - u * 4.2; last.low = peak - u * 5.2; last.high = peak - u * 3.3; last.close = peak - u * 3.5; }
  else { last.open = peak + u * 4.2; last.high = peak + u * 5.2; last.low = peak + u * 3.3; last.close = peak + u * 3.5; }
  return bars;
}
function breakoutSeries(direction: "long" | "short", base = 1.10, pip = 0.0001): Candle[] {
  const u = pip * 10;
  const closes: number[] = [];
  for (let i = 0; i < N - 1; i += 1) closes.push(base + Math.sin(i / 3) * u);
  closes.push(direction === "long" ? base + u * 3.5 : base - u * 3.5);
  return series(closes, u * 0.4);
}
function momentumSeries(direction: "long" | "short"): Candle[] {
  const sign = direction === "long" ? 1 : -1;
  const closes: number[] = [];
  for (let i = 0; i < N - 3; i += 1) closes.push(1.20 + (i % 2 === 0 ? 0 : 0.0004));
  let last = closes.at(-1)!;
  for (const s of [0.0006, 0.0008, 0.0010]) { last += sign * s; closes.push(last); }
  return series(closes, 0.0004);
}
function rangeStretch(direction: "long" | "short"): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < N - 3; i += 1) closes.push(1.10 + Math.sin(i / 2.5) * 0.0008);
  if (direction === "short") closes.push(1.1030, 1.1042, 1.1041); else closes.push(1.0970, 1.0958, 1.0959);
  const bars = series(closes, 0.0004);
  const last = bars.at(-1)!;
  if (direction === "short") { last.high = last.close + 0.0016; last.open = last.close + 0.0004; }
  else { last.low = last.close - 0.0016; last.open = last.close - 0.0004; }
  return bars;
}

const summary = (c: { status: string; direction: unknown; entry: number | null; stop: number | null; target: number | null }) =>
  JSON.stringify({ status: c.status, direction: c.direction, entry: c.entry, stop: c.stop, target: c.target });

// ===========================================================================
// A. FORMING-CANDLE LOOK-AHEAD — a wild incomplete final candle must not change
//    any strategy's decision or the regime.
// ===========================================================================
{
  const cases: Array<[string, () => Candle[], (m: Candle[]) => unknown]> = [
    ["ema", () => emaTrend("long"), (m) => evaluateEma(input(m), regimeOf(m), DEFAULT_EMA_CONFIG)],
    ["breakout", () => breakoutSeries("long"), (m) => evaluateBreakout(input(m), regimeOf(m), DEFAULT_BREAKOUT_CONFIG)],
    ["momentum", () => momentumSeries("long"), (m) => evaluateMomentum(input(m), regimeOf(m), DEFAULT_MOMENTUM_CONFIG)],
    ["meanrev", () => rangeStretch("short"), (m) => evaluateMeanReversion(input(m), regimeOf(m), DEFAULT_MEANREV_CONFIG)],
  ];
  // The live quote (bid/ask) comes from the pricing stream, NOT from candles, so
  // the input's bid/ask is held FIXED while only the candle array gains a violent
  // forming bar. A correct strategy ignores the incomplete bar entirely.
  const forming = (last: Candle): Candle => ({ ...last, time: iso(N, 15), complete: false, open: last.close, close: last.close + 5, high: last.close + 5, low: last.close - 5 });
  const runs: Array<[string, () => Candle[], (inp: StrategyEvaluationInput) => any]> = [
    ["ema", () => emaTrend("long"), (inp) => evaluateEma(inp, classifyRegime("EUR_USD", inp.candles15m, EVAL_AT), DEFAULT_EMA_CONFIG)],
    ["breakout", () => breakoutSeries("long"), (inp) => evaluateBreakout(inp, classifyRegime("EUR_USD", inp.candles15m, EVAL_AT), DEFAULT_BREAKOUT_CONFIG)],
    ["momentum", () => momentumSeries("long"), (inp) => evaluateMomentum(inp, classifyRegime("EUR_USD", inp.candles15m, EVAL_AT), DEFAULT_MOMENTUM_CONFIG)],
    ["meanrev", () => rangeStretch("short"), (inp) => evaluateMeanReversion(inp, classifyRegime("EUR_USD", inp.candles15m, EVAL_AT), DEFAULT_MEANREV_CONFIG)],
  ];
  for (const [name, gen, evalFn] of runs) {
    const base = gen();
    const baseInput = input(base); // fixes bid/ask from the completed series
    const before = evalFn(baseInput) as { status: string; direction: unknown; entry: number | null; stop: number | null; target: number | null };
    const formingInput = { ...baseInput, candles15m: [...base, forming(base.at(-1)!)] };
    const after = evalFn(formingInput) as typeof before;
    assert.equal(summary(after), summary(before), `${name}: a forming candle must not change the decision`);
    assert.equal(classifyRegime("EUR_USD", formingInput.candles15m, EVAL_AT).emaFast, classifyRegime("EUR_USD", base, EVAL_AT).emaFast, `${name}: forming candle must not move the regime`);
  }
  console.log("A forming-candle look-ahead: OK");
}

// ===========================================================================
// B. LONG/SHORT geometry incl. JPY. stop<entry<target (long); target<entry<stop.
// ===========================================================================
{
  const checks: Array<[string, MajorInstrument, () => Candle[], "long" | "short", (m: Candle[], i: MajorInstrument) => any]> = [
    ["EUR_USD ema long", "EUR_USD", () => emaTrend("long"), "long", (m, i) => evaluateEma(input(m, i), regimeOf(m, i), DEFAULT_EMA_CONFIG)],
    ["EUR_USD ema short", "EUR_USD", () => emaTrend("short"), "short", (m, i) => evaluateEma(input(m, i), regimeOf(m, i), DEFAULT_EMA_CONFIG)],
    ["USD_JPY breakout long", "USD_JPY", () => breakoutSeries("long", 150.0, 0.01), "long", (m, i) => evaluateBreakout(input(m, i), regimeOf(m, i), DEFAULT_BREAKOUT_CONFIG)],
    ["USD_JPY breakout short", "USD_JPY", () => breakoutSeries("short", 150.0, 0.01), "short", (m, i) => evaluateBreakout(input(m, i), regimeOf(m, i), DEFAULT_BREAKOUT_CONFIG)],
  ];
  for (const [label, instrument, gen, dir, evalFn] of checks) {
    const c = evalFn(gen(), instrument);
    assert.equal(c.status, "valid", `${label}: expected a valid setup, failing: ${c.conditions.filter((x: any) => x.required && !x.passed).map((x: any) => x.name).join(", ")}`);
    assert.equal(c.direction, dir, `${label}: direction`);
    if (dir === "long") {
      assert.ok(c.stop < c.entry && c.entry < c.target, `${label}: long geometry stop<entry<target (${c.stop}/${c.entry}/${c.target})`);
    } else {
      assert.ok(c.target < c.entry && c.entry < c.stop, `${label}: short geometry target<entry<stop (${c.target}/${c.entry}/${c.stop})`);
    }
    // Risk/reward is finite and positive; position size exists and is > 0 units.
    assert.ok(c.riskReward != null && c.riskReward > 0 && Number.isFinite(c.riskReward), `${label}: rr positive`);
    assert.ok(c.positionSize && c.positionSize.calculatedUnits > 0, `${label}: sizing produced positive units`);
  }
  console.log("B long/short + JPY geometry + sizing: OK");
}

// ===========================================================================
// C. HARD-GATE BOUNDARIES — session (16:45 ET), spread, news buffer.
// ===========================================================================
{
  const validEma = emaTrend("long");
  const ok = evaluateEma(input(validEma), regimeOf(validEma), DEFAULT_EMA_CONFIG);
  assert.equal(ok.status, "valid", "baseline EMA is valid inside session with clear news and tight spread");

  // Past the 16:45 ET forced exit (21:00Z ~ 17:00 ET): session closed → no setup.
  const late = evaluateEma(input(validEma, "EUR_USD", { evaluatedAt: "2026-08-17T21:00:00.000Z" }), classifyRegime("EUR_USD", validEma, "2026-08-17T21:00:00.000Z"), DEFAULT_EMA_CONFIG);
  assert.equal(late.conditions.find((c) => c.name === "Session")?.passed, false, "after 16:45 ET the session gate fails");
  assert.notEqual(late.status, "valid", "no valid setup after the forced-exit time");

  // Spread exactly at the EUR_USD 1.5-pip limit passes; just over fails.
  assert.equal(evaluateEma(input(validEma, "EUR_USD", { spreadPips: 1.5 }), regimeOf(validEma), DEFAULT_EMA_CONFIG).conditions.find((c) => c.name === "Spread")?.passed, true, "spread at the limit is allowed");
  assert.equal(evaluateEma(input(validEma, "EUR_USD", { spreadPips: 1.6 }), regimeOf(validEma), DEFAULT_EMA_CONFIG).conditions.find((c) => c.name === "Spread")?.passed, false, "spread over the limit is blocked");

  // News buffer boundary: 30 minutes away is inside the buffer (blocked); 31 is clear.
  assert.equal(evaluateEma(input(validEma, "EUR_USD", { highImpactNewsWithinMinutes: 30 }), regimeOf(validEma), DEFAULT_EMA_CONFIG).conditions.find((c) => c.name === "News")?.passed, false, "news exactly at 30m is inside the buffer");
  assert.equal(evaluateEma(input(validEma, "EUR_USD", { highImpactNewsWithinMinutes: 31 }), regimeOf(validEma), DEFAULT_EMA_CONFIG).conditions.find((c) => c.name === "News")?.passed, true, "news at 31m is clear");

  // A stale/disconnected calendar fails closed.
  assert.equal(evaluateEma(input(validEma, "EUR_USD", { calendarConnected: false, highImpactNewsWithinMinutes: null }), regimeOf(validEma), DEFAULT_EMA_CONFIG).conditions.find((c) => c.name === "News")?.passed, false, "a disconnected calendar fails closed");
  console.log("C hard-gate boundaries: OK");
}

// ===========================================================================
// D. INDEPENDENCE — only the intended strategy fires on each shaped series.
// ===========================================================================
{
  const only = (m: Candle[], family: string) => {
    const { candidates } = evaluateAllStrategies(input(m));
    const valid = candidates.filter((c) => c.status === "valid").map((c) => c.family as string).sort();
    return { valid, has: valid.includes(family) };
  };
  const brk = only(breakoutSeries("long"), "breakout");
  assert.ok(brk.has, "breakout series makes breakout valid");
  assert.ok(!brk.valid.includes("meanrev"), "a clean breakout is not also a mean-reversion fade");

  const mr = only(rangeStretch("short"), "meanrev");
  assert.ok(mr.has, "range-stretch series makes mean reversion valid");
  assert.ok(!mr.valid.includes("ema"), "a ranging fade is not also an EMA trend continuation");

  // Chop: nobody fires.
  const chop = series(Array.from({ length: N }, (_, i) => 1.10 + Math.sin(i / 2) * 0.0006), 0.0005);
  assert.equal(only(chop, "none").valid.length, 0, "no strategy qualifies in chop");
  console.log("D independence: OK");
}

console.log("\nAll adversarial strategy tests passed.");
