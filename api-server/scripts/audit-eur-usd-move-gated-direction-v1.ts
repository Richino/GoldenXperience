/**
 * Tests a predeclared EUR/USD direction hypothesis only when the independently
 * audited movement-heuristic-v1 says MOVE.  It uses M15 OANDA bid/ask bars,
 * never reads trade rows, and makes no database writes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import { estimateMovementOpportunity } from "../src/directional-research.js";

type Direction = "long" | "short";
type Bar = { closeTime: string; open: number; high: number; low: number; close: number; bidClose: number; bidHigh: number; bidLow: number; askClose: number; askHigh: number; askLow: number; complete: true };
type Observation = { time: string; meanReversion: Direction; momentum: Direction; win: Record<Direction, boolean> };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const output = path.join(root, "research-v2", "eur-usd-move-gated-direction-v1");
if (!existsSync(output)) mkdirSync(output, { recursive: true });

const DEVELOPMENT = { start: "2021-06-03T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" };
const SEALED_HOLDOUT = { start: "2024-01-01T00:00:00.000Z", end: "2025-08-01T00:00:00.000Z" };
const BAR_MS = 15 * 60_000;
const HORIZON_BARS = 16;
const STOP_ATR = 0.75;
const TARGET_ATR = 1.5;
const PIP = 0.0001;

function lower99(wins: number, n: number) { if (!n) return 0; const z = 2.576; const p = wins / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function seededDirection(time: string, seed: number): Direction { let hash = 2166136261 ^ seed; for (const c of `EUR_USD|${time}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return (hash >>> 0) % 2 === 0 ? "long" : "short"; }
function targetFirst(direction: Direction, entry: number, atr: number, future: Bar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) {
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return false; // unknown intrabar order: fail closed
    if (targetHit) return true;
    if (stopHit) return false;
  }
  return false;
}
function armScore(rows: Observation[], arm: "meanReversion" | "momentum" | "random", seed = 0) {
  const wins = rows.filter((row) => row.win[arm === "random" ? seededDirection(row.time, seed) : row[arm]]).length;
  return { n: rows.length, wins, winRate: rows.length ? wins / rows.length : 0, lower99: lower99(wins, rows.length), expectancyR: rows.length ? (3 * wins / rows.length) - 1 : 0 };
}
function scorePeriod(rows: Observation[]) {
  const meanReversion = armScore(rows, "meanReversion");
  const momentum = armScore(rows, "momentum");
  const randomRates = Array.from({ length: 100 }, (_, index) => armScore(rows, "random", index + 1).winRate).sort((a, b) => a - b);
  return { meanReversion, momentum, randomControls: { count: 100, meanWinRate: randomRates.reduce((sum, value) => sum + value, 0) / randomRates.length, p95WinRate: randomRates[94] ?? 0 } };
}
function observations(bars: Bar[], period: { start: string; end: string }) {
  const rows: Observation[] = [];
  for (let index = 200; index < bars.length - HORIZON_BARS; index += 1) {
    const bar = bars[index]!;
    if (bar.closeTime < period.start || bar.closeTime >= period.end) continue;
    const priorHour = bars[index - 4]!;
    const future = bars.slice(index + 1, index + 1 + HORIZON_BARS);
    if (Date.parse(future.at(-1)!.closeTime) - Date.parse(bar.closeTime) !== HORIZON_BARS * BAR_MS || bar.close === priorHour.close) continue;
    const history = bars.slice(index - 199, index + 1);
    const atr = calculateAtrValues(history as never, 14).at(-1) ?? 0;
    if (!(atr > 0)) continue;
    const movement = estimateMovementOpportunity(history as never, history.length - 1, atr, (bar.askClose - bar.bidClose) / PIP, PIP);
    if (!movement.qualified) continue;
    const momentum: Direction = bar.close > priorHour.close ? "long" : "short";
    const meanReversion: Direction = momentum === "long" ? "short" : "long";
    rows.push({ time: bar.closeTime, meanReversion, momentum, win: { long: targetFirst("long", bar.askClose, atr, future), short: targetFirst("short", bar.bidClose, atr, future) } });
  }
  return rows;
}

const records = await query<{ close_time: string; bid_open: number; bid_high: number; bid_low: number; bid_close: number; ask_open: number; ask_high: number; ask_low: number; ask_close: number }>(
  `SELECT close_time::text,bid_open::float,bid_high::float,bid_low::float,bid_close::float,ask_open::float,ask_high::float,ask_low::float,ask_close::float FROM market_candle_quotes WHERE instrument='EUR_USD' AND timeframe='M15' AND source='oanda' AND close_time >= $1 AND close_time < $2 ORDER BY close_time`,
  [DEVELOPMENT.start, SEALED_HOLDOUT.end],
);
const bars: Bar[] = records.rows.map((row) => ({ closeTime: new Date(row.close_time).toISOString(), open: (row.bid_open + row.ask_open) / 2, high: (row.bid_high + row.ask_high) / 2, low: (row.bid_low + row.ask_low) / 2, close: (row.bid_close + row.ask_close) / 2, bidClose: row.bid_close, bidHigh: row.bid_high, bidLow: row.bid_low, askClose: row.ask_close, askHigh: row.ask_high, askLow: row.ask_low, complete: true }));
const developmentRows = observations(bars, DEVELOPMENT);
const development = scorePeriod(developmentRows);
const passes = (score: ReturnType<typeof armScore>) => score.n >= 1_000 && score.winRate >= 0.4 && score.lower99 > 1 / 3 && score.winRate > development.randomControls.p95WinRate;
const selectedArm = passes(development.meanReversion) ? "meanReversion" : passes(development.momentum) ? "momentum" : null;
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  scope: { instrument: "EUR_USD", source: "stored OANDA M15 bid/ask market quotes only", moveGate: "existing movement-heuristic-v1, independently audited before this direction test", candidates: "predeclared one-hour EUR/USD mean reversion and its exact momentum inverse", outcome: "after bid/ask fill at the completed M15 close, +1.5 M15 ATR target before -0.75 M15 ATR stop within four hours; same-bar collision and no target are losses", excludes: "trade rows, paper-engine writes, execution changes, and post-result direction flipping" },
  developmentPeriod: DEVELOPMENT, sealedHoldoutPeriod: SEALED_HOLDOUT, development, developmentQualification: { passRule: "n >= 1,000; win rate >= 40%; 99% Wilson lower bound above 33.33% break-even; beats random p95", selectedArm },
};
if (selectedArm) { const holdout = scorePeriod(observations(bars, SEALED_HOLDOUT)); report.sealedHoldout = holdout; report.verdict = "DIRECTION_ARM_QUALIFIED_HOLDOUT_REVEALED"; } else report.verdict = "NO_DIRECTION_ARM_QUALIFIED_SEALED_HOLDOUT_NOT_EVALUATED";
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
