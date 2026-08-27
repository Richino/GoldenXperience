/**
 * Small, predeclared screen of forced UP/DOWN price-only rules on recorded
 * binary-baseline rows. Research only: reads OANDA Practice candles and the
 * settled rows, then writes a report. It does not change runtime behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { calculateEmaValues, calculateRsiValues } from "../../frontend/src/lib/strategy/indicators.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { query } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const OUT = path.join(root, "research-v2", "binary-forced-direction-screen-v1"), REPORT = path.join(OUT, "FINAL_REPORT.txt");
const BARS = 20_000, PAGE = 5_000, BREAK_EVEN = 1 / 1.8;
type Direction = "long" | "short";
type Prediction = { instrument: MajorInstrument; start_at: string | Date; entry_price: string; resolution_price: string; tie_tolerance: string };
type PriceCandle = { closeMs: number; open: number; high: number; low: number; close: number };
type Event = { ms: number; outcome: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };
type Rule = { name: string; explanation: string; direction: (m1: PriceCandle[], m15: PriceCandle[]) => Direction | null };

function wilson(wins: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (c - m) / d, high: (c + m) / d }; }
function score(events: Event[], inverse = false): Score { const wins = events.filter((event) => event.outcome === (inverse ? "lost" : "won")).length, losses = events.filter((event) => event.outcome === (inverse ? "won" : "lost")).length, ties = events.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function pct(value: number | null) { return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`; }
function format(value: Score) { return `${value.wins}/${value.losses}/${value.ties} (${pct(value.rate)})`; }
function indexAtOrBefore(candles: PriceCandle[], at: number) { let low = 0, high = candles.length - 1, found = -1; while (low <= high) { const middle = (low + high) >> 1; if (candles[middle]!.closeMs <= at) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }
function toCandles(rows: PriceCandle[]): Candle[] { return rows.map((row) => ({ time: new Date(row.closeMs - 60_000).toISOString(), open: row.open, high: row.high, low: row.low, close: row.close, volume: 0, complete: true })); }
function follow(a: number, b: number): Direction { return a >= b ? "long" : "short"; }
function opposite(direction: Direction): Direction { return direction === "long" ? "short" : "long"; }

async function fetch(pair: MajorInstrument, granularity: "M1" | "M15", count: number) {
  const values = new Map<number, PriceCandle>(); let cursor: string | undefined, priorOldest = Infinity;
  for (let page = 0; values.size < count && page < Math.ceil(count / PAGE) + 2; page += 1) {
    const batch = (await getResearchCandles(pair, granularity, Math.min(PAGE, count), cursor ? { to: cursor } : {})).filter((row) => row.complete).map((row) => ({ closeMs: Date.parse(row.time) + (granularity === "M1" ? 1 : 15) * 60_000, open: row.mid.open, high: row.mid.high, low: row.mid.low, close: row.mid.close }));
    if (!batch.length) break;
    for (const row of batch) values.set(row.closeMs, row);
    const oldest = Math.min(...batch.map((row) => row.closeMs - (granularity === "M1" ? 1 : 15) * 60_000));
    if (oldest >= priorOldest) throw new Error(`${pair} ${granularity} pagination did not advance.`);
    priorOldest = oldest; cursor = new Date(oldest - 1).toISOString(); await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return [...values.values()].sort((a, b) => a.closeMs - b.closeMs).slice(-count);
}

const rules: Rule[] = [
  { name: "M1 return-1 follow", explanation: "Follow the last completed one-minute close-to-close move.", direction: (m1) => m1.length >= 2 ? follow(m1.at(-1)!.close, m1.at(-2)!.close) : null },
  { name: "M1 return-5 follow", explanation: "Follow the latest five-minute close-to-close move.", direction: (m1) => m1.length >= 6 ? follow(m1.at(-1)!.close, m1.at(-6)!.close) : null },
  { name: "M1 RSI-2 reversal", explanation: "Go opposite the two-period M1 RSI side: RSI<50 is LONG, otherwise SHORT.", direction: (m1) => { const rsi = calculateRsiValues(m1.map((row) => row.close), 2).at(-1); return rsi === undefined ? null : rsi < 50 ? "long" : "short"; } },
  { name: "M1 EMA 9/21 follow", explanation: "Follow the M1 EMA-9 versus EMA-21 alignment.", direction: (m1) => { const closes = m1.map((row) => row.close), fast = calculateEmaValues(closes, 9).at(-1), slow = calculateEmaValues(closes, 21).at(-1); return fast === undefined || slow === undefined ? null : follow(fast, slow); } },
  { name: "M15 return-1 follow", explanation: "Follow the last completed fifteen-minute candle direction.", direction: (_m1, m15) => m15.length >= 2 ? follow(m15.at(-1)!.close, m15.at(-2)!.close) : null },
  { name: "M15 RSI-2 reversal", explanation: "Go opposite the two-period M15 RSI side: RSI<50 is LONG, otherwise SHORT.", direction: (_m1, m15) => { const rsi = calculateRsiValues(m15.map((row) => row.close), 2).at(-1); return rsi === undefined ? null : rsi < 50 ? "long" : "short"; } },
  { name: "M15 EMA 9/21 follow", explanation: "Follow the M15 EMA-9 versus EMA-21 alignment.", direction: (_m1, m15) => { const closes = m15.map((row) => row.close), fast = calculateEmaValues(closes, 9).at(-1), slow = calculateEmaValues(closes, 21).at(-1); return fast === undefined || slow === undefined ? null : follow(fast, slow); } },
];

fs.mkdirSync(OUT, { recursive: true });
const predictions = (await query<Prediction>(`SELECT instrument,start_at,entry_price,resolution_price,tie_tolerance FROM binary_predictions
  WHERE model_name='binary-baseline-v1' AND is_authoritative=true AND status='resolved' AND result IN ('won','lost','tie') AND resolution_price IS NOT NULL ORDER BY start_at`)).rows;
if (!predictions.length) throw new Error("No settled authoritative baseline rows.");
const pairs = [...new Set(predictions.map((row) => row.instrument))], data = new Map<string, { m1: PriceCandle[]; m15: PriceCandle[] }>(), coverage: string[] = [];
for (const pair of pairs) { const [m1, m15] = await Promise.all([fetch(pair, "M1", BARS), fetch(pair, "M15", 4_000)]); data.set(pair, { m1, m15 }); coverage.push(`${pair}: ${predictions.filter((row) => row.instrument === pair).length} binary rows; M1/M15=${m1.length}/${m15.length}.`); console.log(coverage.at(-1)); }
const first = Date.parse(predictions[0]!.start_at instanceof Date ? predictions[0]!.start_at.toISOString() : predictions[0]!.start_at), last = Date.parse(predictions.at(-1)!.start_at instanceof Date ? predictions.at(-1)!.start_at.toISOString() : predictions.at(-1)!.start_at), trainEnd = first + (last - first) * .60, devEnd = first + (last - first) * .80;
const rows: string[] = [];
for (const rule of rules) {
  const events: Event[] = []; let skipped = 0;
  for (const prediction of predictions) {
    const at = Date.parse(prediction.start_at instanceof Date ? prediction.start_at.toISOString() : prediction.start_at), series = data.get(prediction.instrument)!;
    const i1 = indexAtOrBefore(series.m1, at), i15 = indexAtOrBefore(series.m15, at);
    if (i1 < 0 || i15 < 0) { skipped += 1; continue; }
    const direction = rule.direction(series.m1.slice(Math.max(0, i1 - 99), i1 + 1), series.m15.slice(Math.max(0, i15 - 299), i15 + 1));
    const entry = Number(prediction.entry_price), mark = Number(prediction.resolution_price), tolerance = Number(prediction.tie_tolerance);
    if (!direction || ![entry, mark, tolerance].every(Number.isFinite)) { skipped += 1; continue; }
    const move = mark - entry, outcome = Math.abs(move) <= tolerance ? "tie" : (direction === "long" ? move > 0 : move < 0) ? "won" : "lost";
    events.push({ ms: at, outcome });
  }
  const train = events.filter((event) => event.ms <= trainEnd), dev = events.filter((event) => event.ms > trainEnd && event.ms <= devEnd);
  const trainOriginal = score(train), trainInverse = score(train, true), devOriginal = score(dev), devInverse = score(dev, true);
  const directPass = devOriginal.n >= 100 && (devOriginal.rate ?? 0) > BREAK_EVEN && (devOriginal.low ?? 0) > .5;
  const inversePass = devInverse.n >= 100 && (devInverse.rate ?? 0) > BREAK_EVEN && (devInverse.low ?? 0) > .5;
  rows.push(`${rule.name}\n  ${rule.explanation}\n  rows=${events.length}/${predictions.length}; TRAIN original ${format(trainOriginal)}, inverse ${format(trainInverse)}; DEV original ${format(devOriginal)}, inverse ${format(devInverse)}; verdict=${directPass ? "ORIGINAL CANDIDATE" : inversePass ? "INVERSE CANDIDATE" : "REJECT"}.`);
}
const lines = [
  "GOLDENXPERIENCE — PREDECLARED FORCED BINARY DIRECTION SCREEN V1",
  "Research only. Each rule emits LONG or SHORT for every row with enough past-only candle history. It uses the recorded binary entry/resolution marks and tie tolerance. No database records or runtime behavior changed.",
  `Sample: ${predictions.length} settled binary-baseline rows across ${pairs.length} pairs. Chronological TRAIN through ${new Date(trainEnd).toISOString()}, DEV through ${new Date(devEnd).toISOString()}; HOLDOUT intentionally unread because no DEV candidate is selected by this screen.`,
  `Gate: DEV n>=100, WR>${(BREAK_EVEN * 100).toFixed(2)}%, Wilson lower bound >50%. Exact inverse is reported on the same marks.`, "", "Coverage:", ...coverage, "", ...rows,
  "", "Dependence warning: binary rows can share M1/M15 bars, so results are a rejection screen, not proof of thousands of independent signals. Do not tune these rules using the sealed holdout.",
];
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`); console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
