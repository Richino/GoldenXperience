import assert from "node:assert/strict";
import { buildCalendarSnapshot } from "../src/lib/oanda/calendar";
import { normalizeForexFactoryEvents } from "../src/lib/calendar/normalize";
import { groupSimultaneousRows, HOME_CALENDAR_MAX_EVENTS, homeCalendarEmptyMessage, homeCalendarRows } from "../src/lib/news/home-calendar";

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

const weekendCalendar = buildCalendarSnapshot({
  events: [], source: "forex_factory", connected: true,
  coverageUntil: "2026-10-09T20:00:00.000Z", now: new Date("2026-10-10T21:00:00.000Z"),
});
assert.equal(homeCalendarEmptyMessage(weekendCalendar, Date.parse("2026-10-10T21:00:00.000Z")), "Calendar update expected on Sunday, Oct 11.");
assert.equal(homeCalendarEmptyMessage(weekendCalendar, Date.parse("2026-10-11T21:00:00.000Z")), "Calendar update expected today, Sunday, Oct 11.");
assert.equal(homeCalendarEmptyMessage(weekendCalendar, Date.parse("2026-10-12T21:00:00.000Z")), "Calendar update pending.", "do not promise next Sunday for an overdue weekday feed");
assert.equal(homeCalendarEmptyMessage({ ...weekendCalendar, coverageUntil: "2026-10-02T20:00:00.000Z" }, Date.parse("2026-10-10T21:00:00.000Z")), "Calendar update pending.", "old cached data cannot support a publication date");
assert.equal(homeCalendarEmptyMessage({ ...weekendCalendar, coverageUntil: "2026-10-30T20:00:00.000Z" }, Date.parse("2026-11-01T02:00:00.000Z")), "Calendar update expected on Sunday, Nov 1.", "use New York date across the DST weekend");

// Every currency in the traded catalog is kept, so an RBNZ or BoC release
// reaches the app and the news impact tagger. Only currencies nothing is
// traded against — CNY here — are dropped.
assert.equal(events.length, 6);
assert.deepEqual(
  [...new Set(events.map((event) => event.currency))].sort(),
  ["CAD", "EUR", "GBP", "JPY", "NZD", "USD"],
);
assert.equal(
  events.some((event) => event.currency === "CNY"), false,
  "a currency with no traded instrument stays out",
);
// Region is populated for the widened set too, not left as the global fallback.
assert.equal(events.find((event) => event.currency === "CAD")?.region, "americas");
assert.equal(events.find((event) => event.currency === "NZD")?.region, "asia");

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

const strictTime = normalizeForexFactoryEvents([
  { title: "Timed release", country: "USD", date: "2026-07-20T08:30:00-04:00", impact: "High", forecast: "", previous: "" },
  { title: "Date only", country: "USD", date: "2026-07-20", impact: "High", forecast: "", previous: "" },
]);
assert.equal(strictTime.find(e => e.title === "Timed release")?.timingVerified, true);
assert.notEqual(strictTime.find(e => e.title === "Date only")?.timingVerified, true);

// A morning's GBP/CAD reports used to fill all six upcoming-event slots,
// hiding the afternoon USD decision until those earlier reports passed.
const busyDay = normalizeForexFactoryEvents([
  ...["Annual Budget Release", "Autumn Forecast Statement"].map(title => ({ title, country: "GBP", date: "2026-10-28T08:30:00-04:00", impact: "High" })),
  ...["BOC Monetary Policy Report", "BOC Rate Statement", "Overnight Rate"].map(title => ({ title, country: "CAD", date: "2026-10-28T09:45:00-04:00", impact: "High" })),
  { title: "BOC Press Conference", country: "CAD", date: "2026-10-28T10:30:00-04:00", impact: "High" },
  { title: "Federal Funds Rate", country: "USD", date: "2026-10-28T14:00:00-04:00", impact: "High" },
  { title: "FOMC Statement", country: "USD", date: "2026-10-28T14:00:00-04:00", impact: "High" },
  { title: "FOMC Press Conference", country: "USD", date: "2026-10-28T14:30:00-04:00", impact: "High" },
  { title: "Evening report", country: "NZD", date: "2026-10-28T20:00:00-04:00", impact: "Medium" },
  { title: "Low impact report", country: "USD", date: "2026-10-28T08:30:00-04:00", impact: "Low" },
]);
const morning = Date.parse("2026-10-28T07:00:00-04:00");
const morningSnapshot = buildCalendarSnapshot({ events: busyDay, source: "forex_factory", connected: true, now: new Date(morning) });
const morningRows = homeCalendarRows(morningSnapshot.recentEvents ?? [], morningSnapshot.events, morning);
assert.equal(morningRows.length, 10, "every medium/high release today is visible before the morning events pass");
assert.ok(morningRows.some(e => e.title === "Federal Funds Rate" && e.state === "upcoming"));
assert.ok(morningRows.some(e => e.title === "FOMC Press Conference" && e.state === "upcoming"));
const afternoonRows = homeCalendarRows([], morningSnapshot.events, Date.parse("2026-10-28T15:31:00-04:00"));
assert.equal(afternoonRows.length, morningRows.length, "the same cached feed keeps today's releases throughout the day");
assert.equal(afternoonRows.find(e => e.title === "Federal Funds Rate")?.state, "released");
assert.equal(afternoonRows.find(e => e.title === "Evening report")?.state, "upcoming");

const laterDays = normalizeForexFactoryEvents(Array.from({ length: HOME_CALENDAR_MAX_EVENTS + 1 }, (_, index) => [
  { title: `Future release ${index}`, country: "USD", date: `2026-10-29T${String(index + 8).padStart(2, "0")}:00:00-04:00`, impact: "High" },
  { title: `Companion report ${index}`, country: "USD", date: `2026-10-29T${String(index + 8).padStart(2, "0")}:00:00-04:00`, impact: "Medium" },
]).flat());
const preview = homeCalendarRows([], [...busyDay, ...laterDays], morning);
const futureIds = new Set(laterDays.map(row => row.id));
const futurePreview = preview.filter(row => futureIds.has(row.id));
assert.equal(groupSimultaneousRows(futurePreview).length, HOME_CALENDAR_MAX_EVENTS, "later days retain a bounded preview");
assert.equal(futurePreview.length, HOME_CALENDAR_MAX_EVENTS * 2, "companion reports never consume or get split by the group limit");
assert.equal(preview.filter(row => !futureIds.has(row.id)).length, 10, "future previews never replace today's rows, including the New York evening");
assert.equal(homeCalendarRows(morningRows, morningRows, morning).length, morningRows.length, "overlapping cached lists remain deduplicated");
assert.equal(homeCalendarRows(morningRows, [], Date.parse("2026-10-29T00:01:00-04:00")).length, 0, "yesterday's releases roll off at New York midnight");
console.log("calendar checks passed");
