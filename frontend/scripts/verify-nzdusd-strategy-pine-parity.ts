import assert from "node:assert/strict";

import { evaluateNzdusdStrategyTrace } from "../src/lib/strategy/strategies/nzdusd-strategy";
import type { Candle } from "../src/types/forex";
import { loadNzdusdHistory } from "./nzdusd-history";

type ReferenceSignal = { timestamp: string; direction: "long" | "short"; confidenceTag: "NZDUSD_BODY" | "NZDUSD_BASE" };

/** Independent literal port of the supplied Pine v6 signal and tag rules. */
function literalPineSignals(candles: readonly Candle[]): ReferenceSignal[] {
  const bars = [...candles].filter((bar) => bar.complete).sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const alpha20 = 2 / 21;
  const alpha50 = 2 / 51;
  let ema20: number | null = null;
  let ema50: number | null = null;
  let atr14: number | null = null;
  const trSeed: number[] = [];
  let day = "";
  let preHigh: number | null = null;
  let preLow: number | null = null;
  let preRangeCount = 0;
  const signals: ReferenceSignal[] = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const date = new Date(bar.time);
    const nextDay = date.toISOString().slice(0, 10);
    if (nextDay !== day) {
      day = nextDay;
      preHigh = null;
      preLow = null;
      preRangeCount = 0;
    }
    ema20 = ema20 === null ? bar.close : alpha20 * bar.close + (1 - alpha20) * ema20;
    ema50 = ema50 === null ? bar.close : alpha50 * bar.close + (1 - alpha50) * ema50;
    const priorClose = bars[index - 1]?.close ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    if (atr14 === null) {
      trSeed.push(tr);
      if (trSeed.length === 14) atr14 = trSeed.reduce((sum, value) => sum + value, 0) / 14;
    } else atr14 = (atr14 * 13 + tr) / 14;
    const exact = date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
    const hour = date.getUTCHours();
    if (exact && hour >= 6 && hour <= 10) {
      preHigh = preHigh === null ? bar.high : Math.max(preHigh, bar.high);
      preLow = preLow === null ? bar.low : Math.min(preLow, bar.low);
      preRangeCount += 1;
    }
    const continuous = index >= 5 && Date.parse(bar.time) - Date.parse(bars[index - 5]!.time) === 5 * 60 * 60_000
      && new Date(bars[index - 5]!.time).getUTCHours() === 6;
    const validOrigin = exact && hour === 11 && preRangeCount === 5 && preHigh !== null && preLow !== null
      && continuous && ema20 !== null && ema50 !== null && atr14 !== null && atr14 > 0;
    const direction = validOrigin && ema20 > ema50 && bar.close > preHigh! ? "long" as const
      : validOrigin && ema20 < ema50 && bar.close < preLow! ? "short" as const : null;
    if (!direction) continue;
    const bodyAtrRatio = Math.abs(bar.close - bar.open) / atr14!;
    signals.push({ timestamp: bar.time, direction, confidenceTag: bodyAtrRatio >= 0.5 ? "NZDUSD_BODY" : "NZDUSD_BASE" });
  }
  return signals;
}

async function main() {
  const history = await loadNzdusdHistory(process.argv[2]);
  const production = evaluateNzdusdStrategyTrace(history.candles);
  assert.equal(production.error, null, production.error ?? undefined);
  const productionSignals = production.rows
    .filter((row) => row.finalLongSignal || row.finalShortSignal)
    .map((row) => ({ timestamp: row.timestamp, direction: row.finalLongSignal ? "long" as const : "short" as const, confidenceTag: row.confidenceTag }));
  const referenceSignals = literalPineSignals(history.candles);
  assert.deepEqual(productionSignals, referenceSignals,
    "nzdusd_strategy timestamps, directions, or BODY/BASE tags differ from the independent Pine v6 port");
  const candleTimes = new Set(history.candles.map((bar) => Date.parse(bar.time)));
  const closedTradeEligible = productionSignals.filter((signal) => [1, 2, 3].every((offset) =>
    candleTimes.has(Date.parse(signal.timestamp) + offset * 60 * 60_000)));
  console.log(JSON.stringify({
    strategyId: "nzdusd_strategy",
    strategyVersion: "NZDUSD_PRE_RANGE_BREAKOUT_V1",
    source: history.source,
    requestedPeriod: { from: history.from, to: history.to },
    actualPeriod: { from: history.candles[0]?.time ?? null, to: history.candles.at(-1)?.time ?? null },
    completedCandles: history.candles.length,
    productionSignals: productionSignals.length,
    literalPineSignals: referenceSignals.length,
    exactSignalParity: true,
    closedTradeEligibleSignals: closedTradeEligible.length,
    expectedTradingViewClosedTrades: 100,
    tradingViewClosedTradeCountDelta: closedTradeEligible.length - 100,
    bodySignals: closedTradeEligible.filter((signal) => signal.confidenceTag === "NZDUSD_BODY").length,
    baseSignals: closedTradeEligible.filter((signal) => signal.confidenceTag === "NZDUSD_BASE").length,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
