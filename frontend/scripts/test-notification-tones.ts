import assert from "node:assert/strict";
import { detailTone } from "../src/lib/notifications/display";
import type { AppNotification } from "../src/lib/notifications/types";

const base: AppNotification = { id: "fixture", kind: "trade_update", title: "EUR/USD entry accepted",
  message: "Your pending entry is now being monitored.", instrument: "EUR_USD", paperTradeId: null, readAt: null, createdAt: "2026-10-22T00:00:00Z" };
const tone = (patch: Partial<AppNotification>) => detailTone({ ...base, ...patch });
assert.equal(tone({}), "is-info");
assert.equal(tone({ title: "EUR/USD trade opened", message: "Short filled at 1.12290. No stop or target: close it yourself." }), "is-warning");
assert.equal(tone({ title: "EUR/USD trade opened", message: "Long filled. Stop 1.1200, target 1.1250." }), "is-info");
assert.equal(tone({ title: "EUR/USD trade won", message: "Target reached. Your trade is closed." }), "is-positive");
assert.equal(tone({ title: "EUR/USD trade lost", message: "Stop reached. Your trade is closed." }), "is-negative");
assert.equal(tone({ kind: "paper_closed", message: "Closed +1.25R" }), "is-positive");
assert.equal(tone({ kind: "paper_closed", message: "Closed −0.5R" }), "is-negative");
assert.equal(tone({ kind: "paper_closed", message: "Closed -1R" }), "is-negative");
assert.equal(tone({ kind: "paper_closed", message: "Closed +0R" }), "");
assert.equal(tone({ title: "EUR/USD trade closed", message: "Your trade closed at breakeven." }), "");
assert.equal(tone({ kind: "system_issue", message: "Failed +2R" }), "is-issue");
assert.equal(tone({ title: "EUR/USD entry needs attention" }), "is-issue");
assert.equal(tone({ title: "EUR/USD entry expired" }), "is-warning");
assert.equal(tone({ title: "EUR/USD entry cancelled" }), "is-info");
assert.equal(tone({ kind: "news_reminder", title: "USD news in 30 minutes" }), "is-warning");
assert.equal(tone({ kind: "research_ready", title: "Plan ready to review" }), "is-info");
assert.equal(tone({ title: "EUR/USD setup ready", message: "Potential target +2R" }), "is-info", "a proposed target is not a realized win");
assert.equal(tone({ title: "EUR/USD trade won", readAt: "2026-10-22T01:00:00Z" }), "is-positive", "read state must not erase meaning");
console.log("Notification tones: wins, losses, errors, warnings, updates and neutral closes passed.");
