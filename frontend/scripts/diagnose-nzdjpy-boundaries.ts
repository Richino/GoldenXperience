/** Full-precision diagnostic for the two disputed NZDJPY origins. Read-only. */
import { readFileSync } from "node:fs";
import { evaluateNzdjpy23UtcBullBreakV1 } from "../src/lib/strategy/strategies/nzdjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const CACHE = "../research/frozen-strategies/NZDJPY/oanda-h1-mid.csv";
function loadCache(): Candle[] {
  return readFileSync(CACHE, "utf8").trim().split(/\r?\n/).slice(1).map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" }; });
}

const candles = loadCache();
function diag(ts: string) {
  const i = candles.findIndex((c) => c.time === ts);
  if (i < 0) return { ts, error: "CANDLE_NOT_IN_CACHE" };
  const c = candles[i]!, p = candles[i - 1]!, b3 = candles[i - 3]!;
  const ev = evaluateNzdjpy23UtcBullBreakV1(candles.slice(0, i + 1));
  const body = Math.abs(c.close - c.open), range = c.high - c.low;
  const atr = ev.atr14;
  const breakDistance = c.close - p.high;
  return {
    ts,
    cacheIndex: i,
    prevBar: p.time, threeBack: b3.time,
    ohlc: { open: c.open, high: c.high, low: c.low, close: c.close },
    previousHigh: p.high,
    votes: { voteTrend: ev.voteTrend, votePrice: ev.votePrice, voteSlope: ev.voteSlope, voteMomentum: ev.voteMomentum, consensus: ev.consensus },
    ema: { ema20: ev.ema20, ema50: ev.ema50 },
    atr14: atr,
    bullBody: c.close > c.open,
    body: { body, halfAtr: atr ? 0.5 * atr : null, bodyMinusThreshold: atr ? body - 0.5 * atr : null, bodyR: ev.bodyR },
    upper25: { candleRange: range, boundary: c.high - range * 0.25, close: c.close, closeLocation: ev.closeLocation, passes: ev.closeLocation !== null && ev.closeLocation >= 0.75 },
    breakout: { breakDistance, threshold_0p10ATR: atr ? 0.1 * atr : null, breakMinusThreshold: atr ? breakDistance - 0.1 * atr : null, breakDistanceR: ev.breakDistanceR, passes: ev.breakDistanceR !== null && ev.breakDistanceR >= 0.1 },
    strategySignalQualified: ev.strategySignalQualified,
    // which single condition is the binding one:
    conditionFlags: {
      consensusOk: ev.consensus !== null && ev.consensus >= 3,
      bullBodyOk: c.close > c.open,
      bodyOk: ev.bodyR !== null && ev.bodyR >= 0.5,
      upper25Ok: ev.closeLocation !== null && ev.closeLocation >= 0.75,
      breakoutOk: ev.breakDistanceR !== null && ev.breakDistanceR >= 0.1,
    },
  };
}

console.log(JSON.stringify({
  tvOnly_2023_01_17: diag("2023-01-17T23:00:00.000Z"),
  tsOnly_2023_11_15: diag("2023-11-15T23:00:00.000Z"),
}, null, 2));
