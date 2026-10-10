import type { Candle } from "../../frontend/src/types/forex.js";
import type { ObserverPlan } from "../../frontend/src/lib/market-observer-types.js";
import type { MarketRecord } from "../src/market-recording.js";

/** Explicitly synthetic, deterministic mechanism fixture. Never presented as market performance. */
export function observerReplayFixture() {
  const start = Date.parse("2026-10-05T14:00:00Z"), iso = (ms = 0) => new Date(start + ms).toISOString();
  const plan: ObserverPlan = { id: "synthetic-replay", version: 1, instrument: "EUR_USD", mode: "NORMAL", createdAt: iso(), updatedAt: iso(), expiresAt: iso(3_600_000),
    status: "WATCHING", resumeStatus: "WATCHING", direction: "long", reason: "synthetic", thesis: "Synthetic lifecycle fixture", zone: { low: 1.1, high: 1.1003 }, entry: 1.1001, stop: 1.099, target: 1.102,
    trigger: { timeframe: "M5", boundary: 1.1002, after: iso() }, invalidation: "Bid <= stop", lastEvaluatedCandle: null, confirmationCandle: null,
    triggeredAt: null, observedEntry: null, outcome: null, facts: ["Synthetic data; no market performance claim."] };
  const records: MarketRecord[] = [];
  const add = (ms: number, kind: MarketRecord["kind"], data: Record<string, unknown>) => records.push({ version: 1, sessionId: "synthetic", sequence: records.length + 1, connection: 1, receivedAt: iso(ms), kind, data });
  const bar = (ms: number, complete = true, close = 1.1001): Candle => ({ time: iso(ms), open: close - 0.0001, high: close + 0.001, low: close - 0.001, close, complete, volume: 0 });
  const context = (ms: number, tf: string, candles: Candle[]) => add(ms, "candles", { instrument: plan.instrument, granularity: tf, source: "oanda", snapshot: { instrument: plan.instrument, granularity: tf, source: "oanda", candles } });
  const quote = (ms: number, bid = 1.10005, ask = 1.1001) => add(ms, "quote", { instrument: plan.instrument, valid: true, status: "tradeable", brokerTime: iso(ms), bid, ask,
    raw: { type: "PRICE", instrument: plan.instrument, status: "tradeable", time: iso(ms), bids: [{ price: String(bid) }], asks: [{ price: String(ask) }] } });
  add(-32_000, "session", { source: "oanda", environment: "practice", instruments: ["EUR_USD", "GBP_USD"], syntheticFixture: true });
  add(-32_000, "connection", { state: "connected", source: "oanda" });
  add(-31_000, "calendar", { snapshot: { source: "forex_factory", connected: true, events: [], coverageUntil: iso(86_400_000) } });
  const frames = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
  for (const [tf, interval] of Object.entries(frames)) context(-31_000, tf, [...Array.from({ length: 30 }, (_, i) => bar((i - 31) * interval)), bar(-interval, false)]);
  for (let ms = -31_000; ms <= 301_250; ms += 250) {
    if (ms === 0) for (const [tf, interval] of Object.entries(frames)) context(ms, tf, [...Array.from({ length: 30 }, (_, i) => bar((i - 30) * interval)), bar(0, false)]);
    if (ms > 0 && ms % 60_000 === 0) context(ms, "M1", [bar(ms - 60_000), bar(ms, false)]);
    // The completed candle is delivered a second after closing; prior quotes cannot use it.
    if (ms === 301_000) context(ms, "M5", [bar(0, true, 1.1004), bar(300_000, false)]);
    quote(ms, ms === 300_500 || ms === 301_250 ? 1.102 : 1.10005, ms === 300_500 || ms === 301_250 ? 1.10205 : 1.1001);
  }
  add(301_500, "end", { droppedRecords: 0, failure: null });
  return { plan, records, iso, start };
}
