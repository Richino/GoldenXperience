/**
 * Frozen one-year EUR/USD direction audit.
 *
 * It evaluates only the pre-existing trend-direction-v1 SHORT calls and asks
 * whether the EUR/USD mid-price is lower at fixed 4h through 72h horizons. This is not
 * an execution replay: no stop, target, trade rows, or broker state is used.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { detectTrendDirectionV1, type TrendCandle } from "../src/trend-direction-v1.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const output = path.join(root, "research-v2", "eur-usd-trend-v1-shorts-72h");
if (!existsSync(output)) mkdirSync(output, { recursive: true });

const WARMUP_START = "2025-07-20T00:00:00.000Z";
const REPLAY_START = "2025-08-01T00:00:00.000Z";
const REPLAY_END = "2026-08-01T00:00:00.000Z";
const DATA_END = "2026-08-04T00:00:00.000Z"; // preserves 72h labels for final decisions
const HORIZONS_HOURS = [4, 12, 24, 48, 72] as const;
const LOCK_HORIZON_MS = 72 * 3_600_000;
const stepMs: Record<"M15" | "H1", number> = { M15: 15 * 60_000, H1: 60 * 60_000 };

async function fetchRaw(granularity: "M15" | "H1") {
  const bars = new Map<string, TrendCandle>();
  let cursor = WARMUP_START;
  for (let page = 0; page < 20; page++) {
    const url = `${host}/v3/instruments/EUR_USD/candles?price=BA&granularity=${granularity}&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`EUR_USD ${granularity} fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const midpoint = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2;
      return { closeTime: new Date(Date.parse(bar.time) + stepMs[granularity]).toISOString(), open: midpoint("o"), high: midpoint("h"), low: midpoint("l"), close: midpoint("c"), bidOpen: +bar.bid.o, bidHigh: +bar.bid.h, bidLow: +bar.bid.l, bidClose: +bar.bid.c, askOpen: +bar.ask.o, askHigh: +bar.ask.h, askLow: +bar.ask.l, askClose: +bar.ask.c };
    });
    for (const bar of pageBars) if (bar.closeTime < DATA_END) bars.set(bar.closeTime, bar);
    if (pageBars.length < 5000 || !pageBars.length) break;
    cursor = pageBars.at(-1)!.closeTime;
    if (Date.parse(cursor) >= Date.parse(DATA_END)) break;
  }
  return [...bars.values()].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}
function h1AtOrBefore(bars: TrendCandle[], time: string) {
  const target = Date.parse(time); let low = 0; let high = bars.length - 1; let found = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (Date.parse(bars[middle]!.closeTime) <= target) { found = middle; low = middle + 1; } else high = middle - 1; }
  return found;
}
function finalIndexAtOrBefore(bars: TrendCandle[], timestamp: number) {
  let low = 0; let high = bars.length - 1; let found = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (Date.parse(bars[middle]!.closeTime) <= timestamp) { found = middle; low = middle + 1; } else high = middle - 1; }
  return found;
}
function sessionEligible(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === kind)?.value ?? "0");
  const minutes = value("hour") * 60 + value("minute");
  return minutes >= 3 * 60 && minutes < 16 * 60 + 45;
}
type PathRow = { time: string; lowerByHorizon: Record<number, boolean> };
function horizonSummary(rows: PathRow[]) {
  return Object.fromEntries(HORIZONS_HOURS.map((hours) => {
    const lower = rows.filter((row) => row.lowerByHorizon[hours]).length;
    return [hours, { n: rows.length, lowerAfterHorizon: lower, downRate: rows.length ? lower / rows.length : null }];
  }));
}

const [m15, h1] = await Promise.all([fetchRaw("M15"), fetchRaw("H1")]);
const allEligible: PathRow[] = [];
const shortSignals: Array<PathRow & { netPipsByHorizon: Record<number, number>; atrPips: number; slopeAtrPerBar: number }> = [];
for (let index = 200; index < m15.length; index++) {
  const bar = m15[index]!;
  if (bar.closeTime < REPLAY_START || bar.closeTime >= REPLAY_END || !sessionEligible(bar.closeTime)) continue;
  const lowerByHorizon: Record<number, boolean> = {};
  const netPipsByHorizon: Record<number, number> = {};
  let completePath = true;
  for (const hours of HORIZONS_HOURS) {
    const horizonMs = hours * 3_600_000;
    const endIndex = finalIndexAtOrBefore(m15, Date.parse(bar.closeTime) + horizonMs);
    if (endIndex < 0 || Date.parse(m15[endIndex]!.closeTime) < Date.parse(bar.closeTime) + horizonMs - 30 * 60_000) { completePath = false; break; }
    lowerByHorizon[hours] = m15[endIndex]!.close < bar.close;
    netPipsByHorizon[hours] = (m15[endIndex]!.close - bar.close) / 0.0001;
  }
  if (!completePath) continue;
  allEligible.push({ time: bar.closeTime, lowerByHorizon });
  const h1Index = h1AtOrBefore(h1, bar.closeTime);
  if (h1Index < 200) continue;
  const decision = detectTrendDirectionV1("EUR_USD", m15.slice(index - 199, index + 1), h1.slice(h1Index - 199, h1Index + 1));
  if (decision.action === "TRADE" && decision.direction === "short") {
    shortSignals.push({ time: decision.decisionTime, lowerByHorizon, netPipsByHorizon, atrPips: decision.atrPips, slopeAtrPerBar: decision.slopeAtrPerBar });
  }
}
const nonOverlapping: typeof shortSignals = [];
let unlockedAt = Number.NEGATIVE_INFINITY;
for (const signal of shortSignals) {
  const at = Date.parse(signal.time);
  if (at < unlockedAt) continue;
  nonOverlapping.push(signal);
  unlockedAt = at + LOCK_HORIZON_MS;
}
const report = {
  generatedAt: new Date().toISOString(),
  scope: {
    instrument: "EUR_USD",
    period: "2025-08-01 through 2026-07-31",
    signal: "unchanged trend-direction-v1 SHORT only: H1 bearish slope, structure and EMA agreement plus M15 pullback-resumption trigger",
    label: "mid-price at the last completed M15 close at or before each 4h, 12h, 24h, 48h, and 72h calendar horizon is below the decision mid-price",
    source: "raw OANDA bid/ask candles fetched at runtime",
    excludes: "all trade rows, position sizing, stops, targets, execution P&L, and post-result parameter changes",
  },
  coverage: { m15Bars: m15.length, h1Bars: h1.length, eligibleM15DecisionBars: allEligible.length },
  results: {
    allOverlappingShortSignals: horizonSummary(shortSignals),
    independentShortSignalsOnePer72hWindow: horizonSummary(nonOverlapping),
    matchedSessionEurUsdM15DecisionBars: horizonSummary(allEligible),
  },
  signals: shortSignals,
  nonOverlappingSignals: nonOverlapping,
};
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.results, null, 2));
