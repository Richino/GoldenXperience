import assert from "node:assert/strict";
import { dueMarketHoursAlert } from "../src/market-hours-alerts.js";
import { notificationHref } from "../../frontend/src/lib/notifications/display.js";

const minutes = 60_000;
for (const [timestamp, title] of [
  ["2026-07-10T20:59:00Z", "Forex market closed"],
  ["2026-07-12T21:05:00Z", "Forex market opened"],
  ["2026-11-13T21:59:00Z", "Forex market closed"],
  ["2026-11-15T22:05:00Z", "Forex market opened"],
]) {
  const at = Date.parse(timestamp);
  assert.equal(dueMarketHoursAlert(at - 1), null, "a push must never precede the boundary");
  const alert = dueMarketHoursAlert(at);
  assert.ok(alert);
  assert.equal(alert.title, title);
  assert.equal(alert.expiresAt, at + 5 * minutes);
  assert.equal(dueMarketHoursAlert(at + minutes)?.dedupeKey, alert.dedupeKey);
  assert.equal(dueMarketHoursAlert(at + 5 * minutes), null, "old alerts are not replayed");
  assert.equal(alert.url, "/chart");
  assert.equal(notificationHref({ ...alert, id: "test", readAt: null, createdAt: timestamp }), alert.url);
}
assert.equal(dueMarketHoursAlert(Date.parse("2026-11-16T22:05:00Z")), null, "no alerts for daily rollover");
console.log("Market hours alerts: summer and winter boundaries, expiry, dedupe identity and chart links passed.");
