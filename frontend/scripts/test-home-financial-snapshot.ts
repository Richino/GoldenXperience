import assert from "node:assert/strict";
import { historyAtSnapshot, snapshotFills, type HomeFinancialSnapshot } from "../src/lib/home/financial-snapshot";

const snapshot: HomeFinancialSnapshot = {
  data: { id: "practice", alias: "Practice", currency: "USD", balance: 10_100, nav: 9_900, unrealizedPL: -200, marginUsed: 200, marginAvailable: 9_700, openTradeCount: 2, hedgingEnabled: true, source: "oanda" },
  positions: [
    { id: "1", instrument: "EUR_USD", pair: "EUR/USD", direction: "long", units: 10_000, entryPrice: 1.1, currentPrice: 1.09, unrealizedPL: -100, openedAt: "2026-10-28T12:00:00Z", source: "oanda" },
    { id: "2", instrument: "EUR_USD", pair: "EUR/USD", direction: "long", units: 10_000, entryPrice: 1.1, currentPrice: 1.09, unrealizedPL: -100, openedAt: "2026-10-28T12:00:00Z", source: "oanda" },
  ],
  history: [{ id: "20", time: "2026-10-28T12:00:00Z", balance: 10_100, change: 100, type: "ORDER_FILL" }],
  checkedAt: "2026-10-28T12:05:00Z", lastTransactionID: "21",
};
const fills = snapshotFills(snapshot);
assert.equal(fills["broker:1"].unrealizedPL + fills["broker:2"].unrealizedPL, snapshot.data.unrealizedPL, "same-pair trades must not collapse into one position");
assert.equal(snapshot.data.balance + snapshot.data.unrealizedPL, snapshot.data.nav);
assert.throws(() => snapshotFills({ ...snapshot, data: { ...snapshot.data, unrealizedPL: -150, nav: 9_950 } }), /P\/L disagree/, "reject mixing the next account poll with older fills");
assert.throws(() => snapshotFills({ ...snapshot, data: { ...snapshot.data, source: "mock" } }));
assert.throws(() => snapshotFills({ ...snapshot, positions: [] }), /Invalid account/, "a failed position read cannot become an empty successful frame");
const history = historyAtSnapshot([...snapshot.history, { ...snapshot.history[0], id: "22", balance: 10_200 }], "21", 10_100);
assert.equal(history.length, 1, "a close during a history read must wait for the next financial frame");
assert.throws(() => historyAtSnapshot(snapshot.history, "21", 10_200), /caught up/, "stale history cannot be paired with a newer balance");
assert.equal(historyAtSnapshot([], "21", 10_100).length, 0, "accounts without movements have a valid empty history");
const realized = history.reduce((sum, point) => sum + point.change, 0);
const dayPL = realized + snapshot.data.unrealizedPL;
assert.equal(dayPL, -100);
assert.equal(snapshot.data.nav - dayPL, 10_000, "daily amount, percent baseline and chart use the same frame");
console.log("Passed synchronized account/position P/L, duplicate-pair trades, history boundary, stale-frame rejection and daily arithmetic checks.");
