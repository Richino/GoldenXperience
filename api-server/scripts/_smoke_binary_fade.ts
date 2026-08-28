/**
 * Smoke test: does the fade engine fire and abstain in the intended cases?
 * Not a substitute for forward validation; a sanity check for the wiring.
 */
import { createFadeModel } from "../src/binary-fade-v1.js";
import type { BinaryFeatures } from "../src/binary-engine.js";

function feat(o: Partial<BinaryFeatures> = {}): BinaryFeatures {
  return {
    momentumPips: { m1: 0, m5: 0, m10: 0, m15: 0 },
    returnPct: { m1: 0, m5: 0, m10: 0, m15: 0 },
    trend: "flat",
    emaFast: 1.10000, emaSlow: 1.10000, atrPips: 8, volatilityPips: 2,
    candle: { bodyPips: 1, upperWickPips: 0.3, lowerWickPips: 0.3, bodyRatio: 0.6 },
    distanceFromHighPips: 3, distanceFromLowPips: 3, spreadPips: 0.8,
    session: "London/New York overlap", hourEt: 10, timeOfDayBucket: "08-12 ET",
    rsi14: 50,
    bollinger: { middle: 1.10, upper: 1.101, lower: 1.099, pctB: 0.5, extAtr: 0, dir: 0, streak: 0 },
    instrument: "EUR_USD",
    referenceClose: 1.10000, referenceCloseTime: "2026-01-06T10:39:00.000Z",
    ...o,
  };
}

const model = createFadeModel();
function check(name: string, features: BinaryFeatures, expected: "up" | "down" | "wait") {
  const d = model.evaluate(features);
  const ok = d.direction === expected;
  console.log((ok ? "OK  " : "FAIL") + "  " + name.padEnd(50) + " => " + d.direction + " (score " + d.score.toFixed(2) + ")   " + d.rationale);
  if (!ok) process.exitCode = 1;
}

check("inside band, RSI neutral", feat(), "wait");
check("above upper, small extension, RSI 70", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: 1.05, extAtr: 0.5, dir: 1, streak: 1 }, rsi14: 72 }), "wait");
check("above upper, 1.25 ATR, RSI 68 -> fade short", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: 1.4, extAtr: 1.25, dir: 1, streak: 2 }, rsi14: 68 }), "down");
check("above upper, 1.5 ATR, RSI 62 -> RSI blocks", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: 1.6, extAtr: 1.5, dir: 1, streak: 2 }, rsi14: 62 }), "wait");
check("below lower, 1.4 ATR, RSI 25 -> fade long", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: -0.5, extAtr: 1.4, dir: -1, streak: 3 }, rsi14: 25 }), "up");
check("below lower, 1.4 ATR, RSI 40 -> RSI blocks", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: -0.5, extAtr: 1.4, dir: -1, streak: 3 }, rsi14: 40 }), "wait");
check("above upper, 2.5 ATR, RSI 80 -> fade short strong", feat({ bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: 2.0, extAtr: 2.5, dir: 1, streak: 4 }, rsi14: 80 }), "down");
check("EUR_AUD is excluded even with a good signal", feat({ instrument: "EUR_AUD" as never, bollinger: { middle: 1.6, upper: 1.61, lower: 1.59, pctB: 1.5, extAtr: 2, dir: 1, streak: 2 }, rsi14: 78 }), "wait");
check("RSI missing", feat({ rsi14: null, bollinger: { middle: 1.1, upper: 1.101, lower: 1.099, pctB: 1.5, extAtr: 2, dir: 1, streak: 2 } }), "wait");
check("Bollinger missing", feat({ bollinger: null }), "wait");
