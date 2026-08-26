/**
 * Direction-only audit of actual four-family forex paper decisions.
 *
 * This deliberately ignores trade entry, stops, targets, spread and P&L.  It
 * asks only: did the strategy's original direction match the raw OANDA M1
 * midpoint move ten minutes after the decision?  The inverse arm is the exact
 * opposite direction on the identical two midpoint marks.
 *
 * Research only.  It reads Postgres and OANDA Practice candles and writes one
 * local report.  It does not change paper trades or runtime policy.
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

const OUT = path.join(root, "research-v2", "actual-forex-direction-10m-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const BARS = 20_000, PAGE = 5_000, HORIZON_MS = 10 * 60_000, BREAK_EVEN = 1 / 1.8;
type Direction = "long" | "short";
type Trade = { instrument: MajorInstrument; decision_time: string | Date; direction: Direction; original_direction: Direction | null; inverted: boolean; strategy_family: string | null };
type Candle = { closeMs: number; close: number };
type Event = { pair: string; family: string; ms: number; original: "won" | "lost" | "tie"; executed: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function opposite(direction: Direction): Direction { return direction === "long" ? "short" : "long"; }
function wilson(wins: number, n: number) {
  if (!n) return { low: null, high: null };
  const z = 1.96, p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { low: (c - m) / d, high: (c + m) / d };
}
function score(events: Event[], arm: "original" | "inverse" | "executed"): Score {
  const outcomes = events.map((event) => arm === "inverse" ? event.original === "won" ? "lost" : event.original === "lost" ? "won" : "tie" : event[arm]);
  const wins = outcomes.filter((outcome) => outcome === "won").length, losses = outcomes.filter((outcome) => outcome === "lost").length, ties = outcomes.length - wins - losses, n = wins + losses, ci = wilson(wins, n);
  return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high };
}
function format(result: Score) {
  const pct = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  return `n=${result.n} W/L/T=${result.wins}/${result.losses}/${result.ties} WR=${pct(result.rate)} CI95=[${pct(result.low)}, ${pct(result.high)}]`;
}
function qualifies(result: Score) { return result.n >= 100 && (result.rate ?? 0) > BREAK_EVEN && (result.low ?? 0) > 0.5; }
function outcome(direction: Direction, move: number): "won" | "lost" | "tie" { if (move === 0) return "tie"; return (direction === "long" ? move > 0 : move < 0) ? "won" : "lost"; }

async function fetchM1(pair: MajorInstrument): Promise<Candle[]> {
  const values = new Map<number, Candle>(); let cursor: string | undefined, priorOldest = Infinity;
  for (let page = 0; values.size < BARS && page < Math.ceil(BARS / PAGE) + 2; page += 1) {
    const batch = (await getResearchCandles(pair, "M1", Math.min(PAGE, BARS), cursor ? { to: cursor } : {}))
      .filter((item) => item.complete).map((item) => ({ closeMs: Date.parse(item.time) + 60_000, close: item.mid.close }));
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

function eventsFor(trades: Trade[], candlesByPair: Map<string, Candle[]>) {
  const events: Event[] = [], skipped = new Map<string, number>();
  for (const trade of trades) {
    const candles = candlesByPair.get(trade.instrument), decisionMs = Date.parse(trade.decision_time instanceof Date ? trade.decision_time.toISOString() : trade.decision_time);
    const index = candles ? indexAtOrBefore(candles, decisionMs) : -1;
    if (index < 0 || !candles) { skipped.set(trade.instrument, (skipped.get(trade.instrument) ?? 0) + 1); continue; }
    const mark = candles.find((candle) => candle.closeMs === candles[index]!.closeMs + HORIZON_MS);
    if (!mark) { skipped.set(trade.instrument, (skipped.get(trade.instrument) ?? 0) + 1); continue; }
    const originalDirection = trade.original_direction ?? trade.direction, move = mark.close - candles[index]!.close;
    events.push({ pair: trade.instrument, family: trade.strategy_family ?? "untagged", ms: decisionMs, original: outcome(originalDirection, move), executed: outcome(trade.direction, move) });
  }
  return { events, skipped };
}

fs.mkdirSync(OUT, { recursive: true });
const trades = (await query<Trade>(`SELECT instrument, decision_time, direction, original_direction, inverted, strategy_family
  FROM paper_strategy_trades
  WHERE strategy_family IN ('ema', 'breakout', 'momentum', 'meanrev')
  ORDER BY decision_time`)).rows;
if (!trades.length) throw new Error("No actual four-family paper decisions found.");
const pairs = [...new Set(trades.map((trade) => trade.instrument))];
const candlesByPair = new Map<string, Candle[]>(), coverage: string[] = [];
for (const pair of pairs) { const candles = await fetchM1(pair); candlesByPair.set(pair, candles); coverage.push(`${pair}: ${trades.filter((trade) => trade.instrument === pair).length} actual decisions; ${candles.length} fetched completed M1 candles.`); console.log(coverage.at(-1)); }
const { events, skipped } = eventsFor(trades, candlesByPair);
events.sort((left, right) => left.ms - right.ms);
if (!events.length) throw new Error("No actual decisions had both required M1 midpoint marks.");
const first = events[0]!.ms, last = events.at(-1)!.ms, trainEnd = first + (last - first) * 0.60, devEnd = first + (last - first) * 0.80;
const train = events.filter((event) => event.ms <= trainEnd), dev = events.filter((event) => event.ms > trainEnd && event.ms <= devEnd), holdout = events.filter((event) => event.ms > devEnd);
const devOriginal = score(dev, "original"), devInverse = score(dev, "inverse"), selected = qualifies(devOriginal) ? "original" : qualifies(devInverse) ? "inverse" : null;
const families = [...new Set(events.map((event) => event.family))].sort();
const familyRows = families.map((family) => {
  const sample = events.filter((event) => event.family === family);
  return `${family.padEnd(10)} decisions=${String(sample.length).padStart(3)} | original ${format(score(sample, "original"))} | inverse ${format(score(sample, "inverse"))} | executed ${format(score(sample, "executed"))}`;
});
const inverted = trades.filter((trade) => trade.inverted).length;
const lines = [
  "GOLDENXPERIENCE — ACTUAL FOREX ENGINE 10-MINUTE DIRECTION AUDIT",
  "Research only. This read-only audit does not change trades, runtime strategy policy, paper risk, or production behavior.", "",
  "Question tested: for each actual four-family forex paper decision, did the strategy's original direction match the raw OANDA M1 midpoint move exactly ten minutes after the latest completed M1 close at or before its decision time?",
  "This is direction-only: no trade entry, bid/ask, spread, stop, target, resolver, or R result is used. A zero midpoint move is a tie. Exact inverse flips only the original direction while keeping the same two midpoint marks.",
  `Source: ${trades.length} actual paper_strategy_trades rows from the EMA, breakout, momentum and mean-reversion families; ${events.length} had both required M1 marks. ${inverted} stored rows had an execution-policy direction flip.`,
  `Observation window: ${new Date(first).toISOString()} → ${new Date(last).toISOString()}. Horizon: 10 minutes.`, "",
  "ALL-RECORDS EXPLORATORY FAMILY VIEW — descriptive only; do not use this pooled table to activate or invert a strategy:",
  ...familyRows, "",
  "Chronological validation (the only activation decision):",
  `TRAIN original: ${format(score(train, "original"))}`,
  `TRAIN exact inverse: ${format(score(train, "inverse"))}`,
  `DEV original: ${format(devOriginal)}`,
  `DEV exact inverse: ${format(devInverse)}`,
  `Predeclared gate: n>=100, WR>${(BREAK_EVEN * 100).toFixed(2)}%, Wilson lower bound >50%. Selected for holdout: ${selected?.toUpperCase() ?? "NONE"}.`,
];
if (selected) { const result = score(holdout, selected); lines.push(`HOLDOUT ${selected}: ${format(result)}`, `Holdout verdict: ${qualifies(result) ? "CANDIDATE — forward-test only." : "FAIL — do not activate."}`); }
else lines.push("HOLDOUT NOT READ — neither direction passed the fixed development gate.");
lines.push("", "Coverage:", ...coverage, `Skipped because either M1 mark was unavailable: ${[...skipped.entries()].map(([pair, count]) => `${pair}=${count}`).join(", ") || "none"}.`);
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
