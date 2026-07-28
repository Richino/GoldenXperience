import assert from "node:assert/strict";
import {
  HISTORY_MAX_PREFETCH_BARS,
  HISTORY_LOAD_THRESHOLD,
  anchorRangeAfterPrepend,
  countPrependedCandles,
  historyPrefetchThreshold,
  shouldLoadOlderHistory,
} from "../src/lib/chart-utils";

function bars(...isoTimes: string[]) {
  return isoTimes.map((time) => ({ time }));
}

const M15 = (index: number) =>
  new Date(Date.UTC(2026, 6, 24, 0, index * 15)).toISOString();

// The loader starts well before the loaded edge. Its buffer is at least the
// base threshold and grows with the visible window, so continuous panning does
// not run into an empty edge while a request is in flight.
assert.ok(shouldLoadOlderHistory({ from: 0, to: 80 }));
assert.ok(shouldLoadOlderHistory({ from: -40, to: 40 }), "scrolled past the first bar");
assert.ok(shouldLoadOlderHistory({ from: HISTORY_LOAD_THRESHOLD - 1, to: HISTORY_LOAD_THRESHOLD + 79 }));
assert.ok(!shouldLoadOlderHistory({ from: HISTORY_LOAD_THRESHOLD, to: HISTORY_LOAD_THRESHOLD + 80 }));
assert.ok(!shouldLoadOlderHistory({ from: 400, to: 480 }));
assert.ok(!shouldLoadOlderHistory(null));
assert.equal(historyPrefetchThreshold({ from: 0, to: 80 }), HISTORY_LOAD_THRESHOLD);
assert.equal(historyPrefetchThreshold({ from: 0, to: 500 }), 250);
assert.equal(historyPrefetchThreshold({ from: 0, to: 1_000 }), HISTORY_MAX_PREFETCH_BARS);

// Anchoring keeps the same bars under the viewport after a page is prepended.
assert.deepEqual(anchorRangeAfterPrepend({ from: 10, to: 90 }, 500), {
  from: 510,
  to: 590,
});
assert.deepEqual(anchorRangeAfterPrepend({ from: -30, to: 50 }, 500), {
  from: 470,
  to: 550,
});

/**
 * Drives the real scroll-back cycle: the viewport sits in the trigger zone, a
 * page of history arrives, and the range is anchored. `reposition` is the
 * behaviour under test. Returns how many pages were requested before the chart
 * settled, capped so a runaway loop fails loudly instead of hanging.
 */
function runHistoryCycle(
  reposition: (
    range: { from: number; to: number },
    prependedCount: number,
  ) => { from: number; to: number },
  pageSize = 500,
  maxPages = 50,
) {
  let range = { from: 10, to: 90 };
  let pages = 0;

  while (shouldLoadOlderHistory(range) && pages < maxPages) {
    pages += 1;
    range = reposition(range, pageSize);
  }

  return { pages, range };
}

// The fix: one page is fetched, and the viewport lands clear of the trigger.
const fixed = runHistoryCycle(anchorRangeAfterPrepend);
assert.equal(fixed.pages, 1, "one scroll into the zone should fetch one page");
assert.ok(
  !shouldLoadOlderHistory(fixed.range),
  "viewport must settle outside the trigger zone",
);

// The regression: restoring the pre-load range leaves the viewport inside the
// trigger zone, so the chart requests page after page and walks itself
// backwards through history. Guard against reintroducing it.
const looping = runHistoryCycle((range) => range);
assert.equal(looping.pages, 50, "restoring the old range never terminates");
assert.ok(shouldLoadOlderHistory(looping.range));

// Even a short final page — near the true start of available history — moves
// the viewport forward rather than stalling, and the feed-exhausted guard in
// the workspace stops the cycle.
const shortPage = anchorRangeAfterPrepend({ from: 2, to: 80 }, 8);
assert.equal(shortPage.from, 10);
assert.ok(shortPage.from > 2, "a short page still advances the viewport");

// --- how many bars were actually prepended -------------------------------

// Three older bars inserted ahead of the previous oldest bar (M15(3)).
assert.equal(
  countPrependedCandles(bars(M15(0), M15(1), M15(2), M15(3), M15(4)), M15(3)),
  3,
);

// Nothing inserted: the oldest bar is unchanged.
assert.equal(countPrependedCandles(bars(M15(3), M15(4)), M15(3)), 0);

// A live tick appending a bar at the tail is not a prepend. Counting by array
// length would report 1 here and shift the viewport a bar too far every time
// a tick landed alongside a history page.
assert.equal(countPrependedCandles(bars(M15(3), M15(4), M15(5)), M15(3)), 0);

// Prepend and append in the same update: only the leading bars count.
assert.equal(
  countPrependedCandles(
    bars(M15(0), M15(1), M15(2), M15(3), M15(4), M15(5)),
    M15(3),
  ),
  3,
  "a concurrent append must not inflate the prepend count",
);

// No previous anchor, or an anchor that no longer exists (instrument switched),
// must not shift the viewport.
assert.equal(countPrependedCandles(bars(M15(0), M15(1)), null), 0);
assert.equal(countPrependedCandles(bars(M15(0), M15(1)), "not-a-date"), 0);
assert.equal(countPrependedCandles([], M15(3)), 0);

// The anchor survives a differently-formatted timestamp for the same instant,
// which OANDA's nanosecond precision can produce across requests.
assert.equal(
  countPrependedCandles(
    bars(M15(0), M15(1), "2026-07-24T00:45:00.000000000Z"),
    "2026-07-24T00:45:00.000Z",
  ),
  2,
);

console.log("chart history checks passed");
