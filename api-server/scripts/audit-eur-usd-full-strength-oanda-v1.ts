/**
 * Frozen EUR/USD full relative-strength direction audit using raw OANDA
 * bid/ask M15 candles fetched at runtime. It persists no candles and reads no
 * database or trade rows. The holdout endpoint is not called unless the fixed
 * development gate passes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Direction = "UP" | "DOWN";
type Currency = "EUR" | "USD" | "GBP" | "JPY";
type Quote = { time: string; mid: number };
type Observation = { time: string; predicted: Direction; actual: Direction; targetPastDirection: Direction };
type OandaCandle = { time: string; complete: boolean; bid?: { c: string }; ask?: { c: string } };

const TARGET = "EUR_USD";
const PROXIES = ["EUR_GBP", "EUR_JPY", "GBP_USD", "USD_JPY"] as const;
const UNIVERSE = [TARGET, ...PROXIES] as const;
const BAR_MS = 15 * 60_000; const LOOKBACK_MS = 60 * 60_000; const HORIZON_MS = 60 * 60_000;
const DEVELOPMENT = { start: "2021-06-03T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" };
const SEALED_HOLDOUT = { start: "2024-01-01T00:00:00.000Z", end: "2025-08-01T00:00:00.000Z" };
const PASS_GATE = "development n >= 500, 99% Wilson lower bound > 50%, and accuracy above the 95th percentile of 100 seeded random controls";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^['"]|['"]$/g, "");
if (!token) throw new Error("OANDA credentials are required for raw-market research.");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const outDir = path.join(root, "research-v2", "eur-usd-full-strength-oanda-v1"); if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function splitPair(pair: string): { base: Currency; quote: Currency } { const [base, quote] = pair.split("_"); return { base: base as Currency, quote: quote as Currency }; }
function lower99(correct: number, n: number) { if (!n) return 0; const z = 2.576; const p = correct / n; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); }
function randomDirection(time: string, seed: number): Direction { let hash = 2166136261 ^ seed; for (const character of `${TARGET}|${time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; return (hash >>> 0) % 2 === 0 ? "UP" : "DOWN"; }
function score(rows: Observation[]) { const correct = rows.filter((row) => row.predicted === row.actual).length; const inverseCorrect = rows.length - correct; const random = Array.from({ length: 100 }, (_, index) => rows.filter((row) => randomDirection(row.time, index + 1) === row.actual).length / rows.length).sort((a, b) => a - b); return { n: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, lower99: lower99(correct, rows.length), inverseCorrect, inverseAccuracy: rows.length ? inverseCorrect / rows.length : 0, inverseLower99: lower99(inverseCorrect, rows.length), randomControls: { count: 100, meanAccuracy: random.reduce((sum, value) => sum + value, 0) / random.length, p95Accuracy: random[94] ?? 0 } }; }
function strengthDifference(returns: Record<string, number>) { const sum: Record<Currency, number> = { EUR: 0, USD: 0, GBP: 0, JPY: 0 }; const count: Record<Currency, number> = { EUR: 0, USD: 0, GBP: 0, JPY: 0 }; for (const [pair, value] of Object.entries(returns)) { const { base, quote } = splitPair(pair); sum[base] += value; count[base] += 1; sum[quote] -= value; count[quote] += 1; } return sum.EUR / count.EUR - sum.USD / count.USD; }

async function fetchPeriod(pair: string, period: { start: string; end: string }) {
  const quotes = new Map<number, Quote>(); let cursor = period.start; let requests = 0;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ price: "BA", granularity: "M15", from: cursor, count: "5000" });
    const response = await fetch(`${host}/v3/instruments/${pair}/candles?${params}`, { headers: { Authorization: `Bearer ${token}` } }); requests += 1;
    if (!response.ok) throw new Error(`${pair} candle request failed with HTTP ${response.status}`);
    const payload = await response.json() as { candles?: OandaCandle[] }; const candles = (payload.candles ?? []).filter((candle) => candle.complete && candle.bid && candle.ask);
    if (!candles.length) break;
    for (const candle of candles) { const closeMs = Date.parse(candle.time) + BAR_MS; if (closeMs >= Date.parse(period.start) && closeMs < Date.parse(period.end)) quotes.set(closeMs, { time: new Date(closeMs).toISOString(), mid: (Number(candle.bid!.c) + Number(candle.ask!.c)) / 2 }); }
    const lastOpenMs = Date.parse(candles.at(-1)!.time); if (candles.length < 5000 || lastOpenMs + BAR_MS >= Date.parse(period.end)) break;
    cursor = new Date(lastOpenMs + BAR_MS).toISOString(); await sleep(130);
  }
  return { quotes, requests };
}
type PeriodQuotes = Record<(typeof UNIVERSE)[number], Awaited<ReturnType<typeof fetchPeriod>>>;
async function loadPeriod(period: { start: string; end: string }) { const entries = await Promise.all(UNIVERSE.map(async (pair) => [pair, await fetchPeriod(pair, period)] as const)); return Object.fromEntries(entries) as PeriodQuotes; }
function observations(byPair: PeriodQuotes) { const rows: Observation[] = []; for (const [time, current] of byPair[TARGET].quotes) { const future = byPair[TARGET].quotes.get(time + HORIZON_MS); const targetPrior = byPair[TARGET].quotes.get(time - LOOKBACK_MS); if (!future || !targetPrior || future.mid === current.mid || current.mid === targetPrior.mid) continue; const returns: Record<string, number> = {}; let complete = true; for (const pair of PROXIES) { const now = byPair[pair].quotes.get(time); const prior = byPair[pair].quotes.get(time - LOOKBACK_MS); if (!now || !prior) { complete = false; break; } returns[pair] = Math.log(now.mid / prior.mid); } if (!complete) continue; const diff = strengthDifference(returns); if (!Number.isFinite(diff) || diff === 0) continue; rows.push({ time: current.time, predicted: diff > 0 ? "UP" : "DOWN", actual: future.mid > current.mid ? "UP" : "DOWN", targetPastDirection: current.mid > targetPrior.mid ? "UP" : "DOWN" }); } return rows; }
function coverage(byPair: PeriodQuotes) { return Object.fromEntries(UNIVERSE.map((pair) => { const times = byPair[pair].quotes.keys(); let first = Infinity; let last = -Infinity; let candles = 0; for (const time of times) { candles += 1; if (time < first) first = time; if (time > last) last = time; } return [pair, { candles, requests: byPair[pair].requests, first: candles ? new Date(first).toISOString() : null, last: candles ? new Date(last).toISOString() : null }]; })); }
function triangulationAudit(rows: Observation[]) { const directMeanReversion = rows.filter((row) => (row.targetPastDirection === "UP" ? "DOWN" : "UP") === row.actual).length; const inverseAgreement = rows.filter((row) => (row.predicted === "UP" ? "DOWN" : "UP") === (row.targetPastDirection === "UP" ? "DOWN" : "UP")).length; return { directTargetOneHourMeanReversionAccuracy: rows.length ? directMeanReversion / rows.length : 0, inverseCrossPairMatchesDirectTargetMeanReversion: rows.length ? inverseAgreement / rows.length : 0, interpretation: "Near-total agreement means the inverse basket is a triangular reconstruction of EUR/USD's own past return, not independent cross-pair information." }; }

console.log("Fetching frozen development market history from OANDA (no database writes)...");
const developmentQuotes = await loadPeriod(DEVELOPMENT); const developmentRows = observations(developmentQuotes); const development = score(developmentRows);
const originalQualified = development.n >= 500 && development.lower99 > 0.5 && development.accuracy > development.randomControls.p95Accuracy;
const inverseQualified = development.n >= 500 && development.inverseLower99 > 0.5 && development.inverseAccuracy > development.randomControls.p95Accuracy;
const selectedArm = originalQualified ? "ORIGINAL" : inverseQualified ? "INVERSE" : null;
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), hypothesis: "EUR/USD follows the sign of one-hour EUR-minus-USD strength, built without EUR/USD from EUR/GBP, EUR/JPY, GBP/USD, and USD/JPY, over its next hour", methodology: { source: "raw OANDA bid/ask M15 candles fetched at runtime", inputs: PROXIES, targetExcludedFromInputs: true, synchronization: "all proxy closes must exist at decision time and exactly 60 minutes earlier", label: "EUR/USD midpoint direction exactly 60 minutes later", controls: "exact inverse and 100 seeded random directions; either predeclared arm may unlock the holdout only if it independently passes the fixed gate", developmentPeriod: DEVELOPMENT, sealedHoldoutPeriod: SEALED_HOLDOUT, passGate: PASS_GATE }, developmentCoverage: coverage(developmentQuotes), development, developmentTriangulationAudit: triangulationAudit(developmentRows), developmentQualification: { originalQualified, inverseQualified, selectedArm } };
if (selectedArm) { console.log(`Development ${selectedArm.toLowerCase()} arm qualified. Fetching sealed holdout...`); const holdoutQuotes = await loadPeriod(SEALED_HOLDOUT); const holdoutRows = observations(holdoutQuotes); report.sealedHoldoutCoverage = coverage(holdoutQuotes); report.sealedHoldout = score(holdoutRows); report.sealedHoldoutTriangulationAudit = triangulationAudit(holdoutRows); report.verdict = "NUMERICALLY_QUALIFIED_BUT_REQUIRES_TRIANGULATION_INDEPENDENCE_REVIEW"; } else report.verdict = "DEVELOPMENT_DID_NOT_QUALIFY_SEALED_HOLDOUT_NOT_FETCHED";
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
