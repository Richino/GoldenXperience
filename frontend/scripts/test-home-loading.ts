import assert from "node:assert/strict";
import { HOME_LOADING_SECTIONS, initialHomeLoadingState, updateHomeLoading } from "../src/lib/home/loading";

let state = initialHomeLoadingState();
assert.equal(state.revealed, false);
assert.deepEqual([...HOME_LOADING_SECTIONS], ["account", "history", "positions", "journal", "pending", "news"], "Home waits for every section it shows");
for (const section of ["plans", "swing", "trends", "weekly"]) {
  assert.equal(updateHomeLoading(state, { section, ready: true }), state, `${section} is not on Home and is not waited on`);
}
for (const section of HOME_LOADING_SECTIONS.slice(0, -1)) {
  state = updateHomeLoading(state, { section, ready: true });
  assert.equal(state.revealed, false, `Home stays hidden while a section is still loading (after ${section})`);
}
state = updateHomeLoading(state, { section: "news", ready: true });
assert.equal(state.revealed, true, "Home reveals once the last section settles");
assert.equal(updateHomeLoading(state, { section: "journal", ready: false }), state, "background refreshes never re-hide the page");

let stuck = updateHomeLoading(initialHomeLoadingState(), { section: "account", ready: true });
stuck = updateHomeLoading(stuck, { ceiling: true });
assert.equal(stuck.revealed, true, "the ceiling reveals Home when a section never reports");
console.log("Home loading checks passed: all-sections reveal, off-Home sections ignored, ceiling and stable refreshes.");
