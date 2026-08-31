/**
 * EUR/USD Stage-1 V2 audit. Unlike V1, the label is direction-neutral: can an
 * executable +1.5 ATR move occur on either side within four hours, with no
 * stop? Decisions are fixed every four hours to avoid overlapping windows.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { evaluateEurUsdMoveGateV1 } from "../src/eur-usd-move-gate-v1.js";

type Bar = { closeTime: string; open: number; high: number; low: number; close: number; bidClose: number; bidHigh: number; bidLow: number; askClose: number; askHigh: number; askLow: number; complete: true };
type Observation = { time: string; strength: number; hit: boolean };
type Period = { start: string; end: string };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const output = path.join(root, "research-v2", "eur-usd-move-gate-v2"); if (!existsSync(output)) mkdirSync(output, { recursive: true });

const TRAIN: Period = { start: "2021-06-03T00:00:00.000Z", end: "2023-01-01T00:00:00.000Z" };
const VALIDATION: Period = { start: "2023-01-01T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" };
const SEALED_HOLDOUT: Period = { start: "2024-01-01T00:00:00.000Z", end: "2025-08-01T00:00:00.000Z" };
const STRENGTH_THRESHOLDS = [1, 1.25, 1.5] as const;
const DECISION_HOURS_UTC = new Set([0, 4, 8, 12, 16, 20]);
const BAR_MS = 15 * 60_000; const HORIZON_BARS = 16; const TARGET_ATR = 1.5;

function lower99(hits: number, n: number) { if (!n) return 0; const z = 2.576; const p = hits / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function seeded(time: string, seed: number) { let hash = 2166136261 ^ seed; for (const c of `EUR_USD|${time}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return hash >>> 0; }
function score(rows: Observation[]) { const hits = rows.filter((row) => row.hit).length; return { n: rows.length, hits, hitRate: rows.length ? hits / rows.length : 0, lower99: lower99(hits, rows.length) }; }
function randomControls(all: Observation[], selectedCount: number) { const rates = Array.from({ length: 100 }, (_, seed) => score([...all].sort((a, b) => seeded(a.time, seed + 1) - seeded(b.time, seed + 1)).slice(0, selectedCount)).hitRate).sort((a, b) => a - b); return { count: 100, meanHitRate: rates.reduce((sum, value) => sum + value, 0) / rates.length, p95HitRate: rates[94] ?? 0 }; }
function targetReached(bar: Bar, atr: number, future: Bar[]) { const longTarget = bar.askClose + TARGET_ATR * atr; const shortTarget = bar.bidClose - TARGET_ATR * atr; return future.some((next) => next.bidHigh >= longTarget || next.askLow <= shortTarget); }
function toCandles(bars: Bar[]) { return bars.map((bar) => ({ time: bar.closeTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0, complete: true })); }
function observations(bars: Bar[], period: Period) {
  const rows: Observation[] = [];
  for (let index = 199; index < bars.length - HORIZON_BARS; index += 1) {
    const bar = bars[index]!; const timestamp = Date.parse(bar.closeTime); const date = new Date(timestamp);
    if (bar.closeTime < period.start || bar.closeTime >= period.end || date.getUTCMinutes() !== 0 || !DECISION_HOURS_UTC.has(date.getUTCHours())) continue;
    const future = bars.slice(index + 1, index + 1 + HORIZON_BARS);
    if (future.length !== HORIZON_BARS || Date.parse(future.at(-1)!.closeTime) - timestamp !== HORIZON_BARS * BAR_MS) continue;
    const decision = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: toCandles(bars.slice(index - 199, index + 1)), bid: bar.bidClose, ask: bar.askClose });
    if (decision.atr === null || decision.movementStrength === null) continue;
    rows.push({ time: bar.closeTime, strength: decision.movementStrength, hit: targetReached(bar, decision.atr, future) });
  }
  return rows;
}
function lane(all: Observation[], threshold: number) { const selected = all.filter((row) => row.strength >= threshold); const result = score(selected); const random = randomControls(all, selected.length); return { threshold, ...result, liftOverRandom: result.hitRate - random.meanHitRate, randomControls: random }; }
function gateTrain(item: ReturnType<typeof lane>) { return item.n >= 250 && item.hitRate >= 0.65 && item.lower99 >= 0.55 && item.liftOverRandom >= 0.1 && item.hitRate > item.randomControls.p95HitRate; }
function gateValidation(item: ReturnType<typeof lane>) { return item.n >= 125 && item.hitRate >= 0.65 && item.liftOverRandom >= 0.1 && item.hitRate > item.randomControls.p95HitRate; }

const records = await query<{ close_time: string; bid_open: number; bid_high: number; bid_low: number; bid_close: number; ask_open: number; ask_high: number; ask_low: number; ask_close: number }>(
  `SELECT close_time::text,bid_open::float,bid_high::float,bid_low::float,bid_close::float,ask_open::float,ask_high::float,ask_low::float,ask_close::float FROM market_candle_quotes WHERE instrument='EUR_USD' AND timeframe='M15' AND source='oanda' AND close_time >= $1 AND close_time < $2 ORDER BY close_time`, [TRAIN.start, SEALED_HOLDOUT.end],
);
const bars: Bar[] = records.rows.map((row) => ({ closeTime: new Date(row.close_time).toISOString(), open: (row.bid_open + row.ask_open) / 2, high: (row.bid_high + row.ask_high) / 2, low: (row.bid_low + row.ask_low) / 2, close: (row.bid_close + row.ask_close) / 2, bidClose: row.bid_close, bidHigh: row.bid_high, bidLow: row.bid_low, askClose: row.ask_close, askHigh: row.ask_high, askLow: row.ask_low, complete: true }));
const trainRows = observations(bars, TRAIN); const validationRows = observations(bars, VALIDATION);
const train = STRENGTH_THRESHOLDS.map((threshold) => lane(trainRows, threshold));
const nominated = train.filter(gateTrain).sort((a, b) => b.hitRate - a.hitRate || b.liftOverRandom - a.liftOverRandom || b.threshold - a.threshold)[0] ?? null;
const validation = nominated ? lane(validationRows, nominated.threshold) : null;
const qualified = nominated !== null && validation !== null && gateValidation(validation) && nominated.n + validation.n >= 500;
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), scope: { instrument: "EUR_USD", source: "stored OANDA M15 bid/ask market quotes only", decisionSchedule: "only completed M15 closes at 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00 UTC; each outcome is a distinct four-hour window", pureMoveLabel: "within four hours, bid reaches ask-close +1.5 ATR or ask reaches bid-close -1.5 ATR; no stop and no direction", features: "frozen existing volatility expansion, compression release, velocity, body-strength score; only predeclared movement-strength thresholds are compared", excludes: "trade rows, shadow-table writes, paper-engine writes, direction selection, and post-result threshold changes" }, splits: { train: TRAIN, validation: VALIDATION, sealedHoldout: SEALED_HOLDOUT }, train, nominationRule: "train n >= 250; hit rate >= 65%; 99% Wilson lower bound >=55%; at least +10 points over random mean and above random p95; highest hit-rate eligible lane wins", nominatedThreshold: nominated?.threshold ?? null, validation, validationRule: "n >=125; hit rate >=65%; at least +10 points over random mean and above random p95; combined train+validation n >=500", qualifiedForSealedHoldout: qualified };
if (qualified && nominated) { const holdoutRows = observations(bars, SEALED_HOLDOUT); report.sealedHoldout = lane(holdoutRows, nominated.threshold); report.verdict = "V2_QUALIFIED_HOLDOUT_REVEALED"; } else report.verdict = "V2_DID_NOT_QUALIFY_SEALED_HOLDOUT_NOT_EVALUATED";
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
