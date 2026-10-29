import assert from "node:assert/strict";
import type { JournalTrade } from "../src/types/forex";
import type { PendingManualEntry } from "../src/types/pending-entry";
import { activeEntryOrders, entryOrderHref, entryOrderStatus, orderMatchesPair } from "../src/lib/journal/active-orders";

const entry = (id: string, patch: Partial<PendingManualEntry> = {}): PendingManualEntry => ({
  id, instrument: "EUR_USD", direction: "long", entryPrice: 1.12, entryOrderType: "buy_stop", currentPriceAtCreation: 1.11,
  expirationType: "none", expiresAt: null, activateAt: null, invalidationPrice: null, status: "PENDING", triggerPrice: null,
  stopPrice: null, targetPrice: null, paperTradeId: null, paperTradeStatus: null, failureReason: null, triggeredAt: null,
  cancelledAt: null, createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T10:00:00Z", metadata: {}, ...patch,
});
const trade = { id: "filled-trade", status: "open", instrument: "EUR_USD", brokerTradeId: "42" } as JournalTrade;
const pending = entry("pending");
const short = entry("short", { direction: "short", entryOrderType: "sell_stop", metadata: { linkedOco: true, straddleId: "group" } });
const cross = entry("cross", { instrument: "GBP_JPY" });
const filled = entry("filled", { status: "TRIGGERED", paperTradeId: trade.id, paperTradeStatus: "open" });
const brokerLinked = entry("broker-linked", { status: "TRIGGERING", metadata: { brokerTradeId: "42" } });
const unknownFill = entry("unknown-fill", { status: "TRIGGERED", paperTradeId: "not-yet-journaled" });
const all = activeEntryOrders([pending, short, cross, filled, brokerLinked, unknownFill, entry("closed", { status: "TRIGGERED", paperTradeStatus: "closed" }), entry("cancelled", { status: "CANCELLED" }), entry("expired", { status: "EXPIRED" }), entry("failed", { status: "FAILED" })], [trade]);
assert.deepEqual(new Set(all.map(e => e.id)), new Set(["pending", "short", "cross", "unknown-fill"]));
assert.equal(all.length + [trade].length, 5, "Pending entries and open positions share the Orders count without duplicate fills");
assert.equal(entryOrderStatus(unknownFill), "Filled · syncing");
assert.equal(entryOrderStatus(entry("checking", { status: "TRIGGERING" })), "Checking broker");
assert.equal(entryOrderStatus(entry("scheduled", { activateAt: "2026-10-30T10:00:00Z" }), Date.parse("2026-10-29T10:00:00Z")), "Scheduled");
assert.equal(entryOrderStatus(entry("submitting", { metadata: { execution: "submitting" } })), "Submitting");
assert.equal(entryOrderStatus(pending), "Pending");
assert.equal(activeEntryOrders([pending, { ...pending, status: "CANCELLED", updatedAt: "2026-10-29T10:01:00Z" }], []).length, 0, "Newest status wins for duplicate snapshots");
for (const search of ["eurusd", "EUR/USD", "eur_usd"]) assert.ok(orderMatchesPair(pending.instrument, search));
assert.ok(!orderMatchesPair(cross.instrument, "EURUSD"));
assert.equal(entryOrderHref(pending), "/chart?instrument=EUR_USD&order=pending");
assert.equal(activeEntryOrders([], []).length, 0);
console.log("Active orders passed: cross-pair aggregation, two OCO legs, fill deduplication, reconciliation visibility, terminal states, search, scheduled status and exact-order links.");
