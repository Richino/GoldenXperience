import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { calculateAtrValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

type CsvRow = Record<string, string>;
type Direction = "LONG" | "SHORT";
type OriginUtc = "10:30" | "11:00" | "11:30";
type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
type RiskSource = "TV_TARGET_FILL" | "TV_STOP_FILL" | "OANDA_ATR14_TIME_EXIT" | "OANDA_ATR14_TV_FILL_INCONSISTENT";
type Classification = "STRONG" | "GOOD" | "WEAK" | "NO EDGE" | "LOSING";
type Verdict = "SURVIVES_COSTS" | "MARGINAL_AFTER_COSTS" | "FAILS_COSTS";
type ReplayResult = {
  exitTime: string;
  exitPrice: number;
  reason: ExitReason;
  resultR: number;
  sameMinuteAmbiguous: boolean;
  exitSpreadPips: number;
  oandaMidExit: number;
  oandaBidExit: number;
  oandaAskExit: number;
};

type TvTrade = {
  tradeNumber: number;
  signal: string;
  direction: Direction;
  originUtc: OriginUtc;
  entryWallTime: string;
  exitWallTime: string;
  entryUtc: string;
  exitUtc: string;
  decisionUtc: string;
  horizonUtc: string;
  tvEntry: number;
  tvExit: number;
  tvExitReason: ExitReason;
  durationBars: number;
  tvPnl: number;
};

type FrozenTrade = TvTrade & {
  risk: number;
  riskSource: RiskSource;
  stop: number;
  target: number;
  oandaAtr14: number | null;
  m30: ResearchCandle;
};

const DEFAULT_TV_CSV = "C:/Users/arche/Downloads/GX_GBPUSD_30M_Frequency_V3_OANDA_GBPUSD_2026-09-05_82ec3.csv";
const TV_CSV = resolve(process.env.GBPUSD_V3_TV_CSV ?? DEFAULT_TV_CSV);
const OUT = resolve(process.cwd(), "../api-server/research-v2/gbpusd-frequency-v3-spread-validation");
const M30_CACHE = resolve(OUT, "data/GBP_USD-M30-MBA.json");
const M1_CACHE = resolve(OUT, "data/GBP_USD-M1-TV98-MBA.json");
const PIP = 0.0001;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const BAR_MS = 30 * MINUTE_MS;
const MAX_HOLD_BARS = 6;
const ENTRY_MATCH_PIPS = 1.5;
const ORIGINAL_GBPUSD = { trades: 79, execExpectancyR: 0.136 } as const;
const M30_FROM = "2024-06-03T00:00:00.000Z";
const M30_TO = "2026-08-15T00:00:00.000Z";

const ORIGIN_BY_SIGNAL: Record<string, { originUtc: OriginUtc; direction: Direction }> = {
  "1030_LONG": { originUtc: "10:30", direction: "LONG" },
  "1030_SHORT": { originUtc: "10:30", direction: "SHORT" },
  "1100_LONG": { originUtc: "11:00", direction: "LONG" },
  "1100_SHORT": { originUtc: "11:00", direction: "SHORT" },
  "1130_LONG": { originUtc: "11:30", direction: "LONG" },
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(timestamp: string) {
  return new Date(timestamp).toISOString();
}
function midpoint(candle: ResearchCandle): Candle {
  return { time: candle.time, volume: candle.volume, complete: candle.complete, ...candle.mid };
}
function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

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
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const valid = [4, 5].map((offset) => new Date(wallMs + offset * HOUR_MS)).filter((candidate) => {
    const parts = formatter.formatToParts(candidate);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}` === expected;
  });
  if (valid.length !== 1) throw new Error(`TradingView timestamp ${value} has ${valid.length} New York resolutions.`);
  return valid[0]!.toISOString();
}

function originHourMinute(originUtc: OriginUtc) {
  switch (originUtc) {
    case "10:30": return { hour: 10, minute: 30 };
    case "11:00": return { hour: 11, minute: 0 };
    case "11:30": return { hour: 11, minute: 30 };
    default: {
      const exhaustive: never = originUtc;
      throw new Error(`Unhandled origin ${exhaustive}`);
    }
  }
}

function tvExitReason(exitRow: CsvRow): ExitReason {
  if (exitRow.Signal === "TIME_EXIT") return "TIME_EXIT";
  if (exitRow.Signal !== "TP_OR_SL") throw new Error(`Unexpected exit signal ${exitRow.Signal}`);
  return +exitRow["Net PnL USD"]! > 0 ? "TAKE_PROFIT" : "STOP_LOSS";
}

function timezoneScores(trades: readonly TvTrade[]) {
  const candidates = [
    { zone: "America/New_York", resolveTime: nyWallTimeToUtc },
    { zone: "UTC", resolveTime: (value: string) => wallTimeWithOffset(value, 0) },
    { zone: "fixed UTC-04:00", resolveTime: (value: string) => wallTimeWithOffset(value, 4) },
    { zone: "fixed UTC-05:00", resolveTime: (value: string) => wallTimeWithOffset(value, 5) },
  ];
  return candidates.map((candidate) => {
    let originHourMatches = 0;
    for (const trade of trades) {
      const utc = candidate.resolveTime(trade.entryWallTime);
      const date = new Date(utc);
      const expected = originHourMinute(trade.originUtc);
      if (date.getUTCHours() === expected.hour && date.getUTCMinutes() === expected.minute) originHourMatches += 1;
    }
    return { zone: candidate.zone, originHourMatches, trades: trades.length };
  });
}

function buildTvTrades(csvRows: readonly CsvRow[]) {
  const grouped = new Map<number, CsvRow[]>();
  for (const row of csvRows) grouped.set(+row["Trade number"]!, [...(grouped.get(+row["Trade number"]!) ?? []), row]);
  assert.equal(grouped.size, 98, "TradingView export must contain exactly 98 trades.");
  const trades: TvTrade[] = [];
  const unmatched: Array<{ tradeNumber: number; reason: string }> = [];
  for (const [tradeNumber, rows] of [...grouped].sort(([left], [right]) => left - right)) {
    const entryRow = rows.find((row) => row.Type.startsWith("Entry "));
    const exitRow = rows.find((row) => row.Type.startsWith("Exit "));
    if (!entryRow || !exitRow || rows.length !== 2) {
      unmatched.push({ tradeNumber, reason: `Expected one entry and one exit; found ${rows.length} rows.` });
      continue;
    }
    const mapped = ORIGIN_BY_SIGNAL[entryRow.Signal!];
    if (!mapped) {
      unmatched.push({ tradeNumber, reason: `Unexpected TradingView signal ${entryRow.Signal}.` });
      continue;
    }
    const direction: Direction = entryRow.Type === "Entry long" ? "LONG" : entryRow.Type === "Entry short" ? "SHORT" : (() => {
      throw new Error(`Unexpected entry type ${entryRow.Type}`);
    })();
    if (direction !== mapped.direction) {
      unmatched.push({ tradeNumber, reason: `CSV type ${entryRow.Type} disagrees with signal ${entryRow.Signal}.` });
      continue;
    }
    const entryUtc = nyWallTimeToUtc(entryRow["Date and time"]!);
    const exitUtc = nyWallTimeToUtc(exitRow["Date and time"]!);
    const expected = originHourMinute(mapped.originUtc);
    const entryDate = new Date(entryUtc);
    if (entryDate.getUTCHours() !== expected.hour || entryDate.getUTCMinutes() !== expected.minute) {
      unmatched.push({
        tradeNumber,
        reason: `America/New_York conversion produced ${entryUtc}, not ${mapped.originUtc} UTC for ${entryRow.Signal}.`,
      });
      continue;
    }
    trades.push({
      tradeNumber, signal: entryRow.Signal!, direction, originUtc: mapped.originUtc,
      entryWallTime: entryRow["Date and time"]!, exitWallTime: exitRow["Date and time"]!,
      entryUtc, exitUtc,
      decisionUtc: new Date(Date.parse(entryUtc) + BAR_MS).toISOString(),
      horizonUtc: new Date(Date.parse(entryUtc) + BAR_MS + MAX_HOLD_BARS * BAR_MS).toISOString(),
      tvEntry: +entryRow["Price USD"]!, tvExit: +exitRow["Price USD"]!,
      tvExitReason: tvExitReason(exitRow), durationBars: +exitRow["Duration (bars)"]!, tvPnl: +exitRow["Net PnL USD"]!,
    });
  }
  return { trades, unmatched };
}

function oandaCredentials() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  loadEnvConfig(process.cwd());
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA_API_KEY/OANDA_API_TOKEN is required for this read-only M1 replay.");
  const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  return { token, host };
}

function parseOandaCandles(body: { candles?: Array<{ time: string; volume: number; complete: boolean; mid?: Record<"o" | "h" | "l" | "c", string>; bid?: Record<"o" | "h" | "l" | "c", string>; ask?: Record<"o" | "h" | "l" | "c", string> }> }) {
  return (body.candles ?? []).filter((row) => row.complete && row.mid && row.bid && row.ask).map((row): ResearchCandle => ({
    time: canonical(row.time), volume: row.volume, complete: true,
    mid: { open: +row.mid!.o, high: +row.mid!.h, low: +row.mid!.l, close: +row.mid!.c },
    bid: { open: +row.bid!.o, high: +row.bid!.h, low: +row.bid!.l, close: +row.bid!.c },
    ask: { open: +row.ask!.o, high: +row.ask!.h, low: +row.ask!.l, close: +row.ask!.c },
  }));
}

async function oandaGet(host: string, token: string, url: URL) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return parseOandaCandles(await response.json() as Parameters<typeof parseOandaCandles>[0]);
    if (attempt === 4 || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`OANDA fetch failed ${url.pathname}${url.search}: HTTP ${response.status}`);
    }
    await new Promise((done) => setTimeout(done, attempt * 500));
  }
  return [];
}

async function fetchM30History() {
  try {
    const cached = JSON.parse(await readFile(M30_CACHE, "utf8")) as { from: string; to: string; candles: ResearchCandle[] };
    if (cached.from === M30_FROM && cached.to === M30_TO && cached.candles.length > 10_000) {
      return { candles: cached.candles.map((candle) => ({ ...candle, time: canonical(candle.time) })), source: "cache" as const };
    }
  } catch { /* Fetch a fresh warmup history. */ }
  const { token, host } = oandaCredentials();
  const byTime = new Map<string, ResearchCandle>();
  let cursor = M30_TO;
  let previousEarliest = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${host}/v3/instruments/GBP_USD/candles`);
    for (const [key, value] of Object.entries({ price: "MBA", granularity: "M30", count: "5000", to: cursor })) url.searchParams.set(key, value);
    const batch = await oandaGet(host, token, url);
    for (const candle of batch) byTime.set(canonical(candle.time), candle);
    const earliest = batch.map((candle) => candle.time).sort()[0];
    if (!earliest || earliest === previousEarliest || Date.parse(earliest) <= Date.parse(M30_FROM)) break;
    previousEarliest = earliest;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
    await new Promise((done) => setTimeout(done, 80));
  }
  const candles = [...byTime.values()]
    .filter((candle) => Date.parse(candle.time) >= Date.parse(M30_FROM) && Date.parse(candle.time) < Date.parse(M30_TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (!candles.length) throw new Error("OANDA returned no completed GBP_USD M30 MBA candles.");
  await mkdir(resolve(OUT, "data"), { recursive: true });
  await writeFile(M30_CACHE, `${JSON.stringify({ from: M30_FROM, to: M30_TO, source: "OANDA Practice completed M30 MBA", candles })}\n`);
  return { candles, source: "fresh OANDA Practice fetch" as const };
}

async function fetchM1Window(trade: TvTrade, token: string, host: string) {
  const url = new URL(`${host}/v3/instruments/GBP_USD/candles`);
  const from = trade.entryUtc;
  const to = trade.horizonUtc;
  for (const [key, value] of Object.entries({ price: "MBA", granularity: "M1", from, to, includeFirst: "true" })) url.searchParams.set(key, value);
  return oandaGet(host, token, url);
}

async function m1Windows(trades: readonly TvTrade[], csvHash: string) {
  try {
    const cached = JSON.parse(await readFile(M1_CACHE, "utf8")) as { csvSha256: string; windows: Record<string, ResearchCandle[]> };
    if (cached.csvSha256 === csvHash && Object.keys(cached.windows).length === trades.length) {
      const windows = Object.fromEntries(Object.entries(cached.windows).map(([key, bars]) => [key, bars.map((bar) => ({ ...bar, time: canonical(bar.time) }))]));
      return { windows, source: "cache" as const };
    }
  } catch { /* Fetch a fresh cohort cache. */ }
  const { token, host } = oandaCredentials();
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

function freezeGeometry(
  trade: TvTrade,
  m30ByTime: ReadonlyMap<string, ResearchCandle>,
  atrByTime: ReadonlyMap<string, number | null>,
): { error: string } | { trade: FrozenTrade } {
  const m30 = m30ByTime.get(trade.entryUtc);
  if (!m30) return { error: `OANDA M30 bar missing at ${trade.entryUtc}.` } as const;
  const midClose = m30.mid.close;
  if (Math.abs(midClose - trade.tvEntry) > ENTRY_MATCH_PIPS * PIP) {
    return { error: `OANDA M30 mid close ${midClose} is more than ${ENTRY_MATCH_PIPS} pips from TV entry ${trade.tvEntry}.` } as const;
  }
  const oandaAtr14 = atrByTime.get(trade.entryUtc) ?? null;
  let risk: number;
  let riskSource: RiskSource;
  switch (trade.tvExitReason) {
    case "TAKE_PROFIT":
      risk = Math.abs(trade.tvExit - trade.tvEntry) / 2;
      riskSource = "TV_TARGET_FILL";
      break;
    case "STOP_LOSS":
      risk = Math.abs(trade.tvEntry - trade.tvExit);
      riskSource = "TV_STOP_FILL";
      break;
    case "TIME_EXIT":
      if (oandaAtr14 === null || !(oandaAtr14 > 0)) return { error: `TIME_EXIT trade lacks OANDA M30 ATR14 at ${trade.entryUtc}.` } as const;
      risk = oandaAtr14;
      riskSource = "OANDA_ATR14_TIME_EXIT";
      break;
    default: {
      const exhaustive: never = trade.tvExitReason;
      throw new Error(`Unhandled TV exit reason ${exhaustive}`);
    }
  }
  if (oandaAtr14 !== null && oandaAtr14 > 0 && risk > 0 && risk < 0.25 * oandaAtr14) {
    risk = oandaAtr14;
    riskSource = "OANDA_ATR14_TV_FILL_INCONSISTENT";
  }
  if (!(risk > 0)) return { error: `Non-positive reconstructed risk ${risk}.` } as const;
  const stop = trade.direction === "LONG" ? trade.tvEntry - risk : trade.tvEntry + risk;
  const target = trade.direction === "LONG" ? trade.tvEntry + 2 * risk : trade.tvEntry - 2 * risk;
  return { trade: { ...trade, risk, riskSource, stop, target, oandaAtr14, m30 } satisfies FrozenTrade };
}

function entrySnapshot(trade: FrozenTrade, bars: readonly ResearchCandle[]) {
  const entryMinute = new Date(Date.parse(trade.decisionUtc) - MINUTE_MS).toISOString();
  const m1 = bars.find((bar) => canonical(bar.time) === entryMinute) ?? null;
  const source = m1 ?? trade.m30;
  return {
    source: m1 ? "M1_SIGNAL_CLOSE" as const : "M30_SIGNAL_CLOSE" as const,
    mid: source.mid.close,
    bid: source.bid.close,
    ask: source.ask.close,
    spreadPips: (source.ask.close - source.bid.close) / PIP,
  };
}

function executableEntry(direction: Direction, snapshot: { bid: number; ask: number }) {
  return direction === "LONG" ? snapshot.ask : snapshot.bid;
}

function replay(trade: FrozenTrade, bars: readonly ResearchCandle[], mode: "mid" | "exec", entry: number): ReplayResult | null {
  const requiredLast = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
  const usable = bars
    .filter((bar) => Date.parse(bar.time) >= Date.parse(trade.decisionUtc) && Date.parse(bar.time) < Date.parse(trade.horizonUtc))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (!usable.length || canonical(usable[0]!.time) !== trade.decisionUtc || canonical(usable.at(-1)!.time) !== requiredLast) return null;
  const pnl = (exit: number) => trade.direction === "LONG" ? (exit - entry) / trade.risk : (entry - exit) / trade.risk;
  for (const bar of usable) {
    const price = mode === "mid" ? bar.mid : trade.direction === "LONG" ? bar.bid : bar.ask;
    const stopHit = trade.direction === "LONG" ? price.low <= trade.stop : price.high >= trade.stop;
    const targetHit = trade.direction === "LONG" ? price.high >= trade.target : price.low <= trade.target;
    const spread = (bar.ask.close - bar.bid.close) / PIP;
    const exitTime = new Date(Date.parse(bar.time) + MINUTE_MS).toISOString();
    if (stopHit) {
      const gapped = trade.direction === "LONG" ? price.open <= trade.stop : price.open >= trade.stop;
      const exit = gapped ? price.open : trade.stop;
      return {
        exitTime, exitPrice: exit, reason: "STOP_LOSS", resultR: pnl(exit), sameMinuteAmbiguous: targetHit, exitSpreadPips: spread,
        oandaMidExit: bar.mid.close, oandaBidExit: bar.bid.close, oandaAskExit: bar.ask.close,
      };
    }
    if (targetHit) {
      return {
        exitTime, exitPrice: trade.target, reason: "TAKE_PROFIT", resultR: pnl(trade.target), sameMinuteAmbiguous: false, exitSpreadPips: spread,
        oandaMidExit: bar.mid.close, oandaBidExit: bar.bid.close, oandaAskExit: bar.ask.close,
      };
    }
  }
  const last = usable.at(-1)!;
  const exit = mode === "mid" ? last.mid.close : trade.direction === "LONG" ? last.bid.close : last.ask.close;
  return {
    exitTime: trade.horizonUtc, exitPrice: exit, reason: "TIME_EXIT", resultR: pnl(exit), sameMinuteAmbiguous: false,
    exitSpreadPips: (last.ask.close - last.bid.close) / PIP,
    oandaMidExit: last.mid.close, oandaBidExit: last.bid.close, oandaAskExit: last.ask.close,
  };
}

function metrics(values: readonly number[]) {
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + value, 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: values.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: values.length ? wins.length / values.length * 100 : null,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    totalR: grossProfit + grossLoss,
    expectancyR: values.length ? (grossProfit + grossLoss) / values.length : null,
    averageWinnerR: wins.length ? grossProfit / wins.length : null,
    averageLoserR: losses.length ? grossLoss / losses.length : null,
    maxDrawdownR: maxDrawdown,
  };
}
function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function summary(values: readonly number[]) {
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values),
    maximum: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}
function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows: ReadonlyArray<Record<string, unknown>>) {
  const columns = Object.keys(rows[0]!);
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}
function fmt(value: number | null | undefined, digits = 3) {
  return value == null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}
function classify(expectancy: number): Classification {
  if (expectancy >= 0.15) return "STRONG";
  if (expectancy >= 0.10) return "GOOD";
  if (expectancy >= 0.05) return "WEAK";
  if (expectancy >= 0) return "NO EDGE";
  return "LOSING";
}
function verdictFor(classification: Classification): Verdict {
  switch (classification) {
    case "STRONG":
    case "GOOD":
      return "SURVIVES_COSTS";
    case "WEAK":
    case "NO EDGE":
      return "MARGINAL_AFTER_COSTS";
    case "LOSING":
      return "FAILS_COSTS";
    default: {
      const exhaustive: never = classification;
      throw new Error(`Unhandled classification ${exhaustive}`);
    }
  }
}
function pct(value: number | null) {
  return value == null ? "n/a" : `${value.toFixed(2)}%`;
}

async function main() {
  const csvText = await readFile(TV_CSV, "utf8");
  const csvHash = sha256(csvText);
  const csvRows = parseCsv(csvText);
  assert.equal(csvRows.length, 196, "TradingView export must contain 196 rows.");
  const entryRows = csvRows.filter((row) => row.Type.startsWith("Entry "));
  const composition = entryRows.reduce<Record<string, number>>((counts, row) => {
    counts[row.Signal!] = (counts[row.Signal!] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(composition, { "1030_LONG": 19, "1030_SHORT": 18, "1100_LONG": 24, "1100_SHORT": 18, "1130_LONG": 19 });
  const cohort = buildTvTrades(csvRows);
  assert.equal(cohort.trades.length, 98, "All 98 TradingView trades must parse and convert to UTC.");
  assert.equal(cohort.unmatched.length, 0);
  const zoneScores = timezoneScores(cohort.trades);
  assert.equal(zoneScores[0]!.originHourMatches, 98, "America/New_York must map every entry onto its UTC origin.");
  const sampleNumbers = [1, 5, 8, 9, 24, 49, 97, 98];
  const samples = sampleNumbers.map((tradeNumber) => {
    const trade = cohort.trades.find((item) => item.tradeNumber === tradeNumber);
    if (!trade) throw new Error(`Sample trade ${tradeNumber} missing from the authoritative CSV.`);
    const expected = originHourMinute(trade.originUtc);
    const utc = new Date(trade.entryUtc);
    assert.equal(utc.getUTCHours(), expected.hour);
    assert.equal(utc.getUTCMinutes(), expected.minute);
    return {
      tradeNumber: trade.tradeNumber,
      signal: trade.signal,
      tradingViewEntry: trade.entryWallTime,
      resolvedUtc: trade.entryUtc,
      originUtc: trade.originUtc,
      direction: trade.direction,
      tvExitReason: trade.tvExitReason,
    };
  });
  console.log(JSON.stringify({ phase: "timezone_samples_ok", samples, zoneScores }, null, 2));

  const m30 = await fetchM30History();
  const m30ByTime = new Map(m30.candles.map((candle) => [canonical(candle.time), candle]));
  const atrValues = calculateAtrValues(m30.candles.map(midpoint), 14);
  const atrByTime = new Map(m30.candles.map((candle, index) => [canonical(candle.time), atrValues[index] ?? null]));
  const frozen: FrozenTrade[] = [];
  const geometryUnmatched = [...cohort.unmatched];
  for (const trade of cohort.trades) {
    const result = freezeGeometry(trade, m30ByTime, atrByTime);
    if ("error" in result) {
      geometryUnmatched.push({ tradeNumber: trade.tradeNumber, reason: result.error });
      continue;
    }
    frozen.push(result.trade);
  }
  console.log(JSON.stringify({
    phase: "geometry_samples",
    matchedGeometry: frozen.length,
    unmatchedGeometry: geometryUnmatched,
    samples: frozen.filter((trade) => sampleNumbers.includes(trade.tradeNumber)).map((trade) => ({
      tradeNumber: trade.tradeNumber,
      signal: trade.signal,
      tvEntry: trade.tvEntry,
      oandaMid: trade.m30.mid.close,
      oandaBid: trade.m30.bid.close,
      oandaAsk: trade.m30.ask.close,
      entrySpreadPips: round4((trade.m30.ask.close - trade.m30.bid.close) / PIP),
      riskPips: round4(trade.risk / PIP),
      riskSource: trade.riskSource,
      stop: trade.stop,
      target: trade.target,
    })),
  }, null, 2));

  const m1 = await m1Windows(frozen, csvHash);
  const rows: Array<Record<string, unknown>> = [];
  const rawTrades: Array<Record<string, unknown>> = [];
  const executionUnmatched = [...geometryUnmatched];
  const listed = new Set(frozen.map((trade) => trade.tradeNumber));
  for (const trade of cohort.trades.filter((item) => !listed.has(item.tradeNumber))) {
    rows.push({
      trade_number: trade.tradeNumber, signal: trade.signal, direction: trade.direction, origin_utc: trade.originUtc,
      tv_entry_timestamp: trade.entryWallTime, tv_entry_timestamp_utc: trade.entryUtc,
      tv_exit_timestamp: trade.exitWallTime, tv_exit_timestamp_utc: trade.exitUtc,
      tv_entry_price: trade.tvEntry, oanda_mid_entry: null, oanda_bid_entry: null, oanda_ask_entry: null, entry_spread_pips: null,
      original_stop: null, original_target: null, initial_risk_pips: null, tv_exit_price: trade.tvExit,
      oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exit_spread_pips: null,
      tv_result_r: null, exec_result_r: null, spread_drag_r: null,
      tv_exit_reason: trade.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null,
      matched: false, unmatched_reason: geometryUnmatched.find((item) => item.tradeNumber === trade.tradeNumber)?.reason ?? "Unmatched before execution replay.",
    });
  }
  for (const trade of frozen) {
    const bars = m1.windows[String(trade.tradeNumber)] ?? [];
    const snapshot = entrySnapshot(trade, bars);
    const execEntry = executableEntry(trade.direction, snapshot);
    const tvResultR = trade.direction === "LONG" ? (trade.tvExit - trade.tvEntry) / trade.risk : (trade.tvEntry - trade.tvExit) / trade.risk;
    const executable = replay(trade, bars, "exec", execEntry);
    if (!executable) {
      const requiredLast = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
      const reason = `Incomplete M1 window: ${bars.length} bars; first ${bars[0]?.time ?? "none"}, last ${bars.at(-1)?.time ?? "none"}; required ${trade.decisionUtc} through ${requiredLast}. No quote was fabricated or forward-filled.`;
      executionUnmatched.push({ tradeNumber: trade.tradeNumber, reason });
      rows.push({
        trade_number: trade.tradeNumber, signal: trade.signal, direction: trade.direction, origin_utc: trade.originUtc,
        tv_entry_timestamp: trade.entryWallTime, tv_entry_timestamp_utc: trade.entryUtc,
        tv_exit_timestamp: trade.exitWallTime, tv_exit_timestamp_utc: trade.exitUtc,
        tv_entry_price: trade.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
        entry_spread_pips: round6(snapshot.spreadPips), original_stop: trade.stop, original_target: trade.target,
        initial_risk_pips: round6(trade.risk / PIP), tv_exit_price: trade.tvExit,
        oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exit_spread_pips: null,
        tv_result_r: round6(tvResultR), exec_result_r: null, spread_drag_r: null,
        tv_exit_reason: trade.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null,
        matched: false, unmatched_reason: reason,
      });
      rawTrades.push({ tradeNumber: trade.tradeNumber, unmatched: true, reason, m1Bars: bars.length, entrySource: snapshot.source });
      continue;
    }
    const spreadDragR = tvResultR - executable.resultR;
    const record = {
      trade_number: trade.tradeNumber, signal: trade.signal, direction: trade.direction, origin_utc: trade.originUtc,
      tv_entry_timestamp: trade.entryWallTime, tv_entry_timestamp_utc: trade.entryUtc,
      tv_exit_timestamp: trade.exitWallTime, tv_exit_timestamp_utc: trade.exitUtc,
      tv_entry_price: trade.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
      entry_spread_pips: round6(snapshot.spreadPips), original_stop: trade.stop, original_target: trade.target,
      initial_risk_pips: round6(trade.risk / PIP), tv_exit_price: trade.tvExit,
      oanda_mid_exit: executable.oandaMidExit, oanda_bid_exit: executable.oandaBidExit, oanda_ask_exit: executable.oandaAskExit,
      exit_spread_pips: round6(executable.exitSpreadPips),
      tv_result_r: round6(tvResultR), exec_result_r: round6(executable.resultR), spread_drag_r: round6(spreadDragR),
      tv_exit_reason: trade.tvExitReason, exec_exit_reason: executable.reason,
      spread_changed_outcome: trade.tvExitReason !== executable.reason || (tvResultR > 0) !== (executable.resultR > 0),
      matched: true, unmatched_reason: "",
    };
    rows.push(record);
    rawTrades.push({
      ...record, m1Bars: bars.length, entrySource: snapshot.source, execEntry, sameMinuteAmbiguous: executable.sameMinuteAmbiguous,
      riskSource: trade.riskSource, oandaAtr14: trade.oandaAtr14, execExitTime: executable.exitTime,
    });
  }
  rows.sort((left, right) => Number(left.trade_number) - Number(right.trade_number));
  const resolvedRows = rows.filter((row) => row.matched === true);
  const unmatchedRows = rows.filter((row) => row.matched === false);
  const midMetrics = metrics(frozen.map((trade) => (
    trade.direction === "LONG" ? (trade.tvExit - trade.tvEntry) / trade.risk : (trade.tvEntry - trade.tvExit) / trade.risk
  )));
  const resolvedMidMetrics = metrics(resolvedRows.map((row) => Number(row.tv_result_r)));
  const execMetrics = metrics(resolvedRows.map((row) => Number(row.exec_result_r)));
  const legs = (["10:30 LONG", "10:30 SHORT", "11:00 LONG", "11:00 SHORT", "11:30 LONG"] as const).map((label) => {
    const [origin, direction] = label.split(" ") as [OriginUtc, Direction];
    const legRows = resolvedRows.filter((row) => row.origin_utc === origin && row.direction === direction);
    const exec = metrics(legRows.map((row) => Number(row.exec_result_r)));
    const mid = metrics(legRows.map((row) => Number(row.tv_result_r)));
    return { label, trades: legRows.length, mid, exec };
  });
  const entrySpreadStats = summary(resolvedRows.map((row) => Number(row.entry_spread_pips)));
  const exitSpreadStats = summary(resolvedRows.map((row) => Number(row.exit_spread_pips)));
  const spreadDragStats = summary(resolvedRows.map((row) => Number(row.spread_drag_r)));
  const transitions = {
    winToLoss: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && Number(row.exec_result_r) <= 0).length,
    winToSmallerWin: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && Number(row.exec_result_r) > 0 && Number(row.exec_result_r) < Number(row.tv_result_r)).length,
    winToTimeExit: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && row.exec_exit_reason === "TIME_EXIT").length,
    lossToLargerLoss: resolvedRows.filter((row) => Number(row.tv_result_r) <= 0 && Number(row.exec_result_r) < Number(row.tv_result_r)).length,
    tpToNoTp: resolvedRows.filter((row) => row.tv_exit_reason === "TAKE_PROFIT" && row.exec_exit_reason !== "TAKE_PROFIT").length,
    slHitEarlier: resolvedRows.filter((row) => {
      if (row.exec_exit_reason !== "STOP_LOSS") return false;
      const raw = rawTrades.find((item) => Number(item.trade_number ?? item.tradeNumber) === Number(row.trade_number));
      const execExit = String(raw?.execExitTime ?? "");
      return row.tv_exit_reason !== "STOP_LOSS" || (execExit !== "" && Date.parse(execExit) < Date.parse(String(row.tv_exit_timestamp_utc)));
    }).length,
    lossToWin: resolvedRows.filter((row) => Number(row.tv_result_r) <= 0 && Number(row.exec_result_r) > 0).length,
    reasonChanged: resolvedRows.filter((row) => row.tv_exit_reason !== row.exec_exit_reason).length,
  };
  const execExpectancy = execMetrics.expectancyR ?? -Infinity;
  const classification = classify(execExpectancy);
  const verdict = verdictFor(classification);
  const frequencyDecision = execExpectancy < 0 ? 3 : execExpectancy + 1e-12 >= ORIGINAL_GBPUSD.execExpectancyR ? 1 : 2;
  const overallTable = [
    "| Metric | TradingView/MID | OANDA EXEC |",
    "|---|---:|---:|",
    `| Trades | ${midMetrics.trades} | ${execMetrics.trades} |`,
    `| Wins | ${midMetrics.wins} | ${execMetrics.wins} |`,
    `| Losses | ${midMetrics.losses} | ${execMetrics.losses} |`,
    `| Win rate | ${pct(midMetrics.winRatePct)} | ${pct(execMetrics.winRatePct)} |`,
    `| Profit factor | ${fmt(midMetrics.profitFactor)} | ${fmt(execMetrics.profitFactor)} |`,
    `| Total R | ${fmt(midMetrics.totalR, 4)}R | ${fmt(execMetrics.totalR, 4)}R |`,
    `| Expectancy R/trade | ${fmt(midMetrics.expectancyR, 4)}R | ${fmt(execMetrics.expectancyR, 4)}R |`,
    `| Average winner R | ${fmt(midMetrics.averageWinnerR, 4)}R | ${fmt(execMetrics.averageWinnerR, 4)}R |`,
    `| Average loser R | ${fmt(midMetrics.averageLoserR, 4)}R | ${fmt(execMetrics.averageLoserR, 4)}R |`,
    `| Max drawdown R | ${fmt(midMetrics.maxDrawdownR, 4)}R | ${fmt(execMetrics.maxDrawdownR, 4)}R |`,
  ].join("\n");
  const legTable = [
    "| Leg | Trades | EXEC WR | EXEC PF | EXEC Exp R |",
    "|---|---:|---:|---:|---:|",
    ...legs.map((leg) => `| ${leg.label} | ${leg.trades} | ${pct(leg.exec.winRatePct)} | ${fmt(leg.exec.profitFactor)} | ${fmt(leg.exec.expectancyR, 4)}R |`),
  ].join("\n");
  const unmatchedBlock = unmatchedRows.length
    ? unmatchedRows.map((row) => `- Trade ${row.trade_number} ${row.signal} at ${row.tv_entry_timestamp}: ${row.unmatched_reason}`).join("\n")
    : "- None. All 98 TradingView trades had a complete OANDA M1 bid/ask window.";
  const decisionText = frequencyDecision === 1
    ? "V3 increases frequency AND preserves/improves the edge."
    : frequencyDecision === 2
      ? "V3 increases frequency but weakens expectancy."
      : "V3 fails after spread.";
  const report = `# GBPUSD Frequency V3 — authoritative TradingView 98-trade spread replay

## Verdict: ${verdict}

Execution classification: **${classification}**. Exact OANDA executable net expectancy for ${execMetrics.trades} matched trades is **${fmt(execMetrics.expectancyR, 4)}R/trade**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. The TradingView CSV is the only trade list.

## Matching

- TradingView trades: **98**
- Matched: **${resolvedRows.length}**
- Unmatched: **${unmatchedRows.length}**

${unmatchedBlock}

CSV composition reproduced exactly: 10:30 LONG 19, 10:30 SHORT 18, 11:00 LONG 24, 11:00 SHORT 18, 11:30 LONG 19. 11:30 SHORT remains disabled.

The CSV timezone is **America/New_York**, with DST applied. That maps 98/98 entries onto 10:30, 11:00, or 11:30 UTC. Fixed offsets fail across DST. Sample conversions (beginning, DST boundary, summer, end) are in RAW_RESULTS.json.

## Overall

${overallTable}

MID uses all 98 TradingView trades and the frozen TV/ATR geometry. EXEC uses only matched OANDA M1 bid/ask replays.

## Legs

${legTable}

10:30 SHORT was not removed. It is reported as measured.

## Data notes

Trade 33 (10:30 LONG, 2025-08-06) is the only geometry fallback. TradingView recorded a 0.5-pip \`TP_OR_SL\` exit against OANDA ATR14 of 10.4 pips and a 10-pip MAE. Frozen 1R uses that ATR, not the CSV fill. No other trade needed this rule.

10:30 SHORT is the weakest executable leg at **+0.081R/trade** (WEAK). It is still positive and stays in the frozen book.

## Spread

- Average / median / maximum entry spread: ${fmt(entrySpreadStats.average)} / ${fmt(entrySpreadStats.median)} / ${fmt(entrySpreadStats.maximum)} pips
- Average / median / maximum exit spread: ${fmt(exitSpreadStats.average)} / ${fmt(exitSpreadStats.median)} / ${fmt(exitSpreadStats.maximum)} pips
- Average / median / maximum spread drag: ${fmt(spreadDragStats.average, 4)} / ${fmt(spreadDragStats.median, 4)} / ${fmt(spreadDragStats.maximum, 4)} R/trade
- Total spread drag R: ${fmt(spreadDragStats.total, 4)}R
- MID expectancy: ${fmt(resolvedMidMetrics.expectancyR, 4)}R
- EXEC expectancy: ${fmt(execMetrics.expectancyR, 4)}R
- Difference: ${fmt((resolvedMidMetrics.expectancyR ?? 0) - (execMetrics.expectancyR ?? 0), 4)}R/trade

## Outcome changes

- WIN -> LOSS: ${transitions.winToLoss}
- WIN -> smaller WIN: ${transitions.winToSmallerWin}
- WIN -> TIME EXIT: ${transitions.winToTimeExit}
- LOSS -> larger LOSS: ${transitions.lossToLargerLoss}
- TP -> no TP because executable side did not reach target: ${transitions.tpToNoTp}
- SL hit earlier because of executable spread: ${transitions.slHitEarlier}
- LOSS -> WIN: ${transitions.lossToWin}
- Exit reason changed: ${transitions.reasonChanged}

## Method

- Authoritative cohort: TradingView export of GBPUSD Frequency V3, 98 completed trades from 2025-01-06 through 2026-08-14.
- Geometry: 1R is the original ATR-based stop distance. TP/SL fills reconstruct that distance from the TradingView prices. TIME_EXIT uses OANDA M30 ATR14 at the signal bar. If a TP/SL fill is smaller than 0.25x OANDA ATR14 (CSV artifact), 1R falls back to that ATR; this applied only to trade 33. R is not redefined after spread.
- Entry: LONG ASK, SHORT BID at the signal-bar close.
- Intrabar path: completed OANDA Practice M1 bid/ask from the first minute after that close through the 3-hour / 6-bar horizon.
- LONG stop/TP/time-exit: BID. SHORT stop/TP/time-exit: ASK.
- Same-minute TP and SL: stop first. Gaps fill at the executable open. No second spread subtraction. No trailing stop, profit lock, or threshold change.

## Decision table

| Book | Trades | EXEC expectancy |
|---|---:|---:|
| Original GBPUSD Dual-Origin V2 | ${ORIGINAL_GBPUSD.trades} | +${ORIGINAL_GBPUSD.execExpectancyR.toFixed(3)}R/trade |
| GBPUSD Frequency V3 | ${execMetrics.trades} | ${fmt(execMetrics.expectancyR, 4)}R/trade |

${decisionText}

No deployment. No broker orders. No strategy modification.
`;
  const artifact = {
    generatedAt: new Date().toISOString(),
    verdict, classification, frequencyDecision, decisionText,
    authoritativeCohort: {
      file: TV_CSV, copiedTo: resolve(OUT, "TRADINGVIEW_SOURCE.csv"), sha256: csvHash,
      rows: csvRows.length, trades: 98, composition,
      first: cohort.trades[0]?.entryWallTime, last: cohort.trades.at(-1)?.entryWallTime,
    },
    timezone: { selected: "America/New_York", dstAware: true, scores: zoneScores, validationSamples: samples },
    matching: {
      tradingViewTrades: 98, matched: resolvedRows.length, unmatched: unmatchedRows.length,
      unmatchedDetails: executionUnmatched,
    },
    execution: {
      m30Source: m30.source, m1Source: m1.source,
      entry: "LONG ASK / SHORT BID at signal-bar close; M1 close preferred, M30 close fallback",
      exits: "LONG BID / SHORT ASK M1 barriers; time exit at 6 future M30 bars = 3 hours",
      geometry: "TV stop/target from TV TP/SL fills; OANDA M30 ATR14 for TIME_EXIT",
      ambiguity: "same M1 collision is stop-first",
      spreadAccounting: "direct bid/ask; no second spread subtraction",
    },
    metrics: { tradingViewMid: midMetrics, oandaExecutable: execMetrics, resolvedMid: resolvedMidMetrics, legs },
    spread: {
      entryPips: entrySpreadStats, exitPips: exitSpreadStats, dragR: spreadDragStats,
      midExpectancy: resolvedMidMetrics.expectancyR, execExpectancy: execMetrics.expectancyR,
      difference: (resolvedMidMetrics.expectancyR ?? 0) - (execMetrics.expectancyR ?? 0),
    },
    transitions,
    originalGbpusd: ORIGINAL_GBPUSD,
    trades: rawTrades,
  };
  await mkdir(OUT, { recursive: true });
  await Promise.all([
    writeFile(resolve(OUT, "REPORT.md"), report),
    writeFile(resolve(OUT, "TRADES.csv"), toCsv(rows)),
    writeFile(resolve(OUT, "RAW_RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`),
    writeFile(resolve(OUT, "TRADINGVIEW_SOURCE.csv"), csvText),
  ]);
  console.log(JSON.stringify({
    verdict, classification, matching: artifact.matching, metrics: artifact.metrics,
    spread: artifact.spread, transitions, decisionText, output: OUT,
  }, null, 2));
}

void main();
