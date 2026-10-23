import assert from "node:assert/strict";
import { HOME_LOADING_SECTIONS, initialHomeLoadingState, updateHomeLoading } from "../src/lib/home/loading";

let state = initialHomeLoadingState();
assert.equal(state.revealed, false);
assert.equal("plans" in state.sections, false, "retired Plans must not hold Home behind the loading skeleton");
assert.equal("trends" in state.sections, false, "the Weekly scan must not hold the rest of Home behind its skeleton");
assert.equal(updateHomeLoading(state, { section: "trends", ready: false }), state, "a slow scan cannot register as a blocking section");
assert.equal(updateHomeLoading(state, { section: "trends", ready: true }), state, "scan completion cannot alter the page reveal");
state = updateHomeLoading(state, { section: "swing", ready: false });
for (const section of HOME_LOADING_SECTIONS) state = updateHomeLoading(state, { section, ready: true });
assert.equal(state.revealed, false, "a nested Swing read holds the same skeleton until it settles");
state = updateHomeLoading(state, { section: "swing", ready: true });
assert.equal(state.revealed, true, "all first snapshots reveal together");
assert.equal(updateHomeLoading(state, { section: "trends", ready: false }), state, "background refreshes never re-hide the page");

let standalone = initialHomeLoadingState();
for (const section of HOME_LOADING_SECTIONS.slice(0, -1)) standalone = updateHomeLoading(standalone, { section, ready: true });
assert.equal(standalone.revealed, false, "a slow weekly review cannot pop in after the page");
standalone = updateHomeLoading(standalone, { section: "weekly", ready: true });
assert.equal(standalone.revealed, true, "settled empty/error sections release loading without requiring data");
console.log("Home loading checks passed: complete first reveal, nested reads, slow sections, empty/error results and stable refreshes.");
