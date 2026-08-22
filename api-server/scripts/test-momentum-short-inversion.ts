import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { recordMomentumShortPair } = await import("../src/momentum-short-inversion.js");
const { resolveShadowOutcome } = await import("../src/shadow-outcomes.js");

/**
 * Self-test for the Momentum SHORT inversion forward experiment.
 *
 * Writes into an isolated TEST cohort and deletes it at the end, so the real
 * forward cohort is never contaminated. Asserts the properties that make the
 * experiment trustworthy rather than merely runnable.
 */
// recordMomentumShortPair writes to the module's real cohort constant, so the
// test cannot redirect it by label. Instead every synthetic row is dated 2030 —
// a timestamp no live signal can produce — and cleanup is scoped to that.
const TEST_EPOCH = "2030-01-01T00:00:00.000Z";
await query("DELETE FROM momentum_short_inversion_pairs WHERE decision_time >= $1", [TEST_EPOCH]);

const BID = 1.10000; const ASK = 1.10014;      // 1.4 pip spread
const STOP_DIST = 0.00300; const TGT_DIST = 0.00600;
const candidate = {
  family: "momentum", version: "momentum-v1", configVersion: "momentum-cfg-v1",
  regime: { regime: "trending", atr: 0.0015, atrPips: 15 } as never,
  qualifyReason: "", status: "valid", instrument: "EUR_USD", pair: "EUR/USD",
  direction: "short" as const, timeframe: "15m" as const,
  entry: BID, stop: BID + STOP_DIST, target: BID - TGT_DIST,
  riskReward: 2, positionSize: null, features: {} as never, summary: "",
  conditions: [], passedConditions: [], failedConditions: [],
  evaluatedAt: "2030-01-02T10:15:00.000Z", dataSource: "oanda" as const,
} as never;

// ---------------------------------------------------------------- geometry
const { MOMENTUM_SHORT_INVERSION_COHORT } = await import("../src/momentum-short-inversion.js");
const outcome = await recordMomentumShortPair({
  candidate, quote: { bid: BID, ask: ASK }, spreadPips: 1.4, session: "London",
});
assert.equal(outcome, "recorded", "a valid momentum SHORT must be recorded");

const row = (await query<Record<string, string>>(
  `SELECT orig_direction, orig_entry::text, orig_stop::text, orig_target::text,
          inv_direction, inv_entry::text, inv_stop::text, inv_target::text,
          stop_distance::text, target_distance::text, status
     FROM momentum_short_inversion_pairs
    WHERE cohort=$1 AND instrument='EUR_USD' AND decision_time='2030-01-02T10:15:00.000Z'`,
  [MOMENTUM_SHORT_INVERSION_COHORT])).rows[0]!;
const n = (k: string) => Number(row[k]);

assert.equal(row.orig_direction, "short");
assert.equal(row.inv_direction, "long");
assert.ok(Math.abs(n("orig_entry") - BID) < 1e-9, "ARM A (short) must fill at the BID");
assert.ok(Math.abs(n("inv_entry") - ASK) < 1e-9, "ARM B (long) must fill at the ASK, not the bid");
assert.ok(n("inv_entry") > n("orig_entry"), "the inverted arm pays the spread rather than inheriting it");
assert.ok(Math.abs(Math.abs(n("orig_entry") - n("orig_stop")) - STOP_DIST) < 1e-9, "short stop distance preserved");
assert.ok(Math.abs(Math.abs(n("inv_entry") - n("inv_stop")) - STOP_DIST) < 1e-9, "long stop distance mirrored identically");
assert.ok(Math.abs(Math.abs(n("orig_target") - n("orig_entry")) - TGT_DIST) < 1e-9, "short target distance preserved");
assert.ok(Math.abs(Math.abs(n("inv_target") - n("inv_entry")) - TGT_DIST) < 1e-9, "long target distance mirrored identically");
assert.ok(n("orig_stop") > n("orig_entry") && n("orig_target") < n("orig_entry"), "short geometry points down");
assert.ok(n("inv_stop") < n("inv_entry") && n("inv_target") > n("inv_entry"), "long geometry points up");
console.log("geometry + bid/ask orientation: OK");

// ------------------------------------------------- no double counting
const again = await recordMomentumShortPair({ candidate, quote: { bid: BID, ask: ASK }, spreadPips: 1.4, session: "London" });
const count = await query<{ n: string }>(
  `SELECT count(*)::text AS n FROM momentum_short_inversion_pairs
    WHERE cohort=$1 AND instrument='EUR_USD' AND decision_time='2030-01-02T10:15:00.000Z'`,
  [MOMENTUM_SHORT_INVERSION_COHORT]);
assert.equal(Number(count.rows[0]!.n), 1, "re-evaluating the same bar must not create a second pair");
assert.equal(again, "recorded");
console.log("duplicate suppression: OK");

// ------------------------------------------------- non-momentum / LONG ignored
assert.equal(await recordMomentumShortPair({
  candidate: { ...(candidate as object), direction: "long" } as never,
  quote: { bid: BID, ask: ASK }, spreadPips: 1.4, session: "London" }), "skipped",
  "Momentum LONG is out of scope and must not enter the experiment");
assert.equal(await recordMomentumShortPair({
  candidate: { ...(candidate as object), family: "ema" } as never,
  quote: { bid: BID, ask: ASK }, spreadPips: 1.4, session: "London" }), "skipped",
  "other families must not enter the experiment");
console.log("scope gate (momentum SHORT only): OK");

// ------------------------------------------------- fail-closed exclusions
assert.equal(await recordMomentumShortPair({
  candidate: { ...(candidate as object), instrument: "GBP_USD", evaluatedAt: "2030-01-02T10:30:00.000Z" } as never,
  quote: undefined, spreadPips: 1.4, session: "London" }), "excluded", "missing quote must fail closed");
const ex = await query<{ excluded_reason: string }>(
  `SELECT excluded_reason FROM momentum_short_inversion_pairs WHERE cohort=$1 AND status='excluded'`,
  [MOMENTUM_SHORT_INVERSION_COHORT]);
assert.ok(ex.rows.length >= 1 && ex.rows[0]!.excluded_reason.length > 0,
  "an excluded signal is stored WITH a reason, never silently dropped");
console.log("fail-closed exclusion with reason: OK");

// ------------------------------------------------- a SHORT loss is NOT a LONG win
const q = (t: string, bh: number, bl: number, ah: number, al: number) => ({
  closeTime: t, bidOpen: bl, bidHigh: bh, bidLow: bl, bidClose: bl,
  askOpen: al, askHigh: ah, askLow: al, askClose: al,
});
// Price chops: touches the SHORT's stop (up) and later the LONG's stop (down).
const chop = [
  q("2030-01-02T10:30:00.000Z", BID + STOP_DIST + 0.0002, BID + 0.0010, ASK + STOP_DIST + 0.0002, ASK + 0.0010),
  q("2030-01-02T10:45:00.000Z", BID - 0.0010, ASK - STOP_DIST - 0.0002, BID - 0.0010, ASK - STOP_DIST - 0.0002),
];
const now = new Date("2030-01-05T00:00:00.000Z");
const shortRes = resolveShadowOutcome("short", BID, BID + STOP_DIST, BID - TGT_DIST, "2030-01-02T10:15:00.000Z", chop, now);
const longRes = resolveShadowOutcome("long", ASK, ASK - STOP_DIST, ASK + TGT_DIST, "2030-01-02T10:15:00.000Z", chop, now);
assert.ok(shortRes && longRes, "both arms resolve");
assert.equal(shortRes!.outcome, "stop_first", "the short is stopped out");
assert.equal(longRes!.outcome, "stop_first", "and so is the long — a short loss is NOT a long win");
assert.ok((shortRes!.resultR ?? 0) < 0 && (longRes!.resultR ?? 0) < 0, "both arms can lose the same opportunity");
console.log("independent resolution (short loss != long win): OK");

// ------------------------------------------------- timestamp convention (§20)
// market_candles/quotes are CLOSE-stamped; a decision at 10:15 may use the bar
// closing at 10:15 but must never use one closing later.
const forwardOnly = chop.filter((x) => new Date(x.closeTime) > new Date("2030-01-02T10:15:00.000Z"));
assert.equal(forwardOnly.length, chop.length, "resolution bars must all close AFTER the decision bar");
assert.ok(new Date(chop[0]!.closeTime).getTime() - Date.parse("2030-01-02T10:15:00.000Z") === 15 * 60_000,
  "the first resolution bar closes exactly one M15 after the decision close");
console.log("timestamp convention (closed candle, forward-only): OK");

await query("DELETE FROM momentum_short_inversion_pairs WHERE decision_time >= $1", [TEST_EPOCH]);
const left = await query<{ n: string }>("SELECT count(*)::text AS n FROM momentum_short_inversion_pairs");
assert.equal(Number(left.rows[0]!.n), 0, "the forward cohort must be left exactly as found: empty");
console.log("cleanup: OK (forward cohort left empty, uncontaminated)");
console.log("\nAll momentum-short-inversion self-tests passed.");
process.exit(0);
