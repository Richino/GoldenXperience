import assert from "node:assert/strict";

import { evaluateNzdusdStrategyTrace } from "../src/lib/strategy/strategies/nzdusd-strategy";
import { loadNzdusdHistory, type NzdusdHistoryCandle, type NzdusdPriceBar } from "./nzdusd-history";

type ExitReason = "TP" | "SL" | "TIME_EXIT";
type Trade = { timestamp: string; year: number; direction: "long" | "short"; tag: string; exitReason: ExitReason; resultR: number };

function resolveTrade(direction: "long" | "short", entry: number, atr: number, future: readonly NzdusdPriceBar[]) {
  const stop = direction === "long" ? entry - atr : entry + atr;
  const target = direction === "long" ? entry + 2 * atr : entry - 2 * atr;
  for (const bar of future) {
    const stopHit = direction === "long" ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === "long" ? bar.high >= target : bar.low <= target;
    if (stopHit) return { exitReason: "SL" as const, resultR: -1 };
    if (targetHit) return { exitReason: "TP" as const, resultR: 2 };
  }
  const exit = future[2]!.close;
  return { exitReason: "TIME_EXIT" as const, resultR: direction === "long" ? (exit - entry) / atr : (entry - exit) / atr };
}

function metrics(trades: readonly Trade[]) {
  const positive = trades.filter((trade) => trade.resultR > 0);
  const grossProfit = positive.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0));
  const expectancy = (rows: readonly Trade[]) => rows.length ? rows.reduce((sum, trade) => sum + trade.resultR, 0) / rows.length : null;
  return {
    trades: trades.length,
    profitableTrades: positive.length,
    nonProfitableTrades: trades.length - positive.length,
    profitableRate: trades.length ? positive.length / trades.length : null,
    tp: trades.filter((trade) => trade.exitReason === "TP").length,
    sl: trades.filter((trade) => trade.exitReason === "SL").length,
    timeExit: trades.filter((trade) => trade.exitReason === "TIME_EXIT").length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancyR: expectancy(trades),
    longExpectancyR: expectancy(trades.filter((trade) => trade.direction === "long")),
    shortExpectancyR: expectancy(trades.filter((trade) => trade.direction === "short")),
    body: trades.filter((trade) => trade.tag === "NZDUSD_BODY").length,
    base: trades.filter((trade) => trade.tag === "NZDUSD_BASE").length,
    yearlyExpectancy: Object.fromEntries([...new Set(trades.map((trade) => trade.year))].sort().map((year) => {
      const rows = trades.filter((trade) => trade.year === year);
      return [year, expectancy(rows)];
    })),
  };
}

function exactFutureBars(bars: readonly NzdusdHistoryCandle[], index: number) {
  const originMs = Date.parse(bars[index]!.time);
  const future = bars.slice(index + 1, index + 4);
  return future.length === 3 && future.every((bar, offset) => Date.parse(bar.time) === originMs + (offset + 1) * 60 * 60_000)
    ? future : null;
}

async function main() {
  const history = await loadNzdusdHistory(process.argv[2]);
  assert.equal(history.symbol, "NZD_USD");
  assert.equal(history.timeframe, "H1");
  const trace = evaluateNzdusdStrategyTrace(history.candles);
  assert.equal(trace.error, null, trace.error ?? undefined);
  const indexByTime = new Map(history.candles.map((bar, index) => [bar.time, index]));
  const research: Trade[] = [];
  const executable: Trade[] = [];
  let missingFutureBars = 0;

  for (const signal of trace.rows.filter((row) => row.finalLongSignal || row.finalShortSignal)) {
    const index = indexByTime.get(signal.timestamp);
    const direction = signal.finalLongSignal ? "long" as const : "short" as const;
    if (index === undefined || signal.atr14 === null) continue;
    const future = exactFutureBars(history.candles, index);
    if (!future) {
      missingFutureBars += 1;
      continue;
    }
    const common = { timestamp: signal.timestamp, year: new Date(signal.timestamp).getUTCFullYear(), direction, tag: signal.confidenceTag };
    research.push({ ...common, ...resolveTrade(direction, signal.signalClose, signal.atr14, future.map((bar) => bar.mid)) });
    const executableEntry = direction === "long" ? history.candles[index]!.ask.close : history.candles[index]!.bid.close;
    const executableBars = future.map((bar) => direction === "long" ? bar.bid : bar.ask);
    executable.push({ ...common, ...resolveTrade(direction, executableEntry, signal.atr14, executableBars) });
  }

  console.log(JSON.stringify({
    strategyId: "nzdusd_strategy",
    strategyVersion: "NZDUSD_PRE_RANGE_BREAKOUT_V1",
    source: history.source,
    requestedPeriod: { from: history.from, to: history.to },
    actualPeriod: { from: history.candles[0]?.time ?? null, to: history.candles.at(-1)?.time ?? null, completedCandles: history.candles.length },
    totalSignals: trace.rows.filter((row) => row.finalLongSignal || row.finalShortSignal).length,
    missingFutureBars,
    historicalResearchMidpoint: metrics(research),
    executableBidAsk: metrics(executable),
    expectedResearch: {
      trades: 100, profitableTrades: 47, profitableRate: 0.47, tp: 23, sl: 45, timeExit: 32,
      profitFactor: 1.318, expectancyR: 0.152, longExpectancyR: 0.241, shortExpectancyR: 0.094,
      body: 73, base: 27, yearlyExpectancy: { 2023: -0.042, 2024: 0.282, 2025: 0.290, 2026: 0.147 },
    },
    expectedExecutablePineProfitFactor: 1.277,
    ambiguityRule: "SL first when both barriers occur inside the same H1 candle",
    timeExitRule: "close of the third contiguous future completed H1 candle",
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
