/**
 * Forced-direction binary test over the recorded baseline sample. Every actual
 * settled binary prediction gets a direction: UP when the latest completed M1
 * close is >= its close five minutes earlier; DOWN otherwise.
 *
 * Research only. Reads OANDA Practice candles and writes one local report.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const OUT = path.join(root, "research-v2", "binary-five-minute-momentum-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const BARS = 20_000, PAGE = 5_000, LOOKBACK = 5, BREAK_EVEN = 1 / 1.8;
type Candle = { closeMs: number; close: number };
type Prediction = { instrument: MajorInstrument; start_at: string | Date; entry_price: string; resolution_price: string; tie_tolerance: string };
type Event = { pair: string; ms: number; outcome: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function wilson(wins: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (c - m) / d, high: (c + m) / d }; }
function score(events: Event[], inverse = false): Score { const wins = events.filter((event) => event.outcome === (inverse ? "lost" : "won")).length, losses = events.filter((event) => event.outcome === (inverse ? "won" : "lost")).length, ties = events.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function format(s: Score) { const pct = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`; return `n=${s.n} W/L/T=${s.wins}/${s.losses}/${s.ties} WR=${pct(s.rate)} CI95=[${pct(s.low)}, ${pct(s.high)}]`; }
function qualifies(s: Score) { return s.n >= 100 && (s.rate ?? 0) > BREAK_EVEN && (s.low ?? 0) > 0.5; }

async function fetchM1(pair: MajorInstrument): Promise<Candle[]> {
  const values = new Map<number, Candle>(); let cursor: string | undefined, priorOldest = Infinity;
  for (let page = 0; values.size < BARS && page < Math.ceil(BARS / PAGE) + 2; page += 1) {
    const batch = (await getResearchCandles(pair, "M1", Math.min(PAGE, BARS), cursor ? { to: cursor } : {})).filter((item) => item.complete).map((item) => ({ closeMs: Date.parse(item.time) + 60_000, close: item.mid.close }));
    if (!batch.length) break;
    for (const candle of batch) values.set(candle.closeMs, candle);
    const oldest = Math.min(...batch.map((candle) => candle.closeMs - 60_000));
    if (oldest >= priorOldest) throw new Error(`${pair} M1 pagination did not advance.`);
    priorOldest = oldest; cursor = new Date(oldest - 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  return [...values.values()].sort((left, right) => left.closeMs - right.closeMs).slice(-BARS);
}

function indexAtOrBefore(candles: Candle[], at: number) { let low = 0, high = candles.length - 1, found = -1; while (low <= high) { const middle = (low + high) >> 1; if (candles[middle]!.closeMs <= at) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }
function continuous(candles: Candle[], from: number, to: number) { for (let index = from + 1; index <= to; index += 1) if (candles[index]!.closeMs - candles[index - 1]!.closeMs !== 60_000) return false; return true; }
function eventsFor(pair: string, predictions: Prediction[], candles: Candle[]) {
  const events: Event[] = [];
  for (const prediction of predictions) {
    const start = Date.parse(prediction.start_at instanceof Date ? prediction.start_at.toISOString() : prediction.start_at);
    const index = indexAtOrBefore(candles, start);
    if (index < LOOKBACK || !continuous(candles, index - LOOKBACK, index)) continue;
    const signalClose = candles[index]!.close, prior = candles[index - LOOKBACK]!.close, entry = Number(prediction.entry_price), mark = Number(prediction.resolution_price), tolerance = Number(prediction.tie_tolerance);
    if (![signalClose, prior, entry, mark, tolerance].every(Number.isFinite)) continue;
    const up = signalClose >= prior; // forced tie-break: a flat 5m move is UP, never WAIT.
    const move = mark - entry;
    const outcome = Math.abs(move) <= tolerance ? "tie" : (up ? move > 0 : move < 0) ? "won" : "lost";
    events.push({ pair, ms: start, outcome });
  }
  return events;
}

fs.mkdirSync(OUT, { recursive: true });
const predictions = (await query<Prediction>(`SELECT instrument,start_at,entry_price,resolution_price,tie_tolerance
  FROM binary_predictions
  WHERE model_name='binary-baseline-v1' AND is_authoritative=true AND status='resolved'
    AND result IN ('won','lost','tie') AND resolution_price IS NOT NULL
  ORDER BY start_at`)).rows;
if (!predictions.length) throw new Error("No resolved authoritative baseline predictions found.");
const all: Event[] = [], coverage: string[] = [];
const pairs = [...new Set(predictions.map((prediction) => prediction.instrument))];
for (const pair of pairs) { const sample = predictions.filter((prediction) => prediction.instrument === pair), candles = await fetchM1(pair), events = eventsFor(pair, sample, candles); all.push(...events); coverage.push(`${pair}: ${sample.length} recorded settled predictions; ${events.length} M1-backed forced UP/DOWN decisions.`); console.log(coverage.at(-1)); }
all.sort((left, right) => left.ms - right.ms);
if (!all.length) throw new Error("No continuous OANDA M1 observations.");
const first = all[0]!.ms, last = all.at(-1)!.ms, trainEnd = first + (last - first) * 0.60, devEnd = first + (last - first) * 0.80;
const train = all.filter((event) => event.ms <= trainEnd), dev = all.filter((event) => event.ms > trainEnd && event.ms <= devEnd), holdout = all.filter((event) => event.ms > devEnd);
const original = score(dev), inverse = score(dev, true);
const selected = qualifies(original) ? "original" : qualifies(inverse) ? "inverse" : null;
const lines = [
  "GOLDENXPERIENCE — FORCED FIVE-MINUTE MOMENTUM BINARY AUDIT", "Research only. Read-only use of recorded binary predictions; no predictions, database records, paper trades, or production behavior changed.", "",
  "Frozen rule: for each recorded baseline entry, predict UP if the latest completed OANDA M1 midpoint close available at entry is at or above its close five minutes earlier; otherwise predict DOWN. There is no WAIT state.",
  "Outcome: the actual recorded binary entry and resolution marks are used, including the row's tie tolerance. Exact inverse is the same entry/mark with the direction reversed.",
  `Recorded sample: ${predictions.length} settled baseline predictions; ${all.length} M1-backed forced decisions across ${pairs.length} pairs, ${new Date(first).toISOString()} → ${new Date(last).toISOString()}.`,
  `Chronological split: TRAIN through ${new Date(trainEnd).toISOString()} | DEV through ${new Date(devEnd).toISOString()} | HOLDOUT after.`, "", "Coverage:", ...coverage, "",
  `TRAIN original: ${format(score(train))}`, `TRAIN exact inverse: ${format(score(train, true))}`,
  `DEV original: ${format(original)}`, `DEV exact inverse: ${format(inverse)}`,
  `Predeclared gate: n>=100, WR>${(BREAK_EVEN * 100).toFixed(2)}%, Wilson lower bound >50%. Selected for holdout: ${selected?.toUpperCase() ?? "NONE"}.`,
];
if (selected) { const result = score(holdout, selected === "inverse"); lines.push(`HOLDOUT ${selected}: ${format(result)}`, `Holdout verdict: ${qualifies(result) ? "CANDIDATE — forward-test only." : "FAIL — do not activate."}`); }
else lines.push("HOLDOUT NOT READ — neither direction passed the fixed development gate.");
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`); console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
