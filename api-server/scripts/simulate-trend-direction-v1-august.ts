/** Research-only August 2026 sequential paper simulation from raw OANDA BA candles. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { labelOutcome } from "../src/research.js";
import { detectTrendDirectionV1, type TrendCandle } from "../src/trend-direction-v1.js";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";
const invert = (process.env.TREND_V1_INVERT ?? "false").toLowerCase() === "true";
const outDir = path.join(serviceRoot, "research-v2", invert ? "trend-direction-v1-august-2026-inverse" : "trend-direction-v1-august-2026");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const pairs = ["EUR_USD", "GBP_USD", "USD_JPY"];
const start = "2026-07-25T00:00:00.000Z"; const monthStart = "2026-08-01T00:00:00.000Z"; const end = "2026-08-28T00:00:00.000Z";
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw August candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const granMinutes: Record<string, number> = { M15: 15, H1: 60 };
async function candles(pair: string, granularity: "M15" | "H1"): Promise<TrendCandle[]> {
  const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=${granularity}&from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${pair} ${granularity} fetch failed: ${response.status}`);
  const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
  return (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => {
    const bid = bar.bid; const ask = bar.ask; const mid = (key: string) => (+bid[key]! + +ask[key]!) / 2;
    return { closeTime: new Date(Date.parse(bar.time) + granMinutes[granularity]! * 60_000).toISOString(), open: mid("o"), high: mid("h"), low: mid("l"), close: mid("c"), bidOpen: +bid.o, bidHigh: +bid.h, bidLow: +bid.l, bidClose: +bid.c, askOpen: +ask.o, askHigh: +ask.h, askLow: +ask.l, askClose: +ask.c };
  });
}
function h1AtOrBefore(bars: TrendCandle[], time: string) { const target = Date.parse(time); let low = 0; let high = bars.length - 1; let result = -1; while (low <= high) { const mid = (low + high) >> 1; if (Date.parse(bars[mid]!.closeTime) <= target) { result = mid; low = mid + 1; } else high = mid - 1; } return result; }
type SimTrade = { pair: string; signalDirection: string; direction: string; decisionTime: string; entry: number; stop: number; target: number; resultR: number | null; outcome: string; resolvedAt: string | null; atrPips: number; slopeAtrPerBar: number; spreadPips: number };
const trades: SimTrade[] = []; const waits: Record<string, number> = {};
for (const pair of pairs) {
  const [m15, h1] = await Promise.all([candles(pair, "M15"), candles(pair, "H1")]);
  let openUntil = Number.NEGATIVE_INFINITY;
  for (let index = 60; index < m15.length - 1; index++) {
    const bar = m15[index]!; const at = Date.parse(bar.closeTime); if (bar.closeTime < monthStart || bar.closeTime >= end || at < openUntil) continue;
    const h1Index = h1AtOrBefore(h1, bar.closeTime); if (h1Index < 60) continue;
    const decision = detectTrendDirectionV1(pair, m15.slice(0, index + 1), h1.slice(0, h1Index + 1));
    if (decision.action === "WAIT") { waits[decision.reason] = (waits[decision.reason] ?? 0) + 1; continue; }
    const direction = invert ? (decision.direction === "long" ? "short" : "long") : decision.direction;
    const riskDistance = Math.abs(decision.entry - decision.stop); const targetDistance = Math.abs(decision.target - decision.entry);
    const entry = direction === "long" ? bar.askClose : bar.bidClose;
    const stop = direction === "long" ? entry - riskDistance : entry + riskDistance;
    const target = direction === "long" ? entry + targetDistance : entry - targetDistance;
    const outcome = labelOutcome(direction, entry, stop, target, decision.decisionTime, m15.slice(index + 1));
    const releasedAt = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : at + 48 * 3600_000;
    openUntil = releasedAt;
    trades.push({ pair, signalDirection: decision.direction, direction, decisionTime: decision.decisionTime, entry, stop, target, resultR: outcome.resultR, outcome: outcome.outcome, resolvedAt: outcome.resolvedAt, atrPips: decision.atrPips, slopeAtrPerBar: decision.slopeAtrPerBar, spreadPips: decision.spreadPips });
  }
}
const resolved = trades.filter((trade) => trade.resultR !== null && trade.outcome !== "ambiguous"); const totalR = resolved.reduce((sum, trade) => sum + trade.resultR!, 0); const wins = resolved.filter((trade) => trade.resultR! > 0).length;
const report = { generatedAt: new Date().toISOString(), scope: { month: "August 2026", pairs, source: "fresh OANDA bid/ask candles fetched at runtime", notUsed: "No existing trade rows or prior strategy outcomes." }, strategy: { regime: "H1 ATR-normalized 48-bar regression slope plus 24-bar higher-high/higher-low or lower-low/lower-high structure", entry: "M15 EMA21 pullback followed by completed resumption candle", stop: "recent M15 pullback swing with 0.2 ATR buffer, at least 0.8 ATR", targetR: 2, execution: "bid/ask entry and bid/ask outcome resolver; one open trade per pair; forced session exit", inverted: invert }, result: { entries: trades.length, resolved: resolved.length, wins, winRate: resolved.length ? wins / resolved.length : null, totalR, expectancyR: resolved.length ? totalR / resolved.length : null }, waits, trades };
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.result, null, 2));
