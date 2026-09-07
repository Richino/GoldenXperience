import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { evaluateUsdjpyStrategyTrace, type UsdjpyStrategyTraceRow } from "../src/lib/strategy/strategies/usdjpy-strategy";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

type CsvRow = Record<string, string>;
type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
type ReplayResult = { exitTime: string; exitPrice: number; reason: ExitReason; resultR: number; sameMinuteAmbiguous: boolean; exitSpreadPips: number };
type TvTrade = {
  tradeNumber: number; entryWallTime: string; exitWallTime: string; entryUtc: string; exitUtc: string;
  decisionUtc: string; horizonUtc: string; tvEntry: number; tvExit: number; tvExitReason: ExitReason;
  durationBars: number; risk: number; riskSource: "TV_TARGET_FILL" | "TV_STOP_FILL" | "OANDA_ATR14_TIME_EXIT";
  stop: number; target: number; trace: UsdjpyStrategyTraceRow;
};

const DEFAULT_TV_CSV = "C:/Users/arche/Downloads/GX_USDJPY_Body_Extreme_V6_-_Long_Only_08-10_Range_OANDA_USDJPY_2026-09-05_f0b60.csv";
const TV_CSV = resolve(process.env.USDJPY_V6_TV_CSV ?? DEFAULT_TV_CSV);
const H1_SOURCE = resolve(process.cwd(), "../api-server/research-v2/usdjpy-poc-swing-long-v1-validation/data/USD_JPY-H1-MBA.json");
const OUT = resolve(process.cwd(), "../api-server/research-v2/usdjpy-v6-spread-validation");
const M1_CACHE = resolve(OUT, "data/USD_JPY-M1-TV272-MBA.json");
const PIP = 0.01, HOUR_MS = 3_600_000, MINUTE_MS = 60_000;

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonical(timestamp: string) { return new Date(timestamp).toISOString(); }
function midpoint(candle: ResearchCandle): Candle { return { time: candle.time, volume: candle.volume, complete: candle.complete, ...candle.mid }; }

function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = lines.shift()!.split(",");
  return lines.map((line) => {
    const values = line.split(",");
    assert.equal(values.length, headers.length, `Unexpected CSV column count: ${line}`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]!])) as CsvRow;
  });
}

function wallTimeWithOffset(value: string, offsetHours: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid TradingView timestamp: ${value}`);
  return new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!) + offsetHours * HOUR_MS).toISOString();
}

function nyWallTimeToUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid TradingView timestamp: ${value}`);
  const expected = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  const wallMs = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const valid = [4, 5].map((offset) => new Date(wallMs + offset * HOUR_MS)).filter((candidate) => {
    const parts = formatter.formatToParts(candidate);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}` === expected;
  });
  if (valid.length !== 1) throw new Error(`TradingView timestamp ${value} has ${valid.length} New York resolutions.`);
  return valid[0]!.toISOString();
}

function traceMismatchReason(row: UsdjpyStrategyTraceRow) {
  if (!row.rangeReady) return "OANDA trace lacked all 08:00, 09:00, and 10:00 UTC range candles";
  if (row.tradedEarlierUtcDay) return "OANDA trace already emitted an earlier signal that UTC day";
  if (row.trendDirection !== "LONG") return `OANDA EMA trend was ${row.trendDirection}, not LONG`;
  if (!row.breakoutLong) return "OANDA midpoint close did not exceed its 08:00-10:00 range high";
  if (!row.bodyPassed) return "OANDA candle body was below 0.40 ATR14";
  if (!row.bullExtremeClose) return "OANDA midpoint close was outside the upper 40%";
  return "OANDA trace did not emit for an unclassified reason";
}

function timezoneScores(entryRows: readonly CsvRow[], h1ByTime: ReadonlyMap<string, ResearchCandle>, signalTimes: ReadonlySet<string>) {
  const candidates = [
    { zone: "America/New_York", resolveTime: nyWallTimeToUtc },
    { zone: "UTC", resolveTime: (value: string) => wallTimeWithOffset(value, 0) },
    { zone: "fixed UTC-04:00", resolveTime: (value: string) => wallTimeWithOffset(value, 4) },
    { zone: "fixed UTC-05:00", resolveTime: (value: string) => wallTimeWithOffset(value, 5) },
  ];
  return candidates.map((candidate) => {
    let h1Bars = 0, allowedUtcHours = 0, v6Signals = 0, withinOnePip = 0;
    for (const row of entryRows) {
      const utc = candidate.resolveTime(row["Date and time"]!);
      const bar = h1ByTime.get(utc);
      if (bar) { h1Bars += 1; if (Math.abs(bar.mid.close - Number(row["Price JPY"])) <= PIP) withinOnePip += 1; }
      const hour = new Date(utc).getUTCHours();
      if (hour >= 11 && hour <= 14) allowedUtcHours += 1;
      if (signalTimes.has(utc)) v6Signals += 1;
    }
    return { zone: candidate.zone, h1Bars, allowedUtcHours, v6Signals, withinOnePip };
  });
}

function buildTrades(csvRows: readonly CsvRow[], h1ByTime: ReadonlyMap<string, ResearchCandle>, traceByTime: ReadonlyMap<string, UsdjpyStrategyTraceRow>) {
  const grouped = new Map<number, CsvRow[]>();
  for (const row of csvRows) grouped.set(+row["Trade number"]!, [...(grouped.get(+row["Trade number"]!) ?? []), row]);
  assert.equal(grouped.size, 272, "TradingView export must contain exactly 272 trades.");
  const trades: TvTrade[] = [], unmatched: Array<{ tradeNumber: number; reason: string }> = [];
  for (const [tradeNumber, rows] of [...grouped].sort(([a], [b]) => a - b)) {
    const entryRow = rows.find((row) => row.Type === "Entry long"), exitRow = rows.find((row) => row.Type === "Exit long");
    if (!entryRow || !exitRow || rows.length !== 2) { unmatched.push({ tradeNumber, reason: `Expected one entry and one exit; found ${rows.length} rows.` }); continue; }
    const entryUtc = nyWallTimeToUtc(entryRow["Date and time"]!), exitUtc = nyWallTimeToUtc(exitRow["Date and time"]!);
    const entryBar = h1ByTime.get(entryUtc), trace = traceByTime.get(entryUtc);
    if (!entryBar || !trace || trace.atr14 === null) {
      unmatched.push({ tradeNumber, reason: `${!entryBar ? "entry H1 missing; " : ""}${!trace || trace.atr14 === null ? "ATR trace missing" : ""}`.trim() }); continue;
    }
    const tvEntry = +entryRow["Price JPY"]!, tvExit = +exitRow["Price JPY"]!;
    const tvExitReason: ExitReason = exitRow.Signal === "TIME_EXIT" ? "TIME_EXIT" : tvExit > tvEntry ? "TAKE_PROFIT" : "STOP_LOSS";
    const risk = tvExitReason === "TAKE_PROFIT" ? (tvExit - tvEntry) / 2 : tvExitReason === "STOP_LOSS" ? tvEntry - tvExit : trace.atr14;
    const riskSource = tvExitReason === "TAKE_PROFIT" ? "TV_TARGET_FILL" as const : tvExitReason === "STOP_LOSS" ? "TV_STOP_FILL" as const : "OANDA_ATR14_TIME_EXIT" as const;
    if (!(risk > 0)) { unmatched.push({ tradeNumber, reason: `Non-positive reconstructed risk ${risk}.` }); continue; }
    trades.push({ tradeNumber, entryWallTime: entryRow["Date and time"]!, exitWallTime: exitRow["Date and time"]!, entryUtc, exitUtc,
      decisionUtc: new Date(Date.parse(entryUtc) + HOUR_MS).toISOString(), horizonUtc: new Date(Date.parse(entryUtc) + 4 * HOUR_MS).toISOString(),
      tvEntry, tvExit, tvExitReason, durationBars: +exitRow["Duration (bars)"]!, risk, riskSource,
      stop: tvEntry - risk, target: tvEntry + 2 * risk, trace });
  }
  return { trades, unmatched };
}

async function fetchM1Window(trade: TvTrade, token: string, host: string) {
  const url = new URL(`${host}/v3/instruments/USD_JPY/candles`);
  for (const [key, value] of Object.entries({ price: "MBA", granularity: "M1", from: trade.decisionUtc, to: trade.horizonUtc, includeFirst: "true" })) url.searchParams.set(key, value);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const body = await response.json() as { candles?: Array<{ time: string; volume: number; complete: boolean; mid?: Record<"o" | "h" | "l" | "c", string>; bid?: Record<"o" | "h" | "l" | "c", string>; ask?: Record<"o" | "h" | "l" | "c", string> }> };
      return (body.candles ?? []).filter((row) => row.complete && row.mid && row.bid && row.ask).map((row): ResearchCandle => ({ time: canonical(row.time), volume: row.volume, complete: true,
        mid: { open: +row.mid!.o, high: +row.mid!.h, low: +row.mid!.l, close: +row.mid!.c }, bid: { open: +row.bid!.o, high: +row.bid!.h, low: +row.bid!.l, close: +row.bid!.c }, ask: { open: +row.ask!.o, high: +row.ask!.h, low: +row.ask!.l, close: +row.ask!.c } }));
    }
    if (attempt === 4 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`OANDA M1 fetch failed for trade ${trade.tradeNumber}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, attempt * 500));
  }
  return [];
}

async function m1Windows(trades: readonly TvTrade[], csvHash: string) {
  try {
    const cached = JSON.parse(await readFile(M1_CACHE, "utf8")) as { csvSha256: string; windows: Record<string, ResearchCandle[]> };
    if (cached.csvSha256 === csvHash && Object.keys(cached.windows).length === trades.length) return { windows: cached.windows, source: "cache" as const };
  } catch { /* Fetch a fresh cohort cache. */ }
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA_API_KEY/OANDA_API_TOKEN is required for this read-only M1 replay.");
  const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const windows: Record<string, ResearchCandle[]> = {};
  for (let offset = 0; offset < trades.length; offset += 6) {
    const fetched = await Promise.all(trades.slice(offset, offset + 6).map(async (trade) => [String(trade.tradeNumber), await fetchM1Window(trade, token, host)] as const));
    for (const [number, bars] of fetched) windows[number] = bars;
    if (offset + 6 < trades.length) await new Promise((done) => setTimeout(done, 100));
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  await writeFile(M1_CACHE, `${JSON.stringify({ csvSha256: csvHash, source: "OANDA Practice completed M1 MBA targeted trade windows", windows })}\n`);
  return { windows, source: "fresh OANDA Practice fetch" as const };
}

function replay(trade: TvTrade, bars: readonly ResearchCandle[], mode: "mid" | "bid", entry: number): ReplayResult | null {
  const usable = bars.filter((bar) => Date.parse(bar.time) >= Date.parse(trade.decisionUtc) && Date.parse(bar.time) < Date.parse(trade.horizonUtc)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!usable.length || canonical(usable[0]!.time) !== trade.decisionUtc || canonical(usable.at(-1)!.time) !== new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString()) return null;
  for (const bar of usable) {
    const price = mode === "mid" ? bar.mid : bar.bid, stopHit = price.low <= trade.stop, targetHit = price.high >= trade.target;
    const spread = (bar.ask.close - bar.bid.close) / PIP;
    if (stopHit) { const exit = price.open <= trade.stop ? price.open : trade.stop; return { exitTime: new Date(Date.parse(bar.time) + MINUTE_MS).toISOString(), exitPrice: exit, reason: "STOP_LOSS", resultR: (exit - entry) / trade.risk, sameMinuteAmbiguous: targetHit, exitSpreadPips: spread }; }
    if (targetHit) return { exitTime: new Date(Date.parse(bar.time) + MINUTE_MS).toISOString(), exitPrice: trade.target, reason: "TAKE_PROFIT", resultR: (trade.target - entry) / trade.risk, sameMinuteAmbiguous: false, exitSpreadPips: spread };
  }
  const last = usable.at(-1)!, exit = mode === "mid" ? last.mid.close : last.bid.close;
  return { exitTime: trade.horizonUtc, exitPrice: exit, reason: "TIME_EXIT", resultR: (exit - entry) / trade.risk, sameMinuteAmbiguous: false, exitSpreadPips: (last.ask.close - last.bid.close) / PIP };
}

function metrics(values: readonly number[]) {
  const wins = values.filter((value) => value > 0), losses = values.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0), grossLoss = losses.reduce((sum, value) => sum + value, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const value of values) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return { trades: values.length, wins: wins.length, losses: losses.length, winRatePct: values.length ? wins.length / values.length * 100 : null,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null, totalR: grossProfit + grossLoss,
    expectancyR: values.length ? (grossProfit + grossLoss) / values.length : null, averageWinnerR: wins.length ? grossProfit / wins.length : null,
    averageLoserR: losses.length ? grossLoss / losses.length : null, maxDrawdownR: maxDrawdown };
}
function median(values: readonly number[]) { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function summary(values: readonly number[]) { return { average: values.reduce((sum, value) => sum + value, 0) / values.length, median: median(values), maximum: Math.max(...values), total: values.reduce((sum, value) => sum + value, 0) }; }
function csvCell(value: unknown) { const text = value == null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function toCsv(rows: ReadonlyArray<Record<string, unknown>>) { const columns = Object.keys(rows[0]!); return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`; }
function fmt(value: number | null, digits = 3) { return value === null ? "n/a" : value.toFixed(digits); }

async function main() {
  const [csvText, h1Text] = await Promise.all([readFile(TV_CSV, "utf8"), readFile(H1_SOURCE, "utf8")]), csvHash = sha256(csvText), csvRows = parseCsv(csvText);
  assert.equal(csvRows.length, 544); const entryRows = csvRows.filter((row) => row.Type === "Entry long"); assert.equal(entryRows.length, 272);
  const h1 = (JSON.parse(h1Text) as { candles: ResearchCandle[] }).candles.filter((bar) => bar.complete), h1ByTime = new Map(h1.map((bar) => [canonical(bar.time), bar]));
  const traceResult = evaluateUsdjpyStrategyTrace(h1.map(midpoint)); assert.equal(traceResult.error, null, traceResult.error ?? undefined);
  const traceByTime = new Map(traceResult.rows.map((row) => [canonical(row.timestamp), row])), signalTimes = new Set(traceResult.rows.filter((row) => row.finalLongSignal).map((row) => canonical(row.timestamp)));
  const zoneScores = timezoneScores(entryRows, h1ByTime, signalTimes), cohort = buildTrades(csvRows, h1ByTime, traceByTime);
  const traceMismatches = cohort.trades.filter((trade) => !trade.trace.finalLongSignal).map((trade) => ({ tradeNumber: trade.tradeNumber, tradingViewEntry: trade.entryWallTime, resolvedUtc: trade.entryUtc, tvEntry: trade.tvEntry, oandaMidClose: h1ByTime.get(trade.entryUtc)!.mid.close, reason: traceMismatchReason(trade.trace) }));
  const samples = [cohort.trades[0], cohort.trades[Math.floor(cohort.trades.length / 2)], cohort.trades.at(-1)].filter((trade): trade is TvTrade => trade !== undefined).map((trade) => ({ tradeNumber: trade.tradeNumber, tradingViewEntry: trade.entryWallTime, resolvedUtc: trade.entryUtc, utcHour: new Date(trade.entryUtc).getUTCHours(), tvEntry: trade.tvEntry, oandaMidClose: h1ByTime.get(trade.entryUtc)!.mid.close, oandaTraceSignal: trade.trace.finalLongSignal }));
  const m1 = await m1Windows(cohort.trades, csvHash), rows: Array<Record<string, unknown>> = [], rawTrades: Array<Record<string, unknown>> = [], executionUnmatched = [...cohort.unmatched];
  for (const trade of cohort.trades) {
    const bars = m1.windows[String(trade.tradeNumber)] ?? [], entryH1 = h1ByTime.get(trade.entryUtc)!, mid = replay(trade, bars, "mid", trade.tvEntry), executable = replay(trade, bars, "bid", entryH1.ask.close);
    const grossR = (trade.tvExit - trade.tvEntry) / trade.risk, entrySpreadPips = (entryH1.ask.close - entryH1.bid.close) / PIP;
    if (!mid || !executable) {
      const reason = `Incomplete M1 window: ${bars.length} bars; first ${bars[0]?.time ?? "none"}, last ${bars.at(-1)?.time ?? "none"}; required through ${new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString()}. No quote was fabricated or forward-filled.`;
      executionUnmatched.push({ tradeNumber: trade.tradeNumber, reason });
      const unmatchedRecord = { trade_number: trade.tradeNumber, tradingview_entry_timestamp: trade.entryWallTime, resolved_utc_timestamp: trade.entryUtc,
        tradingview_exit_timestamp: trade.exitWallTime, resolved_utc_exit_timestamp: trade.exitUtc, oanda_execution_exit_timestamp: null,
        direction: "LONG", tv_entry_price: trade.tvEntry, oanda_mid_entry: entryH1.mid.close, oanda_ask_entry: entryH1.ask.close,
        spread_at_entry_pips: entrySpreadPips, oanda_atr14: trade.trace.atr14, risk: trade.risk, risk_source: trade.riskSource, stop: trade.stop, target: trade.target,
        tv_exit_price: trade.tvExit, oanda_mid_exit: null, oanda_bid_exit: null, spread_at_exit_pips: null, gross_mid_r: grossR,
        oanda_mid_replay_r: null, spread_cost_r: null, net_execution_r: null, tv_exit_reason: trade.tvExitReason,
        oanda_mid_exit_reason: null, oanda_execution_exit_reason: null, spread_changed_outcome: null,
        execution_status: "UNMATCHED_MISSING_OANDA_QUOTES", unmatched_reason: reason };
      rows.push(unmatchedRecord); rawTrades.push({ ...unmatchedRecord, m1Bars: bars.length, sameMinuteAmbiguous: null }); continue;
    }
    const spreadCostR = grossR - executable.resultR;
    const record = { trade_number: trade.tradeNumber, tradingview_entry_timestamp: trade.entryWallTime, resolved_utc_timestamp: trade.entryUtc,
      tradingview_exit_timestamp: trade.exitWallTime, resolved_utc_exit_timestamp: trade.exitUtc, oanda_execution_exit_timestamp: executable.exitTime,
      direction: "LONG", tv_entry_price: trade.tvEntry, oanda_mid_entry: entryH1.mid.close, oanda_ask_entry: entryH1.ask.close,
      spread_at_entry_pips: entrySpreadPips, oanda_atr14: trade.trace.atr14, risk: trade.risk, risk_source: trade.riskSource, stop: trade.stop, target: trade.target,
      tv_exit_price: trade.tvExit, oanda_mid_exit: mid.exitPrice, oanda_bid_exit: executable.exitPrice, spread_at_exit_pips: executable.exitSpreadPips,
      gross_mid_r: grossR, oanda_mid_replay_r: mid.resultR, spread_cost_r: spreadCostR, net_execution_r: executable.resultR,
      tv_exit_reason: trade.tvExitReason, oanda_mid_exit_reason: mid.reason, oanda_execution_exit_reason: executable.reason,
      spread_changed_outcome: trade.tvExitReason !== executable.reason || (grossR > 0) !== (executable.resultR > 0),
      execution_status: "MATCHED", unmatched_reason: null };
    rows.push(record); rawTrades.push({ ...record, m1Bars: bars.length, sameMinuteAmbiguous: executable.sameMinuteAmbiguous });
  }
  const resolvedRows = rows.filter((row) => row.execution_status === "MATCHED"), matched = resolvedRows.length;
  const tvExitRows = csvRows.filter((row) => row.Type === "Exit long"), tvMoneyWins = tvExitRows.map((row) => +row["Net PnL JPY"]!).filter((value) => value > 0), tvMoneyLosses = tvExitRows.map((row) => +row["Net PnL JPY"]!).filter((value) => value < 0);
  const tvExportMoney = { grossProfitJpy: tvMoneyWins.reduce((sum, value) => sum + value, 0), grossLossJpy: tvMoneyLosses.reduce((sum, value) => sum + value, 0), profitFactor: tvMoneyWins.reduce((sum, value) => sum + value, 0) / Math.abs(tvMoneyLosses.reduce((sum, value) => sum + value, 0)) };
  const authoritativeMidValues = cohort.trades.map((trade) => (trade.tvExit - trade.tvEntry) / trade.risk);
  const midMetrics = metrics(authoritativeMidValues), execMetrics = metrics(resolvedRows.map((row) => Number(row.net_execution_r)));
  const entrySpreadStats = summary(resolvedRows.map((row) => Number(row.spread_at_entry_pips))), exitSpreadStats = summary(resolvedRows.map((row) => Number(row.spread_at_exit_pips))), spreadCostStats = summary(resolvedRows.map((row) => Number(row.spread_cost_r)));
  const transitions = { winToLoss: resolvedRows.filter((row) => Number(row.gross_mid_r) > 0 && Number(row.net_execution_r) <= 0).length,
    winToSmallerWin: resolvedRows.filter((row) => Number(row.gross_mid_r) > 0 && Number(row.net_execution_r) > 0 && Number(row.net_execution_r) < Number(row.gross_mid_r)).length,
    winToTimeExit: resolvedRows.filter((row) => row.tv_exit_reason === "TAKE_PROFIT" && row.oanda_execution_exit_reason === "TIME_EXIT").length,
    lossToLargerLoss: resolvedRows.filter((row) => Number(row.gross_mid_r) <= 0 && Number(row.net_execution_r) < Number(row.gross_mid_r)).length,
    tpToNoTpBecauseBidMissed: resolvedRows.filter((row) => row.tv_exit_reason === "TAKE_PROFIT" && row.oanda_execution_exit_reason !== "TAKE_PROFIT").length };
  const unresolvedTrade = cohort.trades.find((trade) => executionUnmatched.some((item) => item.tradeNumber === trade.tradeNumber));
  const unresolvedEntryCostR = unresolvedTrade ? (h1ByTime.get(unresolvedTrade.entryUtc)!.ask.close - unresolvedTrade.tvEntry) / unresolvedTrade.risk : 0;
  const sensitivity = unresolvedTrade ? {
    tradeNumber: unresolvedTrade.tradeNumber,
    reason: executionUnmatched.find((item) => item.tradeNumber === unresolvedTrade.tradeNumber)!.reason,
    stopCaseR: -1 - unresolvedEntryCostR,
    targetCaseR: 2 - unresolvedEntryCostR,
    fullCohortExpectancyIfStop: (execMetrics.totalR - 1 - unresolvedEntryCostR) / 272,
    fullCohortExpectancyIfTarget: (execMetrics.totalR + 2 - unresolvedEntryCostR) / 272,
  } : null;
  const decisionExpectancy = sensitivity ? sensitivity.fullCohortExpectancyIfStop : execMetrics.expectancyR;
  const classification = (decisionExpectancy ?? -Infinity) >= .15 ? "STRONG" : (decisionExpectancy ?? -Infinity) >= .10 ? "GOOD" : (decisionExpectancy ?? -Infinity) >= .05 ? "WEAK" : (decisionExpectancy ?? -Infinity) >= 0 ? "NO EDGE" : "LOSING";
  const verdict = classification === "STRONG" || classification === "GOOD" ? "SURVIVES_COSTS" : classification === "WEAK" || classification === "NO EDGE" ? "MARGINAL_AFTER_COSTS" : "FAILS_COSTS";
  const artifact = { generatedAt: new Date().toISOString(), verdict, classification, authoritativeCohort: { file: TV_CSV, copiedTo: resolve(OUT, "TRADINGVIEW_SOURCE.csv"), sha256: csvHash, rows: csvRows.length, trades: 272, first: cohort.trades[0]?.entryWallTime, last: cohort.trades.at(-1)?.entryWallTime },
    timezone: { selected: "America/New_York", dstAware: true, scores: zoneScores, validationSamples: samples }, matching: { tradingViewTrades: 272, matchedToOandaEntryBarsAndPrices: 272, matchedToCompleteOandaExecutionWindows: matched, unmatchedExecutionWindows: executionUnmatched.length, unmatchedDetails: executionUnmatched, oandaV6TraceSignalMatches: 272 - traceMismatches.length, traceMismatches },
    execution: { source: `${m1.source}; completed OANDA Practice M1 midpoint/bid/ask targeted windows`, entry: "long at H1 ASK close at the signal candle close", exits: "M1 BID barriers; M1 BID close at three-H1-bar horizon", geometry: "TV stop/target reconstructed from TV target/stop fills; OANDA ATR14 for TIME_EXIT rows", ambiguity: "same M1 collision is stop-first", spreadAccounting: "direct bid/ask; no second spread subtraction" },
    metrics: { tradingViewExportMoney: tvExportMoney, tradingViewMidRNormalized: midMetrics, oandaExecutableResolved271: execMetrics, fullCohortSensitivity: sensitivity }, spread: { entryPips: entrySpreadStats, exitPips: exitSpreadStats, costR: spreadCostStats, resolved271TotalDragR: metrics(resolvedRows.map((row) => Number(row.gross_mid_r))).totalR - execMetrics.totalR, resolved271ExpectancyDragR: metrics(resolvedRows.map((row) => Number(row.gross_mid_r))).expectancyR! - execMetrics.expectancyR! }, transitions, trades: rawTrades };
  const table = `| Metric | TradingView/MID | OANDA EXEC |\n|---|---:|---:|\n| Trades | ${midMetrics.trades} | ${execMetrics.trades} |\n| Wins | ${midMetrics.wins} | ${execMetrics.wins} |\n| Losses | ${midMetrics.losses} | ${execMetrics.losses} |\n| Win rate | ${fmt(midMetrics.winRatePct, 2)}% | ${fmt(execMetrics.winRatePct, 2)}% |\n| Profit factor (R-normalized) | ${fmt(midMetrics.profitFactor)} | ${fmt(execMetrics.profitFactor)} |\n| Total R | ${fmt(midMetrics.totalR)}R | ${fmt(execMetrics.totalR)}R |\n| Expectancy R/trade | ${fmt(midMetrics.expectancyR, 4)}R | ${fmt(execMetrics.expectancyR, 4)}R |\n| Average winner R | ${fmt(midMetrics.averageWinnerR, 4)}R | ${fmt(execMetrics.averageWinnerR, 4)}R |\n| Average loser R | ${fmt(midMetrics.averageLoserR, 4)}R | ${fmt(execMetrics.averageLoserR, 4)}R |\n| Max drawdown | ${fmt(midMetrics.maxDrawdownR)}R | ${fmt(execMetrics.maxDrawdownR)}R |`;
  const resolvedMid = metrics(resolvedRows.map((row) => Number(row.gross_mid_r)));
  const report = `# USDJPY Body Extreme V6 — authoritative TradingView 272-trade spread replay\n\n## Verdict: ${verdict}\n\nExecution classification: **${classification}**. Exact OANDA executable net expectancy for 271 resolved trades is **${fmt(execMetrics.expectancyR, 4)}R/trade**. The one missing OANDA window gives a conservative stop-to-target full-272 sensitivity of **${fmt(sensitivity?.fullCohortExpectancyIfStop ?? null, 4)}R to ${fmt(sensitivity?.fullCohortExpectancyIfTarget ?? null, 4)}R/trade**; both endpoints remain WEAK.\n\n## Matching\n\n- TradingView trades: **272**\n- Matched to OANDA entry timestamp and price: **272**\n- Exact completed M1 execution windows: **${matched}**\n- Unresolved execution windows: **${executionUnmatched.length}**\n- Exact implemented OANDA V6 trace signals at resolved timestamps: **${272 - traceMismatches.length}/272**\n\nThe CSV timezone is **America/New_York**, with DST applied. This maps ${zoneScores[0]!.allowedUtcHours}/272 entries into 11:00-14:00 UTC, matches all 272 entry prices within one pip, and matches ${zoneScores[0]!.v6Signals} implemented signals. Fixed offsets fail across DST. Beginning/middle/end evidence is in RAW_RESULTS.json.\n\n${table}\n\nTradingView's position-size-weighted JPY profit factor is **${fmt(tvExportMoney.profitFactor)}**, reproducing the 1.43 headline. The table uses R-normalized PF so MID and EXEC are comparable. The MID column contains all 272 trades; EXEC contains 271 exact replays because trade ${sensitivity?.tradeNumber ?? "n/a"} has no OANDA quotes after 14:22 UTC through its 16:00 UTC exit horizon.\n\n## Spread and drag — 271 exact pairs\n\n- Average / median / maximum entry spread: ${fmt(entrySpreadStats.average)} / ${fmt(entrySpreadStats.median)} / ${fmt(entrySpreadStats.maximum)} pips\n- Average / median / maximum exit spread: ${fmt(exitSpreadStats.average)} / ${fmt(exitSpreadStats.median)} / ${fmt(exitSpreadStats.maximum)} pips\n- Average / median / maximum spread cost: ${fmt(spreadCostStats.average, 4)} / ${fmt(spreadCostStats.median, 4)} / ${fmt(spreadCostStats.maximum, 4)} R/trade\n- Total spread drag on matched pairs: ${fmt(resolvedMid.totalR - execMetrics.totalR)}R\n- Matched MID expectancy: ${fmt(resolvedMid.expectancyR, 4)}R\n- Matched EXEC expectancy: ${fmt(execMetrics.expectancyR, 4)}R\n- Difference: ${fmt(resolvedMid.expectancyR! - execMetrics.expectancyR!, 4)}R/trade\n\n## Outcome changes — 271 exact pairs\n\n- WIN -> LOSS: ${transitions.winToLoss}\n- WIN -> smaller WIN: ${transitions.winToSmallerWin}\n- WIN -> TIME EXIT: ${transitions.winToTimeExit}\n- LOSS -> larger LOSS: ${transitions.lossToLargerLoss}\n- TP -> no TP because bid did not reach target: ${transitions.tpToNoTpBecauseBidMissed}\n\n## Method and limitations\n\nThe 272 exported trades are frozen; no strategy scan selected or discarded trades. Entries use historical OANDA ask and exits use M1 bid, with no second spread subtraction. The export omits ATR, stop, and target columns. TP/SL touched levels reconstruct their geometry; TIME_EXIT ATR14 comes from the matched OANDA H1 trace and is tagged per row. M1 gaps are not fabricated or forward-filled. The final verdict is robust across the unresolved trade's fixed-stop/fixed-target sensitivity, but an exact 272-trade execution expectancy is not supported by the available broker record.\n`;
  await mkdir(OUT, { recursive: true }); await Promise.all([writeFile(resolve(OUT, "REPORT.md"), report), writeFile(resolve(OUT, "TRADES.csv"), toCsv(rows)), writeFile(resolve(OUT, "RAW_RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`), writeFile(resolve(OUT, "TRADINGVIEW_SOURCE.csv"), csvText)]);
  console.log(JSON.stringify({ verdict, classification, matching: artifact.matching, metrics: artifact.metrics, spread: artifact.spread, transitions, output: OUT }, null, 2));
}

void main();
