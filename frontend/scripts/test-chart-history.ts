import assert from "node:assert/strict";
import {
  HISTORY_MAX_PREFETCH_BARS,
  HISTORY_LOAD_THRESHOLD,
  anchorRangeAfterPrepend,
  buildTradeMarkers,
  buildTradePath,
  countPrependedCandles,
  historyPrefetchThreshold,
  shouldLoadOlderHistory,
  snapToCandleTime,
} from "../src/lib/chart-utils";
import { accountSeriesRose, buildAccountAmountSeries } from "../src/components/dashboard/account-amount-chart";
import type { PaperChartTrade } from "../src/types/forex";

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

// --- paper trade markers ---------------------------------------------------

const seconds = (index: number) => Math.floor(Date.parse(M15(index)) / 1_000);
const candleTimes = [0, 1, 2, 3, 4, 5, 6].map(seconds);

// A decision or exit lands mid-candle, so it snaps back to the bar holding it.
assert.equal(snapToCandleTime(candleTimes, seconds(2) + 400), seconds(2));
assert.equal(snapToCandleTime(candleTimes, seconds(2)), seconds(2));
assert.equal(snapToCandleTime(candleTimes, seconds(6) + 900), seconds(6));
// Before the loaded history there is no bar to mark.
assert.equal(snapToCandleTime(candleTimes, seconds(0) - 1), null);
assert.equal(snapToCandleTime([], seconds(2)), null);

const palette = {
  long: "long",
  short: "short",
  win: "win",
  loss: "loss",
  muted: "muted",
};

function trade(overrides: Partial<PaperChartTrade> = {}): PaperChartTrade {
  return {
    id: "trade-1",
    tradeSequence: "12",
    instrument: "EUR_USD",
    direction: "long",
    status: "closed",
    outcome: "target_first",
    entry: 1.085,
    stop: 1.083,
    target: 1.088,
    exit: 1.088,
    resultR: 1.5,
    openedAt: M15(2),
    closedAt: M15(5),
    exitReason: "target_first",
    batchNumber: 1,
    ...overrides,
  };
}

const focused = buildTradeMarkers(candleTimes, [trade()], "trade-1", palette);
assert.equal(focused.length, 2);
assert.equal(focused[0]!.time, seconds(2));
assert.equal(focused[0]!.position, "belowBar");
assert.equal(focused[0]!.shape, "arrowUp");
assert.equal(focused[0]!.color, "long");
assert.ok(focused[0]!.text?.includes("BUY"));
assert.equal(focused[1]!.time, seconds(5));
assert.equal(focused[1]!.position, "aboveBar");
assert.equal(focused[1]!.color, "win");
assert.ok(focused[1]!.text?.includes("+1.50R"));

// A short is mirrored, and a losing exit is coloured by its result, not its side.
const shortLoss = buildTradeMarkers(
  candleTimes,
  [trade({ direction: "short", outcome: "stop_first", exit: 1.087, resultR: -1 })],
  "trade-1",
  palette,
);
assert.equal(shortLoss[0]!.position, "aboveBar");
assert.equal(shortLoss[0]!.shape, "arrowDown");
assert.equal(shortLoss[0]!.color, "short");
assert.equal(shortLoss[1]!.position, "belowBar");
assert.equal(shortLoss[1]!.color, "loss");

// Nothing is drawn until a trade is picked. Marking every trade on the pair put
// a permanent thicket over the price and, worse, mixed retired strategies in
// with the live one.
assert.deepEqual(
  buildTradeMarkers(candleTimes, [trade(), trade({ id: "trade-2" })], null, palette),
  [],
  "with no trade selected the chart carries no markers at all",
);

// Picking one trade draws that trade and no other.
const onlyOne = buildTradeMarkers(
  candleTimes,
  [trade(), trade({ id: "trade-2", openedAt: M15(3), closedAt: M15(6) })],
  "trade-2",
  palette,
);
assert.equal(onlyOne.length, 2, "only the picked trade is marked");
assert.ok(
  onlyOne.every((marker) => String(marker.id).endsWith("trade-2")),
  "and the markers belong to it",
);
assert.ok(
  onlyOne.every((marker) => marker.color !== "muted"),
  "there is no background tier left to dim",
);

// An open trade has no exit to mark yet.
assert.equal(
  buildTradeMarkers(
    candleTimes,
    [trade({ status: "open", outcome: "open", exit: null, resultR: null, closedAt: null })],
    "trade-1",
    palette,
  ).length,
  1,
);

// Markers must reach the chart in ascending time order — entry before exit,
// whatever order the trade list arrived in.
const ordered = buildTradeMarkers(
  candleTimes,
  [
    trade({ id: "late", openedAt: M15(4), closedAt: M15(6) }),
    trade({ id: "early", openedAt: M15(0), closedAt: M15(1) }),
  ],
  "early",
  palette,
);
assert.equal(ordered.length, 2, "the picked trade contributes its entry and its exit");
assert.deepEqual(
  ordered.map((marker) => Number(marker.time)),
  [...ordered.map((marker) => Number(marker.time))].sort((left, right) => left - right),
);
assert.ok(String(ordered[0]!.id).startsWith("entry:"), "the entry is the earlier of the two");

// The entry-to-exit segment needs both ends on loaded bars, in that order.
assert.deepEqual(buildTradePath(candleTimes, trade()), [
  { time: seconds(2), value: 1.085 },
  { time: seconds(5), value: 1.088 },
]);
assert.deepEqual(buildTradePath(candleTimes, trade({ exit: null })), []);
assert.deepEqual(buildTradePath(candleTimes, trade({ closedAt: M15(2) })), []);
assert.deepEqual(buildTradePath(candleTimes, null), []);

// --- Account amount series ---------------------------------------------------
// The hero chart reports the account balance, so the two things that must never
// drift are the endpoints and the values themselves.

const NOW = Date.parse("2026-08-12T16:00:00.000Z");

const brokerHistory = (movements: Array<{ hoursAgo: number; change: number }>, openingBalance = 10_000) => {
  let balance = openingBalance;
  return movements.map(({ hoursAgo, change }, index) => {
    balance += change;
    return {
      id: String(index + 1),
      time: new Date(NOW - hoursAgo * 60 * 60_000).toISOString(),
      balance,
      change,
      type: "ORDER_FILL",
    };
  });
};

const history = brokerHistory([
  { hoursAgo: 40 * 24, change: 100 },
  { hoursAgo: 8 * 24, change: -200 },
  { hoursAgo: 6 * 24, change: 300 },
  { hoursAgo: 20, change: -50 },
  { hoursAgo: 0.5, change: 25 },
]);

const hour = buildAccountAmountSeries({ unrealizedPL: 0, history, range: "1h", now: NOW });
const day = buildAccountAmountSeries({ unrealizedPL: 0, history, range: "1d", now: NOW });
const week = buildAccountAmountSeries({ unrealizedPL: 0, history, range: "1w", now: NOW });
const month = buildAccountAmountSeries({ unrealizedPL: 0, history, range: "1m", now: NOW });

const total = (series: Array<{ value: number }>) => series.reduce((sum, point) => sum + point.value, 0);

assert.equal(total(hour), 25, "one hour includes only the recent $25 win");
assert.equal(total(day), -25, "one day includes the $50 loss and $25 win");
assert.equal(total(week), 275, "one week includes its three broker P/L changes");
assert.equal(total(month), 75, "one month excludes movements older than 30 days");
assert.deepEqual([hour.length, day.length, week.length, month.length], [12, 12, 7, 10]);

for (const [name, series] of [["hour", hour], ["day", day], ["week", week], ["month", month]] as const) {
  series.forEach((point, index) => assert.equal(point.index, index, `${name} keeps ordered time buckets`));
}

// An account with no closed trades keeps empty time buckets, not invented P/L.
const empty = buildAccountAmountSeries({ unrealizedPL: 0, history: [], range: "1d", now: NOW });
assert.equal(empty.length, 12, "a day is divided into twelve readable two-hour bars");
assert.ok(empty.every((point) => point.value === 0), "and empty buckets remain zero");

// Current unrealised P/L belongs only in the final, live bucket.
const withOpen = buildAccountAmountSeries({
  unrealizedPL: 250,
  history: brokerHistory([{ hoursAgo: 2, change: 100 }], 9_900),
  range: "1d",
  now: NOW,
});
assert.equal(withOpen.at(-1)!.value, 350, "the last point includes closed and current open P/L");
assert.equal(withOpen.at(-1)!.movementCount, 1, "the final bucket records its broker movement");
assert.equal(withOpen.at(-1)!.includesOpenPL, true, "the tooltip discloses that open P/L is included");

// The card tint follows the sum of all bars, not the final bucket alone.
assert.equal(accountSeriesRose(week), true, "a profitable week is a series that rose");
const fell = buildAccountAmountSeries({
  unrealizedPL: 0,
  history: brokerHistory([{ hoursAgo: 2, change: -200 }]),
  range: "1d",
  now: NOW,
});
assert.equal(accountSeriesRose(fell), false, "a losing day is a series that fell");
assert.equal(
  accountSeriesRose(buildAccountAmountSeries({ unrealizedPL: 0, history: [], range: "1m", now: NOW })),
  true,
  "a flat series is not a loss",
);

console.log("chart history checks passed");
