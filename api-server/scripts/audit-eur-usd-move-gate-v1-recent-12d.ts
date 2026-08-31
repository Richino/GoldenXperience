/** Read-only recent EUR/USD Stage-1 replay. No shadow rows or trade rows. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { evaluateEurUsdMoveGateV1 } from "../src/eur-usd-move-gate-v1.js";
import type { ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const output = path.join(root, "research-v2", "eur-usd-move-gate-v1-recent-12d");
if (!existsSync(output)) mkdirSync(output, { recursive: true });

const BAR_MS = 15 * 60_000;
const HORIZON_BARS = 16;
const PERIOD_MS = 12 * 24 * 60 * 60_000;
const STOP_ATR = 0.75;
const TARGET_ATR = 1.5;
type Direction = "long" | "short";
type Bar = { closeTime: string; candle: Candle; bidClose: number; bidHigh: number; bidLow: number; askClose: number; askHigh: number; askLow: number };
type Row = { time: string; action: "MOVE" | "WAIT"; hit: boolean };

function closeTime(time: string) { return new Date(Date.parse(time) + BAR_MS).toISOString(); }
function normalized(candles: ResearchCandle[]): Bar[] { return candles.filter((candle) => candle.complete).map((candle) => ({ closeTime: closeTime(candle.time), candle: { time: closeTime(candle.time), open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true }, bidClose: candle.bid.close, bidHigh: candle.bid.high, bidLow: candle.bid.low, askClose: candle.ask.close, askHigh: candle.ask.high, askLow: candle.ask.low })).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime)); }
function targetFirst(direction: Direction, entry: number, atr: number, future: Bar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) { const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target; const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop; if (targetHit && stopHit) return false; if (targetHit) return true; if (stopHit) return false; }
  return false;
}
function seeded(time: string, seed: number) { let hash = 2166136261 ^ seed; for (const c of `EUR_USD|${time}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return hash >>> 0; }
function score(rows: Row[]) { const hits = rows.filter((row) => row.hit).length; return { n: rows.length, hits, hitRate: rows.length ? hits / rows.length : 0 }; }
function randomControls(rows: Row[], selectedCount: number) { const rates = Array.from({ length: 100 }, (_, seed) => score([...rows].sort((a, b) => seeded(a.time, seed + 1) - seeded(b.time, seed + 1)).slice(0, selectedCount)).hitRate).sort((a, b) => a - b); return { count: 100, meanHitRate: rates.reduce((sum, value) => sum + value, 0) / rates.length, p95HitRate: rates[94] ?? 0 }; }

console.log("Fetching recent raw OANDA EUR/USD M15 bid/ask history (read-only)...");
const bars = normalized(await getResearchCandles("EUR_USD", "M15", 2000));
const latest = bars.at(-1);
if (!latest) throw new Error("No completed OANDA EUR/USD M15 candles returned.");
const labelableEnd = Date.parse(latest.closeTime) - HORIZON_BARS * BAR_MS;
const periodStart = labelableEnd - PERIOD_MS;
const rows: Row[] = [];
for (let index = 199; index < bars.length - HORIZON_BARS; index += 1) {
  const bar = bars[index]!; const time = Date.parse(bar.closeTime);
  if (time < periodStart || time > labelableEnd) continue;
  const future = bars.slice(index + 1, index + 1 + HORIZON_BARS);
  if (future.length !== HORIZON_BARS || Date.parse(future.at(-1)!.closeTime) - time !== HORIZON_BARS * BAR_MS) continue;
  const decision = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: bars.slice(index - 199, index + 1).map((item) => item.candle), bid: bar.bidClose, ask: bar.askClose });
  if (decision.atr === null) continue;
  const hit = targetFirst("long", bar.askClose, decision.atr, future) || targetFirst("short", bar.bidClose, decision.atr, future);
  rows.push({ time: bar.closeTime, action: decision.action, hit });
}
const move = rows.filter((row) => row.action === "MOVE");
const wait = rows.filter((row) => row.action === "WAIT");
const report = { generatedAt: new Date().toISOString(), scope: { instrument: "EUR_USD", source: "raw OANDA M15 bid/ask candles fetched at runtime", period: { start: new Date(periodStart).toISOString(), end: new Date(labelableEnd).toISOString() }, label: "within four hours, either long or short reaches +1.5 M15 ATR before its own -0.75 M15 ATR stop; same-bar collision fails closed", excludes: "all trade rows, shadow-table writes, paper-engine writes, and direction selection" }, results: { all: score(rows), move: score(move), wait: score(wait), randomControlsMatchedToMoveCount: randomControls(rows, move.length) }, verdict: "DESCRIPTIVE_RECENT_12_DAY_REPLAY_NOT_A_NEW_MODEL_SELECTION" };
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
