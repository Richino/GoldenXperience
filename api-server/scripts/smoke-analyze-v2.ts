/**
 * Analyze V2 on live OANDA data: each pair's decision, the first blocking
 * check, trend, pullback state and nearby zones, for both modes.
 * Read-only GETs (OANDA, ForexFactory); touches no database.
 *
 *   npx tsx scripts/smoke-analyze-v2.ts [EUR_USD GBP_JPY ...]
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2, type AnalyzeMode, type V2Timeframe } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { analyzeV2 } from "../../frontend/src/lib/strategy/analyze-v2/decide.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const GRANULARITY: Record<V2Timeframe, string> = { M5: "M5", M15: "M15", H1: "H1", H4: "H4", D1: "D" };
const pairs = (process.argv.slice(2).length ? process.argv.slice(2) : ["EUR_USD", "GBP_USD", "USD_JPY", "GBP_JPY", "AUD_USD"]) as MajorInstrument[];

const calendar = await getEconomicCalendar();
const news = calendar.data.connected ? calendar.data.events : null;
console.log(`calendar: ${calendar.data.connected ? "connected" : `UNAVAILABLE (${calendar.status.message})`}`);
for (const instrument of pairs) {
  const digits = precisionFor(instrument);
  const pricing = await getPricing([instrument]);
  const quote = pricing.data[0] ? { bid: pricing.data[0].bid, ask: pricing.data[0].ask, time: pricing.data[0].time } : null;
  for (const mode of ["NORMAL", "SWING"] as AnalyzeMode[]) {
    const config = ANALYZE_V2[mode];
    const candles: Partial<Record<V2Timeframe, Awaited<ReturnType<typeof getCandles>>["data"]["candles"]>> = {};
    for (const timeframe of [config.primary, config.higher]) {
      const series = await getCandles(instrument, GRANULARITY[timeframe] as never, 250);
      candles[timeframe] = series.data.candles;
    }
    const result = analyzeV2({ instrument, mode, candles, quote, now: Date.now(), news });
    const read = result.foundation;
    const blocking = result.checks.filter((check) => check.status === "FAIL" || check.status === "UNKNOWN").filter((check) => check.evaluated);
    const fmt = (value: number | null | undefined) => (typeof value === "number" ? value.toFixed(digits) : "—");
    const problems = read.data.checks.filter((check) => check.status !== "PASS").map((check) => `${check.id}:${check.status}`);
    const near = read.zones
      .filter((zone) => zone.distanceAtr <= 3)
      .map((zone) => `${fmt(zone.low)}–${fmt(zone.high)} ${zone.type.slice(0, 3)}${zone.status === "BROKEN" ? "/broken" : ""} ${zone.relevance.toLowerCase()} (${zone.sources.join("+")})`);
    const verdict = result.execution
      ? `${result.decision} entry ${fmt(result.execution.entry)} stop ${fmt(result.execution.stop)} target ${fmt(result.execution.target)} ${result.execution.rewardRisk.toFixed(2)}R`
      : `${result.decision} — blocked by ${blocking.map((check) => check.id).join(", ")}`;
    console.log(`\n${instrument} ${mode}  ${verdict}  ref ${fmt(read.referencePrice)}  spread ${read.data.quote.executable?.spreadPips.toFixed(1) ?? "—"}`);
    for (const check of blocking) console.log(`  ✗ ${check.label}: ${check.reason}`);
    const liq = result.liquidity.assessment;
    const side = (item: typeof liq.nearestAbove) => item ? `${item.level.labels.join("/")} ${fmt(item.level.price)} ${item.level.status} (${item.distancePips.toFixed(1)}p)` : "—";
    console.log(`  liquidity: ${liq.risk} · above ${side(liq.nearestAbove)} · below ${side(liq.nearestBelow)} · ${result.liquidity.levels.length} levels`);
    console.log(`  ${read.alignmentText}`);
    console.log(`  evidence: ${read.primary?.evidence.join(" · ")}`);
    console.log(`  pullback: ${read.pullback?.state}${read.pullback?.depth != null ? ` depth ${Math.round(read.pullback.depth * 100)}%` : ""}${read.pullback?.zone ? ` zone ${fmt(read.pullback.zone.low)}–${fmt(read.pullback.zone.high)}` : ""} — ${read.pullback?.notes.join(" ")}`);
    console.log(`  zones ≤3 ATR: ${near.length ? near.join(" | ") : "none"}`);
    console.log(`  data: ${problems.length ? problems.join(", ") : "all PASS"}`);
  }
}
