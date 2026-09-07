/** EUR/USD New York opening-range sweep and reclaim V1. Research-only. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNewsTimes, nearestNewsMinutes, type RawBar } from "../eurusd-neural-day-v1/experiment.js";

type Bar = RawBar & { t: number };
type Direction = 1 | -1;
type Config = { name: string; rangeMinutes: 30 | 60; sweepAtr: number; reclaimBars: 1 | 3; holdMinutes: 90 | 120 };
type Signal = { index: number; time: number; day: string; direction: Direction; stopDistance: number; score: number; sweepDepthAtr: number; rangeMinutes: number; spreadAtr: number; newsDistanceMinutes: number | null };
type Trade = Signal & { entryTime: string; exitTime: string; resultR: number; outcome: "TARGET" | "STOP" | "TIME_EXIT"; holdMinutes: number };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(ROOT, "api-server", "research-v2", "eurusd-ny-opening-sweep-v1");
const M5 = path.join(ROOT, "backtest-breakout-m5", "candles", "EUR_USD_M5.json");
const H1 = path.join(ROOT, "backtest-legacy-expanded", "candles", "EUR_USD_H1.json");
const DEV = { from: Date.parse("2024-08-01T00:00:00Z"), to: Date.parse("2025-08-01T00:00:00Z") };
const CHECK = { from: Date.parse("2025-08-01T00:00:00Z"), to: Date.parse("2026-08-01T00:00:00Z") };
const PIP = 0.0001;
const CONFIGS: Config[] = [];
for (const rangeMinutes of [30, 60] as const) for (const sweepAtr of [0.25, 0.4]) for (const reclaimBars of [1, 3] as const) for (const holdMinutes of [90, 120] as const) CONFIGS.push({ name: `range-${rangeMinutes}-sweep-${sweepAtr}-reclaim-${reclaimBars}-hold-${holdMinutes}`, rangeMinutes, sweepAtr, reclaimBars, holdMinutes });
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function bars(file: string) {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { bars: RawBar[] };
  return raw.bars.map((bar) => ({ ...bar, t: Date.parse(bar.closeTime) })).filter((bar) => Number.isFinite(bar.t)).sort((a, b) => a.t - b.t);
}
function clock(time: number) {
  const parts = Object.fromEntries(ny.formatToParts(new Date(time)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
function atr(rows: Bar[], period = 14) {
  const out = new Float64Array(rows.length); out.fill(Number.NaN); let sum = 0;
  const tr = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) { const prev = i ? rows[i - 1]!.close : rows[i]!.open; tr[i] = Math.max(rows[i]!.high - rows[i]!.low, Math.abs(rows[i]!.high - prev), Math.abs(rows[i]!.low - prev)); sum += tr[i]!; if (i >= period) sum -= tr[i - period]!; if (i >= period - 1) out[i] = sum / period; }
  return out;
}
function ema(values: number[], period: number) { const out = new Float64Array(values.length); const alpha = 2 / (period + 1); for (let i = 0; i < values.length; i += 1) out[i] = i ? alpha * values[i]! + (1 - alpha) * out[i - 1]! : values[i]!; return out; }
function h1Direction(rows: Bar[], ema20: Float64Array, ema50: Float64Array, time: number): Direction | 0 {
  let low = 0; let high = rows.length;
  while (low < high) { const mid = (low + high) >> 1; if (rows[mid]!.t <= time) low = mid + 1; else high = mid; }
  const i = low - 1; if (i < 4) return 0;
  if (rows[i]!.close > ema20[i]! && ema20[i]! > ema50[i]! && ema20[i]! > ema20[i - 3]!) return 1;
  if (rows[i]!.close < ema20[i]! && ema20[i]! < ema50[i]! && ema20[i]! < ema20[i - 3]!) return -1;
  return 0;
}
function openingRange(rows: Bar[], index: number, rangeMinutes: number) {
  const now = clock(rows[index]!.t); const start = 8 * 60; const end = start + rangeMinutes;
  const range = rows.slice(Math.max(0, index - 20), index).filter((bar) => { const local = clock(bar.t); return local.day === now.day && local.minutes >= start && local.minutes < end; });
  return range.length === rangeMinutes / 5 ? { high: Math.max(...range.map((bar) => bar.high)), low: Math.min(...range.map((bar) => bar.low)) } : null;
}
function signals(rows: Bar[], h1: Bar[], news: number[], config: Config, period: { from: number; to: number }) {
  const values = atr(rows); const h1Ema20 = ema(h1.map((bar) => bar.close), 20); const h1Ema50 = ema(h1.map((bar) => bar.close), 50); const output: Signal[] = [];
  for (let i = 70; i < rows.length - 30; i += 1) {
    const current = rows[i]!; const local = clock(current.t); if (current.t < period.from || current.t >= period.to || local.minutes < 8 * 60 + config.rangeMinutes || local.minutes > 11 * 60) continue;
    const currentAtr = values[i]!; if (!Number.isFinite(currentAtr) || currentAtr <= 0) continue;
    const trend = h1Direction(h1, h1Ema20, h1Ema50, current.t); if (!trend) continue;
    const range = openingRange(rows, i, config.rangeMinutes); if (!range) continue;
    let best: Omit<Signal, "index" | "time" | "day" | "spreadAtr" | "newsDistanceMinutes"> | null = null;
    for (let ago = 0; ago <= config.reclaimBars; ago += 1) {
      const sweep = rows[i - ago]!;
      const longSweep = sweep.low <= range.low - config.sweepAtr * currentAtr && current.close > range.low && trend === 1;
      const shortSweep = sweep.high >= range.high + config.sweepAtr * currentAtr && current.close < range.high && trend === -1;
      if (!longSweep && !shortSweep) continue;
      const direction: Direction = longSweep ? 1 : -1;
      const body = direction === 1 ? current.close - current.open : current.open - current.close;
      if (body <= 0) continue;
      const section = rows.slice(i - ago, i + 1);
      const extreme = direction === 1 ? Math.min(...section.map((bar) => bar.low)) : Math.max(...section.map((bar) => bar.high));
      const entryBar = rows[i + 1]!; const entry = direction === 1 ? entryBar.askOpen + 0.1 * PIP : entryBar.bidOpen - 0.1 * PIP;
      const stop = direction === 1 ? extreme - 0.05 * currentAtr : extreme + 0.05 * currentAtr;
      const stopDistance = Math.abs(entry - stop); const stopAtr = stopDistance / currentAtr;
      if (stopDistance < 3 * PIP || stopAtr < 0.3 || stopAtr > 1.5) continue;
      const sweepDepthAtr = direction === 1 ? (range.low - extreme) / currentAtr : (extreme - range.high) / currentAtr;
      const score = sweepDepthAtr + body / currentAtr - 0.15 * ago;
      if (!best || score > best.score) best = { direction, stopDistance, score, sweepDepthAtr, rangeMinutes: config.rangeMinutes };
    }
    if (!best) continue;
    const entry = rows[i + 1]!; const spreadAtr = (entry.askOpen - entry.bidOpen) / currentAtr; const newsDistanceMinutes = nearestNewsMinutes(news, current.t);
    if (spreadAtr > 0.3 || (newsDistanceMinutes != null && newsDistanceMinutes <= 60)) continue;
    output.push({ index: i, time: current.t, day: local.day, ...best, spreadAtr, newsDistanceMinutes });
  }
  return output;
}
function resolve(rows: Bar[], signal: Signal, holdMinutes: number) {
  const entryIndex = signal.index + 1; const entryBar = rows[entryIndex]!; const entry = signal.direction === 1 ? entryBar.askOpen + 0.1 * PIP : entryBar.bidOpen - 0.1 * PIP; const stop = signal.direction === 1 ? entry - signal.stopDistance : entry + signal.stopDistance; const target = signal.direction === 1 ? entry + 2 * signal.stopDistance : entry - 2 * signal.stopDistance; const exitSlip = 0.1 * PIP; let exitIndex = entryIndex;
  for (let i = entryIndex; i <= Math.min(rows.length - 1, entryIndex + holdMinutes / 5 - 1); i += 1) { exitIndex = i; const bar = rows[i]!; const stopped = signal.direction === 1 ? bar.bidLow <= stop : bar.askHigh >= stop; const targeted = signal.direction === 1 ? bar.bidHigh >= target : bar.askLow <= target; if (stopped || targeted) { const level = stopped ? stop : target; const fill = signal.direction === 1 ? level + (stopped ? -exitSlip : -exitSlip) : level + (stopped ? exitSlip : exitSlip); const move = signal.direction === 1 ? fill - entry : entry - fill; return { outcome: (stopped ? "STOP" : "TARGET") as "STOP" | "TARGET", resultR: 0.75 * move / signal.stopDistance, exitTime: bar.t, holdMinutes: (bar.t - signal.time) / 60_000 }; } }
  const bar = rows[exitIndex]!; const fill = signal.direction === 1 ? bar.bidClose - exitSlip : bar.askClose + exitSlip; const move = signal.direction === 1 ? fill - entry : entry - fill; return { outcome: "TIME_EXIT" as const, resultR: Math.max(-0.8, Math.min(1.5, 0.75 * move / signal.stopDistance)), exitTime: bar.t, holdMinutes: (bar.t - signal.time) / 60_000 };
}
function replay(rows: Bar[], raw: Signal[], config: Config) { const trades: Trade[] = []; const daily = new Map<string, number>(); let locked = -Infinity; for (const signal of raw.sort((a, b) => a.time - b.time)) { if (signal.time < locked || (daily.get(signal.day) ?? 0) >= 1) continue; const result = resolve(rows, signal, config.holdMinutes); trades.push({ ...signal, ...result, entryTime: new Date(signal.time).toISOString(), exitTime: new Date(result.exitTime).toISOString() }); daily.set(signal.day, (daily.get(signal.day) ?? 0) + 1); locked = result.exitTime; } return trades; }
function days(rows: Bar[], period: { from: number; to: number }) { return new Set(rows.filter((bar) => bar.t >= period.from && bar.t < period.to && clock(bar.t).minutes === 8 * 60).map((bar) => clock(bar.t).day)).size; }
function summary(trades: Trade[], marketDays: number) { const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0); const wins = trades.filter((trade) => trade.resultR > 0); const losses = trades.filter((trade) => trade.resultR < 0); let equity = 0; let peak = 0; let dd = 0; const months = new Map<string, number>(); for (const trade of trades) { equity += trade.resultR; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); const m = trade.entryTime.slice(0, 7); months.set(m, (months.get(m) ?? 0) + trade.resultR); } const mean = totalR / Math.max(1, trades.length); const variance = trades.length > 1 ? trades.reduce((sum, trade) => sum + (trade.resultR - mean) ** 2, 0) / (trades.length - 1) : 0; const se = Math.sqrt(variance / Math.max(1, trades.length)); return { trades: trades.length, marketDays, tradesPerMarketDay: trades.length / Math.max(1, marketDays), profitableRate: wins.length / Math.max(1, trades.length), targetRate: trades.filter((trade) => trade.outcome === "TARGET").length / Math.max(1, trades.length), totalR, expectancyR: mean, expectancy95: { lower: mean - 1.96 * se, upper: mean + 1.96 * se }, profitFactor: losses.length ? wins.reduce((sum, trade) => sum + trade.resultR, 0) / -losses.reduce((sum, trade) => sum + trade.resultR, 0) : wins.length ? Infinity : 0, maxDrawdownR: dd, positiveMonths: [...months.values()].filter((value) => value > 0).length, activeMonths: months.size, stops: trades.filter((trade) => trade.outcome === "STOP").length, timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length }; }
function select(grid: Array<{ config: Config; trades: Trade[]; summary: ReturnType<typeof summary> }>) { const qualified = grid.filter((row) => row.summary.trades >= 60 && row.summary.expectancyR > 0 && row.summary.profitFactor > 1 && row.summary.positiveMonths >= Math.ceil(row.summary.activeMonths * 0.55)); const pool = qualified.length ? qualified : grid.filter((row) => row.summary.trades >= 60); return [...(pool.length ? pool : grid)].sort((a, b) => b.summary.expectancy95.lower - a.summary.expectancy95.lower || b.summary.tradesPerMarketDay - a.summary.tradesPerMarketDay)[0]!; }
function rounded(value: unknown): unknown { if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value); if (Array.isArray(value)) return value.map(rounded); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rounded(child)])); return value; }
function write(report: any) { const d = report.results.development; const c = report.results.historicalCheck; writeFileSync(path.join(OUT, "FINDINGS.md"), `# EUR/USD New York Opening-Range Sweep/Reclaim V1\n\nVerdict: **${report.verdict}**\n\n| Period | Trades | Trades/day | Profitable rate | Target rate | Expectancy | PF | Total R | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| Development | ${d.trades} | ${d.tradesPerMarketDay.toFixed(3)} | ${(d.profitableRate * 100).toFixed(2)}% | ${(d.targetRate * 100).toFixed(2)}% | ${d.expectancyR.toFixed(3)}R | ${d.profitFactor.toFixed(3)} | ${d.totalR.toFixed(2)}R | ${d.maxDrawdownR.toFixed(2)}R |\n| Later historical check | ${c.trades} | ${c.tradesPerMarketDay.toFixed(3)} | ${(c.profitableRate * 100).toFixed(2)}% | ${(c.targetRate * 100).toFixed(2)}% | ${c.expectancyR.toFixed(3)}R | ${c.profitFactor.toFixed(3)} | ${c.totalR.toFixed(2)}R | ${c.maxDrawdownR.toFixed(2)}R |\n\n${report.interpretation}\n`); }
function main() { mkdirSync(OUT, { recursive: true }); console.log("Loading EUR/USD M5/H1 bid-ask history..."); const m5 = bars(M5); const h1 = bars(H1); const news = loadNewsTimes(); const devDays = days(m5, DEV); const checkDays = days(m5, CHECK); const grid = CONFIGS.map((config) => { console.log(`Development family: ${config.name}`); const trades = replay(m5, signals(m5, h1, news, config, DEV), config); return { config, trades, summary: summary(trades, devDays) }; }); const selected = select(grid); console.log(`Selected ${selected.config.name}; running frozen later check...`); const checkTrades = replay(m5, signals(m5, h1, news, selected.config, CHECK), selected.config); const check = summary(checkTrades, checkDays); const positive = check.expectancyR > 0 && check.profitFactor > 1; const statisticallyPositive = check.expectancy95.lower > 0; const verdict = positive && statisticallyPositive ? "POSITIVE_HISTORICAL_CHECK_RESEARCH_ONLY" : positive ? "POSITIVE_POINT_ESTIMATE_EDGE_UNCERTAIN" : "NO_POSITIVE_HISTORICAL_EDGE"; const interpretation = positive && statisticallyPositive ? "The frozen family was positive after costs; forward practice validation is still required." : positive ? `The point estimate is positive but its interval (${check.expectancy95.lower.toFixed(3)}R to ${check.expectancy95.upper.toFixed(3)}R) crosses zero, so the edge is uncertain.` : "The frozen family failed after realistic bid/ask execution costs; do not add it to the bot."; const report = rounded({ generatedAt: new Date().toISOString(), verdict, isolation: { v19Modified: false, v4Modified: false, productionOrPaperBehaviorChanged: false }, protocol: { instrument: "EUR_USD", session: "New York opening range 08:00 America/New_York, DST aware; trade 08:30/09:00 through 11:00", setup: "sweep opening-range high/low, reclaim inside range within 1 or 3 M5 bars, H1 trend alignment, next M5-open entry", execution: "historical bid/ask, 0.1 pip entry/exit slippage, structural sweep-extreme stop, 2x target (+1.5R/-0.75R), stop charged first on same-bar ambiguity", filters: "high-impact EUR/USD news +/-60m, spread <=0.30 ATR, one trade per day" }, selection: { ...selected.config, objective: "development only: at least 60 trades, positive expectancy, PF > 1, and >=55% positive active months; maximize lower expectancy bound", frontier: grid.map((row) => ({ ...row.config, ...row.summary })) }, results: { development: selected.summary, historicalCheck: check }, interpretation }) as any; writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(report, null, 2)); writeFileSync(path.join(OUT, "TRADES.development.json"), JSON.stringify(selected.trades, null, 2)); writeFileSync(path.join(OUT, "TRADES.historical-check.json"), JSON.stringify(checkTrades, null, 2)); write(report); console.log(JSON.stringify({ verdict, selection: report.selection && { name: report.selection.name, rangeMinutes: report.selection.rangeMinutes, sweepAtr: report.selection.sweepAtr, reclaimBars: report.selection.reclaimBars, holdMinutes: report.selection.holdMinutes }, development: report.results.development, historicalCheck: report.results.historicalCheck }, null, 2)); }
main();
