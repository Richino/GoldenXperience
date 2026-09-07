import assert from "node:assert/strict";

import { evaluateAudusdStrategyTrace } from "../src/lib/strategy/strategies/audusd-strategy";
import type { Candle } from "../src/types/forex";
import { loadAudusdHistory } from "./audusd-history";

type Signal = { timestamp: string; voteSum: number; confidenceTag: string };

/** Independent literal reference used only to catch production-port drift. */
function literalReferenceSignals(candles: readonly Candle[]): Signal[] {
  const bars = [...candles].filter((bar) => bar.complete).sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const alpha20 = 2 / 21;
  const alpha50 = 2 / 51;
  let ema20: number | null = null;
  let ema50: number | null = null;
  let atr14: number | null = null;
  const trSeed: number[] = [];
  let day = "";
  let dayBars = new Map<number, { candle: Candle; ema20: number }>();
  const signals: Signal[] = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const date = new Date(bar.time);
    const nextDay = date.toISOString().slice(0, 10);
    if (nextDay !== day) {
      day = nextDay;
      dayBars = new Map();
    }
    ema20 = ema20 === null ? bar.close : alpha20 * bar.close + (1 - alpha20) * ema20;
    ema50 = ema50 === null ? bar.close : alpha50 * bar.close + (1 - alpha50) * ema50;
    const priorClose = bars[index - 1]?.close ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    if (atr14 === null) {
      trSeed.push(tr);
      if (trSeed.length === 14) atr14 = trSeed.reduce((sum, value) => sum + value, 0) / 14;
    } else {
      atr14 = (atr14 * 13 + tr) / 14;
    }
    if (date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) continue;
    dayBars.set(date.getUTCHours(), { candle: bar, ema20 });
    if (date.getUTCHours() !== 11 || atr14 === null || !(atr14 > 0)) continue;
    const rangeBars = [6, 7, 8, 9, 10].map((hour) => dayBars.get(hour));
    if (rangeBars.some((item) => !item)) continue;
    const at0800 = dayBars.get(8)!;
    const at1000 = dayBars.get(10)!;
    const preHigh = Math.max(...rangeBars.map((item) => item!.candle.high));
    const preLow = Math.min(...rangeBars.map((item) => item!.candle.low));
    const preMid = (preHigh + preLow) / 2;
    const cmp = (left: number, right: number) => left > right ? 1 : left < right ? -1 : 0;
    const bullStructure = bar.high > at1000.candle.high && bar.low > at1000.candle.low;
    const bearStructure = bar.high < at1000.candle.high && bar.low < at1000.candle.low;
    const votes = [
      cmp(ema20, ema50),
      cmp(bar.close, ema20),
      cmp(ema20, at0800.ema20),
      cmp(bar.close, preMid),
      bullStructure ? 1 : bearStructure ? -1 : 0,
      cmp(bar.close, at0800.candle.close),
    ];
    const voteSum = votes.reduce((sum, value) => sum + value, 0);
    if (voteSum < 4 || !bullStructure) continue;
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    const bodyConfirm = body >= 0.5 * atr14;
    const extreme = range > 0 && bar.close >= bar.high - range * 0.25;
    signals.push({ timestamp: bar.time, voteSum, confidenceTag: bodyConfirm && extreme ? "AUDUSD_BODY_EXTREME" : "AUDUSD_BASE" });
  }
  return signals;
}

async function main() {
  const history = await loadAudusdHistory(process.argv[2]);
  assert.equal(history.symbol, "AUD_USD");
  assert.equal(history.timeframe, "H1");
  const production = evaluateAudusdStrategyTrace(history.candles);
  assert.equal(production.error, null, production.error ?? undefined);
  const productionSignals = production.rows.filter((row) => row.finalLongSignal).map((row) => ({
    timestamp: row.timestamp, voteSum: row.voteSum, confidenceTag: row.confidenceTag,
  }));
  const referenceSignals = literalReferenceSignals(history.candles);
  assert.deepEqual(productionSignals, referenceSignals,
    "audusd_strategy signal timestamps or frozen metadata differ from the independent literal reference");
  const candleTimes = new Set(history.candles.map((bar) => Date.parse(bar.time)));
  const closedTradeEligibleSignals = productionSignals.filter((signal) => {
    const originMs = Date.parse(signal.timestamp);
    return [1, 2, 3].every((offset) => candleTimes.has(originMs + offset * 60 * 60_000));
  });
  console.log(JSON.stringify({
    strategyId: "audusd_strategy",
    strategyVersion: "AUDUSD_STRONG_CONS_STRUCTURE_V1",
    source: history.source,
    requestedPeriod: { from: history.from, to: history.to },
    actualPeriod: { from: history.candles[0]?.time ?? null, to: history.candles.at(-1)?.time ?? null },
    completedCandles: history.candles.length,
    productionSignals: productionSignals.length,
    literalReferenceSignals: referenceSignals.length,
    signalCountMatchesReference: true,
    closedTradeEligibleSignals: closedTradeEligibleSignals.length,
    openSignalsAwaitingFutureBars: productionSignals.length - closedTradeEligibleSignals.length,
    expectedTradingViewClosedTrades: 195,
    tradingViewClosedTradeCountDelta: closedTradeEligibleSignals.length - 195,
    bodyExtremeClosedTrades: closedTradeEligibleSignals.filter((signal) => signal.confidenceTag === "AUDUSD_BODY_EXTREME").length,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
