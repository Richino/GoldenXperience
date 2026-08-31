/**
 * Sealed, price-only H1 direction experiment.
 *
 * Raw OANDA BA midpoint candles only.  It never reads trade rows or places
 * orders.  Aug 2025-Feb 2026 trains predeclared models; Feb-Apr selects one
 * abstention margin.  Apr-Aug is read only if a development gate passes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Candle = { time: string; close: number; high: number; low: number };
type Actual = 0 | 1;
type FeatureRow = { pair: string; time: string; actual: Actual; features: number[] };
type Model = { name: string; columns: number[]; mean: number[]; scale: number[]; weights: number[]; bias: number };
type Scored = { n: number; correct: number; accuracy: number; inverseAccuracy: number; wilsonLower: number; threshold: number };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA credentials are required to fetch raw candles");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const pairs = ["EUR_USD", "GBP_USD", "USD_JPY"];
const warmupStart = "2025-07-20T00:00:00.000Z";
const replayStart = "2025-08-01T00:00:00.000Z";
const trainEnd = "2026-02-01T00:00:00.000Z";
const developmentEnd = "2026-04-01T00:00:00.000Z";
const replayEnd = "2026-08-01T00:00:00.000Z";
const margins = [0, 0.05, 0.1, 0.15];
const output = path.join(root, "research-v2", "h1-direction-v2-sealed"); if (!existsSync(output)) mkdirSync(output, { recursive: true });

function ema(values: number[], period: number) {
  const result = [values[0]!]; const multiplier = 2 / (period + 1);
  for (let index = 1; index < values.length; index++) result.push(values[index]! * multiplier + result[index - 1]! * (1 - multiplier));
  return result;
}
function atr(bars: Candle[], period = 14) {
  const result = new Array<number>(bars.length).fill(Number.NaN); let smoothed = 0;
  for (let index = 0; index < bars.length; index++) {
    const current = bars[index]!; const prior = bars[index - 1];
    const range = prior ? Math.max(current.high - current.low, Math.abs(current.high - prior.close), Math.abs(current.low - prior.close)) : current.high - current.low;
    if (index < period) { smoothed += range; if (index === period - 1) result[index] = smoothed / period; }
    else { smoothed = ((result[index - 1] as number) * (period - 1) + range) / period; result[index] = smoothed; }
  }
  return result;
}
function slope(values: number[]) {
  const meanX = (values.length - 1) / 2; const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0; let denominator = 0;
  for (let index = 0; index < values.length; index++) { numerator += (index - meanX) * (values[index]! - meanY); denominator += (index - meanX) ** 2; }
  return denominator ? numerator / denominator : 0;
}
function sigmoid(value: number) { return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value)); }
function wilsonLower(correct: number, n: number) {
  if (!n) return 0; const z = 1.96; const p = correct / n; const denominator = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denominator;
}

async function fetchH1(pair: string, endExclusive: string) {
  const all = new Map<string, Candle>(); let cursor = warmupStart;
  for (let page = 0; page < 20; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=H1&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair}: H1 fetch failed (${response.status})`);
    const json = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (json.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const midpoint = (key: string) => (+bar.bid[key]! + +bar.ask[key]!) / 2;
      return { time: new Date(Date.parse(bar.time) + 3_600_000).toISOString(), close: midpoint("c"), high: midpoint("h"), low: midpoint("l") };
    });
    for (const bar of pageBars) if (bar.time < endExclusive) all.set(bar.time, bar);
    if (pageBars.length < 5000 || !pageBars.length) break;
    cursor = pageBars.at(-1)!.time; if (Date.parse(cursor) >= Date.parse(endExclusive)) break;
  }
  return [...all.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

function makeRows(pair: string, bars: Candle[]) {
  const values = bars.map((bar) => bar.close); const atr14 = atr(bars, 14); const atr48 = atr(bars, 48); const ema8 = ema(values, 8); const ema21 = ema(values, 21);
  const rows: FeatureRow[] = [];
  for (let index = 48; index < bars.length - 1; index++) {
    const current = bars[index]!; const future = bars[index + 1]!;
    if (current.time < replayStart || current.time >= replayEnd || Date.parse(future.time) - Date.parse(current.time) !== 3_600_000 || !Number.isFinite(atr14[index]) || !Number.isFinite(atr48[index]) || future.close === current.close) continue;
    const unit = atr14[index]!; const window24 = bars.slice(index - 23, index + 1); const low24 = Math.min(...window24.map((bar) => bar.low)); const high24 = Math.max(...window24.map((bar) => bar.high));
    const rangePosition = high24 === low24 ? 0 : (current.close - low24) / (high24 - low24) - 0.5;
    rows.push({ pair, time: current.time, actual: future.close > current.close ? 1 : 0, features: [
      (current.close - bars[index - 4]!.close) / unit,                         // four-hour impulse
      slope(values.slice(index - 11, index + 1)) / unit,                        // twelve-hour slope
      rangePosition,                                                             // 24-hour range location
      (ema8[index]! - ema21[index]!) / unit,                                    // short EMA spread
      atr48[index]! > 0 ? unit / atr48[index]! : 1,                             // volatility regime (filter feature)
    ] });
  }
  return rows;
}

function fit(name: string, columns: number[], rows: FeatureRow[]): Model {
  const mean = columns.map((column) => rows.reduce((sum, row) => sum + row.features[column]!, 0) / rows.length);
  const scale = columns.map((column, index) => Math.max(1e-9, Math.sqrt(rows.reduce((sum, row) => sum + (row.features[column]! - mean[index]!) ** 2, 0) / rows.length)));
  const weights = columns.map(() => 0); let bias = 0; const learningRate = 0.04; const l2 = 0.03;
  for (let epoch = 0; epoch < 500; epoch++) {
    const gradient = columns.map(() => 0); let biasGradient = 0;
    for (const row of rows) {
      const xs = columns.map((column, index) => (row.features[column]! - mean[index]!) / scale[index]!);
      const error = sigmoid(bias + xs.reduce((sum, value, index) => sum + value * weights[index]!, 0)) - row.actual;
      for (let index = 0; index < gradient.length; index++) gradient[index] += error * xs[index]!;
      biasGradient += error;
    }
    for (let index = 0; index < weights.length; index++) weights[index] -= learningRate * (gradient[index]! / rows.length + l2 * weights[index]!);
    bias -= learningRate * biasGradient / rows.length;
  }
  return { name, columns, mean, scale, weights, bias };
}
function probability(model: Model, row: FeatureRow) {
  return sigmoid(model.bias + model.columns.reduce((sum, column, index) => sum + ((row.features[column]! - model.mean[index]!) / model.scale[index]!) * model.weights[index]!, 0));
}
function score(model: Model, rows: FeatureRow[], threshold: number): Scored {
  const selected = rows.filter((row) => Math.abs(probability(model, row) - 0.5) >= threshold);
  const correct = selected.filter((row) => (probability(model, row) >= 0.5 ? 1 : 0) === row.actual).length;
  const accuracy = selected.length ? correct / selected.length : 0;
  return { n: selected.length, correct, accuracy, inverseAccuracy: selected.length ? 1 - accuracy : 0, wilsonLower: wilsonLower(correct, selected.length), threshold };
}
function randomAccuracy(rows: FeatureRow[], seed: number) {
  let correct = 0;
  for (const row of rows) { let hash = 2166136261 ^ seed; for (const character of `${row.pair}|${row.time}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16; if (((hash >>> 0) % 2) === row.actual) correct++; }
  return rows.length ? correct / rows.length : 0;
}

// Do not fetch the sealed period unless development selects a candidate.
const rows = (await Promise.all(pairs.map(async (pair) => makeRows(pair, await fetchH1(pair, developmentEnd))))).flat();
const train = rows.filter((row) => row.time < trainEnd); const development = rows.filter((row) => row.time >= trainEnd && row.time < developmentEnd);
const definitions = [{ name: "impulse_4h", columns: [0] }, { name: "slope_12h", columns: [1] }, { name: "range_position_24h", columns: [2] }, { name: "ema_spread_8_21", columns: [3] }, { name: "combined_price_and_volatility", columns: [0, 1, 2, 3, 4] }];
const developmentResults = definitions.map((definition) => {
  const model = fit(definition.name, definition.columns, train); const variants = margins.map((margin) => score(model, development, margin));
  const best = variants.filter((result) => result.n >= 250).sort((left, right) => right.wilsonLower - left.wilsonLower || right.n - left.n)[0] ?? variants[0]!;
  return { model, variants, selected: best, qualifies: best.n >= 250 && best.accuracy > 0.5 && best.wilsonLower > 0.5 };
});
const qualified = developmentResults.filter((result) => result.qualifies).sort((left, right) => right.selected.wilsonLower - left.selected.wilsonLower || right.selected.n - left.selected.n)[0];
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), methodology: { source: "raw OANDA bid/ask midpoint H1 candles fetched at runtime", label: "UP if the next completed H1 midpoint close is higher, otherwise DOWN", split: { train: `${replayStart} through ${trainEnd} exclusive`, development: `${trainEnd} through ${developmentEnd} exclusive`, sealedHoldout: `${developmentEnd} through ${replayEnd} exclusive` }, features: ["4h ATR-normalized impulse", "12h ATR-normalized slope", "24h range position", "EMA8-EMA21 spread", "ATR14/ATR48 volatility regime"], model: "L2-regularized logistic regression; candidate-specific model fits only the training split", selectionGate: "development n >= 250, accuracy > 50%, Wilson 95% lower bound > 50%; choose highest lower bound", controls: "exact inverse and 100 deterministic random directions", excluded: "trade rows, M15 timing, stops, targets, execution, and position locks" }, coverage: { trainAndDevelopmentRows: rows.length, train: train.length, development: development.length, sealedHoldout: qualified ? "fetched only after qualification" : "not fetched" }, development: developmentResults.map(({ model, variants, selected, qualifies }) => ({ model: model.name, columns: model.columns, variants, selected, qualifies })), verdict: qualified ? "QUALIFIED_FOR_SEALED_HOLDOUT" : "NO_MODEL_QUALIFIED_HOLDOUT_REMAINS_UNREAD" };
if (qualified) {
  const holdout = (await Promise.all(pairs.map(async (pair) => makeRows(pair, await fetchH1(pair, replayEnd))))).flat().filter((row) => row.time >= developmentEnd); const selected = score(qualified.model, holdout, qualified.selected.threshold); const random = Array.from({ length: 100 }, (_, seed) => randomAccuracy(holdout.filter((row) => Math.abs(probability(qualified.model, row) - 0.5) >= qualified.selected.threshold), seed + 1)).sort((left, right) => left - right);
  report.selected = { model: qualified.model.name, development: qualified.selected, holdout: { ...selected, randomControls: { count: random.length, meanAccuracy: random.reduce((sum, value) => sum + value, 0) / random.length, p05Accuracy: random[4]!, p95Accuracy: random[94]! } } };
}
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
