import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

type Direction = "LONG" | "SHORT";
type CalendarEvent = { currency: string; importance: number; date: string; title: string };
type Trade = {
  signalTime: string; entryTime: string; direction: Direction; entry: number; stop: number; target: number;
  riskPips: number; spreadPips: number; exitTime: string; exit: number; outcome: "WIN" | "LOSS" | "TIME_EXIT"; r: number;
  reason: string; aiExplanationInput: string;
};

const pair = "EUR_USD" as const;
const start = "2026-08-01T00:00:00.000Z";
const end = "2026-09-01T00:00:00.000Z";
const maxHoldMs = 24 * 60 * 60 * 1000;
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "eurusd-deterministic-paper-bot-v1");
const calendarPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "research-v2", "pre-news-prediction-v1", "data", "calendar_raw.json");

const number = (value: number) => Number(value.toFixed(5));
const pip = (value: number) => value / 0.0001;

function ema(values: number[], period: number, index: number) {
  if (index < period - 1) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i <= index; i += 1) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

function atr(candles: ResearchCandle[], index: number, period = 14) {
  if (index < period) return null;
  const ranges: number[] = [];
  for (let i = index - period + 1; i <= index; i += 1) {
    const candle = candles[i]; const previous = candles[i - 1];
    ranges.push(Math.max(candle.mid.high - candle.mid.low, Math.abs(candle.mid.high - previous.mid.close), Math.abs(candle.mid.low - previous.mid.close)));
  }
  return ranges.reduce((sum, range) => sum + range, 0) / period;
}

function hasNewsRisk(events: CalendarEvent[], at: string) {
  const atMs = Date.parse(at);
  return events.some((event) => (event.currency === "EUR" || event.currency === "USD") && event.importance >= 1 && Math.abs(Date.parse(event.date) - atMs) <= 30 * 60 * 1000);
}

function resolveTrade(direction: Direction, entry: number, stop: number, target: number, entryTime: string, candles: ResearchCandle[]) {
  const deadline = Date.parse(entryTime) + maxHoldMs;
  const relevant = candles.filter((candle) => candle.complete && Date.parse(candle.time) > Date.parse(entryTime) && Date.parse(candle.time) <= deadline);
  const risk = Math.abs(entry - stop);
  for (const candle of relevant) {
    const stopHit = direction === "LONG" ? candle.bid.low <= stop : candle.ask.high >= stop;
    const targetHit = direction === "LONG" ? candle.bid.high >= target : candle.ask.low <= target;
    if (stopHit && targetHit) return { outcome: "LOSS" as const, exit: stop, exitTime: candle.time, r: -1 };
    if (stopHit) return { outcome: "LOSS" as const, exit: stop, exitTime: candle.time, r: -1 };
    if (targetHit) return { outcome: "WIN" as const, exit: target, exitTime: candle.time, r: 1 };
  }
  const last = relevant.at(-1);
  if (!last) return null;
  const exit = direction === "LONG" ? last.bid.close : last.ask.close;
  return { outcome: "TIME_EXIT" as const, exit, exitTime: last.time, r: (direction === "LONG" ? exit - entry : entry - exit) / risk };
}

async function run() {
  const [h1, m15, calendar] = await Promise.all([
    getResearchCandles(pair, "H1", 1_000, { to: end }),
    getResearchCandles(pair, "M15", 5_000, { to: end }),
    readFile(calendarPath, "utf8").then((text) => JSON.parse(text) as CalendarEvent[]),
  ]);
  const hourly = h1.filter((candle) => candle.complete).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const quarterHourly = m15.filter((candle) => candle.complete).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const closes = hourly.map((candle) => candle.mid.close);
  const trades: Trade[] = [];
  let nextAvailableAt = Date.parse(start);

  for (let index = 50; index < hourly.length - 1; index += 1) {
    const signal = hourly[index]; const previous = hourly[index - 1]; const next = hourly[index + 1];
    const signalMs = Date.parse(signal.time);
    if (signalMs < Date.parse(start) || signalMs >= Date.parse(end) || signalMs < nextAvailableAt) continue;
    const date = signal.time.slice(0, 10); const hour = new Date(signal.time).getUTCHours();
    if (hour < 6 || hour >= 11) continue;
    const asia = hourly.filter((candle) => candle.time.slice(0, 10) === date && new Date(candle.time).getUTCHours() >= 0 && new Date(candle.time).getUTCHours() < 6);
    if (asia.length !== 6 || hasNewsRisk(calendar, next.time)) continue;
    const ema20 = ema(closes, 20, index); const ema50 = ema(closes, 50, index); const atr14 = atr(hourly, index);
    if (ema20 === null || ema50 === null || atr14 === null || atr14 <= 0) continue;
    const asiaHigh = Math.max(...asia.map((candle) => candle.mid.high)); const asiaLow = Math.min(...asia.map((candle) => candle.mid.low));
    const body = Math.abs(signal.mid.close - signal.mid.open);
    const longSignal = signal.mid.close > asiaHigh && previous.mid.close <= asiaHigh && ema20 > ema50 && signal.mid.high > previous.mid.high && signal.mid.low > previous.mid.low && body >= 0.35 * atr14;
    const shortSignal = signal.mid.close < asiaLow && previous.mid.close >= asiaLow && ema20 < ema50 && signal.mid.high < previous.mid.high && signal.mid.low < previous.mid.low && body >= 0.35 * atr14;
    if (!longSignal && !shortSignal) continue;
    const direction: Direction = longSignal ? "LONG" : "SHORT";
    const entry = direction === "LONG" ? next.ask.open : next.bid.open;
    const stop = direction === "LONG" ? signal.bid.low : signal.ask.high;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const spread = next.ask.open - next.bid.open;
    if (spread / risk > 0.1) continue;
    const target = direction === "LONG" ? entry + risk : entry - risk;
    const resolved = resolveTrade(direction, entry, stop, target, next.time, quarterHourly);
    if (!resolved) continue;
    nextAvailableAt = Date.parse(resolved.exitTime);
    const reason = `${direction} Asia-range break; EMA20/50 aligned; HH/HL or LH/LL; body >= 0.35 ATR; spread <= 10% of risk; no high-impact EUR/USD news within 30m.`;
    trades.push({ signalTime: signal.time, entryTime: next.time, direction, entry: number(entry), stop: number(stop), target: number(target), riskPips: Number(pip(risk).toFixed(2)), spreadPips: Number(pip(spread).toFixed(2)), exitTime: resolved.exitTime, exit: number(resolved.exit), outcome: resolved.outcome, r: Number(resolved.r.toFixed(4)), reason, aiExplanationInput: `Explain only; do not change this paper trade. ${reason} Entry ${number(entry)}, stop ${number(stop)}, target ${number(target)}.` });
  }
  const wins = trades.filter((trade) => trade.r > 0); const losses = trades.filter((trade) => trade.r < 0);
  const totalR = trades.reduce((sum, trade) => sum + trade.r, 0);
  const report = { version: "EURUSD_DETERMINISTIC_PAPER_BOT_V1", scope: { pair, start, end, mode: "paper research only", aiRole: "explain-only; no influence on selection, levels, or outcome" }, rules: { timeframe: "H1 signal / M15 executable outcome", asiaRangeUtc: "00:00-06:00", signalWindowUtc: "06:00-11:00", trend: "EMA20 vs EMA50", structure: "HH+HL or LH+LL", body: "at least 0.35 ATR14", entry: "next completed H1 candle executable bid/ask open", stop: "signal candle opposite executable-side extreme", target: "1R", newsBlock: "high-impact EUR/USD +/-30m", spreadCap: "spread <= 10% of stop distance", maxOpenPositions: 1, maxHold: "24h, then executable-side time exit" }, summary: { trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : null, totalR: Number(totalR.toFixed(4)), expectancyR: trades.length ? Number((totalR / trades.length).toFixed(4)) : null, profitFactor: losses.length ? Number((wins.reduce((sum, trade) => sum + trade.r, 0) / Math.abs(losses.reduce((sum, trade) => sum + trade.r, 0))).toFixed(4)) : null }, trades };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "RESULTS.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
