import assert from "node:assert/strict";
import type { Candle } from "../src/types/forex";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import { classifyRegime } from "../src/lib/strategy/regime";
import { evaluateEma } from "../src/lib/strategy/strategies/ema";
import { evaluateBreakout } from "../src/lib/strategy/strategies/breakout";
import { evaluateMomentum } from "../src/lib/strategy/strategies/momentum";
import { evaluateMeanReversion } from "../src/lib/strategy/strategies/meanrev";
import { evaluateAllStrategies } from "../src/lib/strategy/strategies";
import { DEFAULT_EMA_CONFIG } from "../src/lib/strategy/strategies/ema";
import { DEFAULT_BREAKOUT_CONFIG } from "../src/lib/strategy/strategies/breakout";
import { DEFAULT_MOMENTUM_CONFIG } from "../src/lib/strategy/strategies/momentum";
import { DEFAULT_MEANREV_CONFIG } from "../src/lib/strategy/strategies/meanrev";

// Monday 14:00 UTC = London/New York overlap, market open, entry window open.
const EVAL_AT = "2026-08-17T14:00:00.000Z";
const N = 260;

function iso(i: number, stepMin: number) {
  return new Date(Date.parse(EVAL_AT) - (N - 1 - i) * stepMin * 60_000).toISOString();
}

/** Build a candle series from closes, with wicks sized by `wick` (price units). */
function series(closes: number[], wick: number, stepMin = 15): Candle[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1]! : close;
    const hi = Math.max(open, close) + wick;
    const lo = Math.min(open, close) - wick;
    return { time: iso(i, stepMin), open, high: hi, low: lo, close, volume: 100, complete: true };
  });
}

/** Flat filler history for the timeframes a strategy does not read directly. */
function fillers(stepMin: number): Candle[] {
  return series(Array.from({ length: N }, () => 1.1), 0.0004, stepMin);
}

function input(m15: Candle[], overrides: Partial<StrategyEvaluationInput> = {}): StrategyEvaluationInput {
  // A realistic live quote straddling the last close, so entry/stop/target are
  // sanely placed relative to the candles the setup was read from.
  const close = m15.at(-1)!.close;
  return {
    instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
    candles15m: m15, candles1h: fillers(60), candles4h: fillers(240),
    bid: close - 0.00006, ask: close + 0.00006, spreadPips: 1.2, marketOpen: true,
    calendarConnected: true, highImpactNewsWithinMinutes: null, newsRequired: true,
    evaluatedAt: EVAL_AT, evaluationMode: "live", ...overrides,
  };
}

function regimeFor(m15: Candle[]) {
  return classifyRegime("EUR_USD", m15, EVAL_AT);
}

function failed(candidate: { conditions: Array<{ name: string; passed: boolean; required: boolean }> }) {
  return candidate.conditions.filter((c) => c.required && !c.passed).map((c) => c.name).join(", ") || "(none)";
}

// ===========================================================================
// Regime classifier
// ===========================================================================
{
  // A clean uptrend must read as trending/up with high strength.
  const up = series(Array.from({ length: N }, (_, i) => 1.10 + i * 0.0006 + Math.sin(i / 5) * 0.0006), 0.0006);
  const r = regimeFor(up);
  assert.equal(r.regime, "trending", "a clean uptrend is trending");
  assert.equal(r.trendDirection, "up", "the trend direction is up");
  assert.ok(r.trendStrength >= 0.5, `uptrend R² should be high, got ${r.trendStrength.toFixed(2)}`);
  assert.ok(r.atr !== null && r.atr > 0, "ATR is computed");

  // A downtrend is trending/down.
  const down = series(Array.from({ length: N }, (_, i) => 1.40 - i * 0.0006 + Math.sin(i / 5) * 0.0006), 0.0006);
  assert.equal(regimeFor(down).trendDirection, "down", "a clean downtrend reads down");

  // Choppy sideways price is not trending.
  const chop = series(Array.from({ length: N }, (_, i) => 1.10 + Math.sin(i / 2) * 0.0015), 0.0006);
  const rc = regimeFor(chop);
  assert.notEqual(rc.regime, "trending", "sideways chop is not a trend");
  assert.ok(rc.trendStrength < 0.5, `chop R² should be low, got ${rc.trendStrength.toFixed(2)}`);

  // Look-ahead guard: an incomplete final candle must not enter any computation.
  const withForming = [...up];
  withForming.push({ ...up.at(-1)!, complete: false, close: 5.0, high: 5.0 });
  const rGuarded = regimeFor(withForming);
  assert.equal(rGuarded.emaFast, regimeFor(up).emaFast, "a forming candle must not change the regime");
  console.log("regime: OK");
}

// ===========================================================================
// EMA Trend/Pullback V1  — valid long, valid short, abstention
// ===========================================================================
function emaTrend(direction: "long" | "short"): Candle[] {
  // A gentle trend (slope small relative to ATR) so the EMAs stay near price
  // and a pullback can actually reach the value area — the way a real pullback
  // setup forms. The final bar is placed in the EMA zone with an in-direction
  // rejection close.
  const sign = direction === "long" ? 1 : -1;
  const base = 1.10;
  const closes: number[] = [];
  for (let i = 0; i < N - 4; i += 1) closes.push(base + sign * i * 0.00025 + Math.sin(i / 6) * 0.0004);
  const peak = closes.at(-1)!;
  closes.push(peak - sign * 0.0025);
  closes.push(peak - sign * 0.0040);
  closes.push(peak - sign * 0.0048);
  closes.push(peak - sign * 0.0035);
  const bars = series(closes, 0.0006);
  const last = bars.at(-1)!;
  if (direction === "long") { last.open = peak - 0.0042; last.low = peak - 0.0052; last.high = peak - 0.0033; last.close = peak - 0.0035; }
  else { last.open = peak + 0.0042; last.high = peak + 0.0052; last.low = peak + 0.0033; last.close = peak + 0.0035; }
  return bars;
}
{
  const longM15 = emaTrend("long");
  const longCand = evaluateEma(input(longM15), regimeFor(longM15), DEFAULT_EMA_CONFIG);
  assert.equal(longCand.direction, "long", "EMA uptrend produces a long");
  assert.equal(longCand.status, "valid", `EMA long should be valid; failing: ${failed(longCand)}`);
  assert.ok(longCand.entry! > longCand.stop!, "EMA long stop sits below entry");
  assert.ok(longCand.target! > longCand.entry!, "EMA long target sits above entry");
  assert.ok(longCand.features.ema?.aligned, "EMA features record alignment");

  const shortM15 = emaTrend("short");
  const shortCand = evaluateEma(input(shortM15), regimeFor(shortM15), DEFAULT_EMA_CONFIG);
  assert.equal(shortCand.direction, "short", "EMA downtrend produces a short");
  assert.equal(shortCand.status, "valid", `EMA short should be valid; failing: ${failed(shortCand)}`);
  assert.ok(shortCand.stop! > shortCand.entry! && shortCand.target! < shortCand.entry!, "EMA short levels are oriented correctly");

  // Chop: no aligned trend → no setup.
  const chop = series(Array.from({ length: N }, (_, i) => 1.10 + Math.sin(i / 2) * 0.0015), 0.0006);
  const chopCand = evaluateEma(input(chop), regimeFor(chop), DEFAULT_EMA_CONFIG);
  assert.equal(chopCand.status, "no_setup", "EMA abstains in chop");

  // Extended: price far above the fast EMA (no pullback) → not valid.
  const extended = series(Array.from({ length: N }, (_, i) => 1.10 + i * 0.0006 + Math.sin(i / 6) * 0.0005), 0.0006);
  const extCand = evaluateEma(input(extended), regimeFor(extended), DEFAULT_EMA_CONFIG);
  assert.notEqual(extCand.status, "valid", "EMA does not chase an extended trend with no pullback");
  console.log("ema: OK");
}

// ===========================================================================
// Breakout V1 — valid long, valid short, abstention
// ===========================================================================
function breakoutSeries(direction: "long" | "short"): Candle[] {
  const closes: number[] = [];
  // A contained range for most of the history.
  for (let i = 0; i < N - 1; i += 1) closes.push(1.10 + Math.sin(i / 3) * 0.0010);
  // A decisive close beyond the range on the final bar.
  closes.push(direction === "long" ? 1.1035 : 1.0965);
  return series(closes, 0.0004);
}
{
  const longM15 = breakoutSeries("long");
  const longCand = evaluateBreakout(input(longM15), regimeFor(longM15), DEFAULT_BREAKOUT_CONFIG);
  assert.equal(longCand.direction, "long", "an upside break is long");
  assert.equal(longCand.status, "valid", `breakout long should be valid; failing: ${failed(longCand)}`);
  assert.ok(longCand.features.breakout?.breakoutDistanceAtr! > 0, "breakout distance recorded");

  const shortM15 = breakoutSeries("short");
  const shortCand = evaluateBreakout(input(shortM15), regimeFor(shortM15), DEFAULT_BREAKOUT_CONFIG);
  assert.equal(shortCand.direction, "short", "a downside break is short");
  assert.equal(shortCand.status, "valid", `breakout short should be valid; failing: ${failed(shortCand)}`);

  // Inside the range → no break.
  const inside = series([...Array.from({ length: N }, (_, i) => 1.10 + Math.sin(i / 3) * 0.0010)], 0.0004);
  assert.equal(evaluateBreakout(input(inside), regimeFor(inside), DEFAULT_BREAKOUT_CONFIG).status, "no_setup", "breakout abstains inside the range");

  // A weak poke just past the range (below the ATR threshold) is not a breakout.
  const weakCloses = Array.from({ length: N - 1 }, (_, i) => 1.10 + Math.sin(i / 3) * 0.0010);
  weakCloses.push(1.10100 + 0.00002); // barely above the ~1.101 range top
  const weak = series(weakCloses, 0.0004);
  assert.notEqual(evaluateBreakout(input(weak), regimeFor(weak), DEFAULT_BREAKOUT_CONFIG).status, "valid", "a weak poke is not a breakout");
  console.log("breakout: OK");
}

// ===========================================================================
// Momentum V1 — valid long, valid short, abstention
// ===========================================================================
function momentumSeries(direction: "long" | "short"): Candle[] {
  const sign = direction === "long" ? 1 : -1;
  const closes: number[] = [];
  // An alternating zigzag base holds RSI near 50 (symmetric for long and short),
  // then a short 3-bar acceleration: a strong run that is not yet exhausted.
  for (let i = 0; i < N - 3; i += 1) closes.push(1.20 + (i % 2 === 0 ? 0 : 0.0004));
  let last = closes.at(-1)!;
  for (const step of [0.0006, 0.0008, 0.0010]) { last += sign * step; closes.push(last); }
  return series(closes, 0.0004);
}
{
  const longM15 = momentumSeries("long");
  const longCand = evaluateMomentum(input(longM15), regimeFor(longM15), DEFAULT_MOMENTUM_CONFIG);
  assert.equal(longCand.direction, "long", "an up burst is long");
  assert.equal(longCand.status, "valid", `momentum long should be valid; failing: ${failed(longCand)}`);
  assert.ok(longCand.features.momentum?.consecutiveBars! >= 2, "consecutive bars recorded");

  const shortM15 = momentumSeries("short");
  const shortCand = evaluateMomentum(input(shortM15), regimeFor(shortM15), DEFAULT_MOMENTUM_CONFIG);
  assert.equal(shortCand.direction, "short", "a down burst is short");
  assert.equal(shortCand.status, "valid", `momentum short should be valid; failing: ${failed(shortCand)}`);

  // Flat market → no run.
  const flat = series(Array.from({ length: N }, (_, i) => 1.20 + Math.sin(i / 4) * 0.0003), 0.0004);
  assert.equal(evaluateMomentum(input(flat), regimeFor(flat), DEFAULT_MOMENTUM_CONFIG).status, "no_setup", "momentum abstains when flat");

  // Overextended parabolic move with RSI pinned high → not valid.
  const parabolic = series(Array.from({ length: N }, (_, i) => 1.10 + i * 0.0010), 0.0004);
  assert.notEqual(evaluateMomentum(input(parabolic), regimeFor(parabolic), DEFAULT_MOMENTUM_CONFIG).status, "valid", "momentum refuses an exhausted move");
  console.log("momentum: OK");
}

// ===========================================================================
// Mean Reversion V1 — valid short, valid long, refuses to fade a trend
// ===========================================================================
function rangeStretch(direction: "long" | "short"): Candle[] {
  // Ranging base around 1.10, then a stretch away from the mean with a reversal
  // candle. direction is the reversion direction (toward the mean).
  const closes: number[] = [];
  for (let i = 0; i < N - 3; i += 1) closes.push(1.10 + Math.sin(i / 2.5) * 0.0008);
  if (direction === "short") { closes.push(1.1030); closes.push(1.1042); closes.push(1.1041); }
  else { closes.push(1.0970); closes.push(1.0958); closes.push(1.0959); }
  const bars = series(closes, 0.0004);
  // Give the final bar an exhaustion wick against the stretch.
  const last = bars.at(-1)!;
  if (direction === "short") { last.high = last.close + 0.0016; last.open = last.close + 0.0004; }
  else { last.low = last.close - 0.0016; last.open = last.close - 0.0004; }
  return bars;
}
{
  const shortM15 = rangeStretch("short");
  const shortCand = evaluateMeanReversion(input(shortM15), regimeFor(shortM15), DEFAULT_MEANREV_CONFIG);
  assert.equal(shortCand.direction, "short", "stretched above the mean fades short");
  assert.equal(shortCand.status, "valid", `mean-rev short should be valid; failing: ${failed(shortCand)}`);
  assert.ok(shortCand.target! < shortCand.entry!, "mean-rev short targets back down toward the mean");

  const longM15 = rangeStretch("long");
  const longCand = evaluateMeanReversion(input(longM15), regimeFor(longM15), DEFAULT_MEANREV_CONFIG);
  assert.equal(longCand.direction, "long", "stretched below the mean fades long");
  assert.equal(longCand.status, "valid", `mean-rev long should be valid; failing: ${failed(longCand)}`);

  // A strong uptrend that is stretched must NOT be faded.
  const trend = series(Array.from({ length: N }, (_, i) => 1.10 + i * 0.0006), 0.0004);
  const trendCand = evaluateMeanReversion(input(trend), regimeFor(trend), DEFAULT_MEANREV_CONFIG);
  assert.notEqual(trendCand.status, "valid", "mean reversion refuses to fade a strong trend");
  assert.equal(trendCand.conditions.find((c) => c.name === "Non-trending")?.passed, false, "the trend gate is what blocks it");

  // Not stretched enough → no setup.
  const tight = series(Array.from({ length: N }, (_, i) => 1.10 + Math.sin(i / 2.5) * 0.0004), 0.0004);
  assert.equal(evaluateMeanReversion(input(tight), regimeFor(tight), DEFAULT_MEANREV_CONFIG).status, "no_setup", "mean reversion abstains without a stretch");
  console.log("meanrev: OK");
}

// ===========================================================================
// Independence: all four run over one instrument; some fire, some don't.
// ===========================================================================
{
  const m15 = breakoutSeries("long");
  const { candidates, regime } = evaluateAllStrategies(input(m15));
  assert.equal(candidates.length, 4, "all four strategies always return a candidate");
  assert.ok(regime.regime, "a shared regime is computed once");
  const families = candidates.map((c) => c.family).sort();
  assert.deepEqual(families, ["breakout", "ema", "meanrev", "momentum"], "one candidate per family");
  console.log("independence: OK");
}

console.log("\nAll multi-strategy tests passed.");
