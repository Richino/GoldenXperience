/**
 * Frozen-portfolio post-+2R runner experiment.
 * Research / paper only. Does not change entries, deploy, or place orders.
 * Distinct from frozen-portfolio-near-target-protection-v1: no stop move before +2R.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

type Direction = "LONG" | "SHORT";
type VariantId = "R0" | "R1" | "R2";
type ExitReason = "TAKE_PROFIT" | "ORIGINAL_STOP" | "RUNNER_STOP" | "TIME_EXIT" | "RUNNER_48H";
type Side = { open: number; high: number; low: number; close: number };
type MinuteBar = { t: number; bid: Side; ask: Side };
type CompactCandle = { t: number; bo: number; bh: number; bl: number; bc: number; ao: number; ah: number; al: number; ac: number };
type ResearchLike = {
  time: string;
  bid: { open: number; high: number; low: number; close: number } | { o: string; h: string; l: string; c: string };
  ask: { open: number; high: number; low: number; close: number } | { o: string; h: string; l: string; c: string };
};
type FrozenTrade = {
  pair: string; instrument: string; strategy: string; version: string; tradeNumber: number;
  direction: Direction; geometry: string; entryUtc: string; decisionMs: number; horizonMs: number;
  execEntry: number; risk: number; originalStop: number; originalTarget: number;
  publishedExecR: number | null; publishedExitReason: string; matched: boolean; unmatchedReason: string;
};
type Replay = {
  reason: ExitReason; resultR: number; exitMs: number; exitPrice: number; mfeR: number;
  runner: boolean; runnerActivateMs: number | null; durationMs: number;
  sameMinuteAmbiguous: boolean; incomplete48h: boolean;
};

const ROOT = resolve(process.cwd(), "../api-server/research-v2");
const PRIOR = resolve(ROOT, "frozen-portfolio-near-target-protection-v1");
const OUT = resolve(ROOT, "frozen-portfolio-post-2r-runner-v1");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const RUNNER_MAX_MS = 48 * HOUR;
const PAIR_ORDER = ["USDCHF", "USDCAD", "GBPUSD", "NZDUSD", "AUDUSD", "USDJPY", "EURUSD"] as const;
const PRIOR_PORTFOLIO = { trades: 1176, totalR: 155.8446, expectancyR: 0.132521, pf: 1.2487, wr: 44.5578 };

function canonical(value: string) { return new Date(value).toISOString(); }
function round(value: number, digits = 6) { const f = 10 ** digits; return Math.round(value * f) / f; }
function csvCell(value: string | number | boolean) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows: Array<Record<string, string | number | boolean>>) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  return [headers.join(","), ...rows.map((row) => headers.map((key) => csvCell(row[key]!)).join(","))].join("\n") + "\n";
}
function side(open: number, high: number, low: number, close: number): Side { return { open, high, low, close }; }
function fromCompact(c: CompactCandle): MinuteBar {
  return { t: c.t, bid: side(c.bo, c.bh, c.bl, c.bc), ask: side(c.ao, c.ah, c.al, c.ac) };
}
function fromResearch(bar: ResearchLike): MinuteBar {
  const bid = "open" in bar.bid ? bar.bid : { open: +bar.bid.o, high: +bar.bid.h, low: +bar.bid.l, close: +bar.bid.c };
  const ask = "open" in bar.ask ? bar.ask : { open: +bar.ask.o, high: +bar.ask.h, low: +bar.ask.l, close: +bar.ask.c };
  return { t: Date.parse(bar.time), bid, ask };
}
function readJson<T>(path: string) { return readFile(path, "utf8").then((text) => JSON.parse(text) as T); }
function windowOf(bars: readonly MinuteBar[], fromMs: number, toMs: number) {
  return bars.filter((bar) => bar.t >= fromMs && bar.t < toMs).sort((a, b) => a.t - b.t);
}
function mergeBars(...lists: Array<readonly MinuteBar[]>) {
  return [...new Map(lists.flat().map((bar) => [bar.t, bar])).values()].sort((a, b) => a.t - b.t);
}
function favorableR(direction: Direction, entry: number, risk: number, bar: MinuteBar) {
  return direction === "LONG" ? (bar.bid.high - entry) / risk : (entry - bar.ask.low) / risk;
}
function adverseHit(direction: Direction, stop: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  return direction === "LONG" ? px.low <= stop : px.high >= stop;
}
function targetHit(direction: Direction, target: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  return direction === "LONG" ? px.high >= target : px.low <= target;
}
function stopFill(direction: Direction, stop: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  if (direction === "LONG") return px.open <= stop ? px.open : stop;
  return px.open >= stop ? px.open : stop;
}
function targetFill(direction: Direction, target: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  if (direction === "LONG") return px.open >= target ? px.open : target;
  return px.open <= target ? px.open : target;
}
function timeFill(direction: Direction, bar: MinuteBar) {
  return direction === "LONG" ? bar.bid.close : bar.ask.close;
}
function resultR(direction: Direction, entry: number, risk: number, exit: number) {
  return direction === "LONG" ? (exit - entry) / risk : (entry - exit) / risk;
}
function lockPrice(direction: Direction, entry: number, risk: number, lockR: number) {
  return direction === "LONG" ? entry + lockR * risk : entry - lockR * risk;
}
function trailStopR(mfeR: number) {
  if (mfeR >= 2.2) return mfeR - 0.2;
  return 1.8;
}
function nyHour(ms: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return { hour: +get("hour"), minute: +get("minute"), day: `${get("year")}-${get("month")}-${get("day")}` };
}
function crossesNy1700(fromMs: number, toMs: number) {
  for (let t = fromMs; t <= toMs; t += HOUR) {
    const a = nyHour(Math.max(t, fromMs));
    if (a.hour === 17 && a.minute === 0 && t >= fromMs && t <= toMs) return true;
  }
  const start = nyHour(fromMs);
  const end = nyHour(toMs);
  return start.day !== end.day && (start.hour < 17 || end.hour >= 17);
}
function metrics(rs: readonly number[]) {
  const wins = rs.filter((value) => value > 0);
  const losses = rs.filter((value) => value <= 0);
  const gp = wins.reduce((sum, value) => sum + value, 0);
  const gl = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const value of rs) { equity += value; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  return {
    trades: rs.length, wins: wins.length, losses: losses.length,
    wr: rs.length ? 100 * wins.length / rs.length : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    totalR: rs.reduce((sum, value) => sum + value, 0),
    expectancyR: rs.length ? rs.reduce((sum, value) => sum + value, 0) / rs.length : 0,
    averageWinnerR: wins.length ? gp / wins.length : 0,
    averageLoserR: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0,
    maxDdR: maxDd,
  };
}

function replayBaseline(trade: FrozenTrade, bars: readonly MinuteBar[]): Replay | null {
  if (!trade.matched || !(trade.risk > 0)) return null;
  const usable = windowOf(bars, trade.decisionMs, trade.horizonMs);
  if (usable.length < 10) return null;
  if (usable.at(-1)!.t < trade.horizonMs - 6 * MINUTE) return null;
  let mfeR = 0;
  for (const bar of usable) {
    mfeR = Math.max(mfeR, favorableR(trade.direction, trade.execEntry, trade.risk, bar));
    const sl = adverseHit(trade.direction, trade.originalStop, bar);
    const tp = targetHit(trade.direction, trade.originalTarget, bar);
    if (sl) {
      const fill = stopFill(trade.direction, trade.originalStop, bar);
      return { reason: "ORIGINAL_STOP", resultR: resultR(trade.direction, trade.execEntry, trade.risk, fill), exitMs: bar.t + MINUTE, exitPrice: fill, mfeR, runner: false, runnerActivateMs: null, durationMs: bar.t + MINUTE - trade.decisionMs, sameMinuteAmbiguous: tp, incomplete48h: false };
    }
    if (tp) {
      const fill = targetFill(trade.direction, trade.originalTarget, bar);
      return { reason: "TAKE_PROFIT", resultR: resultR(trade.direction, trade.execEntry, trade.risk, fill), exitMs: bar.t + MINUTE, exitPrice: fill, mfeR, runner: false, runnerActivateMs: null, durationMs: bar.t + MINUTE - trade.decisionMs, sameMinuteAmbiguous: false, incomplete48h: false };
    }
  }
  const last = usable.at(-1)!;
  const fill = timeFill(trade.direction, last);
  return { reason: "TIME_EXIT", resultR: resultR(trade.direction, trade.execEntry, trade.risk, fill), exitMs: trade.horizonMs, exitPrice: fill, mfeR, runner: false, runnerActivateMs: null, durationMs: trade.horizonMs - trade.decisionMs, sameMinuteAmbiguous: false, incomplete48h: false };
}

function replayRunner(trade: FrozenTrade, bars: readonly MinuteBar[], partial: boolean): Replay | null {
  const base = replayBaseline(trade, bars);
  if (!base) return null;
  if (base.reason !== "TAKE_PROFIT") return { ...base, runner: false };
  const runnerEnd = Date.parse(trade.entryUtc) + RUNNER_MAX_MS;
  const usable = windowOf(bars, trade.decisionMs, runnerEnd);
  let mfeR = 0;
  let runner = false;
  let activateMs: number | null = null;
  let tpFillR = 0;
  let ambiguous = false;
  let incomplete48h = usable.at(-1)!.t < runnerEnd - 30 * MINUTE;

  for (const bar of usable) {
    const fav = favorableR(trade.direction, trade.execEntry, trade.risk, bar);
    if (!runner) {
      if (bar.t >= trade.horizonMs) break;
      const sl = adverseHit(trade.direction, trade.originalStop, bar);
      const tp = targetHit(trade.direction, trade.originalTarget, bar);
      mfeR = Math.max(mfeR, fav);
      if (sl) {
        const fill = stopFill(trade.direction, trade.originalStop, bar);
        return { reason: "ORIGINAL_STOP", resultR: resultR(trade.direction, trade.execEntry, trade.risk, fill), exitMs: bar.t + MINUTE, exitPrice: fill, mfeR, runner: false, runnerActivateMs: null, durationMs: bar.t + MINUTE - trade.decisionMs, sameMinuteAmbiguous: tp, incomplete48h: false };
      }
      if (!tp) continue;
      const fill = targetFill(trade.direction, trade.originalTarget, bar);
      tpFillR = resultR(trade.direction, trade.execEntry, trade.risk, fill);
      const lock = lockPrice(trade.direction, trade.execEntry, trade.risk, 1.8);
      runner = true;
      activateMs = bar.t;
      mfeR = Math.max(mfeR, fav, 2);
      if (adverseHit(trade.direction, lock, bar)) {
        ambiguous = true;
        const stopPx = stopFill(trade.direction, lock, bar);
        const runnerR = resultR(trade.direction, trade.execEntry, trade.risk, stopPx);
        const mixed = partial ? 0.8 * tpFillR + 0.2 * runnerR : runnerR;
        return { reason: "RUNNER_STOP", resultR: mixed, exitMs: bar.t + MINUTE, exitPrice: stopPx, mfeR, runner: true, runnerActivateMs: activateMs, durationMs: bar.t + MINUTE - trade.decisionMs, sameMinuteAmbiguous: true, incomplete48h: false };
      }
      continue;
    }
    const stopRBefore = trailStopR(mfeR);
    const stopPx = lockPrice(trade.direction, trade.execEntry, trade.risk, stopRBefore);
    if (adverseHit(trade.direction, stopPx, bar)) {
      const fill = stopFill(trade.direction, stopPx, bar);
      const runnerR = resultR(trade.direction, trade.execEntry, trade.risk, fill);
      const mixed = partial ? 0.8 * tpFillR + 0.2 * runnerR : runnerR;
      return { reason: "RUNNER_STOP", resultR: mixed, exitMs: bar.t + MINUTE, exitPrice: fill, mfeR, runner: true, runnerActivateMs: activateMs, durationMs: bar.t + MINUTE - trade.decisionMs, sameMinuteAmbiguous: ambiguous, incomplete48h: false };
    }
    const newMfe = Math.max(mfeR, fav);
    if (newMfe > mfeR && adverseHit(trade.direction, lockPrice(trade.direction, trade.execEntry, trade.risk, trailStopR(newMfe)), bar)) {
      ambiguous = true;
    }
    mfeR = newMfe;
  }
  if (!runner) return base;
  const last = usable.at(-1)!;
  const fill = timeFill(trade.direction, last);
  const runnerR = resultR(trade.direction, trade.execEntry, trade.risk, fill);
  const mixed = partial ? 0.8 * tpFillR + 0.2 * runnerR : runnerR;
  return {
    reason: "RUNNER_48H", resultR: mixed, exitMs: Math.min(last.t + MINUTE, runnerEnd), exitPrice: fill, mfeR,
    runner: true, runnerActivateMs: activateMs, durationMs: Math.min(last.t + MINUTE, runnerEnd) - trade.decisionMs,
    sameMinuteAmbiguous: ambiguous, incomplete48h,
  };
}

function oandaCredentials() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  loadEnvConfig(process.cwd());
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA_API_KEY/OANDA_API_TOKEN is required for 48h runner M1 windows.");
  if ((process.env.OANDA_ENVIRONMENT ?? "").toLowerCase() === "live") throw new Error("Practice-only experiment refuses a live OANDA environment.");
  return { token, host: "https://api-fxpractice.oanda.com" };
}

async function oandaM1(instrument: string, fromIso: string, toIso: string, token: string, host: string) {
  const out: MinuteBar[] = [];
  let from = Date.parse(fromIso);
  const end = Date.parse(toIso);
  while (from < end) {
    const url = new URL(`${host}/v3/instruments/${instrument}/candles`);
    url.searchParams.set("price", "MBA");
    url.searchParams.set("granularity", "M1");
    url.searchParams.set("from", new Date(from).toISOString());
    url.searchParams.set("to", new Date(end).toISOString());
    url.searchParams.set("includeFirst", "true");
    let body: { candles?: Array<{ time: string; complete: boolean; bid?: Record<"o"|"h"|"l"|"c", string>; ask?: Record<"o"|"h"|"l"|"c", string> }> } | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) { body = await response.json() as typeof body; break; }
      if (attempt === 5 || ![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`OANDA ${instrument} M1 HTTP ${response.status}`);
      }
      await new Promise((done) => setTimeout(done, attempt * 400));
    }
    const batch = (body?.candles ?? []).filter((row) => row.complete && row.bid && row.ask).map((row) => fromResearch({
      time: canonical(row.time),
      bid: { open: +row.bid!.o, high: +row.bid!.h, low: +row.bid!.l, close: +row.bid!.c },
      ask: { open: +row.ask!.o, high: +row.ask!.h, low: +row.ask!.l, close: +row.ask!.c },
    })).filter((bar) => bar.t < end);
    if (!batch.length) break;
    out.push(...batch);
    const next = batch.at(-1)!.t + MINUTE;
    if (next <= from) break;
    from = next;
  }
  return [...new Map(out.map((bar) => [bar.t, bar])).values()].sort((a, b) => a.t - b.t);
}

async function loadCompactSeries(path: string) {
  const raw = await readJson<{ candles?: unknown }>(path);
  const candles = raw.candles ?? raw;
  if (!Array.isArray(candles) || !candles.length) return [];
  const first = candles[0] as CompactCandle | ResearchLike;
  if (first && typeof first === "object" && "t" in first) return (candles as CompactCandle[]).map(fromCompact);
  return (candles as ResearchLike[]).map(fromResearch);
}
async function loadWindows(path: string) {
  const raw = await readJson<{ windows: Record<string, ResearchLike[]> }>(path);
  return Object.fromEntries(Object.entries(raw.windows).map(([key, bars]) => [key, bars.map(fromResearch)]));
}

async function loadUsdchf() {
  const raw = await readJson<{ rows: Array<Record<string, unknown>> }>(resolve(ROOT, "usdchf-bear-consensus-v1-spread-validation/RAW_RESULTS.json"));
  const series = await loadCompactSeries(resolve(ROOT, "usdchf-bear-consensus-v1-spread-validation/data/USD_CHF-M1-MBA.json"));
  const trades: FrozenTrade[] = raw.rows.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "USDCHF", instrument: "USD_CHF", strategy: "USDCHF Bear Consensus Structure V1", version: "V1",
      tradeNumber: Number(row.trade_number), direction: "SHORT", geometry: "+2R/-1R ATR14",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_bid_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, originalBars: (trade: FrozenTrade) => series, instrument: "USD_CHF" };
}
async function loadUsdcad() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "usdcad-v3-1100-long-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "usdcad-v3-1100-long-spread-validation/data/USD_CAD-M1-TV53-MBA.json"));
  const trades: FrozenTrade[] = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "USDCAD", instrument: "USD_CAD", strategy: "USDCAD V3 11:00 LONG", version: "V3",
      tradeNumber: Number(row.trade_number), direction: "LONG", geometry: "+2R/-1R ATR14",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, originalBars: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? [], instrument: "USD_CAD" };
}
async function loadGbpusd() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "gbpusd-frequency-v3-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "gbpusd-frequency-v3-spread-validation/data/GBP_USD-M1-TV98-MBA.json"));
  const trades: FrozenTrade[] = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.tv_entry_timestamp_utc));
    const direction: Direction = String(row.direction).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    return {
      pair: "GBPUSD", instrument: "GBP_USD", strategy: "GBPUSD Frequency V3", version: "V3",
      tradeNumber: Number(row.trade_number), direction, geometry: "+2R/-1R",
      entryUtc: String(row.tv_entry_timestamp_utc), decisionMs: entryMs + 30 * MINUTE, horizonMs: entryMs + 7 * 30 * MINUTE,
      execEntry: Number(row.execEntry), risk: Number(row.initial_risk_pips) * 0.0001,
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, originalBars: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? [], instrument: "GBP_USD" };
}
async function loadNzdusd() {
  const raw = await readJson<{ rows: Array<Record<string, unknown>> }>(resolve(ROOT, "nzdusd-bull-consensus-structure-v1-spread-validation/RAW_RESULTS.json"));
  const series = await loadCompactSeries(resolve(ROOT, "nzdusd-bull-consensus-structure-v1-spread-validation/data/NZD_USD-M1-MBA.json"));
  const trades: FrozenTrade[] = raw.rows.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "NZDUSD", instrument: "NZD_USD", strategy: "NZDUSD Bull Consensus Structure V1", version: "V1",
      tradeNumber: Number(row.trade_number), direction: "LONG", geometry: "+2R/-1R ATR14",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, originalBars: (trade: FrozenTrade) => series, instrument: "NZD_USD" };
}
async function loadUsdjpy() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "usdjpy-v6-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "usdjpy-v6-spread-validation/data/USD_JPY-M1-TV272-MBA.json"));
  const trades: FrozenTrade[] = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_timestamp));
    const matched = String(row.execution_status) === "MATCHED";
    return {
      pair: "USDJPY", instrument: "USD_JPY", strategy: "USDJPY Body Extreme V6", version: "V6",
      tradeNumber: Number(row.trade_number), direction: "LONG", geometry: "+2R/-1R frozen TV risk",
      entryUtc: String(row.resolved_utc_timestamp), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.risk),
      originalStop: Number(row.stop), originalTarget: Number(row.target),
      publishedExecR: matched ? Number(row.net_execution_r) : null, publishedExitReason: String(row.oanda_execution_exit_reason ?? ""),
      matched, unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, originalBars: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? [], instrument: "USD_JPY" };
}
async function loadCostPair(pair: "EURUSD" | "AUDUSD") {
  const key = pair === "EURUSD" ? "EUR_USD" : "AUD_USD";
  const raw = await readJson<{ pairs: Record<string, { trades: Array<Record<string, unknown>> }> }>(resolve(ROOT, "executable-cost-validation/RESULTS.json"));
  const maxHold = pair === "AUDUSD" ? 3 : null;
  const trades: FrozenTrade[] = raw.pairs[key]!.trades.map((row, index) => {
    const direction: Direction = String(row.direction).toLowerCase() === "short" ? "SHORT" : "LONG";
    const decisionMs = Date.parse(String(row.decisionTime));
    const exitMs = Date.parse(String(row.exitTimestamp));
    const execEntry = Number(row.executableEntry);
    const stop = Number(row.stop);
    const atr = Number(row.atr);
    return {
      pair, instrument: key, strategy: pair === "EURUSD" ? "EURUSD London Breakout V1" : "AUDUSD Strong Consensus Structure V1",
      version: "V1", tradeNumber: index + 1, direction, geometry: "+2R/-1R",
      entryUtc: canonical(String(row.signalTimestamp)), decisionMs,
      horizonMs: maxHold === null ? Math.max(exitMs, decisionMs + HOUR) : decisionMs + maxHold * HOUR,
      execEntry, risk: pair === "EURUSD" ? Math.abs(execEntry - stop) : atr,
      originalStop: stop, originalTarget: Number(row.target),
      publishedExecR: Number(row.executableResultR), publishedExitReason: String(row.exitReason),
      matched: true, unmatchedReason: "",
    };
  });
  const windows = await loadWindows(resolve(PRIOR, `data/${key}-M1-windows.json`));
  return { trades, originalBars: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? [], instrument: key };
}

type Loaded = { trades: FrozenTrade[]; originalBars: (trade: FrozenTrade) => MinuteBar[]; instrument: string };

function bucketDuration(ms: number) {
  const h = ms / HOUR;
  if (h <= 3) return "<=3h";
  if (h <= 6) return "3-6h";
  if (h <= 12) return "6-12h";
  if (h <= 24) return "12-24h";
  return "24-48h";
}
function runnerExitBucket(r: number) {
  if (r < 1.8) return "<+1.8R";
  if (r < 2) return "+1.8R to +1.99R";
  if (r < 2.5) return "+2.0R to +2.49R";
  if (r < 3) return "+2.5R to +2.99R";
  if (r < 4) return "+3.0R to +3.99R";
  if (r < 5) return "+4.0R to +4.99R";
  return ">= +5R";
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(resolve(OUT, "data"), { recursive: true });
  const loaded: Record<string, Loaded> = {
    USDCHF: await loadUsdchf(),
    USDCAD: await loadUsdcad(),
    GBPUSD: await loadGbpusd(),
    NZDUSD: await loadNzdusd(),
    USDJPY: await loadUsdjpy(),
    AUDUSD: await loadCostPair("AUDUSD"),
    EURUSD: await loadCostPair("EURUSD"),
  };

  const usable: Array<{ pair: string; trade: FrozenTrade; bars: MinuteBar[]; r0: Replay }> = [];
  for (const pair of PAIR_ORDER) {
    const pack = loaded[pair]!;
    for (const trade of pack.trades) {
      if (!trade.matched) continue;
      const bars = pack.originalBars(trade);
      const r0 = replayBaseline(trade, bars);
      if (!r0) continue;
      usable.push({ pair, trade, bars, r0 });
    }
  }
  const r0All = metrics(usable.map((row) => row.r0.resultR));
  console.log(`R0 n=${r0All.trades} exp=${r0All.expectancyR.toFixed(4)} total=${r0All.totalR.toFixed(2)} pf=${r0All.pf.toFixed(3)}`);
  if (r0All.trades !== PRIOR_PORTFOLIO.trades || Math.abs(r0All.expectancyR - PRIOR_PORTFOLIO.expectancyR) > 0.003) {
    throw new Error(`R0 failed to reproduce prior portfolio: n=${r0All.trades} exp=${r0All.expectancyR}`);
  }

  const tpTrades = usable.filter((row) => row.r0.reason === "TAKE_PROFIT");
  const cachePath = resolve(OUT, "data/M1-48h-windows.json");
  let extra: Record<string, MinuteBar[]> = {};
  try {
    const cached = await readJson<{ windows: Record<string, ResearchLike[]> }>(cachePath);
    extra = Object.fromEntries(Object.entries(cached.windows).map(([key, bars]) => [key, bars.map(fromResearch)]));
  } catch { extra = {}; }
  const missing = tpTrades.filter((row) => !extra[`${row.pair}:${row.trade.tradeNumber}`]?.length);
  if (missing.length) {
    const { token, host } = oandaCredentials();
    console.log(`Fetching 48h M1 for ${missing.length} +2R trades`);
    for (let i = 0; i < missing.length; i += 4) {
      const batch = missing.slice(i, i + 4);
      const fetched = await Promise.all(batch.map(async (row) => {
        const to = Date.parse(row.trade.entryUtc) + RUNNER_MAX_MS;
        const from = row.trade.decisionMs;
        const bars = await oandaM1(row.trade.instrument, new Date(from).toISOString(), new Date(to).toISOString(), token, host);
        return [`${row.pair}:${row.trade.tradeNumber}`, bars] as const;
      }));
      for (const [key, bars] of fetched) extra[key] = bars;
      if (i + 4 < missing.length) await new Promise((done) => setTimeout(done, 120));
      if (i % 20 === 0) console.log(`48h windows ${Math.min(i + 4, missing.length)}/${missing.length}`);
    }
    await writeFile(cachePath, JSON.stringify({
      source: "OANDA Practice M1 MBA 48h from original entry, +2R trades only",
      windows: extra,
    }));
  }

  function barsFor(row: { pair: string; trade: FrozenTrade; bars: MinuteBar[] }) {
    return mergeBars(row.bars, extra[`${row.pair}:${row.trade.tradeNumber}`] ?? []);
  }

  const r1ByKey = new Map<string, Replay>();
  const r2ByKey = new Map<string, Replay>();
  for (const row of usable) {
    const key = `${row.pair}:${row.trade.tradeNumber}`;
    const extended = barsFor(row);
    r1ByKey.set(key, replayRunner(row.trade, extended, false) ?? row.r0);
    r2ByKey.set(key, replayRunner(row.trade, extended, true) ?? row.r0);
  }

  const variants: Array<{ id: VariantId; label: string; get: (key: string) => Replay }> = [
    { id: "R0", label: "FROZEN BASELINE", get: (key) => usable.find((row) => `${row.pair}:${row.trade.tradeNumber}` === key)!.r0 },
    { id: "R1", label: "FULL 2R RUNNER", get: (key) => r1ByKey.get(key)! },
    { id: "R2", label: "80/20 RUNNER", get: (key) => r2ByKey.get(key)! },
  ];

  const pairSummary: Array<Record<string, string | number | boolean>> = [];
  const portfolioSummary: Array<Record<string, string | number | boolean>> = [];
  const runnerTrades: Array<Record<string, string | number | boolean>> = [];
  const post2r: Array<Record<string, string | number | boolean>> = [];
  const years: Array<Record<string, string | number | boolean>> = [];
  const durations: Array<Record<string, string | number | boolean>> = [];
  const overnight: Array<Record<string, string | number | boolean>> = [];
  const ambiguous: Array<Record<string, string | number | boolean>> = [];

  for (const spec of variants) {
    const rows = usable.map((row) => ({ ...row, replay: spec.get(`${row.pair}:${row.trade.tradeNumber}`) }));
    const m = metrics(rows.map((row) => row.replay.resultR));
    portfolioSummary.push({
      variant: spec.id, label: spec.label, trades: m.trades, wins: m.wins, losses: m.losses,
      wr: round(m.wr, 4), pf: round(m.pf, 4), total_r: round(m.totalR, 4), expectancy_r: round(m.expectancyR, 6),
      average_winner_r: round(m.averageWinnerR, 4), average_loser_r: round(m.averageLoserR, 4), max_dd_r: round(m.maxDdR, 4),
      financing: "UNAVAILABLE", result_basis: "EXEC_BEFORE_FINANCING",
    });
    for (const pair of PAIR_ORDER) {
      const subset = rows.filter((row) => row.pair === pair);
      const pm = metrics(subset.map((row) => row.replay.resultR));
      const r0m = metrics(usable.filter((row) => row.pair === pair).map((row) => row.r0.resultR));
      const runners = subset.filter((row) => row.replay.runner);
      pairSummary.push({
        pair, variant: spec.id, trades: pm.trades, baseline_exp: round(r0m.expectancyR, 6), runner_exp: round(pm.expectancyR, 6),
        delta: round(pm.expectancyR - r0m.expectancyR, 6), baseline_pf: round(r0m.pf, 4), runner_pf: round(pm.pf, 4),
        baseline_total_r: round(r0m.totalR, 4), runner_total_r: round(pm.totalR, 4),
        plus_2r_trades: subset.filter((row) => row.r0.reason === "TAKE_PROFIT").length,
        runner_count: runners.length, runner_avg_r: runners.length ? round(runners.reduce((s, r) => s + r.replay.resultR, 0) / runners.length, 4) : 0,
        max_runner_r: runners.length ? round(Math.max(...runners.map((r) => r.replay.resultR)), 4) : 0,
        average_winner_r: round(pm.averageWinnerR, 4), wr: round(pm.wr, 2),
      });
    }
    for (const year of [2023, 2024, 2025, 2026]) {
      const subset = rows.filter((row) => new Date(row.trade.entryUtc).getUTCFullYear() === year);
      const ym = metrics(subset.map((row) => row.replay.resultR));
      years.push({ variant: spec.id, year, trades: ym.trades, pf: round(ym.pf, 3), total_r: round(ym.totalR, 4), expectancy_r: round(ym.expectancyR, 4), average_winner_r: round(ym.averageWinnerR, 4) });
    }
  }

  const r1Rows = usable.map((row) => ({ ...row, replay: r1ByKey.get(`${row.pair}:${row.trade.tradeNumber}`)! }));
  const r2Rows = usable.map((row) => ({ ...row, replay: r2ByKey.get(`${row.pair}:${row.trade.tradeNumber}`)! }));
  const plus2 = r1Rows.filter((row) => row.r0.reason === "TAKE_PROFIT");

  for (const row of plus2) {
    const horizons = [3, 6, 12, 24, 48];
    const extended = barsFor(row);
    const after = windowOf(extended, row.r0.exitMs, Date.parse(row.trade.entryUtc) + RUNNER_MAX_MS);
    let mfe = row.r0.mfeR;
    const reached: Record<number, number> = {};
    for (const h of horizons) reached[h] = mfe;
    for (const bar of after) {
      mfe = Math.max(mfe, favorableR(row.trade.direction, row.trade.execEntry, row.trade.risk, bar));
      const hoursAfter = (bar.t - row.r0.exitMs) / HOUR;
      for (const h of horizons) if (hoursAfter <= h) reached[h] = Math.max(reached[h] ?? 0, mfe);
    }
    post2r.push({
      pair: row.pair, trade_number: row.trade.tradeNumber, baseline_r: round(row.r0.resultR, 6),
      mfe_at_tp: round(row.r0.mfeR, 4),
      mfe_3h: round(reached[3] ?? row.r0.mfeR, 4), mfe_6h: round(reached[6] ?? row.r0.mfeR, 4),
      mfe_12h: round(reached[12] ?? row.r0.mfeR, 4), mfe_24h: round(reached[24] ?? row.r0.mfeR, 4),
      mfe_48h: round(reached[48] ?? row.r0.mfeR, 4),
      reach_2_2: (reached[48] ?? 0) >= 2.2, reach_2_5: (reached[48] ?? 0) >= 2.5,
      reach_3: (reached[48] ?? 0) >= 3, reach_4: (reached[48] ?? 0) >= 4, reach_5: (reached[48] ?? 0) >= 5,
    });
    const r1 = row.replay;
    runnerTrades.push({
      pair: row.pair, trade_number: row.trade.tradeNumber, direction: row.trade.direction, entry_utc: row.trade.entryUtc,
      year: new Date(row.trade.entryUtc).getUTCFullYear(), baseline_r: round(row.r0.resultR, 6),
      r1_r: round(r1.resultR, 6), r2_r: round(r2ByKey.get(`${row.pair}:${row.trade.tradeNumber}`)!.resultR, 6),
      r1_reason: r1.reason, mfe_r: round(r1.mfeR, 4), duration_hours: round(r1.durationMs / HOUR, 3),
      duration_bucket: bucketDuration(r1.durationMs), exit_bucket: runnerExitBucket(r1.resultR),
      overnight_ny17: r1.runner && crossesNy1700(row.trade.decisionMs, r1.exitMs),
      next_utc_day: r1.runner && new Date(r1.exitMs).getUTCDate() !== new Date(row.trade.decisionMs).getUTCDate(),
      held_over_24h: r1.runner && r1.durationMs > 24 * HOUR,
      incomplete_48h: r1.incomplete48h, ambiguous: r1.sameMinuteAmbiguous,
    });
    if (r1.sameMinuteAmbiguous) {
      ambiguous.push({ pair: row.pair, trade_number: row.trade.tradeNumber, kind: "RUNNER_ACTIVATION_AMBIGUOUS", r1_r: round(r1.resultR, 6), r1_reason: r1.reason });
    }
  }

  const nPlus2 = plus2.length;
  const postReach = (threshold: number) => post2r.filter((row) => Boolean(row[`reach_${threshold === 2.2 ? "2_2" : threshold === 2.5 ? "2_5" : String(threshold)}`])).length;
  const changeCats = [
    { id: "below_2", test: (r: number) => r < 2 },
    { id: "approx_2", test: (r: number) => r >= 2 && r < 2.5 },
    { id: "plus_2_5", test: (r: number) => r >= 2.5 },
    { id: "plus_3", test: (r: number) => r >= 3 },
    { id: "plus_4", test: (r: number) => r >= 4 },
    { id: "plus_5", test: (r: number) => r >= 5 },
  ].map((cat) => {
    const subset = plus2.filter((row) => cat.test(row.replay.resultR));
    const baseR = subset.reduce((s, row) => s + row.r0.resultR, 0);
    const runR = subset.reduce((s, row) => s + row.replay.resultR, 0);
    return { category: cat.id, count: subset.length, baseline_r: round(baseR, 4), runner_r: round(runR, 4), delta_r: round(runR - baseR, 4) };
  });

  for (const bucket of ["<=3h", "3-6h", "6-12h", "12-24h", "24-48h"]) {
    const subset = plus2.filter((row) => bucketDuration(row.replay.durationMs) === bucket && row.replay.runner);
    durations.push({
      bucket, count: subset.length,
      total_r: round(subset.reduce((s, row) => s + row.replay.resultR, 0), 4),
      avg_r: subset.length ? round(subset.reduce((s, row) => s + row.replay.resultR, 0) / subset.length, 4) : 0,
      delta_vs_baseline_r: round(subset.reduce((s, row) => s + row.replay.resultR - row.r0.resultR, 0), 4),
    });
  }
  const runnerDurations = plus2.filter((row) => row.replay.runner).map((row) => row.replay.durationMs);
  const sortedDur = [...runnerDurations].sort((a, b) => a - b);

  const overnightSet = plus2.filter((row) => row.replay.runner && crossesNy1700(row.trade.decisionMs, row.replay.exitMs));
  const nextDay = plus2.filter((row) => row.replay.runner && new Date(row.replay.exitMs).getUTCDate() !== new Date(row.trade.decisionMs).getUTCDate());
  const over24 = plus2.filter((row) => row.replay.runner && row.replay.durationMs > 24 * HOUR);
  overnight.push(
    { group: "cross_ny_17", count: overnightSet.length, avg_r: overnightSet.length ? round(overnightSet.reduce((s, r) => s + r.replay.resultR, 0) / overnightSet.length, 4) : 0, total_r: round(overnightSet.reduce((s, r) => s + r.replay.resultR, 0), 4), delta_r: round(overnightSet.reduce((s, r) => s + r.replay.resultR - r.r0.resultR, 0), 4), financing_drag_r: "UNAVAILABLE" },
    { group: "next_utc_day", count: nextDay.length, avg_r: nextDay.length ? round(nextDay.reduce((s, r) => s + r.replay.resultR, 0) / nextDay.length, 4) : 0, total_r: round(nextDay.reduce((s, r) => s + r.replay.resultR, 0), 4), delta_r: round(nextDay.reduce((s, r) => s + r.replay.resultR - r.r0.resultR, 0), 4), financing_drag_r: "UNAVAILABLE" },
    { group: "held_over_24h", count: over24.length, avg_r: over24.length ? round(over24.reduce((s, r) => s + r.replay.resultR, 0) / over24.length, 4) : 0, total_r: round(over24.reduce((s, r) => s + r.replay.resultR, 0), 4), delta_r: round(over24.reduce((s, r) => s + r.replay.resultR - r.r0.resultR, 0), 4), financing_drag_r: "UNAVAILABLE" },
  );

  const r0p = portfolioSummary.find((row) => row.variant === "R0")!;
  const r1p = portfolioSummary.find((row) => row.variant === "R1")!;
  const r2p = portfolioSummary.find((row) => row.variant === "R2")!;
  const pairDelta = PAIR_ORDER.map((pair) => {
    const r0 = Number(pairSummary.find((row) => row.pair === pair && row.variant === "R0")?.runner_exp);
    const r1 = Number(pairSummary.find((row) => row.pair === pair && row.variant === "R1")?.runner_exp);
    return { pair, r0, r1, delta: r1 - r0 };
  });
  const improved = pairDelta.filter((row) => row.delta > 1e-9);
  const worsened = pairDelta.filter((row) => row.delta < -1e-9);
  const bestPair = [...pairDelta].sort((a, b) => b.delta - a.delta)[0]!;
  const worstPair = [...pairDelta].sort((a, b) => a.delta - b.delta)[0]!;
  const r1Delta = Number(r1p.expectancy_r) - Number(r0p.expectancy_r);
  const r2Delta = Number(r2p.expectancy_r) - Number(r0p.expectancy_r);
  const yearOk = [2023, 2024, 2025, 2026].filter((year) => {
    const a = Number(years.find((row) => row.variant === "R0" && row.year === year)?.expectancy_r);
    const b = Number(years.find((row) => row.variant === "R1" && row.year === year)?.expectancy_r);
    return b >= a;
  }).length;
  const r1PfUp = Number(r1p.pf) >= Number(r0p.pf);
  const r1TotalUp = Number(r1p.total_r) > Number(r0p.total_r);
  const r1WinnerUp = Number(r1p.average_winner_r) > Number(r0p.average_winner_r);
  const r2Better = r2Delta > r1Delta && r2Delta > 0.005;
  let classification = "NO_RUNNER_EDGE";
  if (r1Delta >= 0.02 && r1PfUp && r1TotalUp && r1WinnerUp && improved.length >= 5 && yearOk >= 3) classification = "RUNNER_EDGE";
  else if (r2Better && Number(r2p.pf) >= Number(r0p.pf) && Number(r2p.total_r) > Number(r0p.total_r) && Number(r2p.average_winner_r) > Number(r0p.average_winner_r)) classification = "PARTIAL_RUNNER_EDGE";
  else if (r1Delta < 0.02 && improved.length <= 2 && bestPair.delta >= 0.03) classification = "PAIR_SPECIFIC_RUNNER";
  else if (r1Delta < 0.005 && r2Delta < 0.005) classification = "NO_RUNNER_EDGE";
  else if (improved.length <= 2) classification = "PAIR_SPECIFIC_RUNNER";
  else classification = "NO_RUNNER_EDGE";

  const below2 = plus2.filter((row) => row.replay.resultR < 2).length;
  const plus3 = plus2.filter((row) => row.replay.resultR >= 3).length;
  const fmt = (n: number, d = 4) => n.toFixed(d);
  const r1Runners = plus2.filter((row) => row.replay.runner);
  const avgRunner = r1Runners.length ? r1Runners.reduce((s, r) => s + r.replay.resultR, 0) / r1Runners.length : 0;
  const medRunner = r1Runners.length ? [...r1Runners].map((r) => r.replay.resultR).sort((a, b) => a - b)[Math.floor(r1Runners.length / 2)]! : 0;
  const maxRunner = r1Runners.length ? Math.max(...r1Runners.map((r) => r.replay.resultR)) : 0;

  const report = `# Frozen portfolio post-+2R runner v1

Research / paper only. Same 1,176 frozen entries as near-target protection v1. No stop is moved before the original executable +2R target. Historical OANDA financing rates are **not** available; all results are **EXEC BEFORE FINANCING**.

## Classification: ${classification}

Best variant: **${Number(r1p.expectancy_r) >= Number(r2p.expectancy_r) && Number(r1p.expectancy_r) >= Number(r0p.expectancy_r) ? "R1 FULL RUNNER" : Number(r2p.expectancy_r) >= Number(r0p.expectancy_r) ? "R2 80/20 RUNNER" : "R0 FROZEN BASELINE"}**.

## R0 sanity

Reproduced **${r0All.trades}** trades, **${fmt(r0All.totalR, 2)}R**, **${fmt(r0All.expectancyR, 4)}R/trade**, PF **${fmt(r0All.pf, 3)}**, WR **${fmt(r0All.wr, 2)}%**.
Prior protection-v1 baseline: 1,176 / +155.84R / +0.1325R / PF 1.249.

## Portfolio (EXEC BEFORE FINANCING)

| Variant | Trades | WR | PF | Total R | Exp R/trade | Avg winner | Avg loser | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${portfolioSummary.map((row) => `| ${row.variant} ${row.label} | ${row.trades} | ${fmt(Number(row.wr), 2)}% | ${fmt(Number(row.pf), 3)} | ${fmt(Number(row.total_r))} | ${fmt(Number(row.expectancy_r), 4)} | ${fmt(Number(row.average_winner_r), 3)} | ${fmt(Number(row.average_loser_r), 3)} | ${fmt(Number(row.max_dd_r))} |`).join("\n")}

Average winner R0 **${fmt(Number(r0p.average_winner_r), 3)}** vs R1 **${fmt(Number(r1p.average_winner_r), 3)}** vs R2 **${fmt(Number(r2p.average_winner_r), 3)}**.

Entry count is identical: **${r0All.trades}** in every variant.

## +2R runner analysis

Trades reaching original executable +2R TP: **${nPlus2}** / 1176 (**${fmt(100 * nPlus2 / 1176, 2)}%**).

R1 runner avg / median / max: **${fmt(avgRunner, 3)} / ${fmt(medRunner, 3)} / ${fmt(maxRunner, 3)}R**.

Exit buckets of original +2R trades under R1:

${changeCats.map((row) => `- ${row.category}: n=${row.count}, baseline ${row.baseline_r}R, runner ${row.runner_r}R, Δ ${row.delta_r}R`).join("\n")}

Fell back below +2R: **${below2}**. Reached +3R+: **${plus3}**.

## Post-+2R continuation (diagnostic, after baseline TP)

Of ${nPlus2} baseline +2R trades, 48h MFE reached:

- +2.2R: ${post2r.filter((r) => r.reach_2_2).length} (${fmt(100 * post2r.filter((r) => r.reach_2_2).length / Math.max(nPlus2, 1), 1)}%)
- +2.5R: ${post2r.filter((r) => r.reach_2_5).length} (${fmt(100 * post2r.filter((r) => r.reach_2_5).length / Math.max(nPlus2, 1), 1)}%)
- +3R: ${post2r.filter((r) => r.reach_3).length} (${fmt(100 * post2r.filter((r) => r.reach_3).length / Math.max(nPlus2, 1), 1)}%)
- +4R: ${post2r.filter((r) => r.reach_4).length} (${fmt(100 * post2r.filter((r) => r.reach_4).length / Math.max(nPlus2, 1), 1)}%)
- +5R: ${post2r.filter((r) => r.reach_5).length} (${fmt(100 * post2r.filter((r) => r.reach_5).length / Math.max(nPlus2, 1), 1)}%)

## Pair results (R0 vs R1)

| Pair | Trades | Base exp | R1 exp | Δ | Base PF | R1 PF | +2R n | R1 avg runner | Max runner |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${PAIR_ORDER.map((pair) => {
    const r0 = pairSummary.find((row) => row.pair === pair && row.variant === "R0")!;
    const r1 = pairSummary.find((row) => row.pair === pair && row.variant === "R1")!;
    return `| ${pair} | ${r1.trades} | ${fmt(Number(r0.runner_exp), 4)} | ${fmt(Number(r1.runner_exp), 4)} | ${fmt(Number(r1.delta), 4)} | ${fmt(Number(r0.runner_pf), 3)} | ${fmt(Number(r1.runner_pf), 3)} | ${r1.plus_2r_trades} | ${fmt(Number(r1.runner_avg_r), 3)} | ${fmt(Number(r1.max_runner_r), 3)} |`;
  }).join("\n")}

Pairs improved under R1: **${improved.length}**. Worsened: **${worsened.length}**. Best: **${bestPair.pair} ${fmt(bestPair.delta, 4)}R**. Worst: **${worstPair.pair} ${fmt(worstPair.delta, 4)}R**.

## Year stability (R0 vs R1)

${[2023, 2024, 2025, 2026].map((year) => {
    const a = years.find((row) => row.variant === "R0" && row.year === year)!;
    const b = years.find((row) => row.variant === "R1" && row.year === year)!;
    return `- ${year}: R0 ${fmt(Number(a.expectancy_r), 3)}R / PF ${a.pf} vs R1 ${fmt(Number(b.expectancy_r), 3)}R / PF ${b.pf} (n=${a.trades})`;
  }).join("\n")}

R1 ≥ R0 in **${yearOk}/4** years.

## Duration (R1 runners)

Average / median / max hours: **${fmt(runnerDurations.length ? runnerDurations.reduce((s, v) => s + v, 0) / runnerDurations.length / HOUR : 0, 2)} / ${fmt(sortedDur.length ? sortedDur[Math.floor(sortedDur.length / 2)]! / HOUR : 0, 2)} / ${fmt(sortedDur.length ? sortedDur.at(-1)! / HOUR : 0, 2)}**.

${durations.map((row) => `- ${row.bucket}: n=${row.count}, total ${row.total_r}R, Δ vs baseline ${row.delta_vs_baseline_r}R`).join("\n")}

## Overnight

- Cross 17:00 New York: n=${overnightSet.length}, avg ${overnight[0]!.avg_r}R, Δ ${overnight[0]!.delta_r}R
- Next UTC day: n=${nextDay.length}, avg ${overnight[1]!.avg_r}R, Δ ${overnight[1]!.delta_r}R
- Held >24h: n=${over24.length}, avg ${overnight[2]!.avg_r}R, Δ ${overnight[2]!.delta_r}R

Financing: **UNAVAILABLE**. Do not treat these as fully net executable overnight results.

Ambiguous activation minutes: **${ambiguous.length}**. Conservative ordering used.

## Decision

1. Baseline expectancy: **${fmt(Number(r0p.expectancy_r), 4)}R/trade**
2. Full-runner expectancy: **${fmt(Number(r1p.expectancy_r), 4)}R**
3. 80/20-runner expectancy: **${fmt(Number(r2p.expectancy_r), 4)}R**
4. PF R0 / R1 / R2: **${fmt(Number(r0p.pf), 3)} / ${fmt(Number(r1p.pf), 3)} / ${fmt(Number(r2p.pf), 3)}**
5. Total R R0 / R1 / R2: **${fmt(Number(r0p.total_r), 2)} / ${fmt(Number(r1p.total_r), 2)} / ${fmt(Number(r2p.total_r), 2)}**
6. Avg winner R0 / R1 / R2: **${fmt(Number(r0p.average_winner_r), 3)} / ${fmt(Number(r1p.average_winner_r), 3)} / ${fmt(Number(r2p.average_winner_r), 3)}**
7. +2R trades that became ≥+3R: **${plus3}**
8. Fell back below +2R: **${below2}**
9. Pairs improved: **${improved.length} / 7**
10. Best / worst pair: **${bestPair.pair} / ${worstPair.pair}**
11. Overnight contribution Δ: **${overnight[0]!.delta_r}R** on ${overnightSet.length} NY-17 crosses
12. Financing: **not measurable**
13. Year stability: **${yearOk}/4 years R1 ≥ R0**
14. Best variant: **${Number(r1p.expectancy_r) >= Number(r2p.expectancy_r) && Number(r1p.expectancy_r) >= Number(r0p.expectancy_r) ? "R1" : Number(r2p.expectancy_r) >= Number(r0p.expectancy_r) ? "R2" : "R0"}**
15. Classification: **${classification}**

${classification === "RUNNER_EDGE" || classification === "PARTIAL_RUNNER_EDGE" ? "Label if promoted later: RUNNER_CANDIDATE_FOR_OOS. Not frozen production logic." : "No OOS budget is justified from this sample."}

No deployment. No broker orders. No entry-rule modifications. No +1.80R pre-target protection.
`;

  await Promise.all([
    writeFile(resolve(OUT, "REPORT.md"), report),
    writeFile(resolve(OUT, "PORTFOLIO_SUMMARY.csv"), toCsv(portfolioSummary)),
    writeFile(resolve(OUT, "PAIR_SUMMARY.csv"), toCsv(pairSummary)),
    writeFile(resolve(OUT, "RUNNER_TRADES.csv"), toCsv(runnerTrades)),
    writeFile(resolve(OUT, "POST_2R_MFE.csv"), toCsv(post2r)),
    writeFile(resolve(OUT, "YEAR_STABILITY.csv"), toCsv(years)),
    writeFile(resolve(OUT, "DURATION_ANALYSIS.csv"), toCsv(durations)),
    writeFile(resolve(OUT, "OVERNIGHT_ANALYSIS.csv"), toCsv(overnight)),
    writeFile(resolve(OUT, "AMBIGUOUS_INTRAMINUTE.csv"), toCsv(ambiguous)),
    writeFile(resolve(OUT, "RAW_RESULTS.json"), `${JSON.stringify({
      generatedAt: new Date().toISOString(), classification, financing: "UNAVAILABLE", resultBasis: "EXEC_BEFORE_FINANCING",
      r0Sanity: { ...r0All, prior: PRIOR_PORTFOLIO }, portfolio: portfolioSummary, pairDelta, changeCats,
      plus2Count: nPlus2, below2, plus3, improved: improved.length, worsened: worsened.length,
      bestPair, worstPair, yearOk, overnight, ambiguous: ambiguous.length, deployment: false, brokerOrders: false,
    }, null, 2)}\n`),
  ]);
  console.log(JSON.stringify({ classification, n: r0All.trades, r0: r0p.expectancy_r, r1: r1p.expectancy_r, r2: r2p.expectancy_r, plus2: nPlus2, below2, plus3, improved: improved.length }, null, 2));
}

void main();
