/**
 * Frozen 12-month trend-direction-v1 execution comparison.
 * Fetches raw OANDA bid/ask candles; it never reads prior trade rows or writes
 * database records. Original, inverse, and 100 deterministic random controls
 * receive independent one-open-position-per-pair simulations.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { labelOutcome } from "../src/research.js";
import { detectTrendDirectionV1, type TrendCandle, type TrendDirection } from "../src/trend-direction-v1.js";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";
const output = path.join(serviceRoot, "research-v2", "trend-direction-v1-frozen-12mo-1p5r");
if (!existsSync(output)) mkdirSync(output, { recursive: true });
const pairs = ["EUR_USD", "GBP_USD", "USD_JPY"];
const warmupStart = "2025-07-20T00:00:00.000Z";
const replayStart = "2025-08-01T00:00:00.000Z";
const replayEnd = "2026-08-01T00:00:00.000Z";
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const stepMs: Record<"M15" | "H1", number> = { M15: 15 * 60_000, H1: 60 * 60_000 };

async function fetchRaw(pair: string, granularity: "M15" | "H1") {
  const bars = new Map<string, TrendCandle>(); let cursor = warmupStart;
  for (let page = 0; page < 20; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=${granularity}&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair} ${granularity} fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const mid = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2;
      return { closeTime: new Date(Date.parse(bar.time) + stepMs[granularity]).toISOString(), open: mid("o"), high: mid("h"), low: mid("l"), close: mid("c"), bidOpen: +bar.bid.o, bidHigh: +bar.bid.h, bidLow: +bar.bid.l, bidClose: +bar.bid.c, askOpen: +bar.ask.o, askHigh: +bar.ask.h, askLow: +bar.ask.l, askClose: +bar.ask.c };
    });
    for (const bar of pageBars) if (bar.closeTime < replayEnd) bars.set(bar.closeTime, bar);
    if (!pageBars.length || pageBars.length < 5000) break;
    const last = pageBars.at(-1)!; cursor = last.closeTime;
    if (Date.parse(cursor) >= Date.parse(replayEnd)) break;
  }
  return [...bars.values()].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}
function h1AtOrBefore(bars: TrendCandle[], time: string) { const target = Date.parse(time); let low = 0; let high = bars.length - 1; let found = -1; while (low <= high) { const middle = (low + high) >> 1; if (Date.parse(bars[middle]!.closeTime) <= target) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }
function opposite(direction: TrendDirection): TrendDirection { return direction === "long" ? "short" : "long"; }
function randomDirection(pair: string, time: string, seed: number): TrendDirection {
  let hash = 2166136261 ^ seed;
  for (const character of `${pair}|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  // Avalanche before selecting a side: FNV's raw low bit preserves too much
  // of the seed and otherwise creates only two effective random controls.
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  return (hash >>> 0) % 2 === 0 ? "long" : "short";
}
type Candidate = { pair: string; index: number; direction: TrendDirection; decisionTime: string; entry: number; stop: number; target: number };
type Result = { n: number; wins: number; totalR: number; expectancyR: number; winRate: number; byPair: Record<string, { n: number; totalR: number; expectancyR: number }> };
const m15ByPair = new Map<string, TrendCandle[]>(); const candidates: Candidate[] = [];
for (const pair of pairs) {
  const [m15, h1] = await Promise.all([fetchRaw(pair, "M15"), fetchRaw(pair, "H1")]);
  m15ByPair.set(pair, m15);
  for (let index = 200; index < m15.length - 1; index++) {
    const bar = m15[index]!; if (bar.closeTime < replayStart || bar.closeTime >= replayEnd) continue;
    const h1Index = h1AtOrBefore(h1, bar.closeTime); if (h1Index < 200) continue;
    const decision = detectTrendDirectionV1(pair, m15.slice(index - 199, index + 1), h1.slice(h1Index - 199, h1Index + 1));
    if (decision.action === "TRADE") candidates.push({ pair, index, direction: decision.direction, decisionTime: decision.decisionTime, entry: decision.entry, stop: decision.stop, target: decision.target });
  }
}
candidates.sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime));
function simulate(kind: "original" | "inverse" | "random", seed = 0): Result {
  const openUntil = new Map<string, number>(); const rows: Array<{ pair: string; resultR: number }> = [];
  for (const candidate of candidates) {
    const at = Date.parse(candidate.decisionTime); if (at < (openUntil.get(candidate.pair) ?? Number.NEGATIVE_INFINITY)) continue;
    const direction = kind === "original" ? candidate.direction : kind === "inverse" ? opposite(candidate.direction) : randomDirection(candidate.pair, candidate.decisionTime, seed);
    const bars = m15ByPair.get(candidate.pair)!; const bar = bars[candidate.index]!;
    const riskDistance = Math.abs(candidate.entry - candidate.stop); const targetDistance = Math.abs(candidate.target - candidate.entry);
    const entry = direction === "long" ? bar.askClose : bar.bidClose;
    const stop = direction === "long" ? entry - riskDistance : entry + riskDistance;
    const target = direction === "long" ? entry + targetDistance : entry - targetDistance;
    const outcome = labelOutcome(direction, entry, stop, target, candidate.decisionTime, bars.slice(candidate.index + 1, candidate.index + 193));
    const released = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : at + 48 * 3600_000;
    openUntil.set(candidate.pair, released);
    if (outcome.resultR !== null && outcome.outcome !== "ambiguous") rows.push({ pair: candidate.pair, resultR: outcome.resultR });
  }
  const totalR = rows.reduce((sum, row) => sum + row.resultR, 0); const wins = rows.filter((row) => row.resultR > 0).length; const byPair: Result["byPair"] = {};
  for (const pair of pairs) { const arm = rows.filter((row) => row.pair === pair); const armR = arm.reduce((sum, row) => sum + row.resultR, 0); byPair[pair] = { n: arm.length, totalR: armR, expectancyR: arm.length ? armR / arm.length : 0 }; }
  return { n: rows.length, wins, totalR, expectancyR: rows.length ? totalR / rows.length : 0, winRate: rows.length ? wins / rows.length : 0, byPair };
}
const original = simulate("original"); const inverse = simulate("inverse"); const random = Array.from({ length: 100 }, (_, index) => simulate("random", index + 1));
const randomExpectancies = random.map((result) => result.expectancyR).sort((a, b) => a - b);
const report = { generatedAt: new Date().toISOString(), scope: { period: "2025-08-01 through 2026-07-31", pairs, source: "raw OANDA bid/ask candles fetched at runtime", frozenDetector: "trend-direction-v1; no thresholds changed after August 2026" }, execution: { targetR: 1.5, sameCandidates: candidates.length, eachArm: "own bid/ask fills, preserved stop/target distance, forced session exit, one open position per pair" }, arms: { original, inverse, randomControls: { count: random.length, meanExpectancyR: random.reduce((sum, result) => sum + result.expectancyR, 0) / random.length, medianExpectancyR: randomExpectancies[49]!, p05ExpectancyR: randomExpectancies[4]!, p95ExpectancyR: randomExpectancies[94]!, controlsBeatenByInverse: random.filter((result) => inverse.expectancyR > result.expectancyR).length } } };
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
