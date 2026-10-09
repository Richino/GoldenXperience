/**
 * One real explanation call for a live Analyze V2 result (or the synthetic
 * LONG from the test fixtures with --synthetic), printing the explanation or
 * why it was rejected. Uses OPENAI_API_KEY; read-only otherwise.
 *
 *   npx tsx scripts/smoke-analyze-explain.ts USD_CAD SWING
 *   npx tsx scripts/smoke-analyze-explain.ts --synthetic
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { ANALYZE_V2, type AnalyzeMode, type V2Timeframe } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { analyzeV2, type AnalysisResult } from "../../frontend/src/lib/strategy/analyze-v2/decide.js";
import { explanationFacts } from "../../frontend/src/lib/strategy/analyze-v2/explain.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { explainAnalysis } from "../src/analyze-explain.js";

const GRANULARITY: Record<V2Timeframe, string> = { M5: "M5", M15: "M15", H1: "H1", H4: "H4", D1: "D" };

function syntheticLong(): AnalysisResult {
  const start = Date.parse("2026-09-21T00:00:00Z");
  const leg = (turns: number[], bars: number, step: number, wick: number, from: number) => {
    const closes: number[] = [];
    for (let i = 0; i < turns.length - 1; i += 1) for (let j = 1; j <= bars; j += 1) closes.push(turns[i]! + ((turns[i + 1]! - turns[i]!) * j) / bars);
    let previous = turns[0]!;
    return closes.map((close, index): Candle => {
      const candle = { time: new Date(from + index * step).toISOString(), open: previous, high: Math.max(previous, close) + wick, low: Math.min(previous, close) - wick, close, volume: 1, complete: true };
      previous = close;
      return candle;
    });
  };
  const m15 = leg([1.1030, 1.1000, 1.1060, 1.1030, 1.1090, 1.1060, 1.1120, 1.1105, 1.1091, 1.1096], 15, 900_000, 0.0001, start);
  // Rebuild the fixture's exact tail: 6 bars to 1.1105, 5 to 1.1091, 1 to 1.1096.
  const base = m15.slice(0, 90);
  const extend = (candles: Candle[], target: number, bars: number) => {
    const out = [...candles];
    const fromPrice = out.at(-1)!.close;
    for (let i = 1; i <= bars; i += 1) {
      const close = fromPrice + ((target - fromPrice) * i) / bars;
      const open = out.at(-1)!.close;
      out.push({ time: new Date(Date.parse(out.at(-1)!.time) + 900_000).toISOString(), open, high: Math.max(open, close) + 0.0001, low: Math.min(open, close) - 0.0001, close, volume: 1, complete: true });
    }
    return out;
  };
  const setup = extend(extend(extend(base, 1.1105, 6), 1.1091, 5), 1.1096, 1);
  const end = Math.floor(Date.parse(setup.at(-1)!.time) / 3_600_000) * 3_600_000;
  const h1 = leg([1.0950, 1.0900, 1.1000, 1.0960, 1.1060, 1.1020, 1.1100], 12, 3_600_000, 0.0002, end - 71 * 3_600_000);
  const now = Date.parse(setup.at(-1)!.time) + 930_000;
  return analyzeV2({ instrument: "EUR_USD", mode: "NORMAL", candles: { M15: setup, H1: h1 }, quote: { bid: 1.10954, ask: 1.10966, time: new Date(now - 2000).toISOString() }, now, news: [] });
}

async function live(instrument: MajorInstrument, mode: AnalyzeMode): Promise<AnalysisResult> {
  const config = ANALYZE_V2[mode];
  const pricing = await getPricing([instrument]);
  const quote = pricing.data[0] ? { bid: pricing.data[0].bid, ask: pricing.data[0].ask, time: pricing.data[0].time } : null;
  const candles: Partial<Record<V2Timeframe, Candle[]>> = {};
  for (const timeframe of [config.primary, config.higher, "D1"] as V2Timeframe[]) {
    candles[timeframe] = (await getCandles(instrument, GRANULARITY[timeframe] as never, 250)).data.candles;
  }
  const calendar = await getEconomicCalendar();
  return analyzeV2({ instrument, mode, candles, quote, now: Date.now(), news: calendar.data.connected ? calendar.data.events : null });
}

const args = process.argv.slice(2);
const result = args[0] === "--synthetic" ? syntheticLong() : await live((args[0] ?? "USD_CAD") as MajorInstrument, (args[1] ?? "SWING") as AnalyzeMode);
console.log(`${result.pair} ${result.mode}: ${result.decision} — ${result.headline}\n`);
const started = Date.now();
try {
  const { explanation, model } = await explainAnalysis(explanationFacts(result));
  console.log(`model ${model}, ${Date.now() - started} ms\n`);
  for (const [key, value] of Object.entries(explanation)) console.log(`${key.toUpperCase()}: ${value}\n`);
} catch (error) {
  console.log(`NOT SHOWN (${Date.now() - started} ms): ${error instanceof Error ? error.message : error}`);
}
