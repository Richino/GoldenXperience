import assert from "node:assert/strict";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";
import { dueNewsReminders, runNewsReminders } from "../src/news-reminders.js";
import { queueNotification, sendPushNotification, type QueueNotification } from "../src/notifications.js";
import { db } from "../src/database.js";
import webpush from "web-push";
import { notificationHref } from "../../frontend/src/lib/notifications/display.js";

const MINUTE = 60_000;
const release = Date.parse("2026-10-22T12:30:00Z");
const event: EconomicCalendarEvent = { id: "claims", title: "Unemployment Claims", currency: "USD", region: "americas",
  impact: 2, timestamp: new Date(release).toISOString(), timingVerified: true, forecast: null, previous: null, actual: null, unit: null };
const due = (minutes: number, events = [event]) => dueNewsReminders(events, release - minutes * MINUTE);
assert.equal(due(61).length, 0);
assert.equal(due(60).length, 1);
assert.equal(due(59).length, 1);
assert.equal(due(55).length, 0, "do not replay the hour alert after its grace period");
assert.equal(due(31).length, 0);
assert.equal(due(30).length, 1);
assert.equal(due(29).length, 1);
assert.equal(due(25).length, 0);
assert.equal(due(0).length, 0);
assert.equal(due(-1).length, 0);
assert.notEqual(due(60)[0]!.dedupeKey, due(30)[0]!.dedupeKey);
assert.equal(due(60)[0]!.expiresAt, release - 55 * MINUTE, "queued alerts must expire before their wording becomes stale");
assert.match(due(60)[0]!.title, /1 hour/);
assert.match(due(30)[0]!.title, /30 minutes/);
assert.match(due(30)[0]!.message, /8:30 AM EDT/);
assert.equal(due(60)[0]!.url, "/");
assert.equal(notificationHref({ ...due(60)[0]!, id: "notice", readAt: null, createdAt: new Date().toISOString() }), "/", "inbox and push both open Home");
for (const override of [{ impact: 1 }, { impact: NaN }, { timingVerified: false }, { timingVerified: undefined },
  { timestamp: "bad" }, { actual: "220K" }, { title: " " }]) {
  assert.equal(due(60, [{ ...event, ...override }]).length, 0, JSON.stringify(override));
}
const cpi = { ...event, id: "cpi", title: "CPI y/y", impact: 3 };
const grouped = due(60, [event, cpi, { ...event, id: "duplicate-provider-row" }]);
assert.equal(grouped.length, 1);
assert.match(grouped[0]!.message, /CPI y\/y \+ Unemployment Claims\. High impact/);
assert.equal(due(60, [cpi, event])[0]!.dedupeKey, grouped[0]!.dedupeKey);
assert.equal(due(60, [{ ...event, title: "Revised label" }])[0]!.dedupeKey, due(60)[0]!.dedupeKey);
assert.equal(due(60, [event, { ...event, currency: "EUR" }]).length, 2);

const queued: QueueNotification[] = [];
let recipientReads = 0;
let clock = release - 60 * MINUTE;
const deps = { calendar: async () => ({ events: [event] }), now: () => clock,
  recipients: async () => { recipientReads++; return ["user-1", "user-1", "user-2"]; },
  enqueue: async (item: QueueNotification) => { queued.push(item); return true; } };
assert.equal(await runNewsReminders(deps), 2, "one alert per user regardless of device count");
clock = release - 90 * MINUTE;
assert.equal(await runNewsReminders(deps), 0);
assert.equal(recipientReads, 1, "idle cycles do not query subscriptions");
await assert.rejects(runNewsReminders({ ...deps, calendar: async () => { throw new Error("stale calendar"); } }), /stale calendar/);
assert.equal(queued.length, 2, "calendar failure must not send a reminder");
clock = release - 60 * MINUTE;
assert.equal(await runNewsReminders({ ...deps, recipients: async () => { clock = release; return ["user-1"]; } }), 0);

// Exercise the real notification insertion/dedupe and push TTL with fake transports only.
const envKeys = ["DATABASE_URL", "VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
const pool = db();
const originalQuery = pool.query;
const originalPush = webpush.sendNotification;
const originalVapid = webpush.setVapidDetails;
const originalNow = Date.now;
const inserted = new Set<string>();
const deliveries: { payload: string; ttl: number | undefined }[] = [];
try {
  Object.assign(process.env, { VAPID_SUBJECT: "mailto:fixture@example.com", VAPID_PUBLIC_KEY: "fixture", VAPID_PRIVATE_KEY: "fixture" });
  webpush.setVapidDetails = () => {};
  webpush.sendNotification = (async (_subscription, payload, options) => {
    deliveries.push({ payload: String(payload), ttl: options?.TTL });
    return { statusCode: 201, body: "", headers: {} };
  }) as typeof webpush.sendNotification;
  pool.query = (async (sql: string, values: unknown[]) => {
    if (sql.includes("INSERT INTO notification_events")) {
      const key = `${values[0]}:${values[6]}`;
      if (inserted.has(key)) return { rows: [] };
      inserted.add(key);
      return { rows: [{ id: "fixture-id" }] };
    }
    if (sql.includes("SELECT endpoint,p256dh,auth")) return { rows: [{ endpoint: "https://example.invalid/push", p256dh: "fixture", auth: "fixture" }] };
    throw new Error(`Unexpected test query: ${sql}`);
  }) as typeof pool.query;
  Date.now = () => release - 60 * MINUTE;
  const notification = { ...due(60)[0]!, userId: "user-1" };
  assert.equal(await queueNotification(notification), true);
  assert.equal(await queueNotification(notification), false, "database dedupe prevents repeat pushes after restart or on another replica");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.ttl, 300);
  assert.equal(JSON.parse(deliveries[0]!.payload).url, "/");
  Date.now = () => release;
  await sendPushNotification(notification);
  assert.equal(deliveries.length, 1, "expired notifications never reach the push provider");
} finally {
  pool.query = originalQuery;
  webpush.sendNotification = originalPush;
  webpush.setVapidDetails = originalVapid;
  Date.now = originalNow;
  for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  await pool.end();
}
console.log("News reminders: timing, grouping, calendar failure, recipients, durable dedupe and push expiry passed.");
