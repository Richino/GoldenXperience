import assert from "node:assert/strict";

import {
  computeSessionTradability,
  tradabilityPhase,
  tradabilitySortKey,
  type PairTradability,
  type TradabilityInput,
} from "../../frontend/src/lib/strategy/ny-tradability.js";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";
import type { Candle } from "../../frontend/src/types/forex.js";

/**
 * Self-test for the NY session tradability detector (pair selection only).
 * Synthetic, deterministic candles; no network, no database.
 */

const M15 = 15 * 60_000;
const H1 = 60 * 60_000;

function series(endMs: number, stepMs: number, count: number, start: number, drift: number, wave: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = start + index * drift + wave * Math.sin(index / 5);
    const close = start + (index + 1) * drift + wave * Math.sin((index + 1) / 5);
    return {
      time: new Date(endMs - (count - index) * stepMs).toISOString(),
      open,
      close,
      high: Math.max(open, close) + wave * 0.5,
      low: Math.min(open, close) - wave * 0.5,
      volume: 100,
      complete: true,
    };
  });
}

// Wednesday 7 Oct 2026, 13:20 UTC = 09:20 New York (EDT): inside the window.
const NOW = new Date("2026-10-07T13:20:00.000Z");
const nowMs = NOW.getTime();
const lastM15Close = nowMs - (nowMs % M15);
const lastH1Close = nowMs - (nowMs % H1);

function input(instrument: string, overrides: Partial<TradabilityInput> = {}): TradabilityInput {
  const jpy = instrument.endsWith("JPY");
  const scale = jpy ? 100 : 1;
  const start = jpy ? 150 : 1.1;
  const mid = start + 500 * 0.00002 * scale;
  return {
    instrument,
    now: NOW,
    m15: series(lastM15Close, M15, 500, start, 0.00002 * scale, 0.0004 * scale),
    h1: series(lastH1Close, H1, 120, start, 0.00008 * scale, 0.0012 * scale),
    quote: { bid: mid - 0.00003 * scale, ask: mid + 0.00003 * scale, time: new Date(nowMs - 2_000).toISOString(), tradeable: true },
    news: [],
    ...overrides,
  };
}

function event(currency: string, minutesFromNow: number, impact = 3): EconomicCalendarEvent {
  return {
    id: `${currency}-${minutesFromNow}`,
    title: `${currency} test release`,
    currency,
    region: currency,
    impact,
    timestamp: new Date(nowMs + minutesFromNow * 60_000).toISOString(),
    forecast: null,
    previous: null,
    actual: null,
    unit: null,
  };
}

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`ok  ${name}`);
}

check("phase follows the New York clock across DST", () => {
  // EDT (UTC-4)
  assert.equal(tradabilityPhase(new Date("2026-10-07T10:29:00Z")), "outside");
  assert.equal(tradabilityPhase(new Date("2026-10-07T10:30:00Z")), "pre_session");
  assert.equal(tradabilityPhase(new Date("2026-10-07T12:00:00Z")), "active");
  assert.equal(tradabilityPhase(new Date("2026-10-07T14:59:00Z")), "active");
  assert.equal(tradabilityPhase(new Date("2026-10-07T15:00:00Z")), "outside");
  // EST (UTC-5): the same wall-clock window is an hour later in UTC.
  assert.equal(tradabilityPhase(new Date("2026-12-09T11:29:00Z")), "outside");
  assert.equal(tradabilityPhase(new Date("2026-12-09T11:30:00Z")), "pre_session");
  assert.equal(tradabilityPhase(new Date("2026-12-09T13:00:00Z")), "active");
  // Saturday is closed.
  assert.equal(tradabilityPhase(new Date("2026-10-10T13:00:00Z")), "outside");
});

check("outside the window: no score, outside status", () => {
  const result = computeSessionTradability(input("EUR_USD", { now: new Date("2026-10-07T17:40:00Z") }));
  assert.equal(result.status, "OUTSIDE_NY_WINDOW");
  assert.equal(result.score, null);
});

check("live data inside the window is scored 0–100 with all five factors", () => {
  const result = computeSessionTradability(input("EUR_USD"));
  assert.ok(result.score !== null && result.score >= 0 && result.score <= 100, `score ${result.score}`);
  assert.deepEqual(result.factors.map((factor) => factor.max), [20, 20, 25, 15, 20]);
  assert.equal(result.factors.reduce((sum, factor) => sum + factor.points, 0), result.score);
  assert.ok(["HIGHLY_TRADABLE", "MODERATELY_TRADABLE", "LOW_TRADABILITY"].includes(result.status));
});

check("same inputs give the same assessment (both screens share it)", () => {
  assert.deepEqual(computeSessionTradability(input("GBP_USD")), computeSessionTradability(input("GBP_USD")));
});

check("a candle that has not closed yet (or is in the future) is ignored", () => {
  const base = input("EUR_USD");
  const future: Candle = { ...base.m15!.at(-1)!, time: new Date(lastM15Close).toISOString(), open: 2, high: 3, low: 1, close: 2.5 };
  const forming: Candle = { ...future, time: new Date(lastM15Close).toISOString(), complete: false };
  const clean = computeSessionTradability(base);
  assert.deepEqual(computeSessionTradability({ ...base, m15: [...base.m15!, future] }), clean);
  assert.deepEqual(computeSessionTradability({ ...base, m15: [...base.m15!, forming] }), clean);
});

check("missing candles, stale candles, missing or stale quotes → UNAVAILABLE", () => {
  assert.equal(computeSessionTradability(input("EUR_USD", { m15: null })).status, "UNAVAILABLE");
  assert.equal(computeSessionTradability(input("EUR_USD", { h1: null })).status, "UNAVAILABLE");
  const stale = input("EUR_USD");
  stale.m15 = stale.m15!.slice(0, -3); // last close 45 minutes ago
  assert.equal(computeSessionTradability(stale).status, "UNAVAILABLE");
  assert.equal(computeSessionTradability(input("EUR_USD", { quote: null })).status, "UNAVAILABLE");
  const oldQuote = input("EUR_USD");
  oldQuote.quote = { ...oldQuote.quote!, time: new Date(nowMs - 10 * 60_000).toISOString() };
  assert.equal(computeSessionTradability(oldQuote).status, "UNAVAILABLE");
  const halted = input("EUR_USD");
  halted.quote = { ...halted.quote!, tradeable: false };
  assert.equal(computeSessionTradability(halted).status, "UNAVAILABLE");
});

check("spread uses each instrument's own pip size (JPY and non-JPY)", () => {
  const eurUsd = computeSessionTradability(input("EUR_USD"));
  const usdJpy = computeSessionTradability(input("USD_JPY"));
  assert.ok(Math.abs(eurUsd.spreadPips! - 0.6) < 1e-6, `EUR_USD ${eurUsd.spreadPips}`);
  assert.ok(Math.abs(usdJpy.spreadPips! - 0.6) < 1e-6, `USD_JPY ${usdJpy.spreadPips}`);
});

check("a spread too wide for the movement blocks the pair", () => {
  const wide = input("EUR_USD");
  wide.quote = { ...wide.quote!, bid: wide.quote!.bid - 0.003, ask: wide.quote!.ask + 0.003 };
  const result = computeSessionTradability(wide);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.block, "spread");
  assert.equal(result.score, null);
});

check("high-impact news blocks 15 minutes either side, for either currency only", () => {
  assert.equal(computeSessionTradability(input("EUR_USD", { news: [event("USD", 10)] })).status, "BLOCKED");
  assert.equal(computeSessionTradability(input("EUR_USD", { news: [event("EUR", -14)] })).block, "news");
  assert.notEqual(computeSessionTradability(input("EUR_USD", { news: [event("USD", 16)] })).status, "BLOCKED");
  assert.notEqual(computeSessionTradability(input("EUR_GBP", { news: [event("USD", 5)] })).status, "BLOCKED");
  assert.notEqual(computeSessionTradability(input("EUR_USD", { news: [event("USD", 5, 2)] })).status, "BLOCKED");
});

check("after the block, a wide spread keeps it blocked until it settles", () => {
  const widened = input("EUR_USD", { news: [event("USD", -20)] });
  widened.quote = { ...widened.quote!, bid: widened.quote!.bid - 0.0002, ask: widened.quote!.ask + 0.0002 };
  const result = computeSessionTradability(widened);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.block, "news_settling");
  assert.notEqual(computeSessionTradability(input("EUR_USD", { news: [event("USD", -20)] })).block, "news_settling");
});

check("an unreadable calendar is never treated as clear", () => {
  const result = computeSessionTradability(input("EUR_USD", { news: null }));
  assert.equal(result.news.state, "unavailable");
  assert.notEqual(result.status, "HIGHLY_TRADABLE");
});

check("Most tradable sort: scored by score, then blocked, unavailable, outside", () => {
  // As the engine returns them: blocked pairs keep only a rawScore.
  const make = (status: PairTradability["status"], score: number | null) =>
    ({ status, score: status === "BLOCKED" ? null : score, rawScore: score }) as PairTradability;
  const items = [make("UNAVAILABLE", null), make("LOW_TRADABILITY", 40), make("BLOCKED", 90), make("HIGHLY_TRADABLE", 85), make("OUTSIDE_NY_WINDOW", null)];
  const sorted = [...items].sort((left, right) => {
    const a = tradabilitySortKey(left);
    const b = tradabilitySortKey(right);
    return a.group - b.group || b.score - a.score;
  });
  assert.deepEqual(sorted.map((item) => item.status), ["HIGHLY_TRADABLE", "LOW_TRADABILITY", "BLOCKED", "UNAVAILABLE", "OUTSIDE_NY_WINDOW"]);
});

console.log(`\n${passed} checks passed`);
