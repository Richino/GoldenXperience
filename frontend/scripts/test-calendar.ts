import assert from "node:assert/strict";
import { buildCalendarSnapshot } from "../src/lib/oanda/calendar";
import { normalizeForexFactoryEvents } from "../src/lib/calendar/normalize";

// Verbatim records from https://nfs.faireconomy.media/ff_calendar_thisweek.json,
// kept as a fixture because the live feed rate-limits aggressively.
const sample = [
  {
    title: "Trade Balance",
    country: "NZD",
    date: "2026-07-19T18:45:00-04:00",
    impact: "Low",
    forecast: "250M",
    previous: "800M",
  },
  {
    title: "Bank Holiday",
    country: "JPY",
    date: "2026-07-19T19:00:00-04:00",
    impact: "Holiday",
    forecast: "",
    previous: "",
  },
  {
    title: "Rightmove HPI m/m",
    country: "GBP",
    date: "2026-07-19T19:01:00-04:00",
    impact: "Low",
    forecast: "",
    previous: "-0.6%",
  },
  {
    title: "1-y Loan Prime Rate",
    country: "CNY",
    date: "2026-07-19T21:00:00-04:00",
    impact: "Low",
    forecast: "3.00%",
    previous: "3.00%",
  },
  {
    title: "German PPI m/m",
    country: "EUR",
    date: "2026-07-20T02:00:00-04:00",
    impact: "Low",
    forecast: "-0.2%",
    previous: "0.3%",
  },
  {
    title: "CPI m/m",
    country: "CAD",
    date: "2026-07-20T08:30:00-04:00",
    impact: "High",
    forecast: "-0.2%",
    previous: "1.0%",
  },
  {
    title: "Core CPI m/m",
    country: "USD",
    date: "2026-07-22T08:30:00-04:00",
    impact: "High",
    forecast: "0.3%",
    previous: "0.2%",
  },
];

const events = normalizeForexFactoryEvents(sample);

// NZD/CNY/CAD are dropped; EUR, GBP, JPY and USD are kept.
assert.equal(events.length, 4);
assert.deepEqual(
  [...new Set(events.map((event) => event.currency))].sort(),
  ["EUR", "GBP", "JPY", "USD"],
);

// Impact words map onto the numeric scale buildCalendarSnapshot expects.
const byTitle = new Map(events.map((event) => [event.title, event]));
assert.equal(byTitle.get("Core CPI m/m")?.impact, 3);
assert.equal(byTitle.get("German PPI m/m")?.impact, 1);
assert.equal(byTitle.get("Bank Holiday")?.impact, 0);

// Empty strings become null rather than leaking "" into the UI.
assert.equal(byTitle.get("Rightmove HPI m/m")?.forecast, null);
assert.equal(byTitle.get("Rightmove HPI m/m")?.previous, "-0.6%");
assert.equal(byTitle.get("Bank Holiday")?.actual, null);

// Timestamps are normalized to UTC ISO and sorted ascending.
assert.equal(byTitle.get("German PPI m/m")?.timestamp, "2026-07-20T06:00:00.000Z");
const times = events.map((event) => Date.parse(event.timestamp));
assert.deepEqual(times, [...times].sort((a, b) => a - b));

// Malformed payloads degrade to an empty list instead of throwing.
assert.deepEqual(normalizeForexFactoryEvents(null), []);
assert.deepEqual(normalizeForexFactoryEvents({ error: "rate limited" }), []);
assert.deepEqual(normalizeForexFactoryEvents([{ nope: true }]), []);
assert.deepEqual(
  normalizeForexFactoryEvents([
    { title: "Bad date", country: "USD", date: "not-a-date", impact: "High" },
  ]),
  [],
);

// The high-impact USD print gates trading inside the 30-minute buffer.
const beforeCpi = buildCalendarSnapshot({
  events,
  source: "forex_factory",
  connected: true,
  now: new Date("2026-07-22T12:15:00.000Z"),
});
assert.equal(beforeCpi.highImpactNewsWithinMinutes, 15);
assert.equal(beforeCpi.warnings[0]?.tone, "danger");

// Well clear of it, the same event is only an advisory.
const earlier = buildCalendarSnapshot({
  events,
  source: "forex_factory",
  connected: true,
  now: new Date("2026-07-22T09:00:00.000Z"),
});
assert.equal(earlier.highImpactNewsWithinMinutes, 210);
assert.equal(earlier.warnings[0]?.tone, "accent");

// Once the week's events have passed there is nothing left to gate on.
const afterTheWeek = buildCalendarSnapshot({
  events,
  source: "forex_factory",
  connected: true,
  now: new Date("2026-07-25T02:00:00.000Z"),
});
assert.equal(afterTheWeek.events.length, 0);
assert.equal(afterTheWeek.highImpactNewsWithinMinutes, null);
assert.equal(afterTheWeek.warnings[0]?.tone, "success");

// The weekly feed stops at the end of the week. A quiet calendar whose data
// runs out before the 24h lookahead must not read as an all-clear.
const coverageEnds = buildCalendarSnapshot({
  events,
  source: "forex_factory",
  connected: true,
  coverageUntil: "2026-07-25T02:00:00.000Z",
  now: new Date("2026-07-24T20:00:00.000Z"),
});
assert.equal(coverageEnds.warnings[0]?.tone, "accent");
assert.match(coverageEnds.warnings[0]?.message ?? "", /confirm high-impact/i);

// With a full day of data still ahead, the all-clear is genuine.
const coverageAmple = buildCalendarSnapshot({
  events,
  source: "forex_factory",
  connected: true,
  coverageUntil: "2026-07-27T00:00:00.000Z",
  now: new Date("2026-07-25T02:00:00.000Z"),
});
assert.equal(coverageAmple.warnings[0]?.tone, "success");

// A disconnected feed still reports the hard failure, not a coverage notice.
const offline = buildCalendarSnapshot({
  events: [],
  source: "mock",
  connected: false,
  now: new Date("2026-07-24T20:00:00.000Z"),
});
assert.equal(offline.warnings[0]?.tone, "danger");
assert.match(offline.warnings[0]?.message ?? "", /not connected/i);

console.log("calendar checks passed");
