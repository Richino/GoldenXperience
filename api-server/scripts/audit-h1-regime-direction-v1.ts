/**
 * Direction-only audit of the H1 regime component.
 * Uses raw OANDA bid/ask candles fetched at runtime. It reads no trade rows,
 * writes no database data, and has no stop/target/execution logic.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { classifyH1RegimeDirectionV1, type H1Direction } from "../src/h1-regime-direction-v1.js";

type Candle = { closeTime: string; close: number; high: number; low: number };
type Actual = "UP" | "DOWN";
type Row = { pair: string; time: string; predicted: Exclude<H1Direction, "NO_DIRECTION">; actual: Actual };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const pairs = ["EUR_USD", "GBP_USD", "USD_JPY"];
const warmupStart = "2025-07-20T00:00:00.000Z"; const replayStart = "2025-08-01T00:00:00.000Z"; const replayEnd = "2026-08-01T00:00:00.000Z";
const output = path.join(root, "research-v2", "h1-regime-direction-v1-audit"); if (!existsSync(output)) mkdirSync(output, { recursive: true });

async function fetchH1(pair: string) {
  const seen = new Map<string, Candle>(); let cursor = warmupStart;
  for (let page = 0; page < 20; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=H1&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair} H1 fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const midpoint = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2;
      return { closeTime: new Date(Date.parse(bar.time) + 3_600_000).toISOString(), close: midpoint("c"), high: midpoint("h"), low: midpoint("l") };
    });
    for (const bar of pageBars) if (bar.closeTime < replayEnd) seen.set(bar.closeTime, bar);
    if (pageBars.length < 5000) break;
    cursor = pageBars.at(-1)!.closeTime;
    if (Date.parse(cursor) >= Date.parse(replayEnd)) break;
  }
  return [...seen.values()].sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
}

function randomDirection(pair: string, time: string, seed: number): Actual {
  let hash = 2166136261 ^ seed;
  for (const character of `${pair}|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  return (hash >>> 0) % 2 === 0 ? "UP" : "DOWN";
}
function rate(rows: Row[], pick: (row: Row) => Actual) { return rows.length ? rows.filter((row) => pick(row) === row.actual).length / rows.length : 0; }

const rows: Row[] = []; const baseRows: Array<{ actual: Actual }> = [];
for (const pair of pairs) {
  const bars = await fetchH1(pair);
  for (let index = 50; index < bars.length - 1; index++) {
    const current = bars[index]!; const future = bars[index + 1]!;
    if (current.closeTime < replayStart || current.closeTime >= replayEnd || Date.parse(future.closeTime) - Date.parse(current.closeTime) !== 3_600_000 || future.close === current.close) continue;
    const actual: Actual = future.close > current.close ? "UP" : "DOWN"; baseRows.push({ actual });
    const direction = classifyH1RegimeDirectionV1(bars.slice(index - 49, index + 1));
    if (direction !== "NO_DIRECTION") rows.push({ pair, time: current.closeTime, predicted: direction, actual });
  }
}
const random = Array.from({ length: 100 }, (_, seed) => rate(rows, (row) => randomDirection(row.pair, row.time, seed + 1))).sort((left, right) => left - right);
const byPair = Object.fromEntries(pairs.map((pair) => { const arm = rows.filter((row) => row.pair === pair); return [pair, { n: arm.length, accuracy: rate(arm, (row) => row.predicted), inverseAccuracy: rate(arm, (row) => row.predicted === "UP" ? "DOWN" : "UP") }]; }));
const report = { generatedAt: new Date().toISOString(), scope: { period: "2025-08-01 through 2026-07-31", horizon: "next completed H1 midpoint close", source: "raw OANDA bid/ask candles fetched at runtime", excludes: "M15 trigger, trade rows, stops, targets, spreads, execution, and position locks" }, coverage: { eligibleH1Bars: baseRows.length, directionalCalls: rows.length, abstained: baseRows.length - rows.length }, direction: { accuracy: rate(rows, (row) => row.predicted), inverseAccuracy: rate(rows, (row) => row.predicted === "UP" ? "DOWN" : "UP"), randomControls: { count: 100, meanAccuracy: random.reduce((sum, value) => sum + value, 0) / random.length, p05Accuracy: random[4]!, p95Accuracy: random[94]! }, byPair }, baseRate: { up: baseRows.filter((row) => row.actual === "UP").length / baseRows.length, down: baseRows.filter((row) => row.actual === "DOWN").length / baseRows.length } };
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
