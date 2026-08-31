/**
 * Bid/ask counterfactual audit for breakout-m5-confidence-v1.
 *
 * It resolves the inverse at its own bid/ask entry and geometry. It never
 * treats inverse R as `-originalR`, and reports a deterministic random arm.
 *
 * Limitation: the stored source opportunities were already blocked by the
 * original arm. A future replay must regenerate the unblocked universe.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { labelOutcome } from "../src/research.js";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serviceRoot, "..");
const tradesPath = path.join(repoRoot, "backtest-breakout-m5", "trades.json");
const cacheDir = path.join(repoRoot, "backtest-breakout-m5", "candles");
const outDir = path.join(serviceRoot, "research-v2", "confidence-breakout-m5-counterfactual-v1");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

type Direction = "long" | "short";
type Candle = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Trade = { pair: string; direction: Direction; decisionTime: string; entry: number; stop: number; target: number; atrPips: number; rangeWidthAtr: number; sessionHourEt: number; spreadPips: number; resultR: number | null; outcome: string; resolvedAt: string | null };
type Model = { w: number[]; b: number; mean: number[]; std: number[] };
type Arm = "original" | "inverse" | "random";
type Decision = { trade: Trade; resultR: number; resolvedAt: string | null };

const raw = JSON.parse(readFileSync(tradesPath, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((trade) => trade.resultR !== null && Number.isFinite(trade.resultR)).sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime));
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const SESSIONS = ["london", "overlap", "ny", "off"];
const FEATURES = [...SESSIONS.map((s) => `session_${s}`), ...PAIRS.map((p) => `pair_${p}`), "atrPips", "rangeWidthAtr", "spreadPips", "hourEt", "dayOfWeek"];
const MS_MONTH = 30 * 86400e3;

const dayCache = new Map<string, number>();
function etDay(iso: string) {
  const cached = dayCache.get(iso); if (cached !== undefined) return cached;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const day = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const value = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[day] ?? 0;
  dayCache.set(iso, value); return value;
}
function session(hour: number) { return hour >= 8 && hour < 12 ? "overlap" : hour >= 3 && hour < 8 ? "london" : hour >= 12 && hour < 17 ? "ny" : "off"; }
function vector(trade: Trade) {
  const currentSession = session(trade.sessionHourEt);
  return [...SESSIONS.map((s) => Number(s === currentSession)), ...PAIRS.map((p) => Number(p === trade.pair)), trade.atrPips, trade.rangeWidthAtr, trade.spreadPips, trade.sessionHourEt, etDay(trade.decisionTime)];
}
function longWon(trade: Trade) { return (trade.direction === "long" && trade.resultR! > 0) || (trade.direction === "short" && trade.resultR! < 0) ? 1 : 0; }
function train(rows: Trade[]): Model {
  const mean = FEATURES.map((_, index) => rows.reduce((sum, trade) => sum + vector(trade)[index]!, 0) / rows.length);
  const std = FEATURES.map((_, index) => Math.sqrt(rows.reduce((sum, trade) => sum + (vector(trade)[index]! - mean[index]!) ** 2, 0) / rows.length) || 1);
  const w = new Array(FEATURES.length).fill(0); let b = 0;
  const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
  for (let epoch = 0; epoch < 300; epoch++) {
    const grad = new Array(FEATURES.length).fill(0); let biasGrad = 0;
    for (const trade of rows) {
      const x = vector(trade).map((value, index) => (value - mean[index]!) / std[index]!);
      const probability = sigmoid(x.reduce((sum, value, index) => sum + value * w[index]!, b));
      const error = probability - longWon(trade);
      for (let index = 0; index < w.length; index++) grad[index] += error * x[index]!;
      biasGrad += error;
    }
    for (let index = 0; index < w.length; index++) w[index] -= 0.05 * (grad[index]! / rows.length + 0.001 * w[index]!);
    b -= 0.05 * biasGrad / rows.length;
  }
  return { w, b, mean, std };
}
function predict(trade: Trade, model: Model) {
  const x = vector(trade).map((value, index) => (value - model.mean[index]!) / model.std[index]!);
  return 1 / (1 + Math.exp(-x.reduce((sum, value, index) => sum + value * model.w[index]!, model.b)));
}
function randomDirection(trade: Trade): Direction {
  let hash = 2166136261;
  for (const char of `${trade.pair}|${trade.decisionTime}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 2 === 0 ? "long" : "short";
}
const candles = new Map<string, Candle[]>();
const candleIndex = new Map<string, Map<string, number>>();
for (const pair of PAIRS) {
  const bars = (JSON.parse(readFileSync(path.join(cacheDir, `${pair}_M5.json`), "utf8")) as { bars: Candle[] }).bars;
  candles.set(pair, bars);
  candleIndex.set(pair, new Map(bars.map((bar, index) => [bar.closeTime, index])));
}
function resolve(trade: Trade, direction: Direction) {
  const bars = candles.get(trade.pair); if (!bars) throw new Error(`Missing M5 candle cache for ${trade.pair}`);
  const index = candleIndex.get(trade.pair)?.get(trade.decisionTime); if (index === undefined) throw new Error(`Missing decision candle ${trade.pair} ${trade.decisionTime}`);
  const bar = bars[index]!; const entry = direction === "long" ? bar.askClose : bar.bidClose;
  const stopDistance = Math.abs(trade.entry - trade.stop); const targetDistance = Math.abs(trade.target - trade.entry);
  const stop = direction === "long" ? entry - stopDistance : entry + stopDistance;
  const target = direction === "long" ? entry + targetDistance : entry - targetDistance;
  // labelOutcome's horizon is 48 hours; 576 M5 bars cover it exactly, avoiding
  // copying an entire multi-year cache for each counterfactual.
  return labelOutcome(direction, entry, stop, target, trade.decisionTime, bars.slice(index + 1, index + 1 + 576));
}
function executable(decisions: Decision[]) {
  const activeUntil = new Map<string, number>();
  return decisions.sort((a, b) => Date.parse(a.trade.decisionTime) - Date.parse(b.trade.decisionTime)).filter((decision) => {
    const at = Date.parse(decision.trade.decisionTime); const until = activeUntil.get(decision.trade.pair) ?? Number.NEGATIVE_INFINITY;
    if (at < until) return false;
    activeUntil.set(decision.trade.pair, decision.resolvedAt ? Date.parse(decision.resolvedAt) : at + 48 * 3600e3);
    return true;
  });
}
function metrics(rows: Decision[]) {
  const totalR = rows.reduce((sum, row) => sum + row.resultR, 0); const wins = rows.filter((row) => row.resultR > 0).length;
  return { n: rows.length, wins, winRate: rows.length ? wins / rows.length : null, totalR, expectancyR: rows.length ? totalR / rows.length : null };
}

const first = Date.parse(trades[0]!.decisionTime); const last = Date.parse(trades.at(-1)!.decisionTime);
const results: Record<Arm, Decision[]> = { original: [], inverse: [], random: [] };
let windows = 0;
for (let testStart = first + 6 * MS_MONTH; testStart + 2 * MS_MONTH <= last + MS_MONTH; testStart += 2 * MS_MONTH) {
  const training = trades.filter((trade) => { const at = Date.parse(trade.decisionTime); return at >= testStart - 6 * MS_MONTH && at < testStart; });
  const test = trades.filter((trade) => { const at = Date.parse(trade.decisionTime); return at >= testStart && at < testStart + 2 * MS_MONTH; });
  if (training.length < 300 || test.length < 100) continue;
  windows++;
  const model = train(training);
  for (const trade of test) {
    const modelDirection: Direction = predict(trade, model) >= 0.5 ? "long" : "short";
    if (modelDirection === trade.direction) continue;
    const inverse = resolve(trade, modelDirection); const random = resolve(trade, randomDirection(trade));
    results.original.push({ trade, resultR: trade.resultR!, resolvedAt: trade.resolvedAt });
    results.inverse.push({ trade, resultR: inverse.resultR ?? 0, resolvedAt: inverse.resolvedAt });
    results.random.push({ trade, resultR: random.resultR ?? 0, resolvedAt: random.resolvedAt });
  }
}
const report = {
  generatedAt: new Date().toISOString(), purpose: "Bid/ask-resolved inverse counterfactual; no negated original R values.",
  methodology: { trainMonths: 6, testMonths: 2, windows, modelRule: "take only model disagreements", geometry: "same stop and target distances; side-specific bid/ask entry", resolver: "labelOutcome with M5 bid/ask candles", positionLock: "one open trade per instrument, applied separately per arm" },
  limitation: "The source opportunity set was already position-blocked by the original backtest arm. This audit fixes execution outcomes and arm-level locks, but does not reconstruct an unblocked candidate universe.",
  matched: Object.fromEntries((Object.keys(results) as Arm[]).map((arm) => [arm, metrics(results[arm])])),
  executable: Object.fromEntries((Object.keys(results) as Arm[]).map((arm) => [arm, metrics(executable([...results[arm]]))])),
};
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
