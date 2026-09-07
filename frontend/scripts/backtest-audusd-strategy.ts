import assert from "node:assert/strict";

import { evaluateAudusdStrategyTrace } from "../src/lib/strategy/strategies/audusd-strategy";
import { loadAudusdHistory, type AudusdHistoryCandle, type PriceBar } from "./audusd-history";

type ExitReason = "TP" | "SL" | "TIME_EXIT";
type Trade = { timestamp: string; year: number; tag: string; exitReason: ExitReason; resultR: number };

function resolveLong(entry: number, atr: number, future: readonly PriceBar[]): { exitReason: ExitReason; resultR: number } {
  const stop = entry - atr;
  const target = entry + 2 * atr;
  for (const bar of future) {
    const stopHit = bar.low <= stop;
    const targetHit = bar.high >= target;
    if (stopHit) return { exitReason: "SL", resultR: -1 };
    if (targetHit) return { exitReason: "TP", resultR: 2 };
  }
  return { exitReason: "TIME_EXIT", resultR: (future[2]!.close - entry) / atr };
}

function metrics(trades: readonly Trade[]) {
  const positive = trades.filter((trade) => trade.resultR > 0);
  const grossProfit = positive.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0));
  const expectancy = trades.length ? trades.reduce((sum, trade) => sum + trade.resultR, 0) / trades.length : null;
  return {
    trades: trades.length,
    positiveTrades: positive.length,
    nonPositiveTrades: trades.length - positive.length,
    positiveRate: trades.length ? positive.length / trades.length : null,
    tp: trades.filter((trade) => trade.exitReason === "TP").length,
    sl: trades.filter((trade) => trade.exitReason === "SL").length,
    timeExit: trades.filter((trade) => trade.exitReason === "TIME_EXIT").length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancyR: expectancy,
    bodyExtreme: trades.filter((trade) => trade.tag === "AUDUSD_BODY_EXTREME").length,
    yearlyExpectancy: Object.fromEntries([...new Set(trades.map((trade) => trade.year))].sort().map((year) => {
      const rows = trades.filter((trade) => trade.year === year);
      return [year, rows.reduce((sum, trade) => sum + trade.resultR, 0) / rows.length];
    })),
  };
}

function exactFutureBars(bars: readonly AudusdHistoryCandle[], index: number) {
  const originMs = Date.parse(bars[index]!.time);
  const future = bars.slice(index + 1, index + 4);
  return future.length === 3 && future.every((bar, offset) => Date.parse(bar.time) === originMs + (offset + 1) * 60 * 60_000)
    ? future : null;
}

async function main() {
  const history = await loadAudusdHistory(process.argv[2]);
  assert.equal(history.symbol, "AUD_USD");
  assert.equal(history.timeframe, "H1");
  const trace = evaluateAudusdStrategyTrace(history.candles);
  assert.equal(trace.error, null, trace.error ?? undefined);
  const indexByTime = new Map(history.candles.map((bar, index) => [bar.time, index]));
  const research: Trade[] = [];
  const executable: Trade[] = [];
  let missingFutureBars = 0;

  for (const signal of trace.rows.filter((row) => row.finalLongSignal)) {
    const index = indexByTime.get(signal.timestamp);
    if (index === undefined || signal.signalClose === null || signal.atr14 === null) continue;
    const future = exactFutureBars(history.candles, index);
    if (!future) {
      missingFutureBars += 1;
      continue;
    }
    const year = new Date(signal.timestamp).getUTCFullYear();
    research.push({ timestamp: signal.timestamp, year, tag: signal.confidenceTag, ...resolveLong(signal.signalClose, signal.atr14, future.map((bar) => bar.mid)) });
    const actualEntry = history.candles[index]!.ask.close;
    executable.push({ timestamp: signal.timestamp, year, tag: signal.confidenceTag, ...resolveLong(actualEntry, signal.atr14, future.map((bar) => bar.bid)) });
  }

  console.log(JSON.stringify({
    strategyId: "audusd_strategy",
    strategyVersion: "AUDUSD_STRONG_CONS_STRUCTURE_V1",
    source: history.source,
    requestedPeriod: { from: history.from, to: history.to },
    actualPeriod: { from: history.candles[0]?.time ?? null, to: history.candles.at(-1)?.time ?? null, completedCandles: history.candles.length },
    signalCount: trace.rows.filter((row) => row.finalLongSignal).length,
    missingFutureBars,
    historicalResearchMidpoint: metrics(research),
    bodyExtremeResearchMidpoint: metrics(research.filter((trade) => trade.tag === "AUDUSD_BODY_EXTREME")),
    executableBidAsk: metrics(executable),
    expectedApproximateResearch: {
      trades: 195, positiveRate: 0.492, tpRate: 0.231, slRate: 0.446,
      timeExitRate: 0.323, profitFactor: 1.442, expectancyR: 0.210, bodyExtreme: 46,
    },
    ambiguityRule: "SL first when both barriers occur inside the same H1 candle",
    timeExitRule: "close of the third future completed H1 candle",
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
