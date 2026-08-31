/**
 * EUR/USD two-stage audit: movement first, direction second.
 *
 * This is deliberately not an execution simulation. At fixed, non-overlapping
 * four-hour decisions it asks (1) does the frozen move gate select periods
 * whose next four hours contain an executable 1.5-ATR excursion, and (2) does
 * the frozen H1 regime call the sign of the next four-hour midpoint return?
 * Raw OANDA Practice bid/ask candles only; no database, trade rows, or writes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { evaluateEurUsdMoveGateV1 } from "../src/eur-usd-move-gate-v1.js";
import { classifyH1RegimeDirectionV1, type H1Direction } from "../src/h1-regime-direction-v1.js";
import type { Candle } from "../../frontend/src/types/forex.js";

type Direction = "UP" | "DOWN";
type Quote = { closeTime: string; open: number; high: number; low: number; close: number; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Row = { time: string; moveSelected: boolean; moveStrength: number; atr: number; largeMove: boolean; actual: Direction; trend: H1Direction };
type Score = { n: number; hits: number; rate: number; lower95: number };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const output = path.join(root, "research-v2", "eur-usd-move-trend-4h-12mo");
const warmupStart = "2025-07-01T00:00:00.000Z";
const start = "2025-08-01T00:00:00.000Z";
const end = "2026-08-01T00:00:00.000Z";
const splits = { development: { start, end: "2026-05-01T00:00:00.000Z" }, holdout: { start: "2026-05-01T00:00:00.000Z", end } };
const FOUR_HOURS = 4 * 60 * 60_000;
const M15_MS = 15 * 60_000;
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("This audit refuses OANDA live.");

function midpoint(bar: { bid: Record<string, string>; ask: Record<string, string> }, key: string) { return (Number(bar.bid[key]) + Number(bar.ask[key])) / 2; }
async function fetchBars(granularity: "M15" | "H1", stepMs: number): Promise<Quote[]> {
  const seen = new Map<string, Quote>(); let cursor = warmupStart;
  for (let page = 0; page < 20; page += 1) {
    const url = `https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${new URLSearchParams({ price: "BA", granularity, count: "5000", from: cursor }).toString()}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`EUR_USD ${granularity}: HTTP ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => ({
      closeTime: new Date(Date.parse(bar.time) + stepMs).toISOString(), open: midpoint(bar, "o"), high: midpoint(bar, "h"), low: midpoint(bar, "l"), close: midpoint(bar, "c"),
      bidOpen: Number(bar.bid.o), bidHigh: Number(bar.bid.h), bidLow: Number(bar.bid.l), bidClose: Number(bar.bid.c), askOpen: Number(bar.ask.o), askHigh: Number(bar.ask.h), askLow: Number(bar.ask.l), askClose: Number(bar.ask.c),
    }));
    for (const bar of pageBars) if (bar.closeTime < end) seen.set(bar.closeTime, bar);
    if (pageBars.length < 5000 || !pageBars.length) break;
    cursor = pageBars.at(-1)!.closeTime;
    if (Date.parse(cursor) >= Date.parse(end)) break;
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}
function h1AtOrBefore(bars: Quote[], time: string) { let found = -1; const target = Date.parse(time); for (let i = 0; i < bars.length && Date.parse(bars[i]!.closeTime) <= target; i += 1) found = i; return found; }
function seededHash(time: string, seed: number) { let hash = 2166136261 ^ seed; for (const character of `EUR_USD|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return hash >>> 0; }
function randomDirection(time: string, seed: number): Direction { return seededHash(time, seed) % 2 === 0 ? "UP" : "DOWN"; }
function wilson(hits: number, n: number) { if (!n) return 0; const z = 1.96; const p = hits / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function score(rows: Row[], predicate: (row: Row) => boolean): Score { const hits = rows.filter(predicate).length; return { n: rows.length, hits, rate: rows.length ? hits / rows.length : 0, lower95: wilson(hits, rows.length) }; }
function randomMoveRates(all: Row[], count: number, predicate: (row: Row) => boolean) { const rates = Array.from({ length: 100 }, (_, seed) => score([...all].sort((a, b) => seededHash(a.time, seed + 1) - seededHash(b.time, seed + 1)).slice(0, count), predicate).rate).sort((a, b) => a - b); return { count: 100, mean: rates.reduce((sum, rate) => sum + rate, 0) / rates.length, p95: rates[94]! }; }
function arm(rows: Row[]) {
  const selected = rows.filter((row) => row.moveSelected);
  const movement = score(selected, (row) => row.largeMove);
  const moveRandom = randomMoveRates(rows, selected.length, (row) => row.largeMove);
  const directional = selected.filter((row): row is Row & { trend: Direction } => row.trend !== "NO_DIRECTION");
  const trend = score(directional, (row) => row.trend === row.actual);
  const inverse = score(directional, (row) => (row.trend === "UP" ? "DOWN" : "UP") === row.actual);
  const randomRates = Array.from({ length: 100 }, (_, seed) => score(directional, (row) => randomDirection(row.time, seed + 1) === row.actual).rate).sort((a, b) => a - b);
  return { decisions: rows.length, selected: selected.length, movement: { ...movement, liftOverRandom: movement.rate - moveRandom.mean, randomControls: moveRandom }, direction: { directionalCalls: directional.length, abstained: selected.length - directional.length, trend, inverse, randomControls: { count: 100, mean: randomRates.reduce((sum, rate) => sum + rate, 0) / randomRates.length, p95: randomRates[94]! } } };
}

const [m15, h1] = await Promise.all([fetchBars("M15", M15_MS), fetchBars("H1", 60 * 60_000)]);
console.log(`[move-trend-4h] fetched ${m15.length} M15 and ${h1.length} H1 candles`);
const rows: Row[] = [];
for (let index = 199; index < m15.length - 16; index += 1) {
  const bar = m15[index]!; const ms = Date.parse(bar.closeTime); const date = new Date(ms);
  if (bar.closeTime < start || bar.closeTime >= end || date.getUTCMinutes() !== 0 || date.getUTCHours() % 4 !== 0) continue;
  const future = m15.slice(index + 1, index + 17);
  if (future.length !== 16 || Date.parse(future.at(-1)!.closeTime) - ms !== FOUR_HOURS) continue;
  const candles: Candle[] = m15.slice(index - 199, index + 1).map((item) => ({ time: item.closeTime, open: item.open, high: item.high, low: item.low, close: item.close, volume: 0, complete: true }));
  const move = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles, bid: bar.bidClose, ask: bar.askClose });
  const moveAtr = move.atr;
  const moveStrength = move.movementStrength;
  if (moveAtr === null || moveStrength === null) continue;
  const h1Index = h1AtOrBefore(h1, bar.closeTime); if (h1Index < 49) continue;
  const trend = classifyH1RegimeDirectionV1(h1.slice(h1Index - 49, h1Index + 1));
  const longExcursion = Math.max(0, ...future.map((item) => (item.bidHigh - bar.askClose) / moveAtr));
  const shortExcursion = Math.max(0, ...future.map((item) => (bar.bidClose - item.askLow) / moveAtr));
  const fourHourClose = future.at(-1)!.close;
  if (fourHourClose === bar.close) continue;
  rows.push({ time: bar.closeTime, moveSelected: move.action === "MOVE", moveStrength, atr: moveAtr, largeMove: Math.max(longExcursion, shortExcursion) >= 1.5, actual: fourHourClose > bar.close ? "UP" : "DOWN", trend });
}
const development = rows.filter((row) => row.time >= splits.development.start && row.time < splits.development.end);
const holdout = rows.filter((row) => row.time >= splits.holdout.start && row.time < splits.holdout.end);
const report = { generatedAt: new Date().toISOString(), verdict: "DESCRIPTIVE_ONLY_NO_PROMOTION", productionChanged: false, scope: { instrument: "EUR_USD", period: `${start} through ${end}`, decisions: "completed M15 candles on UTC 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 only", source: "raw OANDA Practice bid/ask candles fetched at runtime", stage1: "frozen eur-usd-move-gate-v1; large move means either executable side travels 1.5 ATR from the entry side within the following four hours, with no direction or stop claim", stage2: "frozen h1-regime-direction-v1; trend sign is compared with the next four-hour midpoint close sign only", excludes: "trade rows, stop/target P&L, parameter selection, production or practice execution" }, gates: { movement: "target: >=65% selected large-move rate, >=10 percentage-point lift over matched seeded-random selected schedules", direction: "target: beats exact inverse and seeded-random p95; no claim if it does not" }, development: arm(development), sealedHoldout: arm(holdout), allYearDescriptive: arm(rows) };
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
