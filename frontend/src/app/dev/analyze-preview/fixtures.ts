import { analyzeV2, type AnalysisResult } from "@/lib/strategy/analyze-v2/decide";
import type { Candle } from "@/types/forex";

/**
 * Synthetic Analyze V2 results for the development preview: the same
 * hand-built candles the unit tests use (scripts/test-analyze-v2.ts). Not
 * market data; never shown outside development.
 */

const START = Date.parse("2026-09-21T00:00:00Z");
const M15 = 15 * 60_000;
const H = 60 * 60_000;

function path(turns: number[], bars: number, start = START, step = M15, wick = 0.0001): Candle[] {
  const closes: number[] = [];
  for (let leg = 0; leg < turns.length - 1; leg += 1) {
    for (let i = 1; i <= bars; i += 1) closes.push(turns[leg]! + ((turns[leg + 1]! - turns[leg]!) * i) / bars);
  }
  let previous = turns[0]!;
  return closes.map((close, index) => {
    const candle = { time: new Date(start + index * step).toISOString(), open: previous, high: Math.max(previous, close) + wick, low: Math.min(previous, close) - wick, close, volume: 1, complete: true };
    previous = close;
    return candle;
  });
}

function extend(candles: Candle[], targets: Array<[number, number]>): Candle[] {
  const out = [...candles];
  for (const [target, bars] of targets) {
    const from = out.at(-1)!.close;
    for (let i = 1; i <= bars; i += 1) {
      const close = from + ((target - from) * i) / bars;
      const open = out.at(-1)!.close;
      out.push({ time: new Date(Date.parse(out.at(-1)!.time) + M15).toISOString(), open, high: Math.max(open, close) + 0.0001, low: Math.min(open, close) - 0.0001, close, volume: 1, complete: true });
    }
  }
  return out;
}

const mirror = (candles: Candle[], center: number) =>
  candles.map((candle) => ({ ...candle, open: 2 * center - candle.open, close: 2 * center - candle.close, high: 2 * center - candle.low, low: 2 * center - candle.high }));

const UP = path([1.1030, 1.1000, 1.1060, 1.1030, 1.1090, 1.1060, 1.1120], 15);
const AT_ZONE = extend(UP, [[1.1105, 6], [1.1091, 5]]);
// v2.1 geometry: the higher low (1.1052) sits close under the old 1.1060 high.
const LONG_SETUP = extend(path([1.1030, 1.1000, 1.1040, 1.1025, 1.1060, 1.1052, 1.1100], 15), [[1.1080, 5], [1.1060, 5], [1.1067, 1]]);

function run(m15: Candle[], mid: number, { mirrored = false, h1Down = false, news = [] as Parameters<typeof analyzeV2>[0]["news"] } = {}): AnalysisResult {
  const end = Math.floor(Date.parse(m15.at(-1)!.time) / H) * H;
  let h1 = path([1.0950, 1.0900, 1.1000, 1.0960, 1.1060, 1.1020, 1.1100], 12, end - 71 * H, H, 0.0002);
  if (h1Down) h1 = mirror(h1, 1.1060);
  const candles = mirrored ? mirror(m15, 1.1060) : m15;
  const higher = mirrored ? mirror(h1, 1.1060) : h1;
  const now = Date.parse(candles.at(-1)!.time) + M15 + 30_000;
  const center = mirrored ? 2 * 1.1060 - mid : mid;
  return analyzeV2({
    instrument: "EUR_USD",
    mode: "NORMAL",
    candles: { M15: candles, H1: higher },
    quote: { bid: center - 0.00006, ask: center + 0.00006, time: new Date(now - 2_000).toISOString() },
    now,
    news,
  });
}

export function previewResults() {
  const now = Date.parse(LONG_SETUP.at(-1)!.time) + M15 + 30_000;
  return {
    long: run(LONG_SETUP, 1.1067),
    short: run(LONG_SETUP, 1.1067, { mirrored: true }),
    watching: run(AT_ZONE, AT_ZONE.at(-1)!.close),
    conflict: run(LONG_SETUP, 1.1067, { h1Down: true, news: [{ title: "CPI", currency: "USD", impact: 3, timestamp: new Date(now + 10 * 60_000).toISOString() }] }),
    noNews: run(LONG_SETUP, 1.1067, { news: null }),
  };
}
