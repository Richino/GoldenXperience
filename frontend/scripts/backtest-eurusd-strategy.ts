import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateEurusdStrategy } from "../src/lib/strategy/strategies/eurusd-strategy";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

type PriceBar = { open: number; high: number; low: number; close: number };
type ExecutableCandle = Candle & { bid: PriceBar; ask: PriceBar };
type BacktestFixture = { symbol: "EUR_USD"; timeframe: "H1"; candles: ExecutableCandle[] };

/**
 * Offline, fixture-only future backtest harness. Signals use the mid H1 candle;
 * long exits use bid and short exits use ask. If stop and target occur in the
 * same later H1 candle, the stop wins conservatively. No network or OANDA order
 * path is present here.
 */
async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("Usage: npm run eurusd-strategy:backtest -- <bid-ask-h1-fixture.json>");
  const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as BacktestFixture;
  assert.equal(fixture.symbol, "EUR_USD");
  assert.equal(fixture.timeframe, "H1");
  const bars = [...fixture.candles].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  let active: { direction: "long" | "short"; signalEntryReference: number; actualEntry: number; stop: number; target: number; openedAt: string } | null = null;
  const trades: Array<Record<string, unknown>> = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (active && Date.parse(bar.time) > Date.parse(active.openedAt)) {
      const exitBar = active.direction === "long" ? bar.bid : bar.ask;
      const stopHit = active.direction === "long" ? exitBar.low <= active.stop : exitBar.high >= active.stop;
      const targetHit = active.direction === "long" ? exitBar.high >= active.target : exitBar.low <= active.target;
      if (stopHit || targetHit) {
        const exit = stopHit ? active.stop : active.target;
        const risk = Math.abs(active.actualEntry - active.stop);
        const pnl = active.direction === "long" ? exit - active.actualEntry : active.actualEntry - exit;
        const resultR = risk > 0 ? pnl / risk : null;
        trades.push({ ...active, closedAt: bar.time, exit, resultR });
        active = null;
      }
    }
    if (active) continue;
    const prefix = bars.slice(0, index + 1);
    const input: StrategyEvaluationInput = {
      instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: [], candles1h: prefix, candles4h: [], bid: bar.bid.close, ask: bar.ask.close,
      spreadPips: (bar.ask.close - bar.bid.close) / 0.0001, marketOpen: true,
      calendarConnected: true, highImpactNewsWithinMinutes: null, evaluationMode: "historical_replay",
    };
    const candidate = evaluateEurusdStrategy(input, { timeframe: "H1", hasActivePosition: false });
    if (candidate.status !== "valid" || !candidate.direction || candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
    const actualEntry = candidate.direction === "long" ? bar.ask.close : bar.bid.close;
    const correctlyOrdered = candidate.direction === "long"
      ? candidate.stop < actualEntry && actualEntry < candidate.target
      : candidate.target < actualEntry && actualEntry < candidate.stop;
    if (!Number.isFinite(actualEntry) || !correctlyOrdered) continue;
    active = {
      direction: candidate.direction,
      signalEntryReference: candidate.entry,
      actualEntry,
      stop: candidate.stop,
      target: candidate.target,
      openedAt: bar.time,
    };
  }
  if (active) trades.push({ ...active, closedAt: null, exit: null, resultR: null });
  const resolved = trades.filter((trade) => typeof trade.resultR === "number");
  const totalR = resolved.reduce((sum, trade) => sum + Number(trade.resultR), 0);
  console.log(JSON.stringify({ strategyId: "eurusd_strategy", setup: "A_LONDON_BO", trades, resolved: resolved.length, totalR }, null, 2));
}

await main();
