/**
 * Tests whether the TS 3-bar range gate (rangeReady requires 08,09,10) diverges
 * from the V6 Pine's `preRangeReady = not na(preHigh)` (>=1 of the 08-10 bars),
 * over the full dataset. Read-only; reimplements the relaxed logic locally.
 */
import { readFileSync } from "node:fs";
import { evaluateUsdjpyStrategyTrace, calculatePineEmaValues } from "../src/lib/strategy/strategies/usdjpy-strategy.js";
import { calculateAtrValues } from "../src/lib/strategy/indicators.js";
import type { Candle } from "../src/types/forex.js";

const CACHE = "../research/frozen-strategies/USDJPY/oanda-h1-mid.csv";
function loadCache(): Candle[] { return readFileSync(CACHE, "utf8").trim().split(/\r?\n/).slice(1).map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" }; }); }
const exactH1 = (d: Date) => d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

const candles = loadCache();
// SHIPPED signals (3-bar gate) via the real evaluator.
const shipped = new Set(evaluateUsdjpyStrategyTrace(candles).rows.filter((r) => r.finalLongSignal).map((r) => r.timestamp));

// RELAXED (Pine-faithful >=1 bar) reimplementation of the same V6 logic.
const ema20 = calculatePineEmaValues(candles.map((c) => c.close), 20);
const ema50 = calculatePineEmaValues(candles.map((c) => c.close), 50);
const atr = calculateAtrValues(candles, 14);
const relaxed = new Set<string>();
let day: string | null = null, preHigh: number | null = null, preLow: number | null = null, tradedToday = false, barCount = 0;
for (let i = 0; i < candles.length; i += 1) {
  const c = candles[i]!; const d = new Date(c.time); const dd = c.time.slice(0, 10);
  if (dd !== day) { day = dd; preHigh = null; preLow = null; tradedToday = false; barCount = 0; }
  const hr = d.getUTCHours();
  if (exactH1(d) && hr >= 8 && hr < 11) { preHigh = preHigh === null ? c.high : Math.max(preHigh, c.high); preLow = preLow === null ? c.low : Math.min(preLow, c.low); barCount += 1; }
  const preRangeReady = preHigh !== null && preLow !== null; // Pine: not na(preHigh) — >=1 bar
  const e20 = ema20[i] ?? null, e50 = ema50[i] ?? null, a = atr[i] ?? null;
  const longTrend = e20 !== null && e50 !== null && e20 > e50;
  const inEntry = hr >= 11 && hr <= 14;
  const eligible = exactH1(d) && inEntry && preRangeReady && !tradedToday && a !== null && a > 0 && longTrend;
  const body = Math.abs(c.close - c.open); const rng = c.high - c.low;
  const strongBody = a !== null && a > 0 && body >= a * 0.4;
  const bullExtreme = rng > 0 && c.close >= c.high - rng * 0.4;
  const longSignal = eligible && c.close > preHigh! && strongBody && bullExtreme;
  if (longSignal) { relaxed.add(c.time); tradedToday = true; }
}

const onlyShipped = [...shipped].filter((t) => !relaxed.has(t)).sort();
const onlyRelaxed = [...relaxed].filter((t) => !shipped.has(t)).sort();
console.log(JSON.stringify({
  shippedSignals: shipped.size,
  relaxedSignals: relaxed.size,
  signalsOnlyUnderShipped_3barGate: onlyShipped,
  signalsOnlyUnderRelaxed_pineFaithful: onlyRelaxed,
  identical: onlyShipped.length === 0 && onlyRelaxed.length === 0,
}, null, 2));
