import assert from "node:assert/strict";
import { HOME_LOADING_SECTIONS, initialHomeLoadingState, updateHomeLoading } from "../src/lib/home/loading";

let state = initialHomeLoadingState();
assert.equal(state.revealed, false);
assert.deepEqual([...HOME_LOADING_SECTIONS], ["account"], "only the balance holds Home behind the skeleton");
for (const section of ["news", "weekly", "swing", "plans", "trends"]) {
  assert.equal(updateHomeLoading(state, { section, ready: false }), state, `a slow ${section} read cannot hold Home back`);
}
state = updateHomeLoading(state, { section: "account", ready: true });
assert.equal(state.revealed, true, "Home reveals as soon as the balance has loaded");
assert.equal(updateHomeLoading(state, { section: "account", ready: false }), state, "background refreshes never re-hide the page");
console.log("Home loading checks passed: balance-only reveal, non-blocking sections and stable refreshes.");
