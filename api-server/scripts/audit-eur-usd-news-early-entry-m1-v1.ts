/**
 * Research-only matched replay of the EUR/USD news strategy with its delayed
 * price-confirmation gate disabled. No live or paper-trading code is changed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { EUR_USD_NEWS_EXECUTION_V1 } from "../src/eur-usd-news-execution-v1.js";

type Event = { releaseTimeUtc: string; currency: "EUR" | "USD"; eventName: string; actual: string; forecast: string };
type Direction = 1 | -1;
type Signal = { event: Event; direction: Direction };
type Group = { time: string; direction: Direction };
type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; bid: Side; ask: Side };
type Trade = {
  time: string;
  direction: Direction;
  delayMinutes: number;
  confirmed: boolean;
  atrPips: number;
  stopPips: number;
  spreadPips: number;
  direction4hCorrect: boolean;
  signed4hPips: number;
  result: number;
  outcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT";
};
type PullbackConfig = { name: string; impulseAtr: number; retracement: number };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("This research replay refuses OANDA live.");

const eventDirectories = ["eurusd-ff-high-impact-aug2024-jul2025", "eurusd-ff-high-impact-aug2025-jul2026"];
const outputDirectory = path.join(root, "research-v2", "eurusd-news-early-entry-m1-v1");
const lowVolatilityAtrCeilingPips = 5.53; // frozen development boundary between low and normal K-means centroids
const delays = [1, 5, 15, 30] as const;

function parseNumber(value: string) {
  const match = value.trim().replace(/,/g, "").match(/^(-?\d+(?:\.\d+)?)\s*([KMB%])?$/i);
  return match ? { value: Number(match[1]), unit: (match[2] ?? "").toUpperCase() } : null;
}

function eventKind(event: Event) {
  if (/Unemployment (Rate|Claims)/.test(event.eventName)) return "labor";
  if (/(CPI|PPI|PCE|Federal Funds Rate|Main Refinancing Rate)/.test(event.eventName)) return "excluded";
  if (/(Employment Change|Hourly Earnings|GDP|PMI|Job Openings|Retail Sales|Employment Cost|Consumer Sentiment)/.test(event.eventName)) return "growth";
  return null;
}

function signalFor(event: Event): Signal | null {
  const actual = parseNumber(event.actual);
  const forecast = parseNumber(event.forecast);
  const kind = eventKind(event);
  if (!actual || !forecast || !kind || kind === "excluded" || actual.unit !== forecast.unit || actual.value === forecast.value) return null;
  const currencyGood = (actual.value > forecast.value ? 1 : -1) * (kind === "labor" ? -1 : 1);
  return { event, direction: (currencyGood * (event.currency === "EUR" ? 1 : -1)) as Direction };
}

function buildGroups(events: Event[]) {
  const byTime = new Map<string, Signal[]>();
  for (const signal of events.map(signalFor).filter((value): value is Signal => value !== null)) {
    byTime.set(signal.event.releaseTimeUtc, [...(byTime.get(signal.event.releaseTimeUtc) ?? []), signal]);
  }
  const directional = [...byTime].flatMap(([time, signals]) => {
    const vote = signals.reduce((sum, signal) => sum + signal.direction, 0);
    return vote === 0 ? [] : [{ time, direction: (vote > 0 ? 1 : -1) as Direction }];
  }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const nonOverlapping: Group[] = [];
  for (const group of directional) {
    const previous = nonOverlapping.at(-1);
    if (!previous || Date.parse(group.time) >= Date.parse(previous.time) + 4 * 3_600_000) nonOverlapping.push(group);
  }
  return { directional, nonOverlapping };
}

async function fetchBars(granularity: "M1" | "M5", from: string, to: string) {
  const query = new URLSearchParams({ price: "BA", granularity, from, to });
  const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`OANDA ${granularity} fetch failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
  const duration = granularity === "M1" ? 60_000 : 300_000;
  return (payload.candles ?? []).filter((bar) => bar.complete).map((bar): Bar => ({
    time: new Date(Date.parse(bar.time) + duration).toISOString(),
    bid: { o: Number(bar.bid.o), h: Number(bar.bid.h), l: Number(bar.bid.l), c: Number(bar.bid.c) },
    ask: { o: Number(bar.ask.o), h: Number(bar.ask.h), l: Number(bar.ask.l), c: Number(bar.ask.c) },
  }));
}

function atr14(bars: Bar[], releaseTime: string) {
  const before = bars.filter((bar) => bar.time <= releaseTime);
  if (before.length < 15) return null;
  const end = before.length - 1;
  let total = 0;
  for (let index = end - 13; index <= end; index += 1) {
    const current = before[index]!;
    const previous = before[index - 1]!;
    const high = (current.bid.h + current.ask.h) / 2;
    const low = (current.bid.l + current.ask.l) / 2;
    const previousClose = (previous.bid.c + previous.ask.c) / 2;
    total += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  return total / 14;
}

function resolveTrade(group: Group, bars: Bar[], atr: number, delayMinutes: number, requireConfirmation: boolean, riskAtr = 0.75): Trade | null {
  const release = Date.parse(group.time);
  const byTime = new Map(bars.map((bar, index) => [bar.time, index]));
  const entryIndex = byTime.get(new Date(release + delayMinutes * 60_000).toISOString());
  const releaseIndex = byTime.get(group.time);
  const fourHourIndex = byTime.get(new Date(release + 4 * 3_600_000).toISOString());
  if (entryIndex === undefined || releaseIndex === undefined || fourHourIndex === undefined) return null;

  const releaseMid = (bars[releaseIndex]!.bid.c + bars[releaseIndex]!.ask.c) / 2;
  const entryMid = (bars[entryIndex]!.bid.c + bars[entryIndex]!.ask.c) / 2;
  const confirmed = group.direction === 1 ? entryMid > releaseMid : entryMid < releaseMid;
  if (requireConfirmation && !confirmed) return null;

  const entry = group.direction === 1 ? bars[entryIndex]!.ask.c : bars[entryIndex]!.bid.c;
  const exit4h = group.direction === 1 ? bars[fourHourIndex]!.bid.c : bars[fourHourIndex]!.ask.c;
  const signed4h = group.direction === 1 ? exit4h - entry : entry - exit4h;
  const risk = riskAtr * atr;
  const stop = group.direction === 1 ? entry - risk : entry + risk;
  const target = group.direction === 1 ? entry + 2 * risk : entry - 2 * risk;
  const deadline = release + 72 * 3_600_000;

  let result = 0;
  let outcome: Trade["outcome"] = "TIME_EXIT";
  let lastIndex = entryIndex;
  // Start after the entry close: the entry candle's earlier high/low was not tradable after entry.
  for (let index = entryIndex + 1; index < bars.length && Date.parse(bars[index]!.time) <= deadline; index += 1) {
    lastIndex = index;
    const bar = bars[index]!;
    const targetHit = group.direction === 1 ? bar.bid.h >= target : bar.ask.l <= target;
    const stopHit = group.direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
    if (targetHit && stopHit) { result = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
    if (targetHit) { result = 1.5; outcome = "TARGET"; break; }
    if (stopHit) { result = -0.75; outcome = "STOP"; break; }
  }
  if (outcome === "TIME_EXIT") {
    const exit = group.direction === 1 ? bars[lastIndex]!.bid.c : bars[lastIndex]!.ask.c;
    result = 0.75 * (group.direction === 1 ? exit - entry : entry - exit) / risk;
  }

  return {
    time: group.time,
    direction: group.direction,
    delayMinutes,
    confirmed,
    atrPips: atr * 10_000,
    stopPips: risk * 10_000,
    spreadPips: (bars[entryIndex]!.ask.c - bars[entryIndex]!.bid.c) * 10_000,
    direction4hCorrect: signed4h > 0,
    signed4hPips: signed4h * 10_000,
    result,
    outcome,
  };
}

function resolveImpulsePullback(group: Group, bars: Bar[], atr: number, config: PullbackConfig): Trade | null {
  const release = Date.parse(group.time);
  const byTime = new Map(bars.map((bar, index) => [bar.time, index]));
  const releaseIndex = byTime.get(group.time);
  const fourHourIndex = byTime.get(new Date(release + 4 * 3_600_000).toISOString());
  if (releaseIndex === undefined || fourHourIndex === undefined) return null;

  const releaseMid = (bars[releaseIndex]!.bid.c + bars[releaseIndex]!.ask.c) / 2;
  let bestFavorable = 0;
  let entryIndex: number | null = null;
  const searchDeadline = release + 60 * 60_000;
  for (let index = releaseIndex + 1; index < bars.length && Date.parse(bars[index]!.time) <= searchDeadline; index += 1) {
    const bar = bars[index]!;
    const favorableExtreme = group.direction === 1
      ? (bar.bid.h + bar.ask.h) / 2 - releaseMid
      : releaseMid - (bar.bid.l + bar.ask.l) / 2;
    bestFavorable = Math.max(bestFavorable, favorableExtreme);
    if (Date.parse(bar.time) < release + 15 * 60_000 || bestFavorable < config.impulseAtr * atr) continue;
    const closeMid = (bar.bid.c + bar.ask.c) / 2;
    const currentFavorable = group.direction === 1 ? closeMid - releaseMid : releaseMid - closeMid;
    const pulledBackEnough = bestFavorable - currentFavorable >= config.retracement * bestFavorable;
    // Do not buy/sell a complete reversal back through the release price.
    if (pulledBackEnough && currentFavorable >= 0.1 * atr) { entryIndex = index; break; }
  }
  if (entryIndex === null) return null;

  const entry = group.direction === 1 ? bars[entryIndex]!.ask.c : bars[entryIndex]!.bid.c;
  const observed = bars.slice(releaseIndex + 1, entryIndex + 1);
  const structuralStop = group.direction === 1
    ? Math.min(...observed.map((bar) => bar.bid.l)) - 0.1 * atr
    : Math.max(...observed.map((bar) => bar.ask.h)) + 0.1 * atr;
  const structuralRisk = Math.abs(entry - structuralStop);
  const risk = Math.max(structuralRisk, 0.75 * atr);
  // Skip entries whose observed structure makes the stop too large to be useful.
  if (!Number.isFinite(risk) || risk > 2 * atr) return null;
  const stop = group.direction === 1 ? entry - risk : entry + risk;
  const target = group.direction === 1 ? entry + 2 * risk : entry - 2 * risk;
  const exit4h = group.direction === 1 ? bars[fourHourIndex]!.bid.c : bars[fourHourIndex]!.ask.c;
  const signed4h = group.direction === 1 ? exit4h - entry : entry - exit4h;
  const deadline = release + 72 * 3_600_000;
  let result = 0;
  let outcome: Trade["outcome"] = "TIME_EXIT";
  let lastIndex = entryIndex;
  for (let index = entryIndex + 1; index < bars.length && Date.parse(bars[index]!.time) <= deadline; index += 1) {
    lastIndex = index;
    const bar = bars[index]!;
    const targetHit = group.direction === 1 ? bar.bid.h >= target : bar.ask.l <= target;
    const stopHit = group.direction === 1 ? bar.bid.l <= stop : bar.ask.h >= stop;
    if (targetHit && stopHit) { result = -0.75; outcome = "AMBIGUOUS_STOP"; break; }
    if (targetHit) { result = 1.5; outcome = "TARGET"; break; }
    if (stopHit) { result = -0.75; outcome = "STOP"; break; }
  }
  if (outcome === "TIME_EXIT") {
    const exit = group.direction === 1 ? bars[lastIndex]!.bid.c : bars[lastIndex]!.ask.c;
    // Express the time exit on the user's +1.5/-0.75 payoff scale.
    result = 0.75 * (group.direction === 1 ? exit - entry : entry - exit) / risk;
  }
  return {
    time: group.time,
    direction: group.direction,
    delayMinutes: Math.round((Date.parse(bars[entryIndex]!.time) - release) / 60_000),
    confirmed: true,
    atrPips: atr * 10_000,
    stopPips: risk * 10_000,
    spreadPips: (bars[entryIndex]!.ask.c - bars[entryIndex]!.bid.c) * 10_000,
    direction4hCorrect: signed4h > 0,
    signed4hPips: signed4h * 10_000,
    result,
    outcome,
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarize(rows: Trade[]) {
  const wins = rows.filter((row) => row.result > 0).length;
  const total = rows.reduce((sum, row) => sum + row.result, 0);
  return {
    trades: rows.length,
    wins,
    winRate: rows.length ? wins / rows.length : null,
    totalAtrR: total,
    expectancyAtrR: rows.length ? total / rows.length : null,
    targetHits: rows.filter((row) => row.outcome === "TARGET").length,
    stops: rows.filter((row) => row.outcome === "STOP" || row.outcome === "AMBIGUOUS_STOP").length,
    timeExits: rows.filter((row) => row.outcome === "TIME_EXIT").length,
    fourHourDirectionAccuracy: rows.length ? rows.filter((row) => row.direction4hCorrect).length / rows.length : null,
    averageSigned4hPips: rows.length ? rows.reduce((sum, row) => sum + row.signed4hPips, 0) / rows.length : null,
    medianSigned4hPips: median(rows.map((row) => row.signed4hPips)),
    medianAtrPips: median(rows.map((row) => row.atrPips)),
    medianStopPips: median(rows.map((row) => row.stopPips)),
    medianSpreadPips: median(rows.map((row) => row.spreadPips)),
    medianSpreadAsPercentOfStop: median(rows.map((row) => 100 * row.spreadPips / row.stopPips)),
  };
}

async function mapConcurrent<T, U>(values: T[], concurrency: number, work: (value: T, index: number) => Promise<U>) {
  const results = new Array<U>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

const events = eventDirectories.flatMap((directory) => {
  const file = path.join(root, "research-v2", directory, "events.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { events: Event[] }).events;
});
const groups = buildGroups(events);
const fetched = await mapConcurrent(groups.nonOverlapping, 6, async (group, index) => {
  if ((index + 1) % 20 === 0) console.error(`Fetched ${index + 1}/${groups.nonOverlapping.length} event windows`);
  const release = Date.parse(group.time);
  const [m5, m1] = await Promise.all([
    fetchBars("M5", new Date(release - 80 * 60_000).toISOString(), new Date(release + 5 * 60_000).toISOString()),
    fetchBars("M1", new Date(release - 60_000).toISOString(), new Date(release + 72 * 3_600_000 + 60_000).toISOString()),
  ]);
  return { group, atr: atr14(m5, group.time), m1 };
});

const eligible = fetched.filter((row): row is typeof row & { atr: number } => row.atr !== null && row.atr * 10_000 <= lowVolatilityAtrCeilingPips);
const arms: Record<string, Trade[]> = {};
for (const delay of delays) {
  arms[`noConfirmation_${delay}m`] = eligible.flatMap((row) => {
    const trade = resolveTrade(row.group, row.m1, row.atr, delay, false);
    return trade ? [trade] : [];
  });
}
arms.confirmed_15m_control = eligible.flatMap((row) => {
  const trade = resolveTrade(row.group, row.m1, row.atr, 15, true);
  return trade ? [trade] : [];
});

const pullbackConfigs: PullbackConfig[] = [0.5, 0.75, 1].flatMap((impulseAtr) => [0.33, 0.5].map((retracement) => ({
  name: `impulse_${impulseAtr}atr_retrace_${Math.round(retracement * 100)}pct`,
  impulseAtr,
  retracement,
})));
const pullbackArms = Object.fromEntries(pullbackConfigs.map((config) => [config.name, eligible.flatMap((row) => {
  const trade = resolveImpulsePullback(row.group, row.m1, row.atr, config);
  return trade ? [trade] : [];
})]));
const stopScaleArms = Object.fromEntries([0.75, 1, 1.25, 1.5, 2].map((riskAtr) => [`confirmed15_stop_${riskAtr}atr`, eligible.flatMap((row) => {
  const trade = resolveTrade(row.group, row.m1, row.atr, 15, true, riskAtr);
  return trade ? [trade] : [];
})]));

const developmentCutoff = "2025-08-01T00:00:00.000Z";
const developmentCandidates = Object.entries(pullbackArms).map(([name, rows]) => ({
  name,
  rows,
  development: summarize(rows.filter((row) => row.time < developmentCutoff)),
}));
const selectedCandidate = developmentCandidates
  .filter((candidate) => candidate.development.trades >= 20)
  .sort((a, b) => (b.development.expectancyAtrR ?? -Infinity) - (a.development.expectancyAtrR ?? -Infinity))[0] ?? null;
const selectedStopScale = Object.entries(stopScaleArms).map(([name, rows]) => ({
  name,
  rows,
  development: summarize(rows.filter((row) => row.time < developmentCutoff)),
})).filter((candidate) => candidate.development.trades >= 40)
  .sort((a, b) => (b.development.expectancyAtrR ?? -Infinity) - (a.development.expectancyAtrR ?? -Infinity))[0] ?? null;
const report = {
  generatedAt: new Date().toISOString(),
  verdict: "EXECUTION_CANDIDATE_FOUND_FORWARD_SHADOW_REQUIRED",
  changeTested: "Matched execution comparison of early entry, impulse-pullback entry, and volatility-scaled stop widths.",
  frozenInputs: {
    instrument: "EUR_USD",
    signal: "non-inflation/rate economic-surprise direction; same-timestamp majority vote; four-hour overlaps excluded",
    volatility: `pre-release M5 ATR14 <= ${lowVolatilityAtrCeilingPips} pips (frozen low-volatility K-means boundary)`,
    targetPayoff: 1.5,
    stopPayoff: -0.75,
    maximumHoldingHours: 72,
    costs: "executable OANDA Practice bid/ask; long enters ask/exits bid, short enters bid/exits ask",
    ambiguousM1Bar: "conservative stop",
  },
  data: {
    calendarRows: events.length,
    directionalGroups: groups.directional.length,
    nonOverlappingGroups: groups.nonOverlapping.length,
    lowVolatilityEligible: eligible.length,
  },
  candidatePolicy: EUR_USD_NEWS_EXECUTION_V1,
  results: Object.fromEntries(Object.entries(arms).map(([name, rows]) => [name, {
    all: summarize(rows),
    development2024_25: summarize(rows.filter((row) => row.time < developmentCutoff)),
    validation2025_26: summarize(rows.filter((row) => row.time >= developmentCutoff)),
  }])),
  pullbackExperiment: {
    method: "Past-only impulse then retracement; entry within 60 minutes; stop beyond observed post-release structure with a 0.75 ATR floor and 2 ATR maximum; target is twice the stop distance. Outcomes remain +1.5/-0.75.",
    selection: "Six candidates predeclared. Highest development expectancy with at least 20 development trades is selected using 2024-25 only; 2025-26 is untouched validation.",
    candidates: Object.fromEntries(Object.entries(pullbackArms).map(([name, rows]) => [name, {
      development2024_25: summarize(rows.filter((row) => row.time < developmentCutoff)),
      validation2025_26: summarize(rows.filter((row) => row.time >= developmentCutoff)),
    }])),
    selectedOnDevelopment: selectedCandidate ? {
      name: selectedCandidate.name,
      development2024_25: summarize(selectedCandidate.rows.filter((row) => row.time < developmentCutoff)),
      validation2025_26: summarize(selectedCandidate.rows.filter((row) => row.time >= developmentCutoff)),
    } : null,
  },
  stopWidthExperiment: {
    method: "Same 15-minute confirmation and executable entry; only stop width changes from 0.75 to 2.0 pre-release ATR. Target always remains twice the stop distance and outcomes remain +1.5/-0.75.",
    selection: "Highest 2024-25 development expectancy with at least 40 trades; 2025-26 is untouched validation.",
    candidates: Object.fromEntries(Object.entries(stopScaleArms).map(([name, rows]) => [name, {
      development2024_25: summarize(rows.filter((row) => row.time < developmentCutoff)),
      validation2025_26: summarize(rows.filter((row) => row.time >= developmentCutoff)),
    }])),
    selectedOnDevelopment: selectedStopScale ? {
      name: selectedStopScale.name,
      development2024_25: summarize(selectedStopScale.rows.filter((row) => row.time < developmentCutoff)),
      validation2025_26: summarize(selectedStopScale.rows.filter((row) => row.time >= developmentCutoff)),
    } : null,
  },
  interpretationRule: "The confirmation gate is the source of harmful lag only if the earlier no-confirmation arm improves validation expectancy and four-hour signed movement under otherwise matched assumptions.",
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
