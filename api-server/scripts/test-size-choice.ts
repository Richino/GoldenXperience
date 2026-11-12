import assert from "node:assert/strict";
import { parseSizeChoice } from "../src/pending-manual-entries.js";

// The ticket's per-trade size: lots or % of the account.
assert.equal(parseSizeChoice(undefined), null, "no choice falls back to the default");
assert.equal(parseSizeChoice(null), null);
assert.deepEqual(parseSizeChoice({ mode: "lots", lots: 0.5 }), { mode: "lots", lots: 0.5 });
assert.deepEqual(parseSizeChoice({ mode: "lots", lots: "2.437" }), { mode: "lots", lots: 2.44 }, "lots round to 0.01");
assert.deepEqual(parseSizeChoice({ mode: "percent", percent: "1" }), { mode: "percent", percent: 1 });
assert.throws(() => parseSizeChoice({ mode: "lots", lots: 0 }), /between 0.01 and 100 lots/);
assert.throws(() => parseSizeChoice({ mode: "lots", lots: 101 }), /between 0.01 and 100 lots/);
assert.throws(() => parseSizeChoice({ mode: "percent", percent: 0 }), /between 0.01% and 20%/);
assert.throws(() => parseSizeChoice({ mode: "percent", percent: 25 }), /between 0.01% and 20%/);
assert.throws(() => parseSizeChoice({ mode: "units", units: 1000 }), /lots or % of account/);
console.log("Size choice checks passed: lots and % parse, round and reject out-of-range values.");
