import assert from "node:assert/strict";
import { newsZoneOverlay, zonesAround } from "../src/lib/news/news-zone-overlay";
import type { PendingManualEntry } from "../src/types/pending-entry";

/**
 * The chart's News zones are a pure function of the server's rows, so a
 * refresh, reconnect or second device draws exactly the same thing, and
 * only the selected instrument's setups are drawn.
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const now = Date.parse("2026-10-16T12:29:30Z");
const zones = { buy: { lower: 210.695, upper: 210.725 }, sell: { lower: 210.465, upper: 210.495 } };
function setup(state: string, extra: Record<string, unknown> = {}, instrument = "GBP_JPY", statuses: [string, string] = ["PENDING", "PENDING"]): PendingManualEntry[] {
  const base = {
    mode: "news", straddleId: `s-${state}-${instrument}`, newsState: state, distancePips: 10, slippagePips: 3,
    lockAt: "2026-10-16T12:29:00Z", release: { time: "2026-10-16T12:30:00Z" }, ...extra,
  };
  const row = (id: string, direction: "long" | "short", line: "upper" | "lower", status: string): PendingManualEntry => ({
    id, instrument, direction, entryPrice: 210.695, entryOrderType: direction === "long" ? "buy_stop" : "sell_stop", currentPriceAtCreation: 210.595,
    expirationType: "time", expiresAt: "2026-10-16T12:45:00Z", activateAt: null, invalidationPrice: null, status: status as PendingManualEntry["status"],
    triggerPrice: null, stopPrice: null, targetPrice: null, paperTradeId: status === "TRIGGERED" ? "trade-1" : null, paperTradeStatus: null,
    failureReason: null, triggeredAt: null, cancelledAt: null, createdAt: "2026-10-16T11:00:00Z", updatedAt: "2026-10-16T12:31:00Z",
    metadata: { ...base, line },
  });
  return [row(`${state}-u`, "long", "upper", statuses[0]), row(`${state}-l`, "short", "lower", statuses[1])];
}
const draw = (entries: PendingManualEntry[], extra: Partial<Parameters<typeof newsZoneOverlay>[0]> = {}) => newsZoneOverlay({
  instrument: "GBP_JPY", entries, liveMid: 210.6, now, draft: null, viewedPaperTradeId: null, formatPrice: (price) => price.toFixed(3), ...extra,
});

test("ARMED: both zones follow the live price, faded with dashed lines; one short tag per zone", () => {
  const out = draw(setup("ARMED"));
  assert.equal(out.boxes.length, 2);
  assert.ok(out.boxes.every((box) => box.faded));
  assert.deepEqual(out.lines.map((line) => line.label), ["BUY 210.700", "SELL 210.500"]);
  const buy = out.boxes.find((box) => box.key.endsWith("-buy"))!;
  assert.deepEqual([buy.bottom, buy.top], [210.7, 210.73], "around the live mid 210.600");
  assert.ok(out.lines.every((line) => line.dashed));
});
test("ZONES_LOCKED: the stored zones, solid; the live price does not move them", () => {
  const out = draw(setup("ZONES_LOCKED", { zones, anchor: 210.595 }), { liveMid: 211.5 });
  const buy = out.boxes.find((box) => box.key.endsWith("-buy"))!;
  assert.deepEqual([buy.bottom, buy.top], [210.695, 210.725], "the live price does not move locked zones");
  assert.equal(buy.faded, false);
  assert.deepEqual(out.lines.map((line) => [line.label, line.dashed]), [["BUY 210.695", false], ["SELL 210.495", false]]);
  const sell = out.boxes.find((box) => box.key.endsWith("-sell"))!;
  assert.deepEqual([sell.bottom, sell.top], [210.465, 210.495]);
});
test("WATCHING: same zones, thicker lines, tagged live", () => {
  const out = draw(setup("WATCHING", { zones, anchor: 210.595 }), { now: Date.parse("2026-10-16T12:35:00Z") });
  assert.ok(out.lines.every((line) => line.lineWidth === 2));
  assert.deepEqual(out.lines.map((line) => line.label), ["BUY 210.695 · live", "SELL 210.495 · live"]);
});
test("order pending: the chosen side highlighted, the other greyed OFF", () => {
  const out = draw(setup("ORDER_SUBMITTING", { zones, reservation: { side: "long" } }, "GBP_JPY", ["TRIGGERING", "CANCELLED"]));
  assert.deepEqual(out.lines.map((line) => line.label), ["BUY 210.695 · sending"]);
  assert.ok(out.boxes.some((box) => box.key.endsWith("-sell") && box.faded && box.color === "#8c8c93"), "the other side greyed");
});
test("FILLED: the chosen zone kept for reference; the trade's own lines show entry/SL/TP", () => {
  const out = draw(setup("FILLED", { zones, reservation: { side: "short" } }, "GBP_JPY", ["CANCELLED", "TRIGGERED"]));
  assert.deepEqual(out.boxes.map((box) => box.key.endsWith("-sell")), [true]);
  assert.equal(out.lines.length, 0);
});
test("CLOSED: archived zone only when that trade is being viewed", () => {
  const entries = setup("CLOSED", { zones, reservation: { side: "long" }, exitReason: "target", resultR: 2 }, "GBP_JPY", ["TRIGGERED", "CANCELLED"]);
  assert.equal(draw(entries).boxes.length, 0);
  assert.deepEqual(draw(entries, { viewedPaperTradeId: "trade-1" }).boxes.map((box) => box.key.endsWith("-buy")), [true]);
});
test("SKIPPED / EXPIRED / CANCELLED / ORDER_REJECTED draw nothing", () => {
  for (const state of ["SKIPPED", "EXPIRED", "CANCELLED", "ORDER_REJECTED"]) {
    const out = draw(setup(state, { zones, reservation: { side: "long" } }, "GBP_JPY", ["FAILED", "CANCELLED"]));
    assert.equal(out.boxes.length + out.lines.length, 0, state);
  }
});
test("19. a refresh redraws the same zones from the same server rows", () => {
  const rows = setup("ZONES_LOCKED", { zones, anchor: 210.595 });
  const copy = JSON.parse(JSON.stringify(rows)) as PendingManualEntry[];
  assert.deepEqual(draw(rows), draw(copy));
});
test("20. only the selected instrument's setups are drawn", () => {
  const out = draw([...setup("ZONES_LOCKED", { zones }, "EUR_USD"), ...setup("WATCHING", { zones })]);
  assert.ok(out.boxes.every((box) => box.key.includes("GBP_JPY")));
  assert.equal(draw(setup("WATCHING", { zones }, "EUR_USD")).boxes.length, 0);
});
test("draft: the ticket's unsaved zones are tagged draft and hidden once a setup is live", () => {
  const draft = { distancePips: 12, depthPips: 4 };
  const out = draw([], { draft });
  assert.deepEqual(out.lines.map((line) => line.label), ["BUY 210.720 · draft", "SELL 210.480 · draft"]);
  assert.deepEqual(zonesAround("GBP_JPY", 210.6, 12, 4).buy, { lower: 210.72, upper: 210.76 });
  assert.ok(!draw(setup("WATCHING", { zones }), { draft }).lines.some((line) => line.label.includes("draft")));
});
test("EUR/USD zones use 0.0001 pips and 5-digit rounding", () => {
  assert.deepEqual(zonesAround("EUR_USD", 1.17, 10, 3), { buy: { lower: 1.171, upper: 1.1713 }, sell: { lower: 1.1687, upper: 1.169 } });
});

test("v3 scheduled prices retain executable bid/ask entries, never a mid-price reconstruction", () => {
  const out = draw(setup("SCHEDULED", { configVersion: 3, zones }), { liveMid: 250 });
  assert.deepEqual(out.lines.map(l => l.price), [210.695, 210.495]); assert.ok(out.lines.every(l => l.dashed));
});
test("v3 pending native orders show both sides; filled setup shows only its filled reference", () => {
  const pending = draw(setup("PENDING_ORDERS", { configVersion: 3, zones })); assert.equal(pending.lines.length, 2);
  const filled = draw(setup("TRAILING", { configVersion: 3, zones, reservation: { side: "long" } }, "GBP_JPY", ["TRIGGERED", "CANCELLED"])); assert.equal(filled.lines.length, 0); assert.equal(filled.boxes.length, 1);
});
test("v3 draft uses the supplied executable prices instead of mid ± offset", () => {
  const out = draw([], { liveMid: 250, draft: { distancePips: 10, depthPips: 2, buyEntry: 210.71, sellEntry: 210.49 } }); assert.deepEqual(out.lines.map(l => l.price), [210.71, 210.49]);
});
console.log(`news zone overlay: ${passed} checks passed`);
