import assert from "node:assert/strict";
import { labelOutcome, selectPositionAwareCandidates, type NormalizedQuote } from "../src/research.js";

const decision = "2026-01-05T12:00:00.000Z";
function quote(minutes: number, bidHigh: number, bidLow: number, askHigh = bidHigh + 0.0002, askLow = bidLow + 0.0002): NormalizedQuote {
  return { closeTime: new Date(new Date(decision).getTime() + minutes * 60_000).toISOString(), bidOpen: 1.1, bidHigh, bidLow, bidClose: 1.1, askOpen: 1.1002, askHigh, askLow, askClose: 1.1002 };
}

assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1021, 1.0995)]).outcome, "target_first");
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1005, 1.0989)]).outcome, "stop_first");
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1021, 1.0989)]).outcome, "ambiguous");
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1005, 1.0995), quote(49 * 60, 1.103, 1.098)]).outcome, "unresolved");
assert.equal(labelOutcome("short", 1.1, 1.101, 1.098, decision, [quote(15, 1.1001, 1.0977, 1.1003, 1.0979)]).outcome, "target_first");
assert.equal(labelOutcome("short", 1.1, 1.101, 1.098, decision, [quote(15, 1.1005, 1.0995, 1.1011, 1.0997)]).outcome, "stop_first");

// 12:00Z is 07:00 ET in January. A surviving position must close on the first
// completed M15 quote at 16:45 ET, using bid for a long and ask for a short.
const forcedExitLong = labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(9 * 60 + 45, 1.1006, 1.0996)]);
assert.equal(forcedExitLong.outcome, "forced_close");
assert.equal(forcedExitLong.resolvedAt, "2026-01-05T21:45:00.000Z");
assert.ok(Math.abs(forcedExitLong.resultR! - 0) < 1e-9, "long forced exit must use bid close");
const forcedExitShort = labelOutcome("short", 1.1, 1.101, 1.098, decision, [quote(9 * 60 + 45, 1.1004, 1.0996, 1.1006, 1.0998)]);
assert.equal(forcedExitShort.outcome, "forced_close");
assert.ok(Math.abs(forcedExitShort.resultR! - -0.2) < 1e-9, "short forced exit must use ask close");

const resolved = labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(30, 1.1021, 1.0995)]);
assert.equal(resolved.resolvedAt, "2026-01-05T12:30:00.000Z");
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, []).resolvedAt, null);

// An ambiguous bar touched both levels. The stop is nearer, so it is booked as a
// full loss rather than dropped from the sample.
const ambiguous = labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1021, 1.0989)]);
assert.equal(ambiguous.outcome, "ambiguous");
assert.equal(ambiguous.resultR, -1);

// A trade that never reached either level is marked to market at the horizon on
// the exit side of the book: a long closes on the bid, a short on the ask.
const timedOutLong = labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1005, 1.0995), quote(49 * 60, 1.103, 1.098)]);
assert.equal(timedOutLong.outcome, "unresolved");
// bidClose 1.1 against entry 1.1 over 0.001 of risk.
assert.equal(timedOutLong.resultR, 0);

const timedOutShort = labelOutcome("short", 1.1, 1.101, 1.098, decision, [quote(15, 1.1005, 1.0995)]);
assert.equal(timedOutShort.outcome, "unresolved");
// Short exits on askClose 1.1002 against entry 1.1 over 0.001 of risk.
assert.ok(Math.abs(timedOutShort.resultR! - -0.2) < 1e-9);

// No quotes inside the horizon leaves no price to mark against, so the row stays
// null and every metric basis skips it rather than counting a fabricated zero.
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, []).resultR, null);

// Resolved outcomes keep their existing results.
assert.ok(Math.abs(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1021, 1.0995)]).resultR! - 2) < 1e-9);
assert.equal(labelOutcome("long", 1.1, 1.099, 1.102, decision, [quote(15, 1.1005, 1.0989)]).resultR, -1);

const selected = selectPositionAwareCandidates([
  { id: "first", decisionTime: "2026-01-05T12:00:00.000Z", resolvedAt: "2026-01-05T13:00:00.000Z", horizonEndsAt: "2026-01-07T12:00:00.000Z" },
  { id: "overlap", decisionTime: "2026-01-05T12:45:00.000Z", resolvedAt: "2026-01-05T14:00:00.000Z", horizonEndsAt: "2026-01-07T12:45:00.000Z" },
  { id: "after", decisionTime: "2026-01-05T13:00:00.000Z", resolvedAt: null, horizonEndsAt: "2026-01-07T13:00:00.000Z" },
  { id: "blocked-by-unresolved", decisionTime: "2026-01-06T10:00:00.000Z", resolvedAt: "2026-01-06T11:00:00.000Z", horizonEndsAt: "2026-01-08T10:00:00.000Z" },
]);
assert.deepEqual(selected.map((item) => item.executionStatus), ["accepted", "overlapping", "accepted", "overlapping"]);
assert.equal(selected[1]!.blockedByCandidateId, "first");
assert.equal(selected[3]!.blockedByCandidateId, "after");
assert.equal(selected[2]!.simulatedExitAt, "2026-01-07T13:00:00.000Z");

console.log("Research outcome labeling and position-aware replay checks passed.");
