import assert from "node:assert/strict";
import { analyzeTrend, candleCloseAt, closedBy, DAY, DEFAULT_CONFIG, replay, toBars, type Config, type Granularity, type Series, type TrendReader } from "./lib/eurusd-analyze-hold.js";
import type { ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

const START = Date.parse("2026-09-07T08:00:00Z"), M15 = 900_000;
const near = (actual: number, expected: number, message = "") => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
function candle(at: number, open: number, close = open, high = Math.max(open, close), low = Math.min(open, close)): ResearchCandle {
  const offset = (spread: number) => ({ open: open + spread, close: close + spread, high: high + spread, low: low + spread });
  return { time: new Date(at).toISOString(), volume: 100, complete: true, mid: offset(0), bid: offset(-0.00005), ask: offset(0.00005) };
}
function series(candles: ResearchCandle[]): Series {
  return { M15: toBars(candles, "M15"), H1: [], H4: [], D: [] };
}
const cfg = (overrides: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, since: START, until: START + 40 * DAY,
  slippagePips: 0, longAnnualFinancingPct: 0, shortAnnualFinancingPct: 0, ...overrides });
const trend = (direction: "UPTREND" | "DOWNTREND" = "UPTREND"): TrendReader => () => ({ direction, usable: true, atr: 0.001, alignment: "ALIGNED", evidence: ["test fixture"] });

// Long: ignore a severe loss and reversal; exit only when still profitable
// after a >= 15 pip retreat from favorable CLOSED primary prices.
const prices = [1.10, 1.10, 1.105, 1.103, 1.102];
let data = series(prices.map((price, i) => candle(START + i * M15, price, price, price + 0.0001, i === 1 ? 1.08 : price - 0.0001)));
let run = replay(data, cfg(), trend());
let trade = run.trades[0]!;
assert.equal(trade.enteredAt, START + M15, "Entry must use next bar open");
assert.equal(trade.reason, "major_pullback");
assert.equal(trade.exitSignalAt, START + 4 * M15);
assert.equal(trade.markedAt, START + 4 * M15, "Exit fills at next open, not the detection close price");
near(trade.entry, 1.10005); near(trade.exitPrice, 1.10195);
near(trade.netPips, 19);
assert.ok(trade.maePips > 200, "No stop can conceal the floating loss");
assert.ok(run.summary.maxDrawdownUsd > 200);

// Mirror long and short bid/ask fills and pullback geometry.
data = series(prices.map((price, i) => candle(START + i * M15, 2.2 - price)));
trade = replay(data, cfg(), trend("DOWNTREND")).trades[0]!;
assert.equal(trade.reason, "major_pullback"); near(trade.netPips, 19);

// Huge intrabar high does not become a fictitious peak before its low.
data = series([candle(START, 1.1), candle(START + M15, 1.101, 1.101, 1.12, 1.1005), candle(START + 2 * M15, 1.101)]);
trade = replay(data, cfg(), trend()).trades[0]!;
assert.equal(trade.reason, "open");

// A formerly profitable trade that gives everything back is STILL held.
data = series([1.1, 1.1, 1.104, 1.099, 1.098].map((price, i) => candle(START + i * M15, price)));
assert.equal(replay(data, cfg(), trend()).trades[0]!.reason, "open");

// Exact 14 calendar days from actual entry, not signal and not time of loss.
const entered = START + M15;
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + 14 * DAY - M15, 1.09), candle(entered + 14 * DAY, 1.089)]);
trade = replay(data, cfg(), trend()).trades[0]!;
assert.equal(trade.reason, "loss_timeout"); near(trade.heldDays, 14);
assert.equal(trade.exitSignalAt, entered + 14 * DAY);

// Loss deadline can fall during a weekend/data gap; execute first available open.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + 14 * DAY - M15, 1.09), candle(entered + 16 * DAY, 1.08)]);
trade = replay(data, cfg(), trend()).trades[0]!;
assert.equal(trade.reason, "loss_timeout"); near(trade.heldDays, 16);

// Profitable at day 14: stay open. Turn losing at day 15: close next open.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + 14 * DAY, 1.101), candle(entered + 15 * DAY, 1.099), candle(entered + 15 * DAY + M15, 1.098)]);
trade = replay(data, cfg(), trend()).trades[0]!;
assert.equal(trade.reason, "loss_timeout"); assert.ok(trade.heldDays > 14);
assert.equal(trade.exitSignalAt, entered + 15 * DAY + M15);

// Net P&L governs profitability: estimated costs can outweigh price gains.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + 14 * DAY - M15, 1.1002), candle(entered + 14 * DAY, 1.1002)]);
trade = replay(data, cfg({ longAnnualFinancingPct: 10 }), trend()).trades[0]!;
assert.equal(trade.reason, "loss_timeout"); assert.ok(trade.grossPips > 0 && trade.netUsd < 0);
near(trade.financingUsd, trade.entry * 10_000 * 0.1 * 14 / 365);

// Pullback exit can become a losing fill after a gap (no guaranteed profit).
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + M15, 1.105), candle(entered + 2 * M15, 1.103), candle(entered + 2 * DAY, 1.09)]);
trade = replay(data, cfg(), trend()).trades[0]!;
assert.equal(trade.reason, "major_pullback"); assert.ok(trade.netUsd < 0);

// A queued strategy exit cannot conceal a margin liquidation at the next open.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + M15, 1.105), candle(entered + 2 * M15, 1.103), candle(entered + 2 * DAY, 1.0)]);
run = replay(data, cfg({ initialUsd: 500 }), trend());
assert.equal(run.trades[0]!.reason, "margin_closeout");
assert.equal(run.trades[0]!.markedAt, entered + 2 * DAY);
assert.ok(run.diagnostics.halted);

// Entry signal expires across a gap instead of filling on stale direction.
data = series([candle(START, 1.1), candle(START + 2 * DAY, 1.1)]);
run = replay(data, cfg(), trend());
assert.equal(run.trades.length, 0); assert.equal(run.diagnostics.expiredEntrySignals, 1);

// Margin can liquidate long/short BEFORE 14 days; account stops afterward.
for (const side of ["UPTREND", "DOWNTREND"] as const) {
  const up = side === "UPTREND";
  data = series([candle(START, 1.1), candle(entered, 1.1, 1.1, up ? 1.1 : 1.2, up ? 1.0 : 1.1), candle(entered + M15, 1.1)]);
  run = replay(data, cfg({ initialUsd: 500 }), trend(side));
  assert.equal(run.trades.length, 1); assert.equal(run.trades[0]!.reason, "margin_closeout");
  near(run.summary.finalEquityUsd, run.trades[0]!.entry * 10_000 / 30 * 0.5);
  assert.ok(run.diagnostics.halted && run.trades[0]!.heldDays < 14);
}
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + M15, 1.0)]);
run = replay(data, cfg({ initialUsd: 500 }), trend());
assert.equal(run.trades[0]!.reason, "margin_closeout");
assert.ok(run.summary.finalEquityUsd < 0, "Do not cap gap losses at zero");
assert.equal(replay(data, cfg({ initialUsd: 100 }), trend()).diagnostics.marginRejected, 2);

// Terminal mark-to-market is excluded from win rate/PF and balance but in NAV.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + M15, 1.102)]);
run = replay(data, cfg({ slippagePips: 0.2, commissionPerMillion: 10 }), trend());
assert.equal(run.summary.closedTrades, 0); assert.equal(run.summary.openTrades, 1);
assert.equal(run.summary.winRate, null); assert.equal(run.summary.profitFactor, null);
near(run.summary.finalEquityUsd, 10_000 + run.summary.unrealizedNetUsd);
near(run.trades[0]!.entry, 1.10007); near(run.trades[0]!.exitPrice, 1.10193);
assert.ok(run.summary.commissionUsd > 0);

// SWING pullback exits observe H4 closes; timeout still observes each M15.
const swing = series([1.1, 1.1, 1.105, 1.102, 1.102].map((price, i) => candle(START + i * M15, price)));
swing.H4 = [swing.M15[0]!, swing.M15[2]!];
assert.equal(replay(swing, cfg({ mode: "SWING" }), trend()).trades[0]!.reason, "open");

// Analyze's actual foundation cannot see unclosed higher bars or future data.
const real: Series = { M15: [], H1: [], H4: [], D: [] };
for (const [granularity, step] of Object.entries({ M15, H1: 4 * M15, H4: 16 * M15, D: DAY })) {
  const raw = Array.from({ length: 310 }, (_, i) => candle(START - (310 - i) * step, 1.1 + i * 0.0001 + Math.sin(i * 0.5) * 0.001));
  real[granularity as Granularity] = toBars(raw, granularity as Granularity);
}
const nowBar = toBars([candle(START, 1.131)], "M15")[0]!;
const before = analyzeTrend(real, nowBar, "NORMAL");
const withFuture: Series = { ...real, H1: [...real.H1, ...toBars([candle(START, 1.0, 2.0)], "H1")], M15: [...real.M15, ...toBars([candle(START + 2 * M15, 2.0)], "M15")] };
assert.deepEqual(analyzeTrend(withFuture, nowBar, "NORMAL"), before);
assert.ok(closedBy(withFuture.H1, nowBar.closeAt).every(c => Date.parse(c.time) + 4 * M15 <= nowBar.closeAt));
assert.equal(analyzeTrend({ M15: [], H1: [], H4: [], D: [] }, nowBar, "NORMAL").usable, false);

// OANDA's daily alignment must not expose a daily bar early across DST.
assert.equal(candleCloseAt(Date.parse("2026-03-07T22:00:00Z"), "D"), Date.parse("2026-03-08T21:00:00Z"));
assert.equal(candleCloseAt(Date.parse("2026-10-31T21:00:00Z"), "D"), Date.parse("2026-11-01T22:00:00Z"));
assert.throws(() => replay(data, cfg({ pullbackAtr: 0 }), trend()));
assert.throws(() => replay(data, cfg({ commissionPerMillion: 1_000_000 }), trend()));
assert.throws(() => toBars([candle(START, Number.NaN)], "M15"));
const forming = { ...candle(START, 1.1), complete: false };
assert.equal(toBars([forming], "M15").length, 0);

// Stop activation is intrabar on raw bid/ask, fills at stop + slippage,
// checks the entry bar, and takes precedence over the close pullback rule.
for (const direction of ["UPTREND", "DOWNTREND"] as const) {
  const up = direction === "UPTREND";
  data = series([candle(START, 1.1), candle(entered, 1.1, up ? 1.105 : 1.095, up ? 1.106 : 1.102, up ? 1.098 : 1.094)]);
  run = replay(data, cfg({ slippagePips: 0.2, stopLoss: { kind: "pips", value: 10 } }), trend(direction));
  trade = run.trades[0]!;
  assert.equal(trade.reason, "stop_loss"); near(trade.netPips, -10.2);
  near(trade.maePips, 10.2);
  assert.equal(run.summary.closedTrades, 1);
}
// ATR stops are frozen to the known entry snapshot, not future volatility.
data = series([candle(START, 1.1), candle(entered, 1.1, 1.1, 1.101, 1.09)]);
trade = replay(data, cfg({ stopLoss: { kind: "atr", value: 2 } }), trend()).trades[0]!;
assert.equal(trade.reason, "stop_loss"); near(trade.netPips, -20);

// Opening gaps are not magically filled at the old stop price.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + 2 * DAY, 1.09)]);
trade = replay(data, cfg({ stopLoss: { kind: "pips", value: 10 } }), trend()).trades[0]!;
assert.equal(trade.reason, "stop_loss"); near(trade.exitPrice, 1.08995);
assert.ok(trade.netPips < -100);

// Slippage affects the fill, not the quote that activates a stop.
data = series([candle(START, 1.1), candle(entered, 1.1, 1.1, 1.1, 1.09913)]);
trade = replay(data, cfg({ slippagePips: 0.2, stopLoss: { kind: "pips", value: 10 } }), trend()).trades[0]!;
assert.equal(trade.reason, "open", "A bid still above the stop must not trigger merely because hypothetical exit slippage crosses it");

// A live stop takes priority over a queued pullback exit on a gapped open.
data = series([candle(START, 1.1), candle(entered, 1.1), candle(entered + M15, 1.105), candle(entered + 2 * M15, 1.103), candle(entered + 2 * DAY, 1.09)]);
trade = replay(data, cfg({ stopLoss: { kind: "pips", value: 10 } }), trend()).trades[0]!;
assert.equal(trade.reason, "stop_loss"); near(trade.exitPrice, 1.08995);

// Both thresholds in one OHLC bar: closer protective stop wins, whereas
// a stop beyond liquidation cannot prevent the earlier margin closeout.
data = series([candle(START, 1.1), candle(entered, 1.1, 1.1, 1.1, 1.0)]);
run = replay(data, cfg({ initialUsd: 500, stopLoss: { kind: "pips", value: 100 } }), trend());
assert.equal(run.trades[0]!.reason, "stop_loss"); assert.equal(run.diagnostics.halted, false);
run = replay(data, cfg({ initialUsd: 500, stopLoss: { kind: "pips", value: 1000 } }), trend());
assert.equal(run.trades[0]!.reason, "margin_closeout"); assert.equal(run.diagnostics.halted, true);
assert.throws(() => replay(data, cfg({ stopLoss: { kind: "pips", value: 0 } }), trend()));
console.log("EURUSD Analyze hold: execution, costs, 14-day rules, pullback, margin, floating drawdown, causal Analyze data and DST tests passed.");
