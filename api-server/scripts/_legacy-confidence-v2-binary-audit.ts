/**
 * Locked one-month binary-direction validation for legacy-confidence-v2.
 *
 * The model is retrained only on pre-window legacy P&L records, then its
 * unchanged UP/DOWN/WAIT rule is scored using OANDA midpoint direction exactly
 * ten minutes after each later M15 signal.  No DB writes or paper trades.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { atr, evaluateLegacySetup, rsi, type LegacyCandle } from "../src/legacy-setup-detector.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
const repo = path.resolve(root, "..");
const OUT = path.join(root, "research-v2", "legacy-confidence-v2-binary-oos-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const DATASET = path.join(repo, "backtest-legacy-expanded", "trades.json");
const CACHE = path.join(repo, "backtest-legacy-expanded", "candles");
const PAIRS: MajorInstrument[] = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
const PAGE = 5_000, M1_WANTED = 32_000, M15_WANTED = 4_000, H1_WANTED = 1_100, H4_WANTED = 500;
const TRAIN_MS = 12 * 30 * 86_400_000, HORIZON_MS = 10 * 60_000, CONFIDENCE = 0.10;
const NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3"] as const;
type FeatureName = (typeof NAMES)[number];
type Feature = Record<FeatureName, number>;
type Model = { weights: number[]; bias: number; mean: number[]; std: number[] };
type TrainTrade = { pair: string; direction: "long" | "short"; decisionTime: string; resultR: number | null };
type Event = { pair: string; at: string; ms: number; action: "up" | "down"; pLong: number | null; outcome: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function step(gran: "M1" | "M15" | "H1" | "H4") { return gran === "M1" ? 60_000 : gran === "M15" ? 900_000 : gran === "H1" ? 3_600_000 : 14_400_000; }
function etHour(iso: string) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso)).find((part) => part.type === "hour")?.value ?? "0") % 24; }
function etDay(iso: string) { const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso)).find((part) => part.type === "weekday")?.value ?? "Mon"; return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[day] ?? 0; }
function sigmoid(value: number) { return 1 / (1 + Math.exp(-value)); }
function vector(feature: Feature) { return NAMES.map((name) => feature[name]); }

function computeFeature(m15: LegacyCandle[]): Feature | null {
  const index = m15.length - 1;
  if (index < 500) return null;
  const closes = m15.map((bar) => bar.close), a14 = atr(m15, 14), a50 = atr(m15, 50), r14 = rsi(closes, 14);
  const values = [a14[index], a50[index], closes[index], r14[index], r14[index - 3], closes[index - 3]];
  if (!values.every((value) => Number.isFinite(value))) return null;
  const history = a14.slice(index - 500, index).filter((value) => Number.isFinite(value));
  if (history.length < 100) return null;
  const atrPct = history.filter((value) => value <= a14[index]!).length / history.length;
  const range = m15.slice(index - 20, index), high = Math.max(...range.map((bar) => bar.high)), low = Math.min(...range.map((bar) => bar.low));
  return { atrPct, atrRatio: a14[index]! / a50[index]!, hourEt: etHour(m15[index]!.closeTime), dayOfWeek: etDay(m15[index]!.closeTime), rsiVelocity: (r14[index]! - r14[index - 3]!) / 3, rangePos: high > low ? (closes[index]! - low) / (high - low) : 0.5, mom3: (closes[index]! - closes[index - 3]!) / closes[index]! };
}

function train(rows: Array<{ feature: Feature; label: 0 | 1 }>): Model {
  if (rows.length < 100) throw new Error(`Only ${rows.length} pre-window feature rows; need at least 100.`);
  const width = NAMES.length;
  const mean = Array.from({ length: width }, (_, index) => rows.reduce((sum, row) => sum + vector(row.feature)[index]!, 0) / rows.length);
  const std = mean.map((average, index) => Math.sqrt(rows.reduce((sum, row) => (vector(row.feature)[index]! - average) ** 2 + sum, 0) / rows.length) || 1);
  const weights = new Array(width).fill(0); let bias = 0;
  for (let epoch = 0; epoch < 500; epoch += 1) {
    const grad = new Array(width).fill(0); let biasGrad = 0;
    for (const row of rows) {
      const scaled = vector(row.feature).map((value, index) => (value - mean[index]!) / std[index]!);
      const probability = sigmoid(scaled.reduce((sum, value, index) => sum + value * weights[index]!, bias));
      const error = probability - row.label;
      for (let index = 0; index < width; index += 1) grad[index] += error * scaled[index]!;
      biasGrad += error;
    }
    for (let index = 0; index < width; index += 1) weights[index] -= 0.05 * (grad[index]! / rows.length + 0.001 * weights[index]!);
    bias -= 0.05 * biasGrad / rows.length;
  }
  return { weights, bias, mean, std };
}
function predict(feature: Feature, model: Model) { const scaled = vector(feature).map((value, index) => (value - model.mean[index]!) / model.std[index]!); return sigmoid(scaled.reduce((sum, value, index) => sum + value * model.weights[index]!, model.bias)); }

function cachedBars(pair: string, granularity: "M15"): LegacyCandle[] {
  const file = path.join(CACHE, `${pair}_${granularity}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { bars: LegacyCandle[] };
  return parsed.bars;
}
function indexAtOrBefore(bars: LegacyCandle[], ms: number) { let low = 0, high = bars.length - 1, found = -1; while (low <= high) { const middle = (low + high) >> 1; if (Date.parse(bars[middle]!.closeTime) <= ms) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }

async function recentBars(pair: MajorInstrument, granularity: "M1" | "M15" | "H1" | "H4", wanted: number): Promise<LegacyCandle[]> {
  const found = new Map<number, LegacyCandle>(); let cursor: string | undefined, previous = Infinity;
  while (found.size < wanted) {
    const candles = (await getResearchCandles(pair, granularity, Math.min(PAGE, wanted), cursor ? { to: cursor } : {})).filter((item) => item.complete);
    if (!candles.length) break;
    for (const item of candles) {
      const closeMs = Date.parse(item.time) + step(granularity);
      found.set(closeMs, { closeTime: new Date(closeMs).toISOString(), open: item.mid.open, high: item.mid.high, low: item.mid.low, close: item.mid.close, bidOpen: item.bid.open, bidHigh: item.bid.high, bidLow: item.bid.low, bidClose: item.bid.close, askOpen: item.ask.open, askHigh: item.ask.high, askLow: item.ask.low, askClose: item.ask.close });
    }
    const oldest = Math.min(...candles.map((item) => Date.parse(item.time)));
    if (oldest >= previous) throw new Error(`${pair} ${granularity} pagination did not advance.`);
    previous = oldest; cursor = new Date(oldest - 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return [...found.values()].sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime)).slice(-wanted);
}

function wilson(wins: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = wins / n, divisor = 1 + z * z / n, center = p + z * z / (2 * n), margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (center - margin) / divisor, high: (center + margin) / divisor }; }
function score(events: Event[], inverse = false): Score { const wins = events.filter((event) => event.outcome === (inverse ? "lost" : "won")).length, losses = events.filter((event) => event.outcome === (inverse ? "won" : "lost")).length, ties = events.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function format(value: Score) { const percent = (number: number | null) => number === null ? "n/a" : `${(number * 100).toFixed(2)}%`; return `n=${value.n} W/L/T=${value.wins}/${value.losses}/${value.ties} WR=${percent(value.rate)} CI95=[${percent(value.low)}, ${percent(value.high)}]`; }

fs.mkdirSync(OUT, { recursive: true });
const allTrades = (JSON.parse(fs.readFileSync(DATASET, "utf8")) as { trades: TrainTrade[] }).trades.filter((trade) => trade.resultR !== null && Number.isFinite(trade.resultR));
const firstWindowBars = await recentBars(PAIRS[0]!, "M1", M1_WANTED);
const testStart = firstWindowBars[0] ? Date.parse(firstWindowBars[0].closeTime) : NaN;
if (!Number.isFinite(testStart)) throw new Error("Could not establish an OANDA M1 binary window.");
const trainStart = testStart - TRAIN_MS;
const training: Array<{ feature: Feature; label: 0 | 1 }> = [];
for (const pair of PAIRS.filter((pair) => pair !== "XAU_USD")) {
  const bars = cachedBars(pair, "M15");
  for (const trade of allTrades.filter((trade) => trade.pair === pair && Date.parse(trade.decisionTime) >= trainStart && Date.parse(trade.decisionTime) < testStart)) {
    const index = indexAtOrBefore(bars, Date.parse(trade.decisionTime));
    if (index < 500) continue;
    const feature = computeFeature(bars.slice(index - 500, index + 1));
    if (!feature) continue;
    const longWon = (trade.direction === "long" ? trade.resultR! : -trade.resultR!) > 0;
    training.push({ feature, label: longWon ? 1 : 0 });
  }
}
const model = train(training);
const events: Event[] = [], coverage: string[] = [];
for (const pair of PAIRS) {
  const [m1, m15, h1, h4] = pair === PAIRS[0] ? [firstWindowBars, await recentBars(pair, "M15", M15_WANTED), await recentBars(pair, "H1", H1_WANTED), await recentBars(pair, "H4", H4_WANTED)] : await Promise.all([recentBars(pair, "M1", M1_WANTED), recentBars(pair, "M15", M15_WANTED), recentBars(pair, "H1", H1_WANTED), recentBars(pair, "H4", H4_WANTED)]);
  const mark = new Map(m1.map((bar) => [Date.parse(bar.closeTime), bar.close]));
  const first = Date.parse(m1[0]!.closeTime), last = Date.parse(m1.at(-1)!.closeTime);
  let checked = 0, legacySetups = 0, taken = 0;
  for (let index = 500; index < m15.length; index += 1) {
    const decisionMs = Date.parse(m15[index]!.closeTime);
    if (decisionMs < first || decisionMs + HORIZON_MS > last || !mark.has(decisionMs + HORIZON_MS)) continue;
    checked++;
    const setup = evaluateLegacySetup(pair, m15.slice(index - 500, index + 1), h1.filter((bar) => Date.parse(bar.closeTime) <= decisionMs).slice(-300), h4.filter((bar) => Date.parse(bar.closeTime) <= decisionMs).slice(-200));
    if (!setup.passed) continue;
    legacySetups++;
    let action: "up" | "down"; let probability: number | null = null;
    if (pair === "XAU_USD") action = setup.direction === "long" ? "up" : "down";
    else {
      const feature = computeFeature(m15.slice(index - 500, index + 1)); if (!feature) continue;
      probability = predict(feature, model); const chosen = probability >= 0.5 ? "long" : "short";
      if (chosen === setup.direction || Math.abs(probability - 0.5) < CONFIDENCE) continue;
      action = chosen === "long" ? "up" : "down";
    }
    taken++;
    const entry = m15[index]!.close, exit = mark.get(decisionMs + HORIZON_MS)!;
    const outcome = Math.abs(exit - entry) < 1e-12 ? "tie" : (action === "up" ? exit > entry : exit < entry) ? "won" : "lost";
    events.push({ pair, at: m15[index]!.closeTime, ms: decisionMs, action, pLong: probability, outcome });
  }
  coverage.push(`${pair}: eligible M15=${checked}; legacy 10-gate setups=${legacySetups}; confidence-rule UP/DOWN=${taken}.`);
}
events.sort((left, right) => left.ms - right.ms);
const lines = [
  "GOLDENXPERIENCE — LEGACY-CONFIDENCE-V2 LOCKED BINARY DIRECTION AUDIT", "Research only. No database, binary prediction, configuration, or paper-trade rows changed.", "",
  "Decision: exact legacy 10-gate EMA-pullback setup; FX takes only a confident model disagreement (|pLong−0.5| >= 0.10), XAU takes the legacy direction; all other cases are WAIT.",
  "Training: model retrained from the preceding 12 months of legacy P&L records only. The binary outcome window begins after that training cutoff, so binary labels were not available to the model.",
  "Outcome: freeze UP/DOWN/WAIT at completed M15 close; entry=OANDA M15 midpoint; mark=OANDA M1 midpoint exactly +10 minutes later. Exact inverse is a control using identical marks.",
  `Training cutoff: ${new Date(testStart).toISOString()}; training samples=${training.length}.`,
  `Binary validation window: ${events[0] ? events[0].at : "no signals"} → ${events.at(-1)?.at ?? "no signals"}.`, "", "Coverage:", ...coverage, "",
  `Original confidence rule: ${format(score(events))}`,
  `Exact inverse control: ${format(score(events, true))}`,
  "Verdict: this is one locked, out-of-sample binary window. It is descriptive only unless at least 100 decided signals are available; do not tune the rule from this result.",
  "", "Implementation blocker found separately: the live collector fetches 500 M15 bars but its feature function requires 501, so it currently cannot produce a model-directed FX decision. This audit uses 501 bars to test the intended rule; it does not silently fix the collector.",
];
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
