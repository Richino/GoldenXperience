import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUMENT_CATALOG, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

type Direction = "LONG" | "SHORT";
type CalendarEvent = { currency: string; importance: number; date: string; title: string };
type Outcome = "WIN" | "LOSS" | "TIME_EXIT";
type Trade = { pair: string; signalTime: string; entryTime: string; direction: Direction; entry: number; stop: number; target: number; riskPips: number; spreadPips: number; exitTime: string; exit: number; outcome: Outcome; r: number; reason: string; aiExplanationInput: string };
type PairResult = { pair: string; status: "COMPLETE" | "DATA_ERROR"; error?: string; summary?: Summary; trades?: Trade[] };
type Summary = { trades: number; wins: number; losses: number; timeExits: number; winRate: number | null; totalR: number; expectancyR: number | null; profitFactor: number | null };

const start = "2026-08-01T00:00:00.000Z";
const end = "2026-09-01T00:00:00.000Z";
const maxHoldMs = 24 * 60 * 60 * 1000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "all-pairs-deterministic-paper-bot-v1");
const calendarPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "pre-news-prediction-v1", "data", "calendar_raw.json");

const rounded = (value: number, pair: string) => Number(value.toFixed(precisionFor(pair)));
const ms = (time: string) => Date.parse(time);

function ema(values: number[], period: number, index: number) {
  if (index < period - 1) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i <= index; i += 1) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

function atr(candles: ResearchCandle[], index: number, period = 14) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const current = candles[i]; const previous = candles[i - 1];
    sum += Math.max(current.mid.high - current.mid.low, Math.abs(current.mid.high - previous.mid.close), Math.abs(current.mid.low - previous.mid.close));
  }
  return sum / period;
}

function hasNewsRisk(events: CalendarEvent[], pair: string, at: string) {
  const currencies = new Set(pair.split("_")); const atMs = ms(at);
  return events.some((event) => currencies.has(event.currency) && event.importance >= 1 && Math.abs(ms(event.date) - atMs) <= 30 * 60 * 1000);
}

function resolveTrade(direction: Direction, entry: number, stop: number, target: number, entryTime: string, candles: ResearchCandle[]) {
  const deadline = ms(entryTime) + maxHoldMs;
  const relevant = candles.filter((candle) => candle.complete && ms(candle.time) > ms(entryTime) && ms(candle.time) <= deadline);
  const risk = Math.abs(entry - stop);
  for (const candle of relevant) {
    const stopHit = direction === "LONG" ? candle.bid.low <= stop : candle.ask.high >= stop;
    const targetHit = direction === "LONG" ? candle.bid.high >= target : candle.ask.low <= target;
    // M15 OHLC cannot prove the intrabar order. Count this adverse ambiguity as a loss.
    if (stopHit && targetHit) return { outcome: "LOSS" as const, exit: stop, exitTime: candle.time, r: -1 };
    if (stopHit) return { outcome: "LOSS" as const, exit: stop, exitTime: candle.time, r: -1 };
    if (targetHit) return { outcome: "WIN" as const, exit: target, exitTime: candle.time, r: 1 };
  }
  const last = relevant.at(-1); if (!last) return null;
  const exit = direction === "LONG" ? last.bid.close : last.ask.close;
  return { outcome: "TIME_EXIT" as const, exit, exitTime: last.time, r: (direction === "LONG" ? exit - entry : entry - exit) / risk };
}

function summarise(trades: Trade[]): Summary {
  const wins = trades.filter((trade) => trade.r > 0); const losses = trades.filter((trade) => trade.r < 0);
  const totalR = trades.reduce((sum, trade) => sum + trade.r, 0);
  return { trades: trades.length, wins: wins.length, losses: losses.length, timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length, winRate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : null, totalR: Number(totalR.toFixed(4)), expectancyR: trades.length ? Number((totalR / trades.length).toFixed(4)) : null, profitFactor: losses.length ? Number((wins.reduce((sum, trade) => sum + trade.r, 0) / Math.abs(losses.reduce((sum, trade) => sum + trade.r, 0))).toFixed(4)) : null };
}

async function testPair(pair: string, calendar: CalendarEvent[]): Promise<PairResult> {
  try {
    const [h1, m15] = await Promise.all([getResearchCandles(pair, "H1", 1_000, { to: end }), getResearchCandles(pair, "M15", 5_000, { to: end })]);
    const hourly = h1.filter((candle) => candle.complete).sort((a, b) => ms(a.time) - ms(b.time));
    const quarterHourly = m15.filter((candle) => candle.complete).sort((a, b) => ms(a.time) - ms(b.time));
    const closes = hourly.map((candle) => candle.mid.close); const trades: Trade[] = []; let nextAvailableAt = ms(start);
    for (let index = 50; index < hourly.length - 1; index += 1) {
      const signal = hourly[index]; const previous = hourly[index - 1]; const next = hourly[index + 1]; const signalMs = ms(signal.time);
      if (signalMs < ms(start) || signalMs >= ms(end) || signalMs < nextAvailableAt) continue;
      const date = signal.time.slice(0, 10); const hour = new Date(signal.time).getUTCHours();
      if (hour < 6 || hour >= 11) continue;
      const asia = hourly.filter((candle) => candle.time.slice(0, 10) === date && new Date(candle.time).getUTCHours() < 6);
      if (asia.length !== 6 || hasNewsRisk(calendar, pair, next.time)) continue;
      const ema20 = ema(closes, 20, index); const ema50 = ema(closes, 50, index); const atr14 = atr(hourly, index);
      if (ema20 === null || ema50 === null || atr14 === null || atr14 <= 0) continue;
      const asiaHigh = Math.max(...asia.map((candle) => candle.mid.high)); const asiaLow = Math.min(...asia.map((candle) => candle.mid.low)); const body = Math.abs(signal.mid.close - signal.mid.open);
      const longSignal = signal.mid.close > asiaHigh && previous.mid.close <= asiaHigh && ema20 > ema50 && signal.mid.high > previous.mid.high && signal.mid.low > previous.mid.low && body >= 0.35 * atr14;
      const shortSignal = signal.mid.close < asiaLow && previous.mid.close >= asiaLow && ema20 < ema50 && signal.mid.high < previous.mid.high && signal.mid.low < previous.mid.low && body >= 0.35 * atr14;
      if (!longSignal && !shortSignal) continue;
      const direction: Direction = longSignal ? "LONG" : "SHORT"; const entry = direction === "LONG" ? next.ask.open : next.bid.open; const stop = direction === "LONG" ? signal.bid.low : signal.ask.high; const risk = Math.abs(entry - stop); const spread = next.ask.open - next.bid.open;
      if (!(risk > 0) || spread / risk > 0.1) continue;
      const target = direction === "LONG" ? entry + risk : entry - risk; const resolved = resolveTrade(direction, entry, stop, target, next.time, quarterHourly); if (!resolved) continue;
      nextAvailableAt = ms(resolved.exitTime);
      const reason = `${direction} Asia-range break; EMA20/50 aligned; structure aligned; body >= 0.35 ATR; spread <= 10% of risk; no high-impact ${pair.replace("_", "/")} news within 30m.`;
      trades.push({ pair, signalTime: signal.time, entryTime: next.time, direction, entry: rounded(entry, pair), stop: rounded(stop, pair), target: rounded(target, pair), riskPips: Number((risk / pipSizeFor(pair)).toFixed(2)), spreadPips: Number((spread / pipSizeFor(pair)).toFixed(2)), exitTime: resolved.exitTime, exit: rounded(resolved.exit, pair), outcome: resolved.outcome, r: Number(resolved.r.toFixed(4)), reason, aiExplanationInput: `Explain only; do not change this paper trade. ${reason} Entry ${rounded(entry, pair)}, stop ${rounded(stop, pair)}, target ${rounded(target, pair)}.` });
    }
    return { pair, status: "COMPLETE", summary: summarise(trades), trades };
  } catch (error) { return { pair, status: "DATA_ERROR", error: error instanceof Error ? error.message : String(error) }; }
}

async function run() {
  const calendar = JSON.parse(await readFile(calendarPath, "utf8")) as CalendarEvent[];
  await mkdir(root, { recursive: true }); const results: PairResult[] = [];
  // Small batches respect provider limits and preserve one independent ledger per pair.
  for (let offset = 0; offset < INSTRUMENT_CATALOG.length; offset += 2) {
    const batch = INSTRUMENT_CATALOG.slice(offset, offset + 2); const completed = await Promise.all(batch.map((instrument) => testPair(instrument.name, calendar)));
    results.push(...completed); await writeFile(path.join(root, "RESULTS.json"), `${JSON.stringify({ version: "ALL_PAIRS_DETERMINISTIC_PAPER_BOT_V1", status: "RUNNING", completedPairs: results.length, results }, null, 2)}\n`, "utf8");
    console.log(`completed ${results.length}/${INSTRUMENT_CATALOG.length}: ${completed.map((result) => `${result.pair}=${result.status}`).join(", ")}`);
  }
  const complete = results.filter((result): result is PairResult & { summary: Summary; trades: Trade[] } => result.status === "COMPLETE" && Boolean(result.summary && result.trades)); const trades = complete.flatMap((result) => result.trades); const aggregate = summarise(trades);
  const report = { version: "ALL_PAIRS_DETERMINISTIC_PAPER_BOT_V1", scope: { pairsRequested: INSTRUMENT_CATALOG.length, start, end, mode: "paper research only", portfolioModel: "none; each pair is independent, so aggregate results are not a tradable portfolio", aiRole: "explain-only; no influence on selection, levels, or outcome" }, rules: { timeframe: "H1 signal / M15 executable outcome", asiaRangeUtc: "00:00-06:00", signalWindowUtc: "06:00-11:00", trend: "EMA20 vs EMA50", structure: "HH+HL or LH+LL", body: "at least 0.35 ATR14", entry: "next completed H1 candle executable bid/ask open", stop: "signal candle opposite executable-side extreme", target: "1R", newsBlock: "high-impact base or quote currency +/-30m", spreadCap: "spread <= 10% of stop distance", maxOpenPositionsPerPair: 1, maxHold: "24h, then executable-side time exit", intrabarConflict: "loss" }, aggregate, pairs: results };
  await writeFile(path.join(root, "RESULTS.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.log(JSON.stringify({ aggregate, completedPairs: complete.length, dataErrors: results.filter((result) => result.status === "DATA_ERROR").length }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
