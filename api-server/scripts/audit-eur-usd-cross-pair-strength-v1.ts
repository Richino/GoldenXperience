/**
 * Frozen EUR/USD cross-pair relative-strength direction audit.
 *
 * Reads stored OANDA bid/ask M15 market quotes only. EUR/USD itself is never a
 * strength input: the signal is made from the two long-history external USD
 * proxies (GBP_USD and USD_JPY) at exactly the same completed timestamps. No trade rows, stops,
 * targets, or execution results are read.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Direction = "UP" | "DOWN";
type Currency = "EUR" | "USD" | "GBP" | "JPY" | "AUD" | "CAD";
type Quote = { time: string; mid: number };
type Observation = { time: string; predicted: Direction; actual: Direction };

const TARGET = "EUR_USD";
const PROXIES = ["GBP_USD", "USD_JPY"] as const;
const UNIVERSE = [TARGET, ...PROXIES] as const;
const LOOKBACK_MS = 60 * 60_000;
const HORIZON_MS = 60 * 60_000;
const DEVELOPMENT = { start: "2021-06-03T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" };
// This period is intentionally not queried unless the frozen development gate passes.
const SEALED_HOLDOUT = { start: "2024-01-01T00:00:00.000Z", end: "2025-08-01T00:00:00.000Z" };
const PASS_GATE = "development n >= 500, 99% Wilson lower bound > 50%, and accuracy above the 95th percentile of 100 seeded random controls";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const outDir = path.join(root, "research-v2", "eur-usd-cross-pair-strength-v1");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function splitPair(pair: string): { base: Currency; quote: Currency } { const [base, quote] = pair.split("_"); return { base: base as Currency, quote: quote as Currency }; }
function lower99(correct: number, n: number) { if (!n) return 0; const z = 2.576; const p = correct / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function randomDirection(time: string, seed: number): Direction { let hash = 2166136261 ^ seed; for (const character of `${TARGET}|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return (hash >>> 0) % 2 === 0 ? "UP" : "DOWN"; }
function score(rows: Observation[]) {
  const correct = rows.filter((row) => row.predicted === row.actual).length;
  const random = Array.from({ length: 100 }, (_, index) => rows.filter((row) => randomDirection(row.time, index + 1) === row.actual).length / rows.length).sort((a, b) => a - b);
  return { n: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, lower99: lower99(correct, rows.length), inverseAccuracy: rows.length ? 1 - correct / rows.length : 0, randomControls: { count: 100, meanAccuracy: random.reduce((sum, value) => sum + value, 0) / random.length, p95Accuracy: random[94] ?? 0 } };
}
function eurUsdDirectionFromExternalUsdStrength(returns: Record<string, number>) {
  const sum: Record<Currency, number> = { EUR: 0, USD: 0, GBP: 0, JPY: 0, AUD: 0, CAD: 0 };
  const count: Record<Currency, number> = { EUR: 0, USD: 0, GBP: 0, JPY: 0, AUD: 0, CAD: 0 };
  for (const [pair, value] of Object.entries(returns)) { const { base, quote } = splitPair(pair); sum[base] += value; count[base] += 1; sum[quote] -= value; count[quote] += 1; }
  // EUR/USD rises when EUR is stronger than USD. With only external USD
  // proxies available, EUR strength is deliberately unknown (not imputed), so
  // the frozen call is the opposite of their average USD strength.
  return -sum.USD / count.USD;
}
async function loadPeriod(period: { start: string; end: string }) {
  const result = await query<{ instrument: string; close_time: string; bid_close: number; ask_close: number }>(
    `SELECT instrument,close_time::text,bid_close::float,ask_close::float
       FROM market_candle_quotes
      WHERE source='oanda' AND timeframe='M15' AND instrument = ANY($1::text[])
        AND close_time >= $2 AND close_time < $3
        AND bid_close IS NOT NULL AND ask_close IS NOT NULL
      ORDER BY instrument,close_time`, [UNIVERSE, period.start, period.end],
  );
  const byPair = Object.fromEntries(UNIVERSE.map((pair) => [pair, new Map<number, Quote>()])) as Record<(typeof UNIVERSE)[number], Map<number, Quote>>;
  for (const row of result.rows) byPair[row.instrument as (typeof UNIVERSE)[number]]?.set(Date.parse(row.close_time), { time: new Date(row.close_time).toISOString(), mid: (row.bid_close + row.ask_close) / 2 });
  return byPair;
}
function observations(byPair: Record<(typeof UNIVERSE)[number], Map<number, Quote>>) {
  const target = byPair[TARGET]; const rows: Observation[] = [];
  for (const [time, current] of target) {
    const future = target.get(time + HORIZON_MS); if (!future || future.mid === current.mid) continue;
    const returns: Record<string, number> = {}; let complete = true;
    for (const pair of PROXIES) { const now = byPair[pair].get(time); const prior = byPair[pair].get(time - LOOKBACK_MS); if (!now || !prior || !(now.mid > 0) || !(prior.mid > 0)) { complete = false; break; } returns[pair] = Math.log(now.mid / prior.mid); }
    if (!complete) continue;
    const diff = eurUsdDirectionFromExternalUsdStrength(returns); if (!Number.isFinite(diff) || diff === 0) continue;
    rows.push({ time: current.time, predicted: diff > 0 ? "UP" : "DOWN", actual: future.mid > current.mid ? "UP" : "DOWN" });
  }
  return rows;
}
function coverage(byPair: Record<(typeof UNIVERSE)[number], Map<number, Quote>>) {
  return Object.fromEntries(UNIVERSE.map((pair) => {
    const times = byPair[pair].keys(); let first = Number.POSITIVE_INFINITY; let last = Number.NEGATIVE_INFINITY; let candles = 0;
    for (const time of times) { candles += 1; if (time < first) first = time; if (time > last) last = time; }
    return [pair, { candles, first: candles ? new Date(first).toISOString() : null, last: candles ? new Date(last).toISOString() : null }];
  }));
}

const developmentQuotes = await loadPeriod(DEVELOPMENT);
const developmentRows = observations(developmentQuotes);
const development = score(developmentRows);
const qualified = development.n >= 500 && development.lower99 > 0.5 && development.accuracy > development.randomControls.p95Accuracy;
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(), hypothesis: "EUR/USD follows the opposite sign of one-hour external USD strength from GBP/USD and USD/JPY over its next hour", methodology: { source: "stored OANDA bid/ask M15 market quotes only", inputs: "GBP_USD and USD_JPY only; EUR_USD excluded from strength construction", limitation: "the stored archive has no long-history EUR cross, so this is external USD strength rather than a full EUR-minus-USD basket", synchronization: "all proxy closes must exist at decision time and exactly 60 minutes earlier", label: "EUR/USD midpoint direction exactly 60 minutes later", controls: "exact inverse and 100 seeded random directions", developmentPeriod: DEVELOPMENT, sealedHoldoutPeriod: SEALED_HOLDOUT, passGate: PASS_GATE }, developmentCoverage: coverage(developmentQuotes), development, qualifiedForSealedHoldout: qualified,
};
if (qualified) { const holdoutQuotes = await loadPeriod(SEALED_HOLDOUT); const holdoutRows = observations(holdoutQuotes); report.sealedHoldoutCoverage = coverage(holdoutQuotes); report.sealedHoldout = score(holdoutRows); report.verdict = "DEVELOPMENT_QUALIFIED_HOLDOUT_REVEALED"; }
else report.verdict = "DEVELOPMENT_DID_NOT_QUALIFY_SEALED_HOLDOUT_NOT_QUERIED";
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
