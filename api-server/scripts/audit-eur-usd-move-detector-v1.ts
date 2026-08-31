/**
 * EUR/USD move-detector audit. This validates the prior movement heuristic
 * against a direction-neutral, executable label: within four hours, can either
 * side reach 1.5 M15 ATR before its own 0.75 M15 ATR stop using bid/ask bars?
 * Reads stored OANDA market quotes only; no trade rows or database writes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import { estimateMovementOpportunity } from "../src/directional-research.js";

type Bar = { closeTime: string; open: number; high: number; low: number; close: number; bidClose: number; bidHigh: number; bidLow: number; askClose: number; askHigh: number; askLow: number; complete: true };
type Row = { time: string; qualified: boolean; moveHit: boolean };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const output = path.join(root, "research-v2", "eur-usd-move-detector-v1"); if (!existsSync(output)) mkdirSync(output, { recursive: true });
const DEVELOPMENT = { start: "2021-06-03T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" };
const SEALED_HOLDOUT = { start: "2024-01-01T00:00:00.000Z", end: "2025-08-01T00:00:00.000Z" };
const BAR_MS = 15 * 60_000; const HORIZON_BARS = 16; const STOP_ATR = 0.75; const TARGET_ATR = 1.5; const PIP = 0.0001;

function lower99(correct: number, n: number) { if (!n) return 0; const z = 2.576; const p = correct / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function seeded(time: string, seed: number) { let hash = 2166136261 ^ seed; for (const c of `EUR_USD|${time}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return hash >>> 0; }
function score(rows: Row[]) { const hits = rows.filter((row) => row.moveHit).length; return { n: rows.length, hits, hitRate: rows.length ? hits / rows.length : 0, lower99: lower99(hits, rows.length) }; }
function randomControls(all: Row[], selectedCount: number) { const rates = Array.from({ length: 100 }, (_, seed) => { const chosen = [...all].sort((a, b) => seeded(a.time, seed + 1) - seeded(b.time, seed + 1)).slice(0, selectedCount); return score(chosen).hitRate; }).sort((a, b) => a - b); return { count: 100, meanHitRate: rates.reduce((sum, value) => sum + value, 0) / rates.length, p95HitRate: rates[94] ?? 0 }; }
function sideTargetFirst(direction: "long" | "short", entry: number, atr: number, future: Bar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) { const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target; const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop; if (targetHit && stopHit) return false; if (targetHit) return true; if (stopHit) return false; }
  return false;
}
function rowsFor(bars: Bar[], period: { start: string; end: string }) {
  const rows: Row[] = [];
  for (let index = 200; index < bars.length - HORIZON_BARS; index += 1) {
    const bar = bars[index]!; if (bar.closeTime < period.start || bar.closeTime >= period.end) continue;
    const future = bars.slice(index + 1, index + 1 + HORIZON_BARS); if (future.length < HORIZON_BARS || Date.parse(future.at(-1)!.closeTime) - Date.parse(bar.closeTime) !== HORIZON_BARS * BAR_MS) continue;
    const history = bars.slice(index - 199, index + 1); const atr = calculateAtrValues(history as never, 14).at(-1) ?? 0; if (!(atr > 0)) continue;
    const estimate = estimateMovementOpportunity(history as never, history.length - 1, atr, (bar.askClose - bar.bidClose) / PIP, PIP);
    const longHit = sideTargetFirst("long", bar.askClose, atr, future); const shortHit = sideTargetFirst("short", bar.bidClose, atr, future);
    rows.push({ time: bar.closeTime, qualified: estimate.qualified, moveHit: longHit || shortHit });
  }
  return rows;
}
const records = await query<{ close_time: string; bid_open: number; bid_high: number; bid_low: number; bid_close: number; ask_open: number; ask_high: number; ask_low: number; ask_close: number }>(
  `SELECT close_time::text,bid_open::float,bid_high::float,bid_low::float,bid_close::float,ask_open::float,ask_high::float,ask_low::float,ask_close::float FROM market_candle_quotes WHERE instrument='EUR_USD' AND timeframe='M15' AND source='oanda' AND close_time >= $1 AND close_time < $2 ORDER BY close_time`, [DEVELOPMENT.start, SEALED_HOLDOUT.end],
);
const bars: Bar[] = records.rows.map((row) => ({ closeTime: new Date(row.close_time).toISOString(), open: (row.bid_open + row.ask_open) / 2, high: (row.bid_high + row.ask_high) / 2, low: (row.bid_low + row.ask_low) / 2, close: (row.bid_close + row.ask_close) / 2, bidClose: row.bid_close, bidHigh: row.bid_high, bidLow: row.bid_low, askClose: row.ask_close, askHigh: row.ask_high, askLow: row.ask_low, complete: true }));
const developmentRows = rowsFor(bars, DEVELOPMENT); const developmentQualified = developmentRows.filter((row) => row.qualified); const development = { all: score(developmentRows), heuristicQualified: score(developmentQualified), randomControls: randomControls(developmentRows, developmentQualified.length) };
const qualifies = development.heuristicQualified.n >= 500 && development.heuristicQualified.hitRate > development.randomControls.p95HitRate;
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), scope: { instrument: "EUR_USD", source: "stored OANDA M15 bid/ask market quotes only", detector: "existing movement-heuristic-v1", label: "within four hours, either long or short reaches +1.5 M15 ATR before its own -0.75 M15 ATR stop; a same-bar stop/target collision fails closed", developmentPeriod: DEVELOPMENT, sealedHoldoutPeriod: SEALED_HOLDOUT, excludes: "trade rows, paper-engine writes, direction selection, and execution changes" }, development, qualifiedForSealedHoldout: qualifies };
if (qualifies) { const holdoutRows = rowsFor(bars, SEALED_HOLDOUT); const holdoutQualified = holdoutRows.filter((row) => row.qualified); report.sealedHoldout = { all: score(holdoutRows), heuristicQualified: score(holdoutQualified), randomControls: randomControls(holdoutRows, holdoutQualified.length) }; report.verdict = "HEURISTIC_QUALIFIED_HOLDOUT_REVEALED"; } else report.verdict = "HEURISTIC_DID_NOT_QUALIFY_SEALED_HOLDOUT_NOT_EVALUATED";
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
