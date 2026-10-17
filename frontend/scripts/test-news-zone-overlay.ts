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

test("ARMED: both zones follow the live price, faded and dashed, labelled PREVIEW", () => {
  const out = draw(setup("ARMED"));
  assert.equal(out.boxes.length, 2);
  assert.ok(out.boxes.every((box) => box.faded));
  assert.ok(out.lines.some((line) => line.label.startsWith("BUY ZONE") && line.label.includes("PREVIEW")));
  const buy = out.boxes.find((box) => box.key.endsWith("-buy"))!;
  assert.deepEqual([buy.bottom, buy.top], [210.7, 210.73], "around the live mid 210.600");
  assert.ok(out.lines.every((line) => line.dashed));
});
test("ZONES_LOCKED: the stored zones, solid, with the anchor and a release countdown", () => {
  const out = draw(setup("ZONES_LOCKED", { zones, anchor: 210.595 }), { liveMid: 211.5 });
  const buy = out.boxes.find((box) => box.key.endsWith("-buy"))!;
  assert.deepEqual([buy.bottom, buy.top], [210.695, 210.725], "the live price does not move locked zones");
  assert.equal(buy.faded, false);
  assert.ok(out.lines.some((line) => /^BUY ZONE 210.695–210.725 · LOCKED · news in 30s$/.test(line.label)));
  assert.ok(out.lines.some((line) => line.label === "ANCHOR 210.595"));
  const sell = out.boxes.find((box) => box.key.endsWith("-sell"))!;
  assert.deepEqual([sell.bottom, sell.top], [210.465, 210.495]);
});
test("WATCHING: same zones, entries live, time left", () => {
  const out = draw(setup("WATCHING", { zones, anchor: 210.595 }), { now: Date.parse("2026-10-16T12:35:00Z") });
  assert.ok(out.lines.some((line) => /LIVE · 10m left/.test(line.label)));
  assert.ok(out.lines.some((line) => line.lineWidth === 2));
});
test("order pending: the chosen side highlighted, the other greyed OFF", () => {
  const out = draw(setup("ORDER_SUBMITTING", { zones, reservation: { side: "long" } }, "GBP_JPY", ["TRIGGERING", "CANCELLED"]));
  assert.ok(out.lines.some((line) => line.label === "BUY ZONE 210.695–210.725 · ORDER PENDING"));
  assert.ok(out.boxes.some((box) => box.label === "SELL ZONE · OFF" && box.faded));
  assert.ok(!out.boxes.some((box) => /FILLED/.test(box.label ?? "")), "never says filled before OANDA confirms");
});
test("FILLED: the chosen zone kept for reference; the trade's own lines show entry/SL/TP", () => {
  const out = draw(setup("FILLED", { zones, reservation: { side: "short" } }, "GBP_JPY", ["CANCELLED", "TRIGGERED"]));
  assert.deepEqual(out.boxes.map((box) => box.label), ["SELL ZONE · FILLED"]);
});
test("CLOSED: archived zone only when that trade is being viewed", () => {
  const entries = setup("CLOSED", { zones, reservation: { side: "long" }, exitReason: "target", resultR: 2 }, "GBP_JPY", ["TRIGGERED", "CANCELLED"]);
  assert.equal(draw(entries).boxes.length, 0);
  assert.deepEqual(draw(entries, { viewedPaperTradeId: "trade-1" }).boxes.map((box) => box.label), ["BUY ZONE · CLOSED · target +2.00R"]);
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
test("draft: the ticket's unsaved zones are labelled DRAFT and hidden once a setup is live", () => {
  const draft = { distancePips: 12, depthPips: 4 };
  const out = draw([], { draft });
  assert.ok(out.boxes.length === 2 && out.lines.filter((line) => line.label.includes("DRAFT")).length === 2);
  assert.deepEqual(zonesAround("GBP_JPY", 210.6, 12, 4).buy, { lower: 210.72, upper: 210.76 });
  assert.ok(!draw(setup("WATCHING", { zones }), { draft }).lines.some((line) => line.label.includes("DRAFT")));
});
test("EUR/USD zones use 0.0001 pips and 5-digit rounding", () => {
  assert.deepEqual(zonesAround("EUR_USD", 1.17, 10, 3), { buy: { lower: 1.171, upper: 1.1713 }, sell: { lower: 1.1687, upper: 1.169 } });
});

console.log(`news zone overlay: ${passed} checks passed`);
