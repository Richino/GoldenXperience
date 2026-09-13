import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { PAIR_STRATEGY_REGISTRY, evaluateEnabledPairStrategies } from "../../frontend/src/lib/strategy/strategies/index.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { StrategyEvaluationInput, StrategyId } from "../../frontend/src/lib/strategy/types.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";

type CalendarEvent = { currency: string; importance: number; date: string };
type Candidate = { pair: string; family: string; signalTime: string; entryTime: string; direction: "long" | "short"; entry: number; stop: number; target: number; spreadPips: number; riskPips: number; score: number; explanation: string };
type Trade = Candidate & { exitTime: string; exit: number; outcome: "WIN" | "LOSS" | "TIME_EXIT"; r: number };
type PairData = { h1: ResearchCandle[]; m30: ResearchCandle[]; m15: ResearchCandle[] };

const start = "2026-07-01T00:00:00.000Z";
const signalEnd = "2026-09-01T00:00:00.000Z";
const fetchEnd = "2026-09-01T04:00:00.000Z";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "pair-strategy-router-v1");
const calendarPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "pre-news-prediction-v1", "data", "calendar_raw.json");
const pairs = Object.keys(PAIR_STRATEGY_REGISTRY) as MajorInstrument[];
const time = (value: string) => Date.parse(value);
const asCandle = (item: ResearchCandle): Candle => ({ time: item.time, open: item.mid.open, high: item.mid.high, low: item.mid.low, close: item.mid.close, volume: item.volume, complete: item.complete });
const quote = (value: number, pair: string) => Number(value.toFixed(pair.includes("JPY") || pair.includes("HUF") ? 3 : 5));

async function candles(pair: MajorInstrument, granularity: string, earliest: string) {
  const values = new Map<string, ResearchCandle>(); let cursor = fetchEnd;
  while (true) {
    const batch = (await getResearchCandles(pair, granularity, 5_000, { to: cursor })).filter((item) => item.complete);
    if (!batch.length) break;
    for (const item of batch) values.set(item.time, item);
    const oldest = batch.reduce((minimum, item) => time(item.time) < time(minimum) ? item.time : minimum, batch[0]!.time);
    if (time(oldest) <= time(earliest) || oldest === cursor) break;
    cursor = oldest;
  }
  return [...values.values()].sort((left, right) => time(left.time) - time(right.time));
}

async function loadPair(pair: MajorInstrument): Promise<[string, PairData]> {
  const warmup = "2026-06-01T00:00:00.000Z";
  const [h1, m15, m30] = await Promise.all([candles(pair, "H1", warmup), candles(pair, "M15", start), pair === "GBP_USD" ? candles(pair, "M30", warmup) : Promise.resolve([])]);
  return [pair, { h1, m15, m30 }];
}

function newsBlocked(events: CalendarEvent[], pair: string, at: string) {
  const currencies = new Set(pair.split("_")); const atMs = time(at);
  return events.some((event) => currencies.has(event.currency) && event.importance >= 1 && Math.abs(time(event.date) - atMs) <= 30 * 60_000);
}

function makeCandidate(pair: MajorInstrument, signal: ResearchCandle, next: ResearchCandle, history: PairData, events: CalendarEvent[]): Candidate | null {
  const useM30 = pair === "GBP_USD";
  const signalHistory = (useM30 ? history.m30 : history.h1).filter((item) => time(item.time) <= time(signal.time)).map(asCandle);
  const input: StrategyEvaluationInput = { instrument: pair, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda", candles15m: [], candles30m: useM30 ? signalHistory : [], candles1h: useM30 ? history.h1.filter((item) => time(item.time) <= time(signal.time)).map(asCandle) : signalHistory, candles4h: [], bid: next.bid.open, ask: next.ask.open, spreadPips: (next.ask.open - next.bid.open) / pipSizeFor(pair), marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null, newsRequired: true, evaluationMode: "historical_replay", evaluatedAt: next.time };
  const evaluated = evaluateEnabledPairStrategies(input)[0] as StrategyCandidate<StrategyId> | undefined;
  if (!evaluated || evaluated.status !== "valid" || !evaluated.direction || evaluated.entry === null || evaluated.stop === null || evaluated.target === null) return null;
  if (newsBlocked(events, pair, next.time)) return null;
  const risk = Math.abs(evaluated.entry - evaluated.stop); const spread = next.ask.open - next.bid.open;
  if (!(risk > 0) || spread / risk > 0.1) return null;
  const direction = evaluated.direction as "long" | "short";
  const score = Number(((evaluated.riskReward ?? 0) * 100 - (spread / risk) * 100).toFixed(4));
  return { pair, family: evaluated.family, signalTime: signal.time, entryTime: next.time, direction, entry: quote(evaluated.entry, pair), stop: quote(evaluated.stop, pair), target: quote(evaluated.target, pair), spreadPips: Number((spread / pipSizeFor(pair)).toFixed(2)), riskPips: Number((risk / pipSizeFor(pair)).toFixed(2)), score, explanation: `Explain only; do not change this paper candidate. ${pair.replace("_", "/")} was selected by ${evaluated.family}; ${direction.toUpperCase()} entry ${quote(evaluated.entry, pair)}, stop ${quote(evaluated.stop, pair)}, target ${quote(evaluated.target, pair)}; code score ${score}.` };
}

function resolve(candidate: Candidate, candles15m: ResearchCandle[]): Omit<Trade, keyof Candidate> | null {
  const deadline = time(candidate.entryTime) + 3 * 60 * 60_000;
  // OANDA timestamps candle opening time. Only use an M15 candle if its close
  // is inside the three-hour holding horizon.
  const path = candles15m.filter((item) => time(item.time) >= time(candidate.entryTime) && time(item.time) + 15 * 60_000 <= deadline);
  for (const item of path) {
    const closeTime = new Date(time(item.time) + 15 * 60_000).toISOString();
    const stopped = candidate.direction === "long" ? item.bid.low <= candidate.stop : item.ask.high >= candidate.stop;
    const targeted = candidate.direction === "long" ? item.bid.high >= candidate.target : item.ask.low <= candidate.target;
    // M15 cannot establish intrabar order. The conservative outcome is a loss.
    if (stopped || (stopped && targeted)) return { exitTime: closeTime, exit: candidate.stop, outcome: "LOSS", r: -1 };
    if (targeted) return { exitTime: closeTime, exit: candidate.target, outcome: "WIN", r: 2 };
  }
  const last = path.at(-1); if (!last) return null;
  const exit = candidate.direction === "long" ? last.bid.close : last.ask.close;
  const r = (candidate.direction === "long" ? exit - candidate.entry : candidate.entry - exit) / Math.abs(candidate.entry - candidate.stop);
  return { exitTime: new Date(time(last.time) + 15 * 60_000).toISOString(), exit: quote(exit, candidate.pair), outcome: "TIME_EXIT", r: Number(r.toFixed(4)) };
}

async function run() {
  const events = JSON.parse(await readFile(calendarPath, "utf8")) as CalendarEvent[];
  const loaded = new Map(await Promise.all(pairs.map(loadPair))); const candidates: Candidate[] = [];
  for (const pair of pairs) {
    const data = loaded.get(pair)!; const stream = pair === "GBP_USD" ? data.m30 : data.h1;
    for (let index = 50; index < stream.length - 1; index += 1) {
      const signal = stream[index]!; const next = stream[index + 1]!;
      if (time(signal.time) < time(start) || time(signal.time) >= time(signalEnd)) continue;
      const candidate = makeCandidate(pair, signal, next, data, events); if (candidate) candidates.push(candidate);
    }
  }
  const groups = new Map<string, Candidate[]>(); for (const candidate of candidates) groups.set(candidate.entryTime, [...(groups.get(candidate.entryTime) ?? []), candidate]);
  const trades: Trade[] = []; const suppressed: Candidate[] = []; let availableAt = time(start);
  for (const [entryTime, group] of [...groups.entries()].sort(([left], [right]) => time(left) - time(right))) {
    const ranked = group.sort((left, right) => right.score - left.score || left.pair.localeCompare(right.pair));
    if (time(entryTime) < availableAt) { suppressed.push(...ranked); continue; }
    const selected = ranked[0]!; suppressed.push(...ranked.slice(1)); const outcome = resolve(selected, loaded.get(selected.pair)!.m15);
    if (!outcome) { suppressed.push(selected); continue; }
    trades.push({ ...selected, ...outcome }); availableAt = time(outcome.exitTime);
  }
  const wins = trades.filter((trade) => trade.r > 0); const losses = trades.filter((trade) => trade.r < 0); const totalR = trades.reduce((sum, trade) => sum + trade.r, 0);
  const report = { version: "PAIR_STRATEGY_ROUTER_REPLAY_V1", scope: { requestedUniverse: 68, routedPairs: pairs.length, unsupportedPairs: 68 - pairs.length, start, signalEnd, mode: "paper-only historical research", selection: "one highest-scoring valid candidate at a time; lower-ranked or overlapping candidates suppressed", aiRole: "explain-only; no influence on route, score, levels, or result" }, outcomePolicy: { entry: "next completed strategy-timeframe candle executable bid/ask open", exit: "M15 executable bid/ask", maxHold: "3 hours", sameM15StopAndTarget: "loss" }, summary: { qualifiedCandidates: candidates.length, selectedTrades: trades.length, suppressedCandidates: suppressed.length, wins: wins.length, losses: losses.length, winRate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : null, totalR: Number(totalR.toFixed(4)), expectancyR: trades.length ? Number((totalR / trades.length).toFixed(4)) : null, profitFactor: losses.length ? Number((wins.reduce((sum, trade) => sum + trade.r, 0) / Math.abs(losses.reduce((sum, trade) => sum + trade.r, 0))).toFixed(4)) : null }, trades, suppressedCandidates: suppressed.map((candidate) => ({ pair: candidate.pair, entryTime: candidate.entryTime, family: candidate.family, score: candidate.score })) };
  await mkdir(root, { recursive: true }); await writeFile(path.join(root, "TWO_MONTH_REPLAY.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.log(JSON.stringify(report.summary, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
