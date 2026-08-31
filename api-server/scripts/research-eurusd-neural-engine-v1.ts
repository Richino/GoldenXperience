/**
 * EUR/USD V10 news/opportunity research engine.
 * Trains Stage 1 from fresh OANDA Practice M5 bid/ask, then combines its frozen
 * opportunity score with user-supplied economic surprises for direction.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; volume: number; bid: Side; ask: Side; mid: Side };
type Period = { from: string; to: string };
type ScoreMode = "opportunityOnly" | "opportunityTimesDirectionConfidence" | "opportunityTimesDirectionMargin";
type DirectionMode = "conditionalNeural" | "emaTrend" | "higherTimeframeTrend" | "higherTimeframeMomentum" | "multiTimeframeConsensus" | "neuralHtfAgreement" | "dualTrendAgreement" | "neuralTrendMomentumAgreement" | "momentum12" | "momentum3" | "meanReversion24" | "candleBody";
type NeuralTrade = { entryTime: string; exitTime: string; direction: 1 | -1; probabilityUp: number; selectedBetterPath: boolean; targetPathExisted: boolean; outcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT"; resultR: number; spreadPips: number };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("Neural research refuses OANDA live.");

const fetchStart = "2021-12-20T00:00:00.000Z";
const fetchEnd = "2026-08-01T00:00:00.000Z";
const periods = {
  train2022_23: { from: "2022-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z" },
  calibration2024: { from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
  development2025: { from: "2025-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
  finalHoldout2026: { from: "2026-01-01T00:00:00.000Z", to: fetchEnd },
} satisfies Record<string, Period>;
const opportunityFeatureCount = 26, opportunityHiddenCount = 16, directionFeatureCount = 36, directionHiddenCount = 24, horizonBars = 12, featureLookback = 600;
const targetTradesPerDay = 2.5, dailyEntryCap = 4;
const outputDirectory = path.join(root, "research-v2", "eurusd-neural-engine-v12-news-strength-filter");

async function fetchM5() {
  const collected = new Map<string, Bar>();
  let cursor = fetchStart;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA M5 request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; volume: number; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar): Bar => {
      const bid = { o: Number(bar.bid.o), h: Number(bar.bid.h), l: Number(bar.bid.l), c: Number(bar.bid.c) };
      const ask = { o: Number(bar.ask.o), h: Number(bar.ask.h), l: Number(bar.ask.l), c: Number(bar.ask.c) };
      return { time: bar.time, volume: Number(bar.volume), bid, ask, mid: { o: (bid.o + ask.o) / 2, h: (bid.h + ask.h) / 2, l: (bid.l + ask.l) / 2, c: (bid.c + ask.c) / 2 } };
    });
    for (const bar of pageBars) if (bar.time < fetchEnd) collected.set(bar.time, bar);
    if ((page + 1) % 10 === 0) console.error(`Fetched ${collected.size.toLocaleString()} M5 candles`);
    const last = pageBars.at(-1);
    if (!last || pageBars.length < 5000 || last.time >= fetchEnd) break;
    cursor = new Date(Date.parse(last.time) + 300_000).toISOString();
  }
  return [...collected.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function prepareSeries(bars: Bar[]) {
  const ema12 = new Float64Array(bars.length), ema48 = new Float64Array(bars.length), ema144 = new Float64Array(bars.length), ema576 = new Float64Array(bars.length), tr = new Float64Array(bars.length), atr14 = new Float64Array(bars.length), atr96 = new Float64Array(bars.length), volumeMean24 = new Float64Array(bars.length), volumeMean96 = new Float64Array(bars.length), position48 = new Float64Array(bars.length), position288 = new Float64Array(bars.length), signedEfficiency144 = new Float64Array(bars.length);
  atr14.fill(Number.NaN); atr96.fill(Number.NaN); volumeMean24.fill(Number.NaN); volumeMean96.fill(Number.NaN); position48.fill(Number.NaN); position288.fill(Number.NaN); signedEfficiency144.fill(Number.NaN);
  const k12 = 2 / 13, k48 = 2 / 49, k144 = 2 / 145, k576 = 2 / 577;
  let sum14 = 0, sum96 = 0, volumeSum24 = 0, volumeSum96 = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index]!.mid.c;
    ema12[index] = index ? close * k12 + ema12[index - 1]! * (1 - k12) : close;
    ema48[index] = index ? close * k48 + ema48[index - 1]! * (1 - k48) : close;
    ema144[index] = index ? close * k144 + ema144[index - 1]! * (1 - k144) : close;
    ema576[index] = index ? close * k576 + ema576[index - 1]! * (1 - k576) : close;
    const previousClose = index ? bars[index - 1]!.mid.c : close;
    tr[index] = Math.max(bars[index]!.mid.h - bars[index]!.mid.l, Math.abs(bars[index]!.mid.h - previousClose), Math.abs(bars[index]!.mid.l - previousClose));
    sum14 += tr[index]!; if (index >= 14) sum14 -= tr[index - 14]!; if (index >= 13) atr14[index] = sum14 / 14;
    sum96 += tr[index]!; if (index >= 96) sum96 -= tr[index - 96]!; if (index >= 95) atr96[index] = sum96 / 96;
    volumeSum24 += bars[index]!.volume; if (index >= 24) volumeSum24 -= bars[index - 24]!.volume; if (index >= 23) volumeMean24[index] = volumeSum24 / 24;
    volumeSum96 += bars[index]!.volume; if (index >= 96) volumeSum96 -= bars[index - 96]!.volume; if (index >= 95) volumeMean96[index] = volumeSum96 / 96;
    for (const lookback of [48, 288] as const) {
      if (index < lookback - 1) continue;
      let high = -Infinity, low = Infinity;
      for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) { high = Math.max(high, bars[cursor]!.mid.h); low = Math.min(low, bars[cursor]!.mid.l); }
      const value = high > low ? 2 * (close - low) / (high - low) - 1 : 0;
      if (lookback === 48) position48[index] = value; else position288[index] = value;
    }
    if (index >= 144) {
      let travel = 0;
      for (let cursor = index - 143; cursor <= index; cursor += 1) travel += Math.abs(bars[cursor]!.mid.c - bars[cursor - 1]!.mid.c);
      signedEfficiency144[index] = travel ? (close - bars[index - 144]!.mid.c) / travel : 0;
    }
  }
  return { ema12, ema48, ema144, ema576, atr14, atr96, volumeMean24, volumeMean96, position48, position288, signedEfficiency144 };
}

function efficiency(bars: Bar[], index: number, lookback: number) {
  const displacement = Math.abs(bars[index]!.mid.c - bars[index - lookback]!.mid.c);
  let travel = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) travel += Math.abs(bars[cursor]!.mid.c - bars[cursor - 1]!.mid.c);
  return travel ? displacement / travel : 0;
}

function zScore(bars: Bar[], index: number, lookback: number) {
  let sum = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) sum += bars[cursor]!.mid.c;
  const mean = sum / lookback;
  let squared = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) squared += (bars[cursor]!.mid.c - mean) ** 2;
  const deviation = Math.sqrt(squared / lookback);
  return deviation ? (bars[index]!.mid.c - mean) / deviation : 0;
}

function baseFeaturesAt(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number) {
  const atr = series.atr14[index]!, bar = bars[index]!, values: number[] = [];
  for (const lag of [1, 2, 3, 6, 12]) values.push((bar.mid.c - bars[index - lag]!.mid.c) / atr);
  values.push((bar.mid.c - bar.mid.o) / atr, (bar.mid.h - bar.mid.l) / atr, (bar.mid.h - Math.max(bar.mid.o, bar.mid.c)) / atr, (Math.min(bar.mid.o, bar.mid.c) - bar.mid.l) / atr);
  values.push((bar.mid.c - series.ema12[index]!) / atr, (series.ema12[index]! - series.ema48[index]!) / atr, atr / series.atr96[index]!);
  values.push((bar.ask.c - bar.bid.c) / atr, efficiency(bars, index, 12), efficiency(bars, index, 48), zScore(bars, index, 24));
  let range3 = 0, high12 = -Infinity, low12 = Infinity;
  for (let cursor = index - 11; cursor <= index; cursor += 1) {
    high12 = Math.max(high12, bars[cursor]!.mid.h); low12 = Math.min(low12, bars[cursor]!.mid.l);
    if (cursor >= index - 2) range3 += bars[cursor]!.mid.h - bars[cursor]!.mid.l;
  }
  values.push(bar.volume / series.volumeMean96[index]!, series.volumeMean24[index]! / series.volumeMean96[index]!, (range3 / 3) / atr, (high12 - low12) / atr, Math.abs(bar.mid.c - bars[index - 12]!.mid.c) / atr, efficiency(bars, index, 3));
  const date = new Date(Date.parse(bar.time) + 300_000), hourAngle = 2 * Math.PI * (date.getUTCHours() * 60 + date.getUTCMinutes()) / 1440, dayAngle = 2 * Math.PI * date.getUTCDay() / 7;
  values.push(Math.sin(hourAngle), Math.cos(hourAngle), Math.sin(dayAngle), Math.cos(dayAngle));
  if (values.length !== opportunityFeatureCount || values.some((value) => !Number.isFinite(value))) return null;
  return values;
}

function directionFeaturesAt(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number) {
  const values = baseFeaturesAt(bars, series, index);
  if (!values) return null;
  const atr = series.atr14[index]!, bar = bars[index]!;
  values.push(
    (bar.mid.c - bars[index - 24]!.mid.c) / atr,
    (bar.mid.c - bars[index - 48]!.mid.c) / atr,
    (bar.mid.c - bars[index - 144]!.mid.c) / atr,
    (series.ema48[index]! - series.ema144[index]!) / atr,
    (series.ema144[index]! - series.ema576[index]!) / atr,
    (bar.mid.c - series.ema144[index]!) / atr,
    (bar.mid.c - series.ema576[index]!) / atr,
    series.position48[index]!,
    series.position288[index]!,
    series.signedEfficiency144[index]!,
  );
  if (values.length !== directionFeatureCount || values.some((value) => !Number.isFinite(value))) return null;
  return values;
}

function eligibleIndices(bars: Bar[], series: ReturnType<typeof prepareSeries>, period: Period) {
  const result: number[] = [];
  for (let index = featureLookback; index < bars.length - horizonBars - 1; index += 1) {
    if (bars[index]!.time < period.from || bars[index]!.time >= period.to) continue;
    if (directionFeaturesAt(bars, series, index)) result.push(index);
  }
  return result;
}

class DeterministicRandom {
  private state = 0x6d2b79f5;
  next() { this.state ^= this.state << 13; this.state ^= this.state >>> 17; this.state ^= this.state << 5; return (this.state >>> 0) / 4_294_967_296; }
  normal() { const a = Math.max(this.next(), 1e-12), b = this.next(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); }
}

class Mlp {
  readonly w1: Float64Array; readonly b1: Float64Array; readonly w2: Float64Array; b2 = 0;
  private readonly mw1: Float64Array; private readonly vw1: Float64Array; private readonly mb1: Float64Array; private readonly vb1: Float64Array; private readonly mw2: Float64Array; private readonly vw2: Float64Array; private mb2 = 0; private vb2 = 0; private step = 0;
  constructor(private readonly featureCount: number, private readonly hiddenCount: number, random: DeterministicRandom) {
    this.w1 = new Float64Array(featureCount * hiddenCount); this.b1 = new Float64Array(hiddenCount); this.w2 = new Float64Array(hiddenCount);
    this.mw1 = new Float64Array(this.w1.length); this.vw1 = new Float64Array(this.w1.length); this.mb1 = new Float64Array(hiddenCount); this.vb1 = new Float64Array(hiddenCount); this.mw2 = new Float64Array(hiddenCount); this.vw2 = new Float64Array(hiddenCount);
    const scale = Math.sqrt(2 / featureCount); for (let i = 0; i < this.w1.length; i += 1) this.w1[i] = random.normal() * scale; for (let i = 0; i < hiddenCount; i += 1) this.w2[i] = random.normal() * Math.sqrt(1 / hiddenCount);
  }
  predict(x: ArrayLike<number>) { let output = this.b2; for (let hidden = 0; hidden < this.hiddenCount; hidden += 1) { let value = this.b1[hidden]!; for (let input = 0; input < this.featureCount; input += 1) value += this.w1[hidden * this.featureCount + input]! * x[input]!; output += this.w2[hidden]! * Math.tanh(value); } return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, output)))); }
  trainBatch(xs: ArrayLike<number>[], ys: number[], learningRate: number) {
    const gw1 = new Float64Array(this.w1.length), gb1 = new Float64Array(this.hiddenCount), gw2 = new Float64Array(this.hiddenCount); let gb2 = 0;
    for (let row = 0; row < xs.length; row += 1) {
      const x = xs[row]!, hiddenValues = new Float64Array(this.hiddenCount); let output = this.b2;
      for (let hidden = 0; hidden < this.hiddenCount; hidden += 1) { let value = this.b1[hidden]!; for (let input = 0; input < this.featureCount; input += 1) value += this.w1[hidden * this.featureCount + input]! * x[input]!; hiddenValues[hidden] = Math.tanh(value); output += this.w2[hidden]! * hiddenValues[hidden]!; }
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, output)))), deltaOutput = probability - ys[row]!; gb2 += deltaOutput;
      for (let hidden = 0; hidden < this.hiddenCount; hidden += 1) { gw2[hidden] += deltaOutput * hiddenValues[hidden]!; const deltaHidden = deltaOutput * this.w2[hidden]! * (1 - hiddenValues[hidden]! ** 2); gb1[hidden] += deltaHidden; for (let input = 0; input < this.featureCount; input += 1) gw1[hidden * this.featureCount + input] += deltaHidden * x[input]!; }
    }
    const scale = 1 / xs.length; this.step += 1;
    const update = (parameter: number, gradient: number, m: number, v: number) => { const nextM = 0.9 * m + 0.1 * gradient * scale, nextV = 0.999 * v + 0.001 * (gradient * scale) ** 2; const correctedM = nextM / (1 - 0.9 ** this.step), correctedV = nextV / (1 - 0.999 ** this.step); return { parameter: parameter - learningRate * correctedM / (Math.sqrt(correctedV) + 1e-8), m: nextM, v: nextV }; };
    for (let i = 0; i < this.w1.length; i += 1) { const next = update(this.w1[i]!, gw1[i]!, this.mw1[i]!, this.vw1[i]!); this.w1[i] = next.parameter; this.mw1[i] = next.m; this.vw1[i] = next.v; }
    for (let i = 0; i < this.hiddenCount; i += 1) { let next = update(this.b1[i]!, gb1[i]!, this.mb1[i]!, this.vb1[i]!); this.b1[i] = next.parameter; this.mb1[i] = next.m; this.vb1[i] = next.v; next = update(this.w2[i]!, gw2[i]!, this.mw2[i]!, this.vw2[i]!); this.w2[i] = next.parameter; this.mw2[i] = next.m; this.vw2[i] = next.v; }
    const next = update(this.b2, gb2, this.mb2, this.vb2); this.b2 = next.parameter; this.mb2 = next.m; this.vb2 = next.v;
  }
}

function marketDays(bars: Bar[], period: Period) { return new Set(bars.filter((bar) => bar.time >= period.from && bar.time < period.to).map((bar) => bar.time.slice(0, 10))).size; }
function pathResultAt(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number, direction: 1 | -1, riskAtr: number, maximumHorizonBars: number) {
  const entryIndex = index + 1, entryBar = bars[entryIndex]!, atr = series.atr14[index]!, risk = riskAtr * atr;
  const entry = direction === 1 ? entryBar.ask.o : entryBar.bid.o, stop = direction === 1 ? entry - risk : entry + risk, target = direction === 1 ? entry + 2 * risk : entry - 2 * risk;
  const finalIndex = Math.min(index + maximumHorizonBars, bars.length - 1);
  for (let cursor = entryIndex; cursor <= finalIndex; cursor += 1) {
    const bar = bars[cursor]!, targetHit = direction === 1 ? bar.bid.h >= target : bar.ask.l <= target, stopHit = direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
    if (targetHit && stopHit) return -0.75;
    if (targetHit) return 1.5;
    if (stopHit) return -0.75;
  }
  const exit = direction === 1 ? bars[finalIndex]!.bid.c : bars[finalIndex]!.ask.c;
  return 0.75 * (direction === 1 ? exit - entry : entry - exit) / risk;
}
function pathResult(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number, direction: 1 | -1) { return pathResultAt(bars, series, index, direction, 1.25, horizonBars); }
function betterDirectionLabel(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number) { return pathResult(bars, series, index, 1) > pathResult(bars, series, index, -1) ? 1 : 0; }
function targetHitLabel(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number, direction: 1 | -1) { return pathResult(bars, series, index, direction) === 1.5 ? 1 : 0; }
function opportunityLabel(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number) { return targetHitLabel(bars, series, index, 1) || targetHitLabel(bars, series, index, -1) ? 1 : 0; }
function conditionalDirectionLabel(bars: Bar[], series: ReturnType<typeof prepareSeries>, index: number) {
  const longTarget = targetHitLabel(bars, series, index, 1), shortTarget = targetHitLabel(bars, series, index, -1);
  return longTarget === shortTarget ? null : longTarget;
}

const bars = await fetchM5();
if (bars.length < 200_000) throw new Error(`Insufficient OANDA history: ${bars.length} candles.`);
const series = prepareSeries(bars), trainIndices = eligibleIndices(bars, series, periods.train2022_23), calibrationIndices = eligibleIndices(bars, series, periods.calibration2024), developmentIndices = eligibleIndices(bars, series, periods.development2025);
function normalization(featureCount: number, extractor: (index: number) => number[] | null) {
  const means = new Float64Array(featureCount), deviations = new Float64Array(featureCount);
  for (const index of trainIndices) { const values = extractor(index)!; for (let column = 0; column < featureCount; column += 1) means[column] += values[column]!; }
  for (let column = 0; column < featureCount; column += 1) means[column] /= trainIndices.length;
  for (const index of trainIndices) { const values = extractor(index)!; for (let column = 0; column < featureCount; column += 1) deviations[column] += (values[column]! - means[column]!) ** 2; }
  for (let column = 0; column < featureCount; column += 1) deviations[column] = Math.max(Math.sqrt(deviations[column]! / trainIndices.length), 1e-8);
  return (index: number) => Float64Array.from(extractor(index)!, (value, column) => Math.max(-8, Math.min(8, (value - means[column]!) / deviations[column]!)));
}
const opportunityNormalized = normalization(opportunityFeatureCount, (index) => baseFeaturesAt(bars, series, index));
const directionNormalized = normalization(directionFeatureCount, (index) => directionFeaturesAt(bars, series, index));

const random = new DeterministicRandom(), opportunityModel = new Mlp(opportunityFeatureCount, opportunityHiddenCount, random);
// Consume the exact V7 direction-initialization sequence so Stage 1 receives the same shuffle order as V7.
const v7CompatibilityDirectionModel = new Mlp(opportunityFeatureCount, opportunityHiddenCount, random);
void v7CompatibilityDirectionModel;
const directionModel = new Mlp(directionFeatureCount, directionHiddenCount, new DeterministicRandom()), order = [...trainIndices], batchSize = 256;
for (let epoch = 0; epoch < 4; epoch += 1) {
  for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random.next() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  for (let start = 0; start < order.length; start += batchSize) {
    const batch = order.slice(start, start + batchSize), inputs = batch.map(opportunityNormalized);
    opportunityModel.trainBatch(inputs, batch.map((index) => opportunityLabel(bars, series, index)), 0.002);
    const directionBatch = batch.map((index) => ({ index, label: conditionalDirectionLabel(bars, series, index) })).filter((row): row is { index: number; label: number } => row.label !== null);
    if (directionBatch.length) directionModel.trainBatch(directionBatch.map((row) => directionNormalized(row.index)), directionBatch.map((row) => row.label), 0.002);
  }
  console.error(`Completed neural epoch ${epoch + 1}/4`);
}

const opportunityProbabilities = new Float64Array(bars.length), longProbabilities = new Float64Array(bars.length), shortProbabilities = new Float64Array(bars.length); opportunityProbabilities.fill(Number.NaN); longProbabilities.fill(Number.NaN); shortProbabilities.fill(Number.NaN);
for (let index = featureLookback; index < bars.length - horizonBars - 1; index += 1) if (directionFeaturesAt(bars, series, index)) { const longProbability = directionModel.predict(directionNormalized(index)); opportunityProbabilities[index] = opportunityModel.predict(opportunityNormalized(index)); longProbabilities[index] = longProbability; shortProbabilities[index] = 1 - longProbability; }

type NewsEvent = { releaseTimeUtc: string; currency: "EUR" | "USD"; eventName: string; actual: string; forecast: string };
type NewsGroup = { time: string; direction: 1 | -1; surpriseStrength: number; events: NewsEvent[] };
type NewsTrade = { releaseTime: string; entryTime: string; direction: 1 | -1; opportunityProbability: number; surpriseStrength: number; resultR: number; outcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT"; spreadPips: number };

function parseNewsNumber(value: string) {
  const match = value.trim().replace(/,/g, "").match(/^(-?\d+(?:\.\d+)?)\s*([KMB%])?$/i);
  if (!match) return null;
  return { value: Number(match[1]), unit: (match[2] ?? "").toUpperCase() };
}

function newsDirection(event: NewsEvent): { direction: 1 | -1; magnitude: number } | null {
  const actual = parseNewsNumber(event.actual), forecast = parseNewsNumber(event.forecast);
  if (!actual || !forecast || actual.unit !== forecast.unit || actual.value === forecast.value) return null;
  const name = event.eventName;
  const laborInverse = /Unemployment (Rate|Claims)/.test(name);
  // Inflation/rates were unstable in the earlier chronological audit and remain excluded.
  if (/(CPI|PPI|PCE|Federal Funds Rate|Main Refinancing Rate)/.test(name)) return null;
  if (!laborInverse && !/(Employment Change|Hourly Earnings|GDP|PMI|Job Openings|Retail Sales|Employment Cost|Consumer Sentiment)/.test(name)) return null;
  const currencyGood = (actual.value > forecast.value ? 1 : -1) * (laborInverse ? -1 : 1);
  const direction = (currencyGood * (event.currency === "EUR" ? 1 : -1)) as 1 | -1;
  const magnitude = Math.abs(actual.value - forecast.value) / Math.max(Math.abs(forecast.value), 1);
  return { direction, magnitude };
}

function loadNewsGroups(relativeFile: string) {
  const payload = JSON.parse(readFileSync(path.join(root, relativeFile), "utf8")) as { events: NewsEvent[] };
  const byTime = new Map<string, Array<{ event: NewsEvent; direction: 1 | -1; magnitude: number }>>();
  for (const event of payload.events) {
    const signal = newsDirection(event);
    if (signal === null) continue;
    byTime.set(event.releaseTimeUtc, [...(byTime.get(event.releaseTimeUtc) ?? []), { event, ...signal }]);
  }
  const directional = [...byTime.entries()].flatMap(([time, signals]) => {
    const vote = signals.reduce((sum, signal) => sum + signal.direction, 0);
    return vote === 0 ? [] : [{ time, direction: (vote > 0 ? 1 : -1) as 1 | -1, surpriseStrength: signals.reduce((sum, signal) => sum + signal.magnitude, 0), events: signals.map((signal) => signal.event) }];
  }).sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const nonOverlapping: NewsGroup[] = [];
  for (const group of directional) {
    const prior = nonOverlapping.at(-1);
    if (!prior || Date.parse(group.time) >= Date.parse(prior.time) + 4 * 3_600_000) nonOverlapping.push(group);
  }
  return { calendarRows: payload.events.length, directionalGroups: directional.length, groups: nonOverlapping };
}

const barIndexByTime = new Map(bars.map((bar, index) => [Date.parse(bar.time), index]));
function resolveNewsTrade(group: NewsGroup): NewsTrade | null {
  const releaseIndex = barIndexByTime.get(Date.parse(group.time));
  if (releaseIndex === undefined || releaseIndex < featureLookback || releaseIndex + 3 >= bars.length) return null;
  const preReleaseIndex = releaseIndex - 1, decisionIndex = releaseIndex + 2, entryIndex = decisionIndex + 1;
  const preReleaseAtr = series.atr14[preReleaseIndex]!, opportunityProbability = opportunityProbabilities[decisionIndex]!;
  if (!Number.isFinite(preReleaseAtr) || !Number.isFinite(opportunityProbability) || preReleaseAtr * 10_000 > 5.53) return null;
  const preReleaseMid = bars[preReleaseIndex]!.mid.c, decisionMid = bars[decisionIndex]!.mid.c;
  const confirmed = group.direction === 1 ? decisionMid > preReleaseMid : decisionMid < preReleaseMid;
  if (!confirmed) return null;
  const entryBar = bars[entryIndex]!, entry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const risk = preReleaseAtr, stop = group.direction === 1 ? entry - risk : entry + risk, target = group.direction === 1 ? entry + 2 * risk : entry - 2 * risk;
  const deadline = Date.parse(entryBar.time) + 72 * 3_600_000;
  let resultR = 0, outcome: NewsTrade["outcome"] = "TIME_EXIT", exitIndex = entryIndex;
  for (let index = entryIndex; index < bars.length && Date.parse(bars[index]!.time) <= deadline; index += 1) {
    exitIndex = index;
    const bar = bars[index]!, targetHit = group.direction === 1 ? bar.bid.h >= target : bar.ask.l <= target, stopHit = group.direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
    if (targetHit && stopHit) { resultR = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
    if (targetHit) { resultR = 1.5; outcome = "TARGET"; break; }
    if (stopHit) { resultR = -0.75; outcome = "STOP"; break; }
  }
  if (outcome === "TIME_EXIT") {
    const exit = group.direction === 1 ? bars[exitIndex]!.bid.c : bars[exitIndex]!.ask.c;
    resultR = 0.75 * (group.direction === 1 ? exit - entry : entry - exit) / risk;
  }
  return { releaseTime: group.time, entryTime: entryBar.time, direction: group.direction, opportunityProbability, surpriseStrength: group.surpriseStrength, resultR, outcome, spreadPips: (entryBar.ask.o - entryBar.bid.o) * 10_000 };
}

function summarizeNews(trades: NewsTrade[]) {
  const wins = trades.filter((trade) => trade.resultR > 0).length, totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0), grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const trade of trades) { equity += trade.resultR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  const sortedSpreads = trades.map((trade) => trade.spreadPips).sort((a, b) => a - b);
  return { trades: trades.length, wins, winRate: trades.length ? wins / trades.length : null, totalR, expectancyR: trades.length ? totalR / trades.length : null, profitFactor: grossLoss ? grossProfit / grossLoss : null, maxDrawdownR, targetHits: trades.filter((trade) => trade.outcome === "TARGET").length, stops: trades.filter((trade) => trade.outcome === "STOP" || trade.outcome === "AMBIGUOUS_STOP").length, timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length, medianSpreadPips: sortedSpreads.length ? sortedSpreads[Math.floor(sortedSpreads.length / 2)]! : null };
}

const developmentNews = loadNewsGroups(path.join("research-v2", "eurusd-ff-high-impact-aug2024-jul2025", "events.json"));
const validationNews = loadNewsGroups(path.join("research-v2", "eurusd-ff-high-impact-aug2025-jul2026", "events.json"));
const developmentEligible = developmentNews.groups.map(resolveNewsTrade).filter((trade): trade is NewsTrade => trade !== null);
const validationEligible = validationNews.groups.map(resolveNewsTrade).filter((trade): trade is NewsTrade => trade !== null);
const developmentScores = developmentEligible.map((trade) => trade.surpriseStrength).sort((a, b) => b - a);
const fractions = [1, 0.75, 0.5, 0.33] as const;
const developmentFrontier = fractions.map((keptFraction) => {
  const thresholdIndex = Math.max(0, Math.min(developmentScores.length - 1, Math.ceil(developmentScores.length * keptFraction) - 1));
  const surpriseStrengthThreshold = developmentScores[thresholdIndex] ?? Number.POSITIVE_INFINITY;
  const trades = developmentEligible.filter((trade) => trade.surpriseStrength >= surpriseStrengthThreshold);
  return { keptFraction, surpriseStrengthThreshold: Number.isFinite(surpriseStrengthThreshold) ? surpriseStrengthThreshold : null, ...summarizeNews(trades) };
});
const selectedDevelopment = [...developmentFrontier].filter((row) => row.trades >= 20 && (row.winRate ?? 0) >= 0.4 && (row.expectancyR ?? -Infinity) > 0 && (row.profitFactor ?? 0) > 1).sort((left, right) => (right.expectancyR ?? -Infinity) - (left.expectancyR ?? -Infinity))[0] ?? null;
const validationTrades = selectedDevelopment ? validationEligible.filter((trade) => trade.surpriseStrength >= selectedDevelopment.surpriseStrengthThreshold!) : [];
const validationSummary = selectedDevelopment ? summarizeNews(validationTrades) : null;
const validationPassed = validationSummary !== null && validationSummary.trades >= 20 && (validationSummary.winRate ?? 0) >= 0.4 && (validationSummary.expectancyR ?? -Infinity) > 0 && (validationSummary.profitFactor ?? 0) > 1;
const newsReport = {
  generatedAt: new Date().toISOString(),
  verdict: selectedDevelopment === null ? "NO_DEVELOPMENT_WINNING_RATE_GATE_VALIDATION_SEALED" : validationPassed ? "VALIDATION_GATE_PASSED_SHADOW_ONLY" : "VALIDATION_GATE_FAILED",
  execution: { enabled: false, status: validationPassed ? "SHADOW_CANDIDATE_ONLY" : "DISABLED", reason: "research result never authorizes orders" },
  method: { opportunity: "V7 Stage-1 score retained only as a logged diagnostic after V10 showed it did not select 72-hour news winners", direction: "original non-inflation/rate ForexFactory majority-vote direction", surpriseStrength: "sum of absolute actual-minus-forecast differences normalized by max(abs(forecast), 1); used only as a filter, never to change direction", decision: "15 minutes after release after three completed M5 candles", entry: "next M5 open using executable ask for long and bid for short", confirmation: "15-minute EUR/USD move must agree with news direction", volatilityGate: "pre-release ATR14 <= 5.53 pips", stop: "1.0 pre-release ATR14", target: "2.0 stop distances", payoff: "+1.5R / -0.75R", maximumHold: "72 wall-clock hours", ambiguousBar: "charged as stop", thresholdSelection: "outcome-blind top 100/75/50/33 percent surprise-strength tiers; 2024-25 selects only if n>=20, win>=40%, expectancy>0, PF>1" },
  integrity: { storedTradesRead: false, priorResearchOutputsReadAtRuntime: false, targetPairExcludedFromDirection: true, development: "Aug 2024-Jul 2025", validation: "Aug 2025-Jul 2026; opened only after development gate", warning: "the baseline validation period has appeared in prior research, but this surprise-strength threshold was not previously evaluated" },
  data: { oandaM5Candles: bars.length, trainingExamples2022_23: trainIndices.length, developmentCalendarRows: developmentNews.calendarRows, developmentDirectionalGroups: developmentNews.directionalGroups, developmentNonOverlappingGroups: developmentNews.groups.length, developmentEligibleAfterCausalFilters: developmentEligible.length, validationCalendarRows: validationNews.calendarRows, validationDirectionalGroups: validationNews.directionalGroups, validationNonOverlappingGroups: validationNews.groups.length, validationEligibleAfterCausalFilters: validationEligible.length },
  results: { developmentFrontier, selectedDevelopment, validation: selectedDevelopment ? validationSummary : "SEALED", validationSample: selectedDevelopment ? validationTrades.slice(0, 12) : "SEALED" },
};
mkdirSync(outputDirectory, { recursive: true }); writeFileSync(path.join(outputDirectory, "RESULTS.json"), JSON.stringify(newsReport, null, 2)); console.log(JSON.stringify(newsReport, null, 2));
process.exit(0);

function confidenceScore(opportunityProbability: number, longProbability: number, shortProbability: number, mode: ScoreMode) {
  const selected = Math.max(longProbability, shortProbability), rejected = Math.min(longProbability, shortProbability);
  if (mode === "opportunityTimesDirectionConfidence") return opportunityProbability * selected;
  if (mode === "opportunityTimesDirectionMargin") return opportunityProbability * (selected - rejected);
  return opportunityProbability;
}

function chooseDirection(index: number, mode: DirectionMode): 1 | -1 | 0 {
  const neuralDirection = longProbabilities[index]! >= shortProbabilities[index]! ? 1 : -1;
  const fastTrendDirection = series.ema12[index]! >= series.ema48[index]! ? 1 : -1;
  const higherTrendDirection = series.ema144[index]! >= series.ema576[index]! ? 1 : -1;
  const higherMomentumDirection = bars[index]!.mid.c >= bars[index - 144]!.mid.c ? 1 : -1;
  if (mode === "emaTrend") return series.ema12[index]! >= series.ema48[index]! ? 1 : -1;
  if (mode === "higherTimeframeTrend") return higherTrendDirection;
  if (mode === "higherTimeframeMomentum") return higherMomentumDirection;
  if (mode === "multiTimeframeConsensus") {
    return fastTrendDirection === higherTrendDirection ? fastTrendDirection : higherTrendDirection;
  }
  if (mode === "neuralHtfAgreement") return neuralDirection === higherTrendDirection ? neuralDirection : 0;
  if (mode === "dualTrendAgreement") return fastTrendDirection === higherTrendDirection ? fastTrendDirection : 0;
  if (mode === "neuralTrendMomentumAgreement") return neuralDirection === higherTrendDirection && neuralDirection === higherMomentumDirection ? neuralDirection : 0;
  if (mode === "momentum12") return bars[index]!.mid.c >= bars[index - 12]!.mid.c ? 1 : -1;
  if (mode === "momentum3") return bars[index]!.mid.c >= bars[index - 3]!.mid.c ? 1 : -1;
  if (mode === "meanReversion24") return zScore(bars, index, 24) <= 0 ? 1 : -1;
  if (mode === "candleBody") return bars[index]!.mid.c >= bars[index]!.mid.o ? 1 : -1;
  return neuralDirection;
}

function replay(period: Period, threshold: number, scoreMode: ScoreMode, permittedEntryHours?: ReadonlySet<number>, directionMode: DirectionMode = "conditionalNeural") {
  const trades: NeuralTrade[] = [], dailyEntries = new Map<string, number>(); let activeExitTimes: number[] = [];
  for (let index = featureLookback; index < bars.length - horizonBars - 1; index += 1) {
    if (bars[index]!.time < period.from || bars[index]!.time >= period.to || !Number.isFinite(opportunityProbabilities[index]) || !Number.isFinite(longProbabilities[index]) || !Number.isFinite(shortProbabilities[index])) continue;
    const opportunityProbability = opportunityProbabilities[index]!, longProbability = longProbabilities[index]!, shortProbability = shortProbabilities[index]!, qualityScore = confidenceScore(opportunityProbability, longProbability, shortProbability, scoreMode);
    if (qualityScore < threshold) continue;
    const entryIndex = index + 1, entryBar = bars[entryIndex]!, atr = series.atr14[index]!, direction = chooseDirection(index, directionMode);
    if (direction === 0) continue;
    if (permittedEntryHours) {
      const entryDate = new Date(entryBar.time);
      if (entryDate.getUTCMinutes() !== 0 || !permittedEntryHours.has(entryDate.getUTCHours())) continue;
    }
    const entryDay = entryBar.time.slice(0, 10);
    if ((dailyEntries.get(entryDay) ?? 0) >= dailyEntryCap) continue;
    activeExitTimes = activeExitTimes.filter((time) => time > Date.parse(entryBar.time));
    if (activeExitTimes.length >= 2) continue;
    const spread = entryBar.ask.o - entryBar.bid.o;
    if (spread > 0.5 * atr) continue;
    const entry = direction === 1 ? entryBar.ask.o : entryBar.bid.o, risk = 1.25 * atr, stop = direction === 1 ? entry - risk : entry + risk, target = direction === 1 ? entry + 2 * risk : entry - 2 * risk;
    let resultR = 0, outcome: NeuralTrade["outcome"] = "TIME_EXIT", exitIndex = entryIndex;
    for (let cursor = entryIndex; cursor <= Math.min(index + horizonBars, bars.length - 1); cursor += 1) {
      exitIndex = cursor; const bar = bars[cursor]!; const targetHit = direction === 1 ? bar.bid.h >= target : bar.ask.l <= target, stopHit = direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
      if (targetHit && stopHit) { resultR = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
      if (targetHit) { resultR = 1.5; outcome = "TARGET"; break; }
      if (stopHit) { resultR = -0.75; outcome = "STOP"; break; }
    }
    if (outcome === "TIME_EXIT") { const exit = direction === 1 ? bars[exitIndex]!.bid.c : bars[exitIndex]!.ask.c; resultR = 0.75 * (direction === 1 ? exit - entry : entry - exit) / risk; }
    const longPathR = pathResult(bars, series, index, 1), shortPathR = pathResult(bars, series, index, -1);
    trades.push({ entryTime: entryBar.time, exitTime: bars[exitIndex]!.time, direction, probabilityUp: qualityScore, selectedBetterPath: direction === (longPathR > shortPathR ? 1 : -1), targetPathExisted: longPathR === 1.5 || shortPathR === 1.5, outcome, resultR, spreadPips: spread * 10_000 });
    dailyEntries.set(entryDay, (dailyEntries.get(entryDay) ?? 0) + 1);
    activeExitTimes.push(Date.parse(bars[exitIndex]!.time));
  }
  return trades;
}

function summarize(trades: NeuralTrade[], days: number) {
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0), wins = trades.filter((trade) => trade.resultR > 0).length, grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0), grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0; for (const trade of trades) { equity += trade.resultR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return { trades: trades.length, marketDays: days, tradesPerMarketDay: days ? trades.length / days : null, wins, winRate: trades.length ? wins / trades.length : null, opportunityPrecision: trades.length ? trades.filter((trade) => trade.targetPathExisted).length / trades.length : null, betterPathAccuracy: trades.length ? trades.filter((trade) => trade.selectedBetterPath).length / trades.length : null, totalR, expectancyR: trades.length ? totalR / trades.length : null, profitFactor: grossLoss ? grossProfit / grossLoss : null, maxDrawdownR, targetHits: trades.filter((trade) => trade.outcome === "TARGET").length, stops: trades.filter((trade) => trade.outcome === "STOP" || trade.outcome === "AMBIGUOUS_STOP").length, timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length };
}

const trainDays = marketDays(bars, periods.train2022_23), calibrationDays = marketDays(bars, periods.calibration2024), developmentDays = marketDays(bars, periods.development2025);
function thresholdForFrequency(period: Period, days: number, desiredFrequency: number, scoreMode: ScoreMode, permittedEntryHours: ReadonlySet<number> | undefined, directionMode: DirectionMode) {
  let low = 0, high = 1;
  // Frequency is the only value consulted. Outcomes never influence the threshold.
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const candidate = (low + high) / 2;
    const frequency = replay(period, candidate, scoreMode, permittedEntryHours, directionMode).length / days;
    if (frequency > desiredFrequency) low = candidate; else high = candidate;
  }
  return (low + high) / 2;
}
const trainingHourComparison: unknown[] = [];
const selectedUtcEntryHours: number[] = [];
const permittedEntryHours: ReadonlySet<number> | undefined = undefined;
const scoreModes: ScoreMode[] = ["opportunityOnly"];
const directionModes: DirectionMode[] = ["conditionalNeural", "emaTrend", "higherTimeframeTrend", "higherTimeframeMomentum", "multiTimeframeConsensus", "neuralHtfAgreement", "dualTrendAgreement", "neuralTrendMomentumAgreement", "momentum12", "momentum3", "meanReversion24", "candleBody"];
const calibrationFrontier = scoreModes.flatMap((scoreMode) => [3, 2.5, 2, 1.5, 1, 0.5, 0.25].flatMap((desiredFrequency) => {
  return directionModes.map((directionMode) => {
    const candidateThreshold = thresholdForFrequency(periods.calibration2024, calibrationDays, desiredFrequency, scoreMode, permittedEntryHours, directionMode);
    return { scoreMode, directionMode, targetTradesPerDay: desiredFrequency, confidenceThreshold: candidateThreshold, ...summarize(replay(periods.calibration2024, candidateThreshold, scoreMode, permittedEntryHours, directionMode), calibrationDays) };
  });
}));
const qualifiedCalibrationRows = calibrationFrontier.filter((row) => row.trades >= 600 && (row.tradesPerMarketDay ?? 0) >= 2 && (row.tradesPerMarketDay ?? 0) <= 3 && (row.opportunityPrecision ?? 0) >= 0.4 && (row.winRate ?? 0) >= 0.4 && (row.expectancyR ?? -Infinity) > 0 && (row.profitFactor ?? 0) > 1);
const selectedCalibrationRow = [...qualifiedCalibrationRows].sort((left, right) => (right.expectancyR ?? -Infinity) - (left.expectancyR ?? -Infinity))[0] ?? null;
const selectedScoreMode: ScoreMode = selectedCalibrationRow?.scoreMode ?? "opportunityOnly";
const selectedDirectionMode: DirectionMode = selectedCalibrationRow?.directionMode ?? "conditionalNeural";
const threshold = selectedCalibrationRow?.confidenceThreshold ?? Number.POSITIVE_INFINITY;
const frequencyThreshold = selectedCalibrationRow?.confidenceThreshold ?? null;
const trainTrades = replay(periods.train2022_23, threshold, selectedScoreMode, permittedEntryHours, selectedDirectionMode), calibrationTrades = replay(periods.calibration2024, threshold, selectedScoreMode, permittedEntryHours, selectedDirectionMode), developmentTrades = replay(periods.development2025, threshold, selectedScoreMode, permittedEntryHours, selectedDirectionMode);
const trainSummary = summarize(trainTrades, trainDays), calibrationSummary = summarize(calibrationTrades, calibrationDays), developmentSummary = summarize(developmentTrades, developmentDays);
const frequencyFrontier = selectedCalibrationRow ? [3, 2.5, 2, 1, 0.5].map((desiredFrequency) => {
  const candidateThreshold = thresholdForFrequency(periods.development2025, developmentDays, desiredFrequency, selectedScoreMode, permittedEntryHours, selectedDirectionMode);
  return { targetTradesPerDay: desiredFrequency, confidenceThreshold: candidateThreshold, directionMode: selectedDirectionMode, ...summarize(replay(periods.development2025, candidateThreshold, selectedScoreMode, permittedEntryHours, selectedDirectionMode), developmentDays) };
}) : [];
function failureAudit(period: Period, riskAtr: number, maximumHorizonBars: number, minimumScore = 0) {
  const rows: Array<{ score: number; selectedR: number; oppositeR: number; longR: number; shortR: number }> = [];
  for (let index = featureLookback; index < bars.length - maximumHorizonBars - 1; index += 1) {
    if (bars[index]!.time < period.from || bars[index]!.time >= period.to || !Number.isFinite(opportunityProbabilities[index]) || !Number.isFinite(longProbabilities[index]) || !Number.isFinite(shortProbabilities[index])) continue;
    const entryBar = bars[index + 1]!, entryDate = new Date(entryBar.time);
    if (permittedEntryHours && (entryDate.getUTCMinutes() !== 0 || !permittedEntryHours.has(entryDate.getUTCHours()))) continue;
    if (entryBar.ask.o - entryBar.bid.o > 0.5 * series.atr14[index]!) continue;
    const score = confidenceScore(opportunityProbabilities[index]!, longProbabilities[index]!, shortProbabilities[index]!, selectedScoreMode);
    if (score < minimumScore) continue;
    const longR = pathResultAt(bars, series, index, 1, riskAtr, maximumHorizonBars), shortR = pathResultAt(bars, series, index, -1, riskAtr, maximumHorizonBars);
    const selectedDirection = chooseDirection(index, selectedDirectionMode);
    if (selectedDirection === 0) continue;
    const chooseLong = selectedDirection === 1;
    rows.push({ score, selectedR: chooseLong ? longR : shortR, oppositeR: chooseLong ? shortR : longR, longR, shortR });
  }
  const total = rows.length, sum = (values: number[]) => values.reduce((accumulator, value) => accumulator + value, 0);
  const sorted = [...rows].sort((left, right) => right.score - left.score);
  const confidenceQuintiles = Array.from({ length: 5 }, (_, bucket) => {
    const slice = sorted.slice(Math.floor(bucket * sorted.length / 5), Math.floor((bucket + 1) * sorted.length / 5));
    return { bucket: bucket + 1, quality: bucket === 0 ? "highest" : bucket === 4 ? "lowest" : "middle", trades: slice.length, averageScore: slice.length ? sum(slice.map((row) => row.score)) / slice.length : null, targetRate: slice.length ? slice.filter((row) => row.selectedR === 1.5).length / slice.length : null, winRate: slice.length ? slice.filter((row) => row.selectedR > 0).length / slice.length : null, expectancyR: slice.length ? sum(slice.map((row) => row.selectedR)) / slice.length : null };
  });
  return {
    riskAtr, maximumHoldMinutes: maximumHorizonBars * 5, candidates: total,
    selectedTargetRate: total ? rows.filter((row) => row.selectedR === 1.5).length / total : null,
    selectedWinRate: total ? rows.filter((row) => row.selectedR > 0).length / total : null,
    selectedExpectancyR: total ? sum(rows.map((row) => row.selectedR)) / total : null,
    inverseExpectancyR: total ? sum(rows.map((row) => row.oppositeR)) / total : null,
    oracleExpectancyR: total ? sum(rows.map((row) => Math.max(row.longR, row.shortR))) / total : null,
    eitherDirectionCanHitTarget: total ? rows.filter((row) => row.longR === 1.5 || row.shortR === 1.5).length / total : null,
    neitherDirectionCanHitTarget: total ? rows.filter((row) => row.longR !== 1.5 && row.shortR !== 1.5).length / total : null,
    bothDirectionsLose: total ? rows.filter((row) => row.longR <= 0 && row.shortR <= 0).length / total : null,
    wrongSideWhenOppositeHitsTarget: total ? rows.filter((row) => row.selectedR !== 1.5 && row.oppositeR === 1.5).length / total : null,
    confidenceQuintiles,
  };
}
const geometryCandidates = [
  { riskAtr: 0.75, horizonBars: 12 }, { riskAtr: 1, horizonBars: 12 }, { riskAtr: 1.25, horizonBars: 12 },
  { riskAtr: 0.75, horizonBars: 24 }, { riskAtr: 1, horizonBars: 24 }, { riskAtr: 1.25, horizonBars: 24 },
  { riskAtr: 0.75, horizonBars: 48 }, { riskAtr: 1, horizonBars: 48 }, { riskAtr: 1.25, horizonBars: 48 },
];
const diagnosticCalibrationRow = calibrationFrontier.find((row) => row.scoreMode === selectedScoreMode && row.directionMode === selectedDirectionMode && row.targetTradesPerDay === 2.5) ?? calibrationFrontier[0]!;
const auditThreshold = Number.isFinite(threshold) ? threshold : diagnosticCalibrationRow.confidenceThreshold;
const failureAudit2025 = selectedCalibrationRow ? failureAudit(periods.development2025, 1.25, horizonBars, auditThreshold) : "SEALED_BECAUSE_2024_FAILED";
const opportunityBaseline = { calibration2024: failureAudit(periods.calibration2024, 1.25, horizonBars, 0), development2025: "SEALED_FOR_V9_CONSENSUS_RULES" };
const geometryAudit = geometryCandidates.map(({ riskAtr, horizonBars: candidateHorizon }) => ({
  training2022_23: failureAudit(periods.train2022_23, riskAtr, candidateHorizon, auditThreshold),
  calibration2024: failureAudit(periods.calibration2024, riskAtr, candidateHorizon, auditThreshold),
  development2025: selectedCalibrationRow ? failureAudit(periods.development2025, riskAtr, candidateHorizon, auditThreshold) : "SEALED_BECAUSE_2024_FAILED",
}));
const developmentFrequency = developmentSummary.tradesPerMarketDay ?? 0;
const developmentPassed = selectedCalibrationRow !== null && developmentSummary.trades >= 600 && developmentFrequency >= 2 && developmentFrequency <= 3 && (developmentSummary.opportunityPrecision ?? 0) >= 0.4 && (developmentSummary.winRate ?? 0) >= 0.4 && (developmentSummary.expectancyR ?? -1) > 0 && (developmentSummary.profitFactor ?? 0) > 1 && (developmentSummary.betterPathAccuracy ?? 0) > 0.505;
const finalTrades = developmentPassed ? replay(periods.finalHoldout2026, threshold, selectedScoreMode, permittedEntryHours, selectedDirectionMode) : [];
const report = {
  generatedAt: new Date().toISOString(), verdict: selectedCalibrationRow === null ? "NO_2024_EXECUTABLE_DIRECTION_EDGE_TRADING_DISABLED_FINAL_HOLDOUT_SEALED" : !developmentPassed ? "FAILED_2025_DEVELOPMENT_GATE_FINAL_HOLDOUT_SEALED" : "REACHED_FINAL_HOLDOUT",
  independence: { uses: "fresh raw OANDA Practice EUR_USD M5 bid/ask only", refuses: ["stored trades", "existing strategy code", "existing models", "news data", "previous research outputs"] },
  neuralNetwork: { version: "v9-direction-abstention", architecture: `frozen V7 ${opportunityFeatureCount}->${opportunityHiddenCount}->1 opportunity classifier plus one conditional ${directionFeatureCount}->${directionHiddenCount}->1 direction classifier`, optimizer: "Adam", epochs: 4, batchSize, learningRate: 0.002, deterministicSeed: "0x6d2b79f5", labels: { opportunity: "either executable long or short reaches +1.5R before -0.75R within 60 minutes", direction: "trained only where exactly one side reaches the target; predicts whether that target side is long" }, selectedScoreMode: selectedCalibrationRow?.scoreMode ?? null, selectedDirectionMode: selectedCalibrationRow?.directionMode ?? null, selection: "frozen V7 opportunity score plus nine forced and three abstaining causal direction mechanisms calibrated only on 2024 after training on 2022-2023", features: { opportunity: ["V7 normalized returns 1/2/3/6/12 bars", "candle body/range/wicks", "EMA12 and EMA48 displacement", "ATR14/ATR96", "spread/ATR", "12/48-bar efficiency", "24-bar z-score", "tick-volume expansion", "3-bar range expansion", "12-bar compression width", "cyclic UTC time and weekday"], directionAdditions: ["normalized returns 24/48/144 bars", "EMA48/144/576 trend displacement", "signed 144-bar efficiency", "48/288-bar range position"], abstention: ["neural plus higher-timeframe trend agreement", "fast plus higher-timeframe trend agreement", "neural plus higher-timeframe trend plus 12-hour momentum agreement"] } },
  execution: { enabled: selectedCalibrationRow !== null, disabledReason: selectedCalibrationRow === null ? "no 2024 tier at 2-3 trades/day achieved >=40% target-path precision, >=40% wins, positive expectancy, and PF >1 with at least 600 trades" : null, signalFrequency: "evaluated after every completed M5 candle; Stage 1 predicts target-path opportunity, Stage 2 selects direction, otherwise WAIT", selectedUtcEntryHours, entry: "next M5 open, executable bid/ask", confidenceThreshold: Number.isFinite(threshold) ? threshold : null, frequencyThreshold, thresholdSelection: "2024-only calibration frontier; highest-expectancy qualifying 2-3 trades/day tier locked before 2025", targetTradesPerMarketDay: targetTradesPerDay, maximumEntriesPerUtcDay: dailyEntryCap, maximumConcurrentTrades: 2, stop: "1.25 ATR14", target: "2.5 ATR14", payoff: "+1.5 / -0.75", maximumHold: "60 minutes", ambiguousBar: "charged as stop" },
  data: { source: "OANDA Practice", candles: bars.length, from: fetchStart, toExclusive: fetchEnd, trainExamples2022_23: trainIndices.length, calibrationExamples2024: calibrationIndices.length, developmentExamples2025: developmentIndices.length },
  gates: { development2025: "n>=600, 2-3 trades/day, win rate>=40%, expectancy>0, PF>1, better-path accuracy>50.5%", finalHoldoutOpenedOnlyAfterDevelopmentPasses: true },
  diagnostics: { opportunityBaseline, failureAudit2025, geometryAudit },
  results: { trainingHourComparison2022_23: trainingHourComparison, train2022_23: trainSummary, calibrationFrontier2024: calibrationFrontier, selectedCalibration2024: selectedCalibrationRow, calibration2024: calibrationSummary, development2025: selectedCalibrationRow ? developmentSummary : "SEALED_BECAUSE_2024_FAILED", diagnosticFrequencyFrontier2025: selectedCalibrationRow ? frequencyFrontier : "SEALED_BECAUSE_2024_FAILED", finalHoldout2026: developmentPassed ? summarize(finalTrades, marketDays(bars, periods.finalHoldout2026)) : "SEALED" },
};
mkdirSync(outputDirectory, { recursive: true }); writeFileSync(path.join(outputDirectory, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
