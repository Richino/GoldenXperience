import assert from "node:assert/strict";
import { decidePendingManualEntryEvent, inferPendingOrderType } from "../src/pending-manual-entries.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { practiceOrderStateFromTransactions } from "../../frontend/src/lib/oanda/client.js";

assert.equal(inferPendingOrderType("long", 0.582, 0.58129), "buy_stop");
assert.equal(inferPendingOrderType("long", 0.5805, 0.58129), "buy_limit");
assert.equal(inferPendingOrderType("short", 0.582, 0.58129), "sell_limit");
assert.equal(inferPendingOrderType("short", 0.5805, 0.58129), "sell_stop");

assert.ok(Math.abs((0.582 - 0.58129) / pipSizeFor("NZD_USD") - 7.1) < 1e-9);
assert.equal(pipSizeFor("AUD_JPY"), 0.01);
assert.equal(pipSizeFor("NZD_USD"), 0.0001);

const tickTime = new Date("2026-09-11T13:00:00.000Z");
assert.equal(decidePendingManualEntryEvent({
  entryOrderType: "buy_stop", entryPrice: 1.2, invalidationPrice: null, invalidationSide: null,
  previousPrice: 1.19, currentPrice: 1.2, expiresAt: null, tickTime,
}), "entry");
assert.equal(decidePendingManualEntryEvent({
  entryOrderType: "buy_stop", entryPrice: 1.2, invalidationPrice: 1.1, invalidationSide: "above",
  previousPrice: 1, currentPrice: 1.21, expiresAt: null, tickTime,
}), "invalidation");
assert.equal(decidePendingManualEntryEvent({
  entryOrderType: "buy_stop", entryPrice: 1.1, invalidationPrice: 1.2, invalidationSide: "above",
  previousPrice: 1, currentPrice: 1.21, expiresAt: null, tickTime,
}), "entry");
assert.equal(decidePendingManualEntryEvent({
  entryOrderType: "sell_stop", entryPrice: 1.1, invalidationPrice: null, invalidationSide: null,
  previousPrice: 1.11, currentPrice: 1.09, expiresAt: "2026-09-11T12:59:59.000Z", tickTime,
}), "expired");
assert.equal(decidePendingManualEntryEvent({
  entryOrderType: "sell_limit", entryPrice: 1.2, invalidationPrice: 1.05, invalidationSide: "below",
  previousPrice: 1.1, currentPrice: 1.11, expiresAt: null, tickTime,
}), null);

assert.deepEqual(practiceOrderStateFromTransactions("1516", [
  { id: "1517", time: tickTime.toISOString(), type: "ORDER_FILL", orderID: "1516", price: "154.103", tradeOpened: { tradeID: "1518" } },
]), { state: "FILLED", tradeId: "1518", fillPrice: 154.103 });
assert.deepEqual(practiceOrderStateFromTransactions("1516", [
  { id: "1517", time: tickTime.toISOString(), type: "ORDER_CANCEL", orderID: "1516" },
]), { state: "CANCELLED", tradeId: null, fillPrice: null });
assert.equal(practiceOrderStateFromTransactions("1516", [
  { id: "1517", time: tickTime.toISOString(), type: "ORDER_FILL", orderID: "1515", price: "154.103" },
]), null);

console.log("Pending manual entry checks passed.");
