/**
 * Replay the current forex Momentum V1 signal on the recorded binary-baseline
 * sample.  Research only: reads OANDA Practice candles and resolved binary rows
 * and writes a local report.  It never writes database records or changes
 * binary/forex execution.
 *
 * Two explicitly different arms are reported:
 *  1. EXACT: the production Momentum V1 evaluator, which can decline a setup.
 *  2. FORCED: its native five-M15-bar ATR direction on every binary row. This
 *     is a diagnostic forced UP/DOWN rule, not the production forex engine.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import { classifyRegime } from "../../frontend/src/lib/strategy/regime.js";
import { DEFAULT_MOMENTUM_CONFIG, evaluateMomentum } from "../../frontend/src/lib/strategy/strategies/momentum.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { query } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const OUT = path.join(root, "research-v2", "binary-forex-momentum-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const BREAK_EVEN = 1 / 1.8;
type Direction = "long" | "short";
type Prediction = { instrument: MajorInstrument; start_at: string | Date; entry_price: string; resolution_price: string; tie_tolerance: string };
type Event = { pair: string; ms: number; outcome: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };
type Series = { m15: Candle[]; h1: Candle[]; h4: Candle[] };

function wilson(wins: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (c - m) / d, high: (c + m) / d }; }
function score(events: Event[], inverse = false): Score { const wins = events.filter((event) => event.outcome === (inverse ? "lost" : "won")).length, losses = events.filter((event) => event.outcome === (inverse ? "won" : "lost")).length, ties = events.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function format(result: Score) { const pct = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`; return `n=${result.n} W/L/T=${result.wins}/${result.losses}/${result.ties} WR=${pct(result.rate)} CI95=[${pct(result.low)}, ${pct(result.high)}]`; }
function qualifies(result: Score) { return result.n >= 100 && (result.rate ?? 0) > BREAK_EVEN && (result.low ?? 0) > 0.5; }
function outcome(direction: Direction, entry: number, mark: number, tolerance: number): "won" | "lost" | "tie" { const move = mark - entry; if (Math.abs(move) <= tolerance) return "tie"; return (direction === "long" ? move > 0 : move < 0) ? "won" : "lost"; }
function closeMs(candle: Candle, minutes: number) { return Date.parse(candle.time) + minutes * 60_000; }
function indexAtOrBefore(candles: Candle[], at: number, minutes: number) { let low = 0, high = candles.length - 1, found = -1; while (low <= high) { const middle = (low + high) >> 1; if (closeMs(candles[middle]!, minutes) <= at) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }

async function candles(pair: MajorInstrument, granularity: "M15" | "H1" | "H4", count: number): Promise<Candle[]> {
  return (await getResearchCandles(pair, granularity, count)).filter((candle) => candle.complete).map((candle) => ({
    time: candle.time, open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true,
  }));
}

function exactDirection(pair: MajorInstrument, at: number, data: Series): Direction | null {
  const m15Index = indexAtOrBefore(data.m15, at, 15), h1Index = indexAtOrBefore(data.h1, at, 60), h4Index = indexAtOrBefore(data.h4, at, 240);
  if (m15Index < 0 || h1Index < 0 || h4Index < 0) return null;
  const m15 = data.m15.slice(Math.max(0, m15Index - 299), m15Index + 1), h1 = data.h1.slice(Math.max(0, h1Index - 299), h1Index + 1), h4 = data.h4.slice(Math.max(0, h4Index - 299), h4Index + 1);
  const current = m15.at(-1)!;
  const bid = current.close, spreadPips = (current.close - current.close) / pipSizeFor(pair);
  const evaluatedAt = new Date(closeMs(current, 15)).toISOString();
  const input = { instrument: pair, accountBalance: 100_000, accountCurrency: "USD", dataSource: "oanda" as const,
    candles15m: m15, candles1h: h1, candles4h: h4, bid, ask: current.close, spreadPips, marketOpen: true,
    calendarConnected: false, highImpactNewsWithinMinutes: null, evaluatedAt, newsRequired: false, evaluationMode: "historical_replay" as const };
  const candidate = evaluateMomentum(input, classifyRegime(pair, m15, evaluatedAt), DEFAULT_MOMENTUM_CONFIG);
  return candidate.status === "valid" ? candidate.direction : null;
}

function forcedNativeDirection(at: number, data: Series): Direction | null {
  const index = indexAtOrBefore(data.m15, at, 15);
  if (index < DEFAULT_MOMENTUM_CONFIG.returnLookbackBars) return null;
  const history = data.m15.slice(0, index + 1), atr = calculateAtrValues(history, 14).at(-1) ?? 0;
  if (!(atr > 0)) return null;
  const last = history.at(-1)!, prior = history.at(-1 - DEFAULT_MOMENTUM_CONFIG.returnLookbackBars)!;
  // The production Momentum V1's native direction is the sign of this same
  // ATR-normalized run. A zero run is deterministically LONG to meet the
  // requested forced UP/DOWN contract; it is not a production trade decision.
  return (last.close - prior.close) / atr >= 0 ? "long" : "short";
}

function collect(predictions: Prediction[], seriesByPair: Map<string, Series>, arm: "exact" | "forced") {
  const events: Event[] = [], skipped = new Map<string, number>();
  for (const prediction of predictions) {
    const at = Date.parse(prediction.start_at instanceof Date ? prediction.start_at.toISOString() : prediction.start_at), series = seriesByPair.get(prediction.instrument);
    const direction = series ? arm === "exact" ? exactDirection(prediction.instrument, at, series) : forcedNativeDirection(at, series) : null;
    const entry = Number(prediction.entry_price), mark = Number(prediction.resolution_price), tolerance = Number(prediction.tie_tolerance);
    if (!direction || ![entry, mark, tolerance].every(Number.isFinite)) { skipped.set(prediction.instrument, (skipped.get(prediction.instrument) ?? 0) + 1); continue; }
    events.push({ pair: prediction.instrument, ms: at, outcome: outcome(direction, entry, mark, tolerance) });
  }
  events.sort((left, right) => left.ms - right.ms);
  return { events, skipped };
}

function validation(events: Event[]) {
  if (!events.length) return ["No eligible events."];
  const first = events[0]!.ms, last = events.at(-1)!.ms, trainEnd = first + (last - first) * 0.60, devEnd = first + (last - first) * 0.80;
  const train = events.filter((event) => event.ms <= trainEnd), dev = events.filter((event) => event.ms > trainEnd && event.ms <= devEnd), holdout = events.filter((event) => event.ms > devEnd);
  const original = score(dev), inverse = score(dev, true), selected = qualifies(original) ? "original" : qualifies(inverse) ? "inverse" : null;
  const lines = [`TRAIN original: ${format(score(train))}`, `TRAIN inverse: ${format(score(train, true))}`, `DEV original: ${format(original)}`, `DEV inverse: ${format(inverse)}`, `Predeclared gate: n>=100, WR>${(BREAK_EVEN * 100).toFixed(2)}%, Wilson lower bound >50%. Selected for holdout: ${selected?.toUpperCase() ?? "NONE"}.`];
  if (selected) lines.push(`HOLDOUT ${selected}: ${format(score(holdout, selected === "inverse"))}`); else lines.push("HOLDOUT NOT READ — neither direction passed development.");
  return lines;
}

fs.mkdirSync(OUT, { recursive: true });
const predictions = (await query<Prediction>(`SELECT instrument,start_at,entry_price,resolution_price,tie_tolerance
  FROM binary_predictions
  WHERE model_name='binary-baseline-v1' AND is_authoritative=true AND status='resolved'
    AND result IN ('won','lost','tie') AND resolution_price IS NOT NULL
  ORDER BY start_at`)).rows;
if (!predictions.length) throw new Error("No resolved authoritative binary baseline rows found.");
const pairs = [...new Set(predictions.map((prediction) => prediction.instrument))], seriesByPair = new Map<string, Series>(), coverage: string[] = [];
for (const pair of pairs) {
  const [m15, h1, h4] = await Promise.all([candles(pair, "M15", 4_000), candles(pair, "H1", 1_200), candles(pair, "H4", 400)]);
  seriesByPair.set(pair, { m15, h1, h4 }); coverage.push(`${pair}: ${predictions.filter((prediction) => prediction.instrument === pair).length} binary rows; M15/H1/H4=${m15.length}/${h1.length}/${h4.length}.`); console.log(coverage.at(-1));
}
const exact = collect(predictions, seriesByPair, "exact"), forced = collect(predictions, seriesByPair, "forced");
const lines = [
  "GOLDENXPERIENCE — FOREX MOMENTUM V1 ON THE RECORDED BINARY SAMPLE",
  "Research only. Read-only replay over settled authoritative binary-baseline rows. No binary records, paper trades, strategy policy, or production behavior changed.", "",
  "Binary outcome: each row keeps its actual recorded entry_price, resolution_price and tie_tolerance. Original and inverse use the same outcome marks.",
  "EXACT FOREX MOMENTUM V1: evaluates the current production Momentum V1 strategy only from completed M15/H1/H4 candles available at each binary entry. Its normal validity gates remain intact, so it can decline a row.",
  "FORCED NATIVE MOMENTUM DIRECTION: every usable binary row is LONG when the same current Momentum V1 five-M15-bar ATR run is non-negative, otherwise SHORT. It deliberately skips the production strategy's validity filters. This satisfies forced UP/DOWN coverage but is NOT the forex engine.",
  `Recorded binary sample: ${predictions.length} resolved baseline rows across ${pairs.length} pairs.`, "", "Coverage:", ...coverage, "",
  `EXACT engine eligible: ${exact.events.length}/${predictions.length} rows. Original: ${format(score(exact.events))}. Exact inverse: ${format(score(exact.events, true))}.`,
  `EXACT skipped/no-setup: ${[...exact.skipped.entries()].map(([pair, count]) => `${pair}=${count}`).join(", ") || "none"}.`,
  ...validation(exact.events), "",
  `FORCED native direction eligible: ${forced.events.length}/${predictions.length} rows. Original: ${format(score(forced.events))}. Exact inverse: ${format(score(forced.events, true))}.`,
  `FORCED skipped only for unavailable candle history: ${[...forced.skipped.entries()].map(([pair, count]) => `${pair}=${count}`).join(", ") || "none"}.`,
  ...validation(forced.events), "",
  "DEPENDENCE WARNING: many binary rows share the same completed M15 decision bar. These are the requested per-row results, not thousands of independent forex signals. Do not activate or invert from this replay; use it only to reject a clearly bad forced direction or choose a forward hypothesis.",
];
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
