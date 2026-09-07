import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

import {
  evaluateUsdjpyStrategy, resolveUsdjpyExit,
} from "../src/lib/strategy/strategies/usdjpy-strategy";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

type PriceBar = { open: number; high: number; low: number; close: number };
type ExecutableCandle = Candle & { bid: PriceBar; ask: PriceBar };
type BacktestFixture = { symbol: "USD_JPY"; timeframe: "H1"; candles: ExecutableCandle[] };

async function main() {
  const fixturePath = process.argv[2];
  let fixture: BacktestFixture;
  let source: string;
  if (fixturePath) {
    fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as BacktestFixture;
    source = resolve(fixturePath);
  } else {
    loadEnvConfig(resolve(process.cwd(), "../api-server"));
    const { getResearchCandles } = await import("../src/lib/oanda/client");
    const oanda = await getResearchCandles("USD_JPY", "H1", 5_000);
    fixture = {
      symbol: "USD_JPY",
      timeframe: "H1",
      candles: oanda.map((bar) => ({
        time: bar.time, volume: bar.volume, complete: bar.complete,
        ...bar.mid, bid: bar.bid, ask: bar.ask,
      })),
    };
    source = "OANDA practice API, latest 5,000 H1 bid/ask/mid candles";
  }
  assert.equal(fixture.symbol, "USD_JPY");
  assert.equal(fixture.timeframe, "H1");
  const bars = [...fixture.candles].filter((bar) => bar.complete)
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  let active: {
    direction: "long" | "short";
    decisionTime: string;
    signalPrice: number;
    actualEntry: number;
    stop: number;
    target: number;
    entryATR: number;
  } | null = null;
  const trades: Array<Record<string, unknown>> = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (active) {
      const quotes = bars.slice(0, index + 1).map((item) => ({
        closeTime: new Date(Date.parse(item.time) + 60 * 60_000).toISOString(),
        bidHigh: item.bid.high, bidLow: item.bid.low, bidClose: item.bid.close,
        askHigh: item.ask.high, askLow: item.ask.low, askClose: item.ask.close,
      }));
      const now = new Date(Date.parse(bar.time) + 60 * 60_000);
      const result = resolveUsdjpyExit({ ...active, entry: active.actualEntry, quotes, now });
      if (result) {
        trades.push({ ...active, ...result });
        active = null;
      }
    }
    if (active) continue;

    const prefix = bars.slice(0, index + 1);
    const input: StrategyEvaluationInput = {
      instrument: "USD_JPY",
      accountBalance: 10_000,
      accountCurrency: "USD",
      dataSource: "oanda",
      candles15m: [],
      candles1h: prefix,
      candles4h: [],
      bid: bar.bid.close,
      ask: bar.ask.close,
      spreadPips: (bar.ask.close - bar.bid.close) / 0.01,
      marketOpen: true,
      calendarConnected: true,
      highImpactNewsWithinMinutes: null,
      evaluationMode: "historical_replay",
    };
    const candidate = evaluateUsdjpyStrategy(input, { timeframe: "H1", hasActivePosition: false });
    if (candidate.status !== "valid" || !candidate.direction || candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
    const metadata = candidate.features.usdjpyStrategy!;
    active = {
      direction: candidate.direction,
      decisionTime: candidate.evaluatedAt,
      signalPrice: metadata.signalPrice!,
      actualEntry: candidate.entry,
      stop: candidate.stop,
      target: candidate.target,
      entryATR: metadata.entryATR!,
    };
  }
  if (active) trades.push({ ...active, outcome: "open" });
  const resolvedTrades = trades.filter((trade) => typeof trade.resultR === "number");
  const totalR = resolvedTrades.reduce((sum, trade) => sum + Number(trade.resultR), 0);
  console.log(JSON.stringify({
    strategyId: "usdjpy_strategy",
    setup: "USDJPY_BODY_EXTREME",
    version: "v6",
    execution: "long ask entry; bid exits; same-candle stop-first",
    maxHoldBars: 3,
    source,
    period: bars.length ? { from: bars[0]!.time, to: bars.at(-1)!.time, candles: bars.length } : null,
    trades,
    resolved: resolvedTrades.length,
    totalR,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
