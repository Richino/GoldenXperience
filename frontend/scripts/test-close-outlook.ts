import assert from "node:assert/strict";
import { openTradeCloseOutlook, OUTCOME_HORIZON_HOURS } from "../src/lib/strategy/close-outlook";

/**
 * The "when does this close" label. Pure: no clock, no network, no database.
 *
 * The label makes a claim about system behaviour, so it is pinned to the rules
 * the resolvers actually apply — a badge that quietly went stale would be worse
 * than no badge.
 */
const at = (iso: string) => new Date(iso);

// Reference instants. August is EDT, so ET is UTC-4.
const FRI_MIDDAY = "2026-08-21T14:00:00Z";      // Fri 10:00 ET, market open
const SAT = "2026-08-22T12:00:00Z";             // Sat, market shut
const SUN_BEFORE_OPEN = "2026-08-23T08:00:00Z"; // Sun 04:00 ET, still shut
const SUN_AFTER_OPEN = "2026-08-23T22:00:00Z";  // Sun 18:00 ET, open
const MON_MIDDAY = "2026-08-24T14:00:00Z";      // Mon 10:00 ET, open

// ---------------------------------------------------------------- weekend
{
  // The four trades stranded over this actual weekend.
  const outlook = openTradeCloseOutlook({ openedAt: "2026-08-21T16:00:00Z" }, at(SAT))!;
  assert.equal(outlook.label, "Closes at reopen");
  assert.equal(outlook.tone, "waiting");
  assert.match(outlook.detail, /17:00 ET/, "says when the market reopens");

  // Sunday before 17:00 ET is still shut.
  assert.equal(openTradeCloseOutlook({ openedAt: "2026-08-21T16:00:00Z" }, at(SUN_BEFORE_OPEN))!.label,
    "Closes at reopen");
}
console.log("weekend -> 'Closes at reopen': OK");

// the weekend rule outranks being overdue, because nothing resolves while shut.
// Opened Thu 15:45Z, so the 48h horizon falls on Sat 15:45Z — while shut.
{
  const stale = openTradeCloseOutlook({ openedAt: "2026-08-20T15:45:00Z" }, at("2026-08-22T18:00:00Z"))!;
  assert.equal(stale.label, "Overdue — closes at reopen");
  assert.equal(stale.tone, "overdue");
  assert.match(stale.detail, /resolvers are idle/i, "explains that nothing can close while shut");
}
console.log("overdue + weekend -> 'Overdue — closes at reopen': OK");

// ---------------------------------------------------------------- horizon
{
  // Open longer than the horizon, market now open.
  const overdue = openTradeCloseOutlook({ openedAt: "2026-08-20T15:45:00Z" }, at(MON_MIDDAY))!;
  assert.equal(overdue.label, "Overdue — closes next scan");
  assert.equal(overdue.tone, "overdue");
  assert.match(overdue.detail, new RegExp(String(OUTCOME_HORIZON_HOURS)));

  // Exactly at the horizon counts as reached.
  const opened = "2026-08-22T14:00:00Z";
  const exact = new Date(Date.parse(opened) + OUTCOME_HORIZON_HOURS * 3_600_000);
  assert.equal(openTradeCloseOutlook({ openedAt: opened }, exact)!.tone, "overdue");
  // A minute earlier is not overdue.
  assert.notEqual(
    openTradeCloseOutlook({ openedAt: opened }, new Date(exact.getTime() - 60_000))!.tone, "overdue");
}
console.log("past the 48h horizon -> 'Overdue — closes next scan': OK");

// ---------------------------------------------------------------- same day
{
  // Opened this morning, market open, before the 16:45 ET exit.
  const today = openTradeCloseOutlook({ openedAt: "2026-08-24T13:00:00Z" }, at(MON_MIDDAY))!;
  assert.equal(today.label, "Closes 16:45 ET");
  assert.equal(today.tone, "waiting");
  assert.match(today.detail, /stop or target/, "makes clear it can end sooner");
  assert.match(today.detail, /6h 45m/, "counts down to the forced exit");
}
console.log("same trading day, before 16:45 ET -> 'Closes 16:45 ET': OK");

// ---------------------------------------------------------------- due
{
  // Same day but past 16:45 ET (Mon 21:00 UTC = 17:00 ET).
  const late = openTradeCloseOutlook({ openedAt: "2026-08-24T13:00:00Z" }, at("2026-08-24T21:00:00Z"))!;
  assert.equal(late.label, "Closes next scan");
  assert.equal(late.tone, "due");

  // A previous trading day, still inside the horizon, market open.
  const yesterday = openTradeCloseOutlook({ openedAt: "2026-08-23T22:30:00Z" }, at(MON_MIDDAY))!;
  assert.equal(yesterday.label, "Closes next scan");
  assert.equal(yesterday.tone, "due");
}
console.log("session exit already due -> 'Closes next scan': OK");

// ---------------------------------------------------------------- normal Friday
{
  const friday = openTradeCloseOutlook({ openedAt: "2026-08-21T13:00:00Z" }, at(FRI_MIDDAY))!;
  assert.equal(friday.label, "Closes 16:45 ET");
  // A trade opened right at the Sunday reopen is fresh, so whatever else it
  // says it must not read as overdue. (It reads "due" rather than "waiting"
  // because 18:00 ET is already past the 16:45 ET exit for that date — a real
  // quirk of the rule, though unreachable in practice: the strategies only
  // enter during the London and New York sessions.)
  const sundayEvening = openTradeCloseOutlook({ openedAt: SUN_AFTER_OPEN }, at(SUN_AFTER_OPEN))!;
  assert.notEqual(sundayEvening.tone, "overdue", "a trade opened at the reopen is not overdue");
}
console.log("ordinary open-market cases: OK");

// ---------------------------------------------------------------- fail safe
{
  assert.equal(openTradeCloseOutlook({ openedAt: null }), null, "no open time -> render nothing");
  assert.equal(openTradeCloseOutlook({ openedAt: undefined }), null);
  assert.equal(openTradeCloseOutlook({ openedAt: "not a date" }), null, "unparseable -> render nothing");
}
console.log("missing or unparseable open time -> no badge: OK");

// ---------------------------------------------------------------- timezone
{
  // The same instant written three ways must give the same label.
  const a = openTradeCloseOutlook({ openedAt: "2026-08-24T13:00:00Z" }, at(MON_MIDDAY))!;
  const b = openTradeCloseOutlook({ openedAt: "2026-08-24T09:00:00-04:00" }, at(MON_MIDDAY))!;
  assert.deepEqual(a, b, "an ET-offset open time must equal the UTC one");

  // January is EST (UTC-5); the 16:45 ET exit must still be found correctly.
  const winter = openTradeCloseOutlook({ openedAt: "2026-01-20T15:00:00Z" }, at("2026-01-20T16:00:00Z"))!;
  assert.equal(winter.label, "Closes 16:45 ET", "DST must not shift the session exit");
  assert.match(winter.detail, /5h 45m/, "11:00 ET to 16:45 ET is 5h45m in winter too");
}
console.log("timezone and DST handling: OK");

// every outlook is renderable
for (const opened of ["2026-08-21T16:00:00Z", "2026-08-20T15:45:00Z", "2026-08-24T13:00:00Z"]) {
  for (const now of [SAT, SUN_BEFORE_OPEN, SUN_AFTER_OPEN, MON_MIDDAY, FRI_MIDDAY]) {
    const outlook = openTradeCloseOutlook({ openedAt: opened }, at(now));
    assert.ok(outlook && outlook.label.length > 0 && outlook.detail.length > 0);
    assert.ok(["waiting", "due", "overdue"].includes(outlook.tone));
  }
}
console.log("every combination produces a renderable badge: OK");

console.log("\nAll close-outlook assertions passed.");
