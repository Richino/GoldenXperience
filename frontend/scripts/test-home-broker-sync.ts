import assert from "node:assert/strict";
import { brokerHistoryNotice } from "../src/lib/home/broker-sync";

assert.equal(brokerHistoryNotice(null), null);
assert.equal(brokerHistoryNotice(undefined), null);
for (const completedAt of [null, "2026-10-21T22:00:00Z"]) {
  assert.equal(brokerHistoryNotice({ status: "running", completedAt, retryAfterMs: 3000 }), null,
    "a normal initial or recurring refresh does not show a failure warning");
  assert.equal(brokerHistoryNotice({ status: "ready", completedAt }), null);
}
for (const status of ["failed", "unavailable"] as const) {
  const message = brokerHistoryNotice({ status, completedAt: "2026-10-21T22:00:00Z", retryAfterMs: 15000 });
  assert.match(message!, /could not refresh/);
  assert.match(message!, /Retrying automatically/);
  assert.match(message!, /saved journal data/);
}
console.log("Home broker-sync checks passed: routine refreshes stay quiet; genuine failures retain their warning.");
