import assert from "node:assert/strict";
import { resolveShadowOutcome } from "../src/shadow-outcomes.js";
import type { NormalizedQuote } from "../src/research.js";

// A candidate decided at 10:00 ET (14:00Z), well inside the London/NY window and
// hours before the 16:45 ET forced exit, so nothing here is a session close.
const DECISION = "2026-08-17T14:00:00.000Z";
const ENTRY = 1.10000;
const STOP = 1.09900;   // 1R = 10 pips
const TARGET = 1.10200; // 2R

function q(minutesAfter: number, bidHigh: number, bidLow: number, askHigh: number, askLow: number): NormalizedQuote {
  const closeTime = new Date(Date.parse(DECISION) + minutesAfter * 60_000).toISOString();
  const mid = (bidHigh + bidLow) / 2;
  return { closeTime, bidOpen: mid, bidHigh, bidLow, bidClose: mid, askOpen: mid, askHigh, askLow, askClose: mid };
}

// Quiet bars that touch neither the target nor the stop.
const quiet = (m: number) => q(m, 1.10050, 1.09990, 1.10060, 1.10000);
// A bar whose bidHigh reaches the long target.
const hitsTarget = (m: number) => q(m, 1.10210, 1.10100, 1.10220, 1.10110);
// A bar whose bidLow reaches the long stop.
const hitsStop = (m: number) => q(m, 1.10010, 1.09880, 1.10020, 1.09890);

// ===========================================================================
// 1. Suppressed candidates eventually resolve (target and stop).
// ===========================================================================
{
  const quotes = [quiet(15), quiet(30), hitsTarget(45)];
  const now = new Date(Date.parse(DECISION) + 50 * 60_000);
  const res = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, quotes, now);
  assert.ok(res, "a candidate whose target is hit resolves");
  assert.equal(res!.outcome, "target_first", "the outcome is target_first");
  assert.ok((res!.resultR ?? 0) > 0, "a target is a positive result");
  assert.equal(res!.exit, TARGET, "the exit is booked at the target");
  assert.ok(res!.resolvedAt, "a resolution timestamp is recorded");

  const stopQuotes = [quiet(15), hitsStop(30)];
  const stopRes = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, stopQuotes, new Date(Date.parse(DECISION) + 35 * 60_000));
  assert.equal(stopRes!.outcome, "stop_first", "a stop is stop_first");
  assert.equal(stopRes!.resultR, -1, "a stop is exactly -1R");

  // Short mirror.
  const shortRes = resolveShadowOutcome("short", 1.10000, 1.10100, 1.09800, DECISION, [q(15, 1.09810, 1.09790, 1.09820, 1.09795)], new Date(Date.parse(DECISION) + 20 * 60_000));
  assert.equal(shortRes!.outcome, "target_first", "a short candidate resolves symmetrically");
  console.log("1 resolves: OK");
}

// ===========================================================================
// 4. No look-ahead: an outcome is not known before its resolving bar exists.
// ===========================================================================
{
  // Before the target bar exists, with only quiet bars so far and still inside
  // the horizon, the outcome is NOT known → pending (null).
  const early = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, [quiet(15), quiet(30)], new Date(Date.parse(DECISION) + 35 * 60_000));
  assert.equal(early, null, "outcome is pending while inside the horizon with no level touched");

  // The identical candidate becomes resolved only once the resolving bar is part
  // of the data (i.e. once real time has reached it).
  const later = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, [quiet(15), quiet(30), hitsTarget(45)], new Date(Date.parse(DECISION) + 50 * 60_000));
  assert.equal(later!.outcome, "target_first", "the same candidate resolves once its bar exists");

  // No candles after the decision at all → pending, never a fabricated result.
  const noData = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, [], new Date(Date.parse(DECISION) + 35 * 60_000));
  assert.equal(noData, null, "no post-decision candles means no outcome is invented");
  console.log("4 no-lookahead: OK");
}

// ===========================================================================
// Horizon timeout: past the horizon with no level → marked to market, not lost.
// ===========================================================================
{
  const horizonMs = 48 * 60 * 60_000;
  const afterHorizon = new Date(Date.parse(DECISION) + horizonMs + 60_000);
  const res = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, [quiet(15), quiet(30)], afterHorizon);
  assert.ok(res, "past the horizon the candidate resolves rather than staying pending forever");
  assert.equal(res!.outcome, "timeout", "an untouched candidate past its horizon is a timeout");
  assert.equal(res!.exitReason, "timeout", "the exit reason is timeout");
  console.log("timeout: OK");
}

// ===========================================================================
// 5. Executed vs shadow are distinguishable, and the record is pure data:
//    resolveShadowOutcome has no access to OANDA/risk/positions (2, 3).
// ===========================================================================
{
  const res = resolveShadowOutcome("long", ENTRY, STOP, TARGET, DECISION, [hitsTarget(15)], new Date(Date.parse(DECISION) + 20 * 60_000));
  // A plain outcome object — no order id, no position, no side effects. The
  // caller stores it in shadow_candidate_outcomes (a separate table), never in
  // paper_strategy_trades, so shadow results are always distinguishable from
  // executed ones and can never be counted as executed trades or reach OANDA.
  assert.deepEqual(Object.keys(res!).sort(), ["exit", "exitReason", "horizonEndsAt", "maxAdverseR", "maxFavorableR", "outcome", "resolvedAt", "resultR"].sort(), "the shadow outcome is pure result data");
  assert.equal(typeof res!.resultR, "number", "result R is recorded");
  console.log("5 distinguishable/pure: OK");
}

console.log("\nAll shadow-outcome tests passed.");
