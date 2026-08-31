/**
 * Completely independent EUR/USD research engine.
 *
 * Inputs: fresh OANDA Practice M5 bid/ask candles only.
 * Explicitly does not read stored trades, existing strategy signals/models,
 * news files, confidence scores, or prior research outputs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; bid: Side; ask: Side; mid: Side };
type Mode = "continuation" | "rejection";
type Direction = 1 | -1;
type Candidate = { name: string; trendEfficiency: number; rejectionZ: number; stopAtr: number };
type BreakoutCandidate = { name: string; maximumRangeAtr: number; bufferAtr: number; stopAtr: number };
type Trade = { entryTime: string; exitTime: string; mode: Mode; direction: Direction; outcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT"; resultR: number; spreadPips: number; stopPips: number };

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("Independent research refuses OANDA live.");

const fetchStart = "2021-12-20T00:00:00.000Z";
const fetchEnd = "2026-08-01T00:00:00.000Z";
const trainStart = "2022-01-01T00:00:00.000Z";
const developmentStart = "2024-01-01T00:00:00.000Z";
const validationStart = "2025-01-01T00:00:00.000Z";
const finalHoldoutStart = "2026-01-01T00:00:00.000Z";
const outputDirectory = path.join(serviceRoot, "research-v2", "eurusd-independent-engine-v1");

async function fetchM5() {
  const collected = new Map<string, Bar>();
  let cursor = fetchStart;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA M5 request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const pageBars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar): Bar => {
      const bid = { o: Number(bar.bid.o), h: Number(bar.bid.h), l: Number(bar.bid.l), c: Number(bar.bid.c) };
      const ask = { o: Number(bar.ask.o), h: Number(bar.ask.h), l: Number(bar.ask.l), c: Number(bar.ask.c) };
      return { time: bar.time, bid, ask, mid: { o: (bid.o + ask.o) / 2, h: (bid.h + ask.h) / 2, l: (bid.l + ask.l) / 2, c: (bid.c + ask.c) / 2 } };
    });
    for (const bar of pageBars) if (bar.time < fetchEnd) collected.set(bar.time, bar);
    if ((page + 1) % 10 === 0) console.error(`Fetched ${collected.size.toLocaleString()} M5 candles`);
    const last = pageBars.at(-1);
    if (!last || pageBars.length < 5000 || last.time >= fetchEnd) break;
    cursor = new Date(Date.parse(last.time) + 300_000).toISOString();
  }
  return [...collected.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function buildFeatures(bars: Bar[]) {
  const ema12 = new Array<number>(bars.length);
  const ema48 = new Array<number>(bars.length);
  const tr = new Array<number>(bars.length);
  const atr14 = new Array<number>(bars.length).fill(Number.NaN);
  const atr96 = new Array<number>(bars.length).fill(Number.NaN);
  const k12 = 2 / 13, k48 = 2 / 49;
  let sum14 = 0, sum96 = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index]!.mid.c;
    ema12[index] = index ? close * k12 + ema12[index - 1]! * (1 - k12) : close;
    ema48[index] = index ? close * k48 + ema48[index - 1]! * (1 - k48) : close;
    const previousClose = index ? bars[index - 1]!.mid.c : close;
    tr[index] = Math.max(bars[index]!.mid.h - bars[index]!.mid.l, Math.abs(bars[index]!.mid.h - previousClose), Math.abs(bars[index]!.mid.l - previousClose));
    sum14 += tr[index]!; if (index >= 14) sum14 -= tr[index - 14]!; if (index >= 13) atr14[index] = sum14 / 14;
    sum96 += tr[index]!; if (index >= 96) sum96 -= tr[index - 96]!; if (index >= 95) atr96[index] = sum96 / 96;
  }
  return { ema12, ema48, atr14, atr96 };
}

function efficiencyRatio(bars: Bar[], index: number, lookback = 24) {
  const displacement = Math.abs(bars[index]!.mid.c - bars[index - lookback]!.mid.c);
  let travel = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) travel += Math.abs(bars[cursor]!.mid.c - bars[cursor - 1]!.mid.c);
  return travel > 0 ? displacement / travel : 0;
}

function zScore(bars: Bar[], index: number, lookback = 48) {
  let sum = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) sum += bars[cursor]!.mid.c;
  const mean = sum / lookback;
  let squared = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) squared += (bars[cursor]!.mid.c - mean) ** 2;
  const deviation = Math.sqrt(squared / lookback);
  return deviation > 0 ? (bars[index]!.mid.c - mean) / deviation : 0;
}

function signalAt(bars: Bar[], features: ReturnType<typeof buildFeatures>, index: number, candidate: Candidate): { mode: Mode; direction: Direction } | null {
  if (index < 100 || !Number.isFinite(features.atr14[index]) || !Number.isFinite(features.atr96[index])) return null;
  const closeTime = new Date(Date.parse(bars[index]!.time) + 300_000);
  const hour = closeTime.getUTCHours(), minute = closeTime.getUTCMinutes();
  if (minute % 15 !== 0 || hour < 6 || hour >= 20) return null;
  const atr = features.atr14[index]!;
  const volatilityRatio = atr / features.atr96[index]!;
  if (volatilityRatio < 0.6 || volatilityRatio > 1.2) return null;
  const efficiency = efficiencyRatio(bars, index);
  const currentReturn = bars[index]!.mid.c - bars[index - 1]!.mid.c;
  const previousReturn = bars[index - 1]!.mid.c - bars[index - 2]!.mid.c;
  const trendDirection = features.ema12[index]! > features.ema48[index]! ? 1 : -1;
  if (efficiency >= candidate.trendEfficiency && Math.abs(features.ema12[index]! - features.ema48[index]!) >= 0.25 * atr && trendDirection * previousReturn < 0 && trendDirection * currentReturn > 0) {
    return { mode: "continuation", direction: trendDirection as Direction };
  }
  const z = zScore(bars, index);
  if (efficiency <= 0.25 && Math.abs(z) >= candidate.rejectionZ) {
    const rejectionDirection = z > 0 ? -1 : 1;
    if (rejectionDirection * currentReturn > 0) return { mode: "rejection", direction: rejectionDirection as Direction };
  }
  return null;
}

function replay(bars: Bar[], features: ReturnType<typeof buildFeatures>, candidate: Candidate, from: string, to: string) {
  const trades: Trade[] = [];
  for (let index = 100; index < bars.length - 1; index += 1) {
    if (bars[index]!.time < from || bars[index]!.time >= to) continue;
    const signal = signalAt(bars, features, index, candidate);
    if (!signal) continue;
    const entryIndex = index + 1;
    const entryBar = bars[entryIndex]!;
    const atr = features.atr14[index]!;
    const entry = signal.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
    const spread = entryBar.ask.o - entryBar.bid.o;
    if (spread > 0.25 * atr) continue;
    const risk = candidate.stopAtr * atr;
    const stop = signal.direction === 1 ? entry - risk : entry + risk;
    const target = signal.direction === 1 ? entry + 2 * risk : entry - 2 * risk;
    let resultR = 0, outcome: Trade["outcome"] = "TIME_EXIT", exitIndex = entryIndex;
    for (let cursor = entryIndex; cursor <= Math.min(entryIndex + 23, bars.length - 1); cursor += 1) {
      exitIndex = cursor;
      const bar = bars[cursor]!;
      const targetHit = signal.direction === 1 ? bar.bid.h >= target : bar.ask.l <= target;
      const stopHit = signal.direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
      if (targetHit && stopHit) { resultR = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
      if (targetHit) { resultR = 1.5; outcome = "TARGET"; break; }
      if (stopHit) { resultR = -0.75; outcome = "STOP"; break; }
    }
    if (outcome === "TIME_EXIT") {
      const exit = signal.direction === 1 ? bars[exitIndex]!.bid.c : bars[exitIndex]!.ask.c;
      resultR = 0.75 * (signal.direction === 1 ? exit - entry : entry - exit) / risk;
    }
    trades.push({ entryTime: entryBar.time, exitTime: bars[exitIndex]!.time, mode: signal.mode, direction: signal.direction, outcome, resultR, spreadPips: spread * 10_000, stopPips: risk * 10_000 });
    index = exitIndex; // exactly one open trade; overlapping opportunities are skipped
  }
  return trades;
}

function replayPriceDiscovery(bars: Bar[], features: ReturnType<typeof buildFeatures>, candidate: BreakoutCandidate, from: string, to: string) {
  const trades: Trade[] = [];
  for (let index = 100; index < bars.length - 30; index += 1) {
    if (bars[index]!.time < from || bars[index]!.time >= to) continue;
    const closeTime = new Date(Date.parse(bars[index]!.time) + 300_000);
    const hour = closeTime.getUTCHours(), minute = closeTime.getUTCMinutes();
    if (minute % 30 !== 0 || hour < 6 || hour >= 20) continue;
    const atr = features.atr14[index]!;
    if (!Number.isFinite(atr) || !Number.isFinite(features.atr96[index])) continue;
    const volatilityRatio = atr / features.atr96[index]!;
    if (volatilityRatio < 0.6 || volatilityRatio > 1.4) continue;
    const rangeBars = bars.slice(index - 5, index + 1);
    const midpointHigh = Math.max(...rangeBars.map((bar) => bar.mid.h));
    const midpointLow = Math.min(...rangeBars.map((bar) => bar.mid.l));
    const rangeAtr = (midpointHigh - midpointLow) / atr;
    if (rangeAtr < 0.5 || rangeAtr > candidate.maximumRangeAtr) continue;
    const buyStop = Math.max(...rangeBars.map((bar) => bar.ask.h)) + candidate.bufferAtr * atr;
    const sellStop = Math.min(...rangeBars.map((bar) => bar.bid.l)) - candidate.bufferAtr * atr;
    let triggerIndex: number | null = null, direction: Direction | null = null;
    for (let cursor = index + 1; cursor <= index + 6; cursor += 1) {
      const buyConfirmed = bars[cursor]!.ask.c >= buyStop;
      const sellConfirmed = bars[cursor]!.bid.c <= sellStop;
      if (buyConfirmed) { triggerIndex = cursor; direction = 1; break; }
      if (sellConfirmed) { triggerIndex = cursor; direction = -1; break; }
    }
    if (triggerIndex === null || direction === null) continue;
    const entryIndex = triggerIndex + 1;
    const entry = direction === 1 ? bars[entryIndex]!.ask.o : bars[entryIndex]!.bid.o;
    const risk = candidate.stopAtr * atr;
    const stop = direction === 1 ? entry - risk : entry + risk;
    const target = direction === 1 ? entry + 2 * risk : entry - 2 * risk;
    let resultR = 0, outcome: Trade["outcome"] = "TIME_EXIT", exitIndex = entryIndex;
    for (let cursor = entryIndex; cursor <= Math.min(entryIndex + 23, bars.length - 1); cursor += 1) {
      exitIndex = cursor;
      const bar = bars[cursor]!;
      const targetHit = direction === 1 ? bar.bid.h >= target : bar.ask.l <= target;
      const stopHit = direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
      if (targetHit && stopHit) { resultR = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
      if (targetHit) { resultR = 1.5; outcome = "TARGET"; break; }
      if (stopHit) { resultR = -0.75; outcome = "STOP"; break; }
    }
    if (outcome === "TIME_EXIT") {
      const exit = direction === 1 ? bars[exitIndex]!.bid.c : bars[exitIndex]!.ask.c;
      resultR = 0.75 * (direction === 1 ? exit - entry : entry - exit) / risk;
    }
    const spread = bars[entryIndex]!.ask.o - bars[entryIndex]!.bid.o;
    trades.push({ entryTime: bars[entryIndex]!.time, exitTime: bars[exitIndex]!.time, mode: "continuation", direction, outcome, resultR, spreadPips: spread * 10_000, stopPips: risk * 10_000 });
    index = exitIndex;
  }
  return trades;
}

function marketDays(bars: Bar[], from: string, to: string) {
  return new Set(bars.filter((bar) => bar.time >= from && bar.time < to).map((bar) => bar.time.slice(0, 10))).size;
}

function summary(trades: Trade[], days: number) {
  const wins = trades.filter((trade) => trade.resultR > 0).length;
  const grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const trade of trades) { equity += trade.resultR; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const values = [...trades.map((trade) => trade.spreadPips)].sort((a, b) => a - b);
  const byMode = (mode: Mode) => { const rows = trades.filter((trade) => trade.mode === mode); return { trades: rows.length, totalR: rows.reduce((sum, trade) => sum + trade.resultR, 0), expectancyR: rows.length ? rows.reduce((sum, trade) => sum + trade.resultR, 0) / rows.length : null }; };
  return {
    trades: trades.length,
    tradesPerMarketDay: days ? trades.length / days : null,
    wins,
    winRate: trades.length ? wins / trades.length : null,
    totalR,
    expectancyR: trades.length ? totalR / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownR: maxDrawdown,
    targetHits: trades.filter((trade) => trade.outcome === "TARGET").length,
    stops: trades.filter((trade) => trade.outcome === "STOP" || trade.outcome === "AMBIGUOUS_STOP").length,
    timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length,
    medianSpreadPips: values.length ? values[Math.floor(values.length / 2)] : null,
    byMode: { continuation: byMode("continuation"), rejection: byMode("rejection") },
  };
}

const bars = await fetchM5();
if (bars.length < 200_000) throw new Error(`Insufficient independent OANDA history: ${bars.length} M5 candles.`);
const features = buildFeatures(bars);
const candidates: Candidate[] = [0.3, 0.4].flatMap((trendEfficiency) => [1.25, 1.75].flatMap((rejectionZ) => [1, 1.25].map((stopAtr) => ({
  name: `er${trendEfficiency}_z${rejectionZ}_stop${stopAtr}`,
  trendEfficiency,
  rejectionZ,
  stopAtr,
}))));
const breakoutCandidates: BreakoutCandidate[] = [1.5, 2].flatMap((maximumRangeAtr) => [0.05, 0.15].flatMap((bufferAtr) => [1, 1.25].map((stopAtr) => ({
  name: `range${maximumRangeAtr}_buffer${bufferAtr}_stop${stopAtr}`,
  maximumRangeAtr,
  bufferAtr,
  stopAtr,
}))));
const periods = {
  train2022_23: { from: trainStart, to: developmentStart },
  development2024: { from: developmentStart, to: validationStart },
  validation2025: { from: validationStart, to: finalHoldoutStart },
  finalHoldout2026: { from: finalHoldoutStart, to: fetchEnd },
};
const dayCounts = Object.fromEntries(Object.entries(periods).map(([name, period]) => [name, marketDays(bars, period.from, period.to)]));
const discovery = candidates.map((candidate) => {
  const train = replay(bars, features, candidate, periods.train2022_23.from, periods.train2022_23.to);
  const development = replay(bars, features, candidate, periods.development2024.from, periods.development2024.to);
  return { candidate, train, development, trainSummary: summary(train, dayCounts.train2022_23), developmentSummary: summary(development, dayCounts.development2024) };
});
const qualified = discovery.filter((row) => row.trainSummary.trades >= 500 && row.developmentSummary.trades >= 200 && (row.trainSummary.expectancyR ?? -1) > 0 && (row.developmentSummary.expectancyR ?? -1) > 0.02);
const selected = [...qualified].sort((a, b) => (b.developmentSummary.expectancyR ?? -Infinity) - (a.developmentSummary.expectancyR ?? -Infinity))[0] ?? null;
const validation = selected ? replay(bars, features, selected.candidate, periods.validation2025.from, periods.validation2025.to) : [];
const validationSummary = selected ? summary(validation, dayCounts.validation2025) : null;
const validationPassed = Boolean(validationSummary && validationSummary.trades >= 200 && (validationSummary.expectancyR ?? -1) > 0 && (validationSummary.profitFactor ?? 0) > 1);
const finalHoldout = selected && validationPassed ? replay(bars, features, selected.candidate, periods.finalHoldout2026.from, periods.finalHoldout2026.to) : [];
const breakoutDiscovery = breakoutCandidates.map((candidate) => {
  const train = replayPriceDiscovery(bars, features, candidate, periods.train2022_23.from, periods.train2022_23.to);
  const development = replayPriceDiscovery(bars, features, candidate, periods.development2024.from, periods.development2024.to);
  return { candidate, train, development, trainSummary: summary(train, dayCounts.train2022_23), developmentSummary: summary(development, dayCounts.development2024) };
});
const breakoutQualified = breakoutDiscovery.filter((row) => row.trainSummary.trades >= 500 && row.developmentSummary.trades >= 200 && (row.trainSummary.expectancyR ?? -1) > 0 && (row.developmentSummary.expectancyR ?? -1) > 0.02);
const breakoutSelected = [...breakoutQualified].sort((a, b) => (b.developmentSummary.expectancyR ?? -Infinity) - (a.developmentSummary.expectancyR ?? -Infinity))[0] ?? null;
const breakoutValidation = breakoutSelected ? replayPriceDiscovery(bars, features, breakoutSelected.candidate, periods.validation2025.from, periods.validation2025.to) : [];
const breakoutValidationSummary = breakoutSelected ? summary(breakoutValidation, dayCounts.validation2025) : null;
const breakoutValidationPassed = Boolean(breakoutValidationSummary && breakoutValidationSummary.trades >= 200 && (breakoutValidationSummary.expectancyR ?? -1) > 0 && (breakoutValidationSummary.profitFactor ?? 0) > 1);
const breakoutFinalHoldout = breakoutSelected && breakoutValidationPassed ? replayPriceDiscovery(bars, features, breakoutSelected.candidate, periods.finalHoldout2026.from, periods.finalHoldout2026.to) : [];
const report = {
  generatedAt: new Date().toISOString(),
  verdict: !selected && !breakoutSelected ? "NO_CANDIDATE_QUALIFIED_DEVELOPMENT" : (selected && !validationPassed) || (breakoutSelected && !breakoutValidationPassed) ? "SELECTED_CANDIDATE_FAILED_VALIDATION" : "CANDIDATE_REACHED_FINAL_HOLDOUT",
  independence: {
    uses: "fresh raw OANDA Practice EUR_USD M5 bid/ask candles only",
    refuses: ["stored trades", "existing engine signals", "existing strategy modules", "confidence models", "news/calendar data", "prior research results"],
  },
  engine: {
    opportunityClock: "Every completed 15-minute mark from 06:00 through 19:59 UTC, evaluated from M5 candles",
    continuation: "EMA12/EMA48 direction plus 24-bar efficiency and one-bar pullback/resumption",
    rejection: "48-bar close z-score extreme in a low-efficiency regime plus a rejection candle",
    volatility: "ATR14/ATR96 must be between 0.6 and 1.2; entry spread must be <=25% of ATR14",
    entry: "next M5 open using executable ask for long and bid for short",
    execution: "one open trade; stop = candidate ATR multiple; target = 2x stop; maximum 24 M5 bars; ambiguous bar charged as stop",
    payoffScale: "+1.5 target / -0.75 stop",
  },
  data: { source: "OANDA Practice", instrument: "EUR_USD", granularity: "M5", from: fetchStart, toExclusive: fetchEnd, candles: bars.length, marketDays: dayCounts },
  selection: { candidateCount: candidates.length, trainGate: "n>=500 and expectancy>0", developmentGate: "n>=200 and expectancy>0.02R", validationGate: "n>=200, expectancy>0, PF>1", finalHoldoutOpenedOnlyAfterValidation: true },
  discovery: discovery.map((row) => ({ candidate: row.candidate, train2022_23: row.trainSummary, development2024: row.developmentSummary, qualified: qualified.includes(row) })),
  selected: selected ? { candidate: selected.candidate, train2022_23: selected.trainSummary, development2024: selected.developmentSummary, validation2025: validationSummary, finalHoldout2026: validationPassed ? summary(finalHoldout, dayCounts.finalHoldout2026) : "SEALED" } : null,
  priceDiscoveryBreakout: {
    mechanism: "At each completed 30-minute mark, bracket the completed six-bar executable range. The first completed M5 close beyond either side within 30 minutes determines direction; entry is the following M5 open.",
    candidateCount: breakoutCandidates.length,
    discovery: breakoutDiscovery.map((row) => ({ candidate: row.candidate, train2022_23: row.trainSummary, development2024: row.developmentSummary, qualified: breakoutQualified.includes(row) })),
    selected: breakoutSelected ? { candidate: breakoutSelected.candidate, train2022_23: breakoutSelected.trainSummary, development2024: breakoutSelected.developmentSummary, validation2025: breakoutValidationSummary, finalHoldout2026: breakoutValidationPassed ? summary(breakoutFinalHoldout, dayCounts.finalHoldout2026) : "SEALED" } : null,
  },
};
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
