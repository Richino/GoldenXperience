import assert from "node:assert/strict";
import { selectBatch, selectHistorical, type SelectionCandidate } from "./selective-portfolio-v1";
import type { TradeAudit } from "./validate-executable-costs";

const candidate = (id: string, pair: string, spread: number): SelectionCandidate => ({ id, pair,
  decisionTime: "2025-01-06T12:00:00.000Z", entry: 100, stop: 99, bid: 100 - spread, ask: 100 });
const a = candidate("a", "EUR_USD", 0.10), b = candidate("b", "USD_JPY", 0.05);
assert.equal(selectBatch([a], 0, ["EUR_USD"])[0]!.accepted, true, "Threshold includes equality");
assert.equal(selectBatch([candidate("c", "EUR_USD", 0.11)], 0, ["EUR_USD"])[0]!.reason, "SPREAD_TOO_EXPENSIVE");
assert.deepEqual(selectBatch([a, b], 0, ["EUR_USD", "USD_JPY"]).filter(r => r.accepted).map(r => r.id), ["b"]);
assert.equal(selectBatch([a], 1, ["EUR_USD"])[0]!.reason, "POSITION_ALREADY_OPEN");
assert.equal(selectBatch([candidate("x", "NEW_PAIR", 0.01)], 0, ["EUR_USD"])[0]!.reason, "PAIR_NOT_ADMITTED");
assert.equal(selectBatch([{ ...a, ask: NaN }], 0, ["EUR_USD"])[0]!.reason, "INVALID_GEOMETRY");
assert.throws(() => selectBatch([a, a], 0, ["EUR_USD"]), /Duplicate/);
assert.throws(() => selectBatch([a, { ...b, decisionTime: "2025-01-06T13:00:00.000Z" }], 0, ["EUR_USD", "USD_JPY"]), /one valid/);
const equalA = candidate("a", "EUR_USD", 0.05), equalB = candidate("b", "USD_JPY", 0.05);
assert.deepEqual(selectBatch([equalB, equalA], 0, ["EUR_USD", "USD_JPY"]).filter(r => r.accepted).map(r => r.id), ["a"]);
const trade = (hour: number, exitHour: number, result: number) => ({ pair: "EUR_USD", strategy: "fixture", version: "v1", direction: "long",
  signalTimestamp: `2025-01-06T${hour - 1}:00:00.000Z`, decisionTime: `2025-01-06T${hour}:00:00.000Z`,
  exitTimestamp: `2025-01-06T${exitHour}:00:00.000Z`, executableEntry: 100, stop: 99, bid: 99.95, ask: 100,
  executableResultR: result, exitReason: result > 0 ? "TP" : "SL" } as TradeAudit);
const rows = [trade(12, 14, -1), trade(13, 15, 2), trade(14, 16, 2)];
const picks = selectHistorical(rows);
assert.deepEqual(picks.decisions.map(r => r.accepted), [true, false, true], "Only observed close events release a slot");
const changedOutcomes = selectHistorical(rows.map((r, i) => ({ ...r, executableResultR: i * 100, exitReason: "TIME_EXIT" })));
assert.deepEqual(changedOutcomes.decisions.map(({ id, accepted, reason }) => ({ id, accepted, reason })),
  picks.decisions.map(({ id, accepted, reason }) => ({ id, accepted, reason })), "Changing future profit cannot change selections");
console.log("Selective portfolio tests passed: price gate, deterministic selection, admission, overlap, and outcome blindness.");
