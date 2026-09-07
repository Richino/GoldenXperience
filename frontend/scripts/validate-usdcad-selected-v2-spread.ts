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
type OriginUtc = "09:00" | "10:00" | "11:00";
type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
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
  leg: string;
  direction: Direction;
  originUtc: OriginUtc;
  confidenceTag: "BASE" | "PEN_EXTREME";
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
  atr: number;
  risk: number;
  stop: number;
  target: number;
  h1: ResearchCandle;
};

const DEFAULT_TV_CSV = "C:/Users/arche/Downloads/GX_USDCAD_Structure_EMA_Reclaim_V2_-_Selected_Origins_-_1_to_2_RR_OANDA_USDCAD_2026-09-05_380af.csv";
const TV_CSV = resolve(process.env.USDCAD_V2_TV_CSV ?? DEFAULT_TV_CSV);
const OUT = resolve(process.cwd(), "../api-server/research-v2/usdcad-selected-v2-spread-validation");
const H1_CACHE = resolve(OUT, "data/USD_CAD-H1-MBA.json");
const M1_CACHE = resolve(OUT, "data/USD_CAD-M1-TV181-MBA.json");
const PIP = 0.0001;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MAX_HOLD_BARS = 3;
const ENTRY_MATCH_PIPS = 1.5;
const H1_FROM = "2022-06-01T00:00:00.000Z";
const H1_TO = "2026-09-01T00:00:00.000Z";
const EXPECTED_LEGS = { "09:00 LONG": 55, "10:00 SHORT": 26, "11:00 LONG": 49, "11:00 SHORT": 51 } as const;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(timestamp: string) {
  return new Date(timestamp).toISOString();
}
function midpoint(candle: ResearchCandle): Candle {
  return { time: candle.time, volume: candle.volume, complete: candle.complete, ...candle.mid };
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

function parseSignal(signal: string) {
  const match = /^(0900|1000|1100)_(LONG|SHORT)_(BASE|PEN_EXTREME)$/.exec(signal);
  if (!match) return null;
  const originCode = match[1]!;
  const direction = match[2]! as Direction;
  const originUtc: OriginUtc = originCode === "0900" ? "09:00" : originCode === "1000" ? "10:00" : "11:00";
  const allowed = (originUtc === "09:00" && direction === "LONG")
    || (originUtc === "10:00" && direction === "SHORT")
    || originUtc === "11:00";
  if (!allowed) return null;
  return {
    originUtc, direction, confidenceTag: match[3]! as "BASE" | "PEN_EXTREME",
    leg: `${originUtc} ${direction}`,
  };
}

function tvExitReason(exitRow: CsvRow): ExitReason {
  if (exitRow.Signal === "TIME_EXIT") return "TIME_EXIT";
  if (exitRow.Signal !== "TP_OR_SL") throw new Error(`Unexpected exit signal ${exitRow.Signal}`);
  return +exitRow["Net PnL CAD"]! > 0 ? "TAKE_PROFIT" : "STOP_LOSS";
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
      if (new Date(utc).getUTCHours() === Number(trade.originUtc.slice(0, 2)) && new Date(utc).getUTCMinutes() === 0) {
        originHourMatches += 1;
      }
    }
    return { zone: candidate.zone, originHourMatches, trades: trades.length };
  });
}

function buildTvTrades(csvRows: readonly CsvRow[]) {
  const grouped = new Map<number, CsvRow[]>();
  for (const row of csvRows) grouped.set(+row["Trade number"]!, [...(grouped.get(+row["Trade number"]!) ?? []), row]);
  assert.equal(grouped.size, 181, "TradingView export must contain exactly 181 trades.");
  const trades: TvTrade[] = [];
  const unmatched: Array<{ tradeNumber: number; reason: string }> = [];
  for (const [tradeNumber, rows] of [...grouped].sort(([left], [right]) => left - right)) {
    const entryRow = rows.find((row) => row.Type.startsWith("Entry "));
    const exitRow = rows.find((row) => row.Type.startsWith("Exit "));
    if (!entryRow || !exitRow || rows.length !== 2) {
      unmatched.push({ tradeNumber, reason: `Expected one entry and one exit; found ${rows.length} rows.` });
      continue;
    }
    const mapped = parseSignal(entryRow.Signal!);
    if (!mapped) {
      unmatched.push({ tradeNumber, reason: `Signal ${entryRow.Signal} is not an allowed Selected Origins V2 leg.` });
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
    const entryDate = new Date(entryUtc);
    if (entryDate.getUTCHours() !== Number(mapped.originUtc.slice(0, 2)) || entryDate.getUTCMinutes() !== 0) {
      unmatched.push({
        tradeNumber,
        reason: `America/New_York conversion produced ${entryUtc}, not ${mapped.originUtc} UTC for ${entryRow.Signal}.`,
      });
      continue;
    }
    trades.push({
      tradeNumber, signal: entryRow.Signal!, leg: mapped.leg, direction, originUtc: mapped.originUtc,
      confidenceTag: mapped.confidenceTag,
      entryWallTime: entryRow["Date and time"]!, exitWallTime: exitRow["Date and time"]!,
      entryUtc, exitUtc,
      decisionUtc: new Date(Date.parse(entryUtc) + HOUR_MS).toISOString(),
      horizonUtc: new Date(Date.parse(entryUtc) + (1 + MAX_HOLD_BARS) * HOUR_MS).toISOString(),
      tvEntry: +entryRow["Price CAD"]!, tvExit: +exitRow["Price CAD"]!,
      tvExitReason: tvExitReason(exitRow), durationBars: +exitRow["Duration (bars)"]!, tvPnl: +exitRow["Net PnL CAD"]!,
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

async function fetchH1History() {
  try {
    const cached = JSON.parse(await readFile(H1_CACHE, "utf8")) as { from: string; to: string; candles: ResearchCandle[] };
    if (cached.from === H1_FROM && cached.to === H1_TO && cached.candles.length > 15_000) {
      return { candles: cached.candles.map((candle) => ({ ...candle, time: canonical(candle.time) })), source: "cache" as const };
    }
  } catch { /* Fetch a fresh warmup history. */ }
  const { token, host } = oandaCredentials();
  const byTime = new Map<string, ResearchCandle>();
  let cursor = H1_TO;
  let previousEarliest = "";
  for (let page = 0; page < 24; page += 1) {
    const url = new URL(`${host}/v3/instruments/USD_CAD/candles`);
    for (const [key, value] of Object.entries({ price: "MBA", granularity: "H1", count: "5000", to: cursor })) url.searchParams.set(key, value);
    const batch = await oandaGet(host, token, url);
    for (const candle of batch) byTime.set(canonical(candle.time), candle);
    const earliest = batch.map((candle) => candle.time).sort()[0];
    if (!earliest || earliest === previousEarliest || Date.parse(earliest) <= Date.parse(H1_FROM)) break;
    previousEarliest = earliest;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
    await new Promise((done) => setTimeout(done, 80));
  }
  const candles = [...byTime.values()]
    .filter((candle) => Date.parse(candle.time) >= Date.parse(H1_FROM) && Date.parse(candle.time) < Date.parse(H1_TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (!candles.length) throw new Error("OANDA returned no completed USD_CAD H1 MBA candles.");
  await mkdir(resolve(OUT, "data"), { recursive: true });
  await writeFile(H1_CACHE, `${JSON.stringify({ from: H1_FROM, to: H1_TO, source: "OANDA Practice completed H1 MBA", candles })}\n`);
  return { candles, source: "fresh OANDA Practice fetch" as const };
}

async function fetchM1Window(trade: TvTrade, token: string, host: string) {
  const url = new URL(`${host}/v3/instruments/USD_CAD/candles`);
  for (const [key, value] of Object.entries({
    price: "MBA", granularity: "M1", from: trade.entryUtc, to: trade.horizonUtc, includeFirst: "true",
  })) url.searchParams.set(key, value);
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

function freezeGeometry(trade: TvTrade, h1ByTime: ReadonlyMap<string, ResearchCandle>, atrByTime: ReadonlyMap<string, number | null>) {
  const h1 = h1ByTime.get(trade.entryUtc);
  if (!h1) return { error: `OANDA H1 bar missing at ${trade.entryUtc}.` } as const;
  if (Math.abs(h1.mid.close - trade.tvEntry) > ENTRY_MATCH_PIPS * PIP) {
    return { error: `OANDA H1 mid close ${h1.mid.close} is more than ${ENTRY_MATCH_PIPS} pips from TV entry ${trade.tvEntry}.` } as const;
  }
  const atr = atrByTime.get(trade.entryUtc) ?? null;
  if (atr === null || !(atr > 0)) return { error: `OANDA H1 ATR14 missing or non-positive at ${trade.entryUtc}.` } as const;
  const stop = trade.direction === "LONG" ? trade.tvEntry - atr : trade.tvEntry + atr;
  const target = trade.direction === "LONG" ? trade.tvEntry + 2 * atr : trade.tvEntry - 2 * atr;
  return { trade: { ...trade, atr, risk: atr, stop, target, h1 } satisfies FrozenTrade };
}

function entrySnapshot(trade: FrozenTrade, bars: readonly ResearchCandle[]) {
  const entryMinute = new Date(Date.parse(trade.decisionUtc) - MINUTE_MS).toISOString();
  const m1 = bars.find((bar) => canonical(bar.time) === entryMinute) ?? null;
  const source = m1 ?? trade.h1;
  return {
    source: m1 ? "M1_SIGNAL_CLOSE" as const : "H1_SIGNAL_CLOSE" as const,
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
function signed(value: number | null | undefined, digits = 4) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}R`;
}

function emptyRow(trade: TvTrade, reason: string, extra: Record<string, unknown> = {}) {
  return {
    trade_number: trade.tradeNumber, leg: trade.leg, direction: trade.direction, origin_utc: trade.originUtc,
    tv_entry_timestamp: trade.entryWallTime, resolved_utc_entry: trade.entryUtc,
    tv_exit_timestamp: trade.exitWallTime, resolved_utc_exit: trade.exitUtc,
    tv_entry_price: trade.tvEntry, oanda_mid_entry: extra.oanda_mid_entry ?? null, oanda_bid_entry: extra.oanda_bid_entry ?? null,
    oanda_ask_entry: extra.oanda_ask_entry ?? null, entry_spread_pips: extra.entry_spread_pips ?? null,
    atr_at_entry: extra.atr_at_entry ?? null, initial_risk_pips: extra.initial_risk_pips ?? null,
    original_stop: extra.original_stop ?? null, original_target: extra.original_target ?? null,
    tv_exit_price: trade.tvExit, oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exit_spread_pips: null,
    tv_result_r: extra.tv_result_r ?? null, exec_result_r: null, execution_drag_r: null,
    tv_exit_reason: trade.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null,
    matched: false, unmatched_reason: reason,
  };
}

async function main() {
  const csvText = await readFile(TV_CSV, "utf8");
  const csvHash = sha256(csvText);
  const csvRows = parseCsv(csvText);
  assert.equal(csvRows.length, 362, "TradingView export must contain 362 rows.");
  const entryRows = csvRows.filter((row) => row.Type.startsWith("Entry "));
  const exitRows = csvRows.filter((row) => row.Type.startsWith("Exit "));
  const tvMoneyWins = exitRows.map((row) => +row["Net PnL CAD"]!).filter((value) => value > 0);
  const tvMoneyLosses = exitRows.map((row) => +row["Net PnL CAD"]!).filter((value) => value < 0);
  const tvMoneyZero = exitRows.filter((row) => +row["Net PnL CAD"]! === 0).length;
  const tvExportMoney = {
    wins: tvMoneyWins.length, losses: tvMoneyLosses.length + tvMoneyZero, zero: tvMoneyZero,
    winRatePct: tvMoneyWins.length / exitRows.length * 100,
    grossProfitCad: tvMoneyWins.reduce((sum, value) => sum + value, 0),
    grossLossCad: tvMoneyLosses.reduce((sum, value) => sum + value, 0),
    profitFactor: tvMoneyWins.reduce((sum, value) => sum + value, 0) / Math.abs(tvMoneyLosses.reduce((sum, value) => sum + value, 0)),
    headlineProfitFactor: 1.39,
  };
  const cohort = buildTvTrades(csvRows);
  assert.equal(cohort.trades.length, 181, "All 181 TradingView trades must parse and convert to UTC.");
  assert.equal(cohort.unmatched.length, 0);
  const composition = cohort.trades.reduce<Record<string, number>>((counts, trade) => {
    counts[trade.leg] = (counts[trade.leg] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(composition, EXPECTED_LEGS);
  const zoneScores = timezoneScores(cohort.trades);
  assert.equal(zoneScores[0]!.originHourMatches, 181, "America/New_York must map every entry onto its UTC origin.");
  const sampleNumbers = [1, 3, 4, 12, 21, 91, 179, 181];
  const samples = sampleNumbers.map((tradeNumber) => {
    const trade = cohort.trades.find((item) => item.tradeNumber === tradeNumber);
    if (!trade) throw new Error(`Sample trade ${tradeNumber} missing from the authoritative CSV.`);
    assert.equal(new Date(trade.entryUtc).getUTCHours(), Number(trade.originUtc.slice(0, 2)));
    return {
      tradeNumber: trade.tradeNumber, signal: trade.signal, tradingViewEntry: trade.entryWallTime,
      resolvedUtc: trade.entryUtc, originUtc: trade.originUtc, direction: trade.direction, tvExitReason: trade.tvExitReason,
    };
  });
  console.log(JSON.stringify({ phase: "timezone_samples_ok", samples, zoneScores, tvExportMoney }, null, 2));

  const h1 = await fetchH1History();
  const h1ByTime = new Map(h1.candles.map((candle) => [canonical(candle.time), candle]));
  const atrValues = calculateAtrValues(h1.candles.map(midpoint), 14);
  const atrByTime = new Map(h1.candles.map((candle, index) => [canonical(candle.time), atrValues[index] ?? null]));
  const frozen: FrozenTrade[] = [];
  const geometryUnmatched = [...cohort.unmatched];
  for (const trade of cohort.trades) {
    const result = freezeGeometry(trade, h1ByTime, atrByTime);
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
      tradeNumber: trade.tradeNumber, signal: trade.signal, tvEntry: trade.tvEntry, oandaMid: trade.h1.mid.close,
      oandaBid: trade.h1.bid.close, oandaAsk: trade.h1.ask.close,
      entrySpreadPips: round6((trade.h1.ask.close - trade.h1.bid.close) / PIP),
      atrPips: round6(trade.atr / PIP), stop: trade.stop, target: trade.target,
    })),
  }, null, 2));

  const m1 = await m1Windows(frozen, csvHash);
  const rows: Array<Record<string, unknown>> = [];
  const rawTrades: Array<Record<string, unknown>> = [];
  const executionUnmatched = [...geometryUnmatched];
  const frozenByNumber = new Map(frozen.map((trade) => [trade.tradeNumber, trade]));
  for (const trade of cohort.trades) {
    if (!frozenByNumber.has(trade.tradeNumber)) {
      rows.push(emptyRow(trade, geometryUnmatched.find((item) => item.tradeNumber === trade.tradeNumber)?.reason ?? "Unmatched before execution replay."));
    }
  }
  for (const trade of frozen) {
    const bars = m1.windows[String(trade.tradeNumber)] ?? [];
    const snapshot = entrySnapshot(trade, bars);
    const execEntry = executableEntry(trade.direction, snapshot);
    const tvResultR = trade.direction === "LONG" ? (trade.tvExit - trade.tvEntry) / trade.risk : (trade.tvEntry - trade.tvExit) / trade.risk;
    const extra = {
      oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
      entry_spread_pips: round6(snapshot.spreadPips), atr_at_entry: trade.atr, initial_risk_pips: round6(trade.risk / PIP),
      original_stop: trade.stop, original_target: trade.target, tv_result_r: round6(tvResultR),
    };
    const executable = replay(trade, bars, "exec", execEntry);
    if (!executable) {
      const requiredLast = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
      const reason = `Incomplete M1 window: ${bars.length} bars; first ${bars[0]?.time ?? "none"}, last ${bars.at(-1)?.time ?? "none"}; required ${trade.decisionUtc} through ${requiredLast}. No quote was fabricated or forward-filled.`;
      executionUnmatched.push({ tradeNumber: trade.tradeNumber, reason });
      rows.push(emptyRow(trade, reason, extra));
      rawTrades.push({ tradeNumber: trade.tradeNumber, unmatched: true, reason, m1Bars: bars.length, entrySource: snapshot.source });
      continue;
    }
    const dragR = tvResultR - executable.resultR;
    const record = {
      trade_number: trade.tradeNumber, leg: trade.leg, direction: trade.direction, origin_utc: trade.originUtc,
      tv_entry_timestamp: trade.entryWallTime, resolved_utc_entry: trade.entryUtc,
      tv_exit_timestamp: trade.exitWallTime, resolved_utc_exit: trade.exitUtc,
      tv_entry_price: trade.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
      entry_spread_pips: round6(snapshot.spreadPips), atr_at_entry: trade.atr, initial_risk_pips: round6(trade.risk / PIP),
      original_stop: trade.stop, original_target: trade.target, tv_exit_price: trade.tvExit,
      oanda_mid_exit: executable.oandaMidExit, oanda_bid_exit: executable.oandaBidExit, oanda_ask_exit: executable.oandaAskExit,
      exit_spread_pips: round6(executable.exitSpreadPips),
      tv_result_r: round6(tvResultR), exec_result_r: round6(executable.resultR), execution_drag_r: round6(dragR),
      tv_exit_reason: trade.tvExitReason, exec_exit_reason: executable.reason,
      spread_changed_outcome: trade.tvExitReason !== executable.reason || (tvResultR > 0) !== (executable.resultR > 0),
      matched: true, unmatched_reason: "",
    };
    rows.push(record);
    rawTrades.push({
      ...record, m1Bars: bars.length, entrySource: snapshot.source, execEntry, sameMinuteAmbiguous: executable.sameMinuteAmbiguous,
      confidenceTag: trade.confidenceTag, execExitTime: executable.exitTime, calendarYear: new Date(trade.entryUtc).getUTCFullYear(),
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
  const legs = (["09:00 LONG", "10:00 SHORT", "11:00 LONG", "11:00 SHORT"] as const).map((label) => {
    const legRows = resolvedRows.filter((row) => row.leg === label);
    const exec = metrics(legRows.map((row) => Number(row.exec_result_r)));
    const mid = metrics(legRows.map((row) => Number(row.tv_result_r)));
    return { label, trades: legRows.length, mid, exec, classification: classify(exec.expectancyR ?? -Infinity) };
  });
  const years = [2023, 2024, 2025, 2026].map((year) => {
    const yearRows = resolvedRows.filter((row) => new Date(String(row.resolved_utc_entry)).getUTCFullYear() === year);
    const exec = metrics(yearRows.map((row) => Number(row.exec_result_r)));
    return { year, ...exec };
  });
  const entrySpreadStats = summary(resolvedRows.map((row) => Number(row.entry_spread_pips)));
  const exitSpreadStats = summary(resolvedRows.map((row) => Number(row.exit_spread_pips)));
  const dragStats = summary(resolvedRows.map((row) => Number(row.execution_drag_r)));
  const transitions = {
    winToLoss: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && Number(row.exec_result_r) <= 0).length,
    winToSmallerWin: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && Number(row.exec_result_r) > 0 && Number(row.exec_result_r) < Number(row.tv_result_r)).length,
    winToTimeExit: resolvedRows.filter((row) => Number(row.tv_result_r) > 0 && row.exec_exit_reason === "TIME_EXIT").length,
    lossToLargerLoss: resolvedRows.filter((row) => Number(row.tv_result_r) <= 0 && Number(row.exec_result_r) < Number(row.tv_result_r)).length,
    lossToWin: resolvedRows.filter((row) => Number(row.tv_result_r) <= 0 && Number(row.exec_result_r) > 0).length,
    tpMissed: resolvedRows.filter((row) => row.tv_exit_reason === "TAKE_PROFIT" && row.exec_exit_reason !== "TAKE_PROFIT").length,
    slEarlier: resolvedRows.filter((row) => {
      if (row.exec_exit_reason !== "STOP_LOSS") return false;
      const raw = rawTrades.find((item) => Number(item.trade_number ?? item.tradeNumber) === Number(row.trade_number));
      const execExit = String(raw?.execExitTime ?? "");
      return row.tv_exit_reason !== "STOP_LOSS" || (execExit !== "" && Date.parse(execExit) < Date.parse(String(row.resolved_utc_exit)));
    }).length,
    reasonChanged: resolvedRows.filter((row) => row.tv_exit_reason !== row.exec_exit_reason).length,
  };
  const execExpectancy = execMetrics.expectancyR ?? -Infinity;
  const classification = classify(execExpectancy);
  const verdict = verdictFor(classification);
  const strongest = [...legs].sort((left, right) => (right.exec.expectancyR ?? -Infinity) - (left.exec.expectancyR ?? -Infinity))[0]!;
  const weakest = [...legs].sort((left, right) => (left.exec.expectancyR ?? Infinity) - (right.exec.expectancyR ?? Infinity))[0]!;
  const separateTestWarranted = weakest.classification === "LOSING" || weakest.classification === "NO EDGE"
    || ((weakest.exec.expectancyR ?? 0) + 0.08 < (strongest.exec.expectancyR ?? 0) && (weakest.exec.expectancyR ?? 0) < 0.10);
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
  const yearTable = [
    "| Year | Trades | WR | PF | Total R | Expectancy R/trade |",
    "|---|---:|---:|---:|---:|---:|",
    ...years.map((year) => `| ${year.year} | ${year.trades} | ${pct(year.winRatePct)} | ${fmt(year.profitFactor)} | ${fmt(year.totalR, 4)}R | ${fmt(year.expectancyR, 4)}R |`),
  ].join("\n");
  const unmatchedBlock = unmatchedRows.length
    ? unmatchedRows.map((row) => `- Trade ${row.trade_number} ${row.leg} at ${row.tv_entry_timestamp}: ${row.unmatched_reason}`).join("\n")
    : "- None. All 181 TradingView trades had a complete OANDA M1 bid/ask window.";
  const report = `# USDCAD Structure EMA Reclaim V2 Selected Origins — authoritative TradingView 181-trade spread replay

## Verdict: ${verdict}

Execution classification: **${classification}**. Exact OANDA executable net expectancy for ${execMetrics.trades} matched trades is **${fmt(execMetrics.expectancyR, 4)}R/trade**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. PEN + EXTREME was not used as a filter. The TradingView CSV is the only trade list.

## Matching

- TradingView trades: **181**
- Matched: **${resolvedRows.length}**
- Unmatched: **${unmatchedRows.length}**

${unmatchedBlock}

CSV composition reproduced exactly: 09:00 LONG 55, 10:00 SHORT 26, 11:00 LONG 49, 11:00 SHORT 51. TradingView money result is ${tvExportMoney.wins} wins / ${tvExportMoney.losses} losses (${fmt(tvExportMoney.winRatePct, 2)}% WR). Export CAD profit factor is ${fmt(tvExportMoney.profitFactor)}; the 1.39 headline is the TradingView UI figure. The table below is R-normalized so MID and EXEC are comparable.

The CSV timezone is **America/New_York**, with DST applied. That maps 181/181 entries onto 09:00, 10:00, or 11:00 UTC. Fixed offsets fail across DST. Sample conversions are in RAW_RESULTS.json.

## Overall

${overallTable}

## Legs

${legTable}

10:00 SHORT was not removed. It is reported as measured.

## Spread

- Average / median / maximum entry spread: ${fmt(entrySpreadStats.average)} / ${fmt(entrySpreadStats.median)} / ${fmt(entrySpreadStats.maximum)} pips
- Average / median / maximum exit spread: ${fmt(exitSpreadStats.average)} / ${fmt(exitSpreadStats.median)} / ${fmt(exitSpreadStats.maximum)} pips
- Average / median / maximum execution drag: ${fmt(dragStats.average, 4)} / ${fmt(dragStats.median, 4)} / ${fmt(dragStats.maximum, 4)} R/trade
- Total execution drag R: ${fmt(dragStats.total, 4)}R
- MID expectancy: ${fmt(resolvedMidMetrics.expectancyR, 4)}R
- EXEC expectancy: ${fmt(execMetrics.expectancyR, 4)}R
- Difference: ${fmt((resolvedMidMetrics.expectancyR ?? 0) - (execMetrics.expectancyR ?? 0), 4)}R/trade

## Outcome changes

- WIN -> LOSS: ${transitions.winToLoss}
- WIN -> smaller WIN: ${transitions.winToSmallerWin}
- WIN -> TIME EXIT: ${transitions.winToTimeExit}
- LOSS -> larger LOSS: ${transitions.lossToLargerLoss}
- LOSS -> WIN: ${transitions.lossToWin}
- TP missed because executable side did not reach target: ${transitions.tpMissed}
- SL hit earlier because of spread: ${transitions.slEarlier}
- Exit reason changed: ${transitions.reasonChanged}

## Year stability

${yearTable}

## Method

- Authoritative cohort: TradingView export of USDCAD Structure EMA Reclaim V2 Selected Origins, 181 completed trades from 2023-01-10 through 2026-08-28.
- Geometry: 1R is OANDA H1 ATR14 frozen at the signal bar. Stop = TV/MID entry ± 1 ATR. Target = TV/MID entry ± 2 ATR. R is not redefined after spread.
- Entry: LONG ASK, SHORT BID at the signal-bar close.
- Intrabar path: completed OANDA Practice M1 bid/ask from the first minute after that close through three future H1 bars.
- LONG stop/TP/time-exit: BID. SHORT stop/TP/time-exit: ASK.
- Same-minute TP and SL: stop first. Gaps fill at the executable open. No second spread subtraction. No trailing stop, profit lock, or threshold change.
- Blocked diagnostic opportunities were not reconstructed.

## Post-validation decision

1. Full four-leg V2 after costs: **${verdict}** (${classification}, ${signed(execMetrics.expectancyR)} /trade).
2. Strongest EXEC leg: **${strongest.label}** at ${signed(strongest.exec.expectancyR)} /trade (${strongest.classification}).
3. Weakest EXEC leg: **${weakest.label}** at ${signed(weakest.exec.expectancyR)} /trade (${weakest.classification}).
4. Separate research test to drop a leg: **${separateTestWarranted ? "WARRANTED as a new frozen test, not performed here" : "NOT warranted from this measurement"}**. No leg was removed.

No deployment. No broker orders. No strategy modification.
`;
  const artifact = {
    generatedAt: new Date().toISOString(),
    verdict, classification,
    authoritativeCohort: {
      file: TV_CSV, copiedTo: resolve(OUT, "TRADINGVIEW_SOURCE.csv"), sha256: csvHash,
      rows: csvRows.length, trades: 181, composition,
      first: cohort.trades[0]?.entryWallTime, last: cohort.trades.at(-1)?.entryWallTime,
      tvExportMoney,
    },
    timezone: { selected: "America/New_York", dstAware: true, scores: zoneScores, validationSamples: samples },
    matching: {
      tradingViewTrades: 181, matched: resolvedRows.length, unmatched: unmatchedRows.length,
      unmatchedDetails: executionUnmatched,
    },
    execution: {
      h1Source: h1.source, m1Source: m1.source,
      entry: "LONG ASK / SHORT BID at signal-bar close; M1 close preferred, H1 close fallback",
      exits: "LONG BID / SHORT ASK M1 barriers; time exit at close of future H1 #3",
      geometry: "1R = OANDA H1 ATR14 frozen at the signal bar; stop/target from TV mid entry",
      ambiguity: "same M1 collision is stop-first",
      spreadAccounting: "direct bid/ask; no second spread subtraction",
    },
    metrics: { tradingViewMid: midMetrics, oandaExecutable: execMetrics, resolvedMid: resolvedMidMetrics, legs, years },
    spread: {
      entryPips: entrySpreadStats, exitPips: exitSpreadStats, dragR: dragStats,
      midExpectancy: resolvedMidMetrics.expectancyR, execExpectancy: execMetrics.expectancyR,
      difference: (resolvedMidMetrics.expectancyR ?? 0) - (execMetrics.expectancyR ?? 0),
    },
    transitions,
    decision: {
      strongestLeg: strongest.label, weakestLeg: weakest.label,
      separateTestWarranted, separateTestPerformed: false,
    },
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
    spread: artifact.spread, transitions, decision: artifact.decision, output: OUT,
  }, null, 2));
}

void main();
