import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { calculateAtrValues } from "../src/lib/strategy/indicators";
import { calculateGbpusdPineEmaValues } from "../src/lib/strategy/strategies/gbpusd-strategy";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

type CsvRow = Record<string, string>;
type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
type Classification = "STRONG" | "GOOD" | "WEAK" | "NO EDGE" | "LOSING";
type Verdict = "SURVIVES_COSTS" | "MARGINAL_AFTER_COSTS" | "FAILS_COSTS";
type ConfidenceTag = "BASE" | "PEN_EXTREME";
type ReplayResult = {
  exitTime: string; exitPrice: number; reason: ExitReason; resultR: number;
  sameMinuteAmbiguous: boolean; exitSpreadPips: number;
  oandaMidExit: number; oandaBidExit: number; oandaAskExit: number;
};

type TvTrade = {
  tradeNumber: number; signal: string; confidenceTag: ConfidenceTag;
  entryWallTime: string; exitWallTime: string; entryUtc: string; exitUtc: string;
  decisionUtc: string; horizonUtc: string; tvEntry: number; tvExit: number;
  tvExitReason: ExitReason; durationBars: number; tvPnl: number; restored: boolean;
};

type FrozenTrade = TvTrade & {
  atr: number; risk: number; stop: number; target: number; h1: ResearchCandle;
  prevH1: ResearchCandle; ema20: number; prevEma20: number;
  structureLong: boolean; emaReclaim: boolean; oandaPenExtreme: boolean; parityOk: boolean;
};

const DEFAULT_TV_CSV = "C:/Users/arche/Downloads/GX_USDCAD_Structure_EMA_Reclaim_V3_-_11_00_LONG_Only_-_1_to_2_RR_OANDA_USDCAD_2026-09-05_a548d.csv";
const PINE_SOURCE = "C:/Users/arche/Documents/usdcad.txt";
const TV_CSV = resolve(process.env.USDCAD_V3_TV_CSV ?? DEFAULT_TV_CSV);
const OUT = resolve(process.cwd(), "../api-server/research-v2/usdcad-v3-1100-long-spread-validation");
const PRIOR_DIR = resolve(process.cwd(), "../api-server/research-v2/usdcad-selected-v2-spread-validation");
const H1_CACHE = resolve(OUT, "data/USD_CAD-H1-MBA.json");
const PRIOR_H1 = resolve(PRIOR_DIR, "data/USD_CAD-H1-MBA.json");
const PRIOR_M1 = resolve(PRIOR_DIR, "data/USD_CAD-M1-TV181-MBA.json");
const PRIOR_TRADES = resolve(PRIOR_DIR, "TRADES.csv");
const M1_CACHE = resolve(OUT, "data/USD_CAD-M1-TV53-MBA.json");
const PIP = 0.0001;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MAX_HOLD_BARS = 3;
const ENTRY_MATCH_PIPS = 1.5;
const EMA_PEN_ATR_MIN = 0.25;
const EXTREME_CLOSE_PCT = 0.25;
const H1_FROM = "2022-06-01T00:00:00.000Z";
const H1_TO = "2026-09-01T00:00:00.000Z";
const PRIOR_V2 = { trades: 181, execExpectancyR: 0.010, execPf: 1.016 } as const;
const PRIOR_1100_LONG = { trades: 49, execWrPct: 48.98, execPf: 1.397, execExpectancyR: 0.214 } as const;

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonical(timestamp: string) { return new Date(timestamp).toISOString(); }
function midpoint(candle: ResearchCandle): Candle {
  return { time: candle.time, volume: candle.volume, complete: candle.complete, ...candle.mid };
}
function round6(value: number) { return Math.round(value * 1_000_000) / 1_000_000; }

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
  const match = /^USDCAD_1100_LONG_(BASE|PEN_EXTREME)$/.exec(signal);
  return match ? match[1]! as ConfidenceTag : null;
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
      const utc = new Date(candidate.resolveTime(trade.entryWallTime));
      if (utc.getUTCHours() === 11 && utc.getUTCMinutes() === 0) originHourMatches += 1;
    }
    return { zone: candidate.zone, originHourMatches, trades: trades.length };
  });
}

function prior1100LongNyTimes() {
  return readFile(PRIOR_TRADES, "utf8").then((text) => {
    const rows = parseCsv(text);
    return new Set(rows.filter((row) => row.leg === "11:00 LONG").map((row) => row.tv_entry_timestamp!));
  });
}

function buildTvTrades(csvRows: readonly CsvRow[], priorNy: ReadonlySet<string>) {
  const grouped = new Map<number, CsvRow[]>();
  for (const row of csvRows) grouped.set(+row["Trade number"]!, [...(grouped.get(+row["Trade number"]!) ?? []), row]);
  assert.equal(grouped.size, 53, "TradingView export must contain exactly 53 trades.");
  const trades: TvTrade[] = [];
  const unmatched: Array<{ tradeNumber: number; reason: string }> = [];
  for (const [tradeNumber, rows] of [...grouped].sort(([left], [right]) => left - right)) {
    const entryRow = rows.find((row) => row.Type === "Entry long");
    const exitRow = rows.find((row) => row.Type === "Exit long");
    if (!entryRow || !exitRow || rows.length !== 2) {
      unmatched.push({ tradeNumber, reason: `Expected one long entry and one long exit; found ${rows.length} rows.` });
      continue;
    }
    const tag = parseSignal(entryRow.Signal!);
    if (!tag) {
      unmatched.push({ tradeNumber, reason: `Signal ${entryRow.Signal} is not USDCAD_1100_LONG_BASE/PEN_EXTREME.` });
      continue;
    }
    const entryUtc = nyWallTimeToUtc(entryRow["Date and time"]!);
    const exitUtc = nyWallTimeToUtc(exitRow["Date and time"]!);
    const entryDate = new Date(entryUtc);
    if (entryDate.getUTCHours() !== 11 || entryDate.getUTCMinutes() !== 0) {
      unmatched.push({ tradeNumber, reason: `America/New_York conversion produced ${entryUtc}, not 11:00 UTC.` });
      continue;
    }
    trades.push({
      tradeNumber, signal: entryRow.Signal!, confidenceTag: tag,
      entryWallTime: entryRow["Date and time"]!, exitWallTime: exitRow["Date and time"]!,
      entryUtc, exitUtc,
      decisionUtc: new Date(Date.parse(entryUtc) + HOUR_MS).toISOString(),
      horizonUtc: new Date(Date.parse(entryUtc) + (1 + MAX_HOLD_BARS) * HOUR_MS).toISOString(),
      tvEntry: +entryRow["Price CAD"]!, tvExit: +exitRow["Price CAD"]!,
      tvExitReason: tvExitReason(exitRow), durationBars: +exitRow["Duration (bars)"]!, tvPnl: +exitRow["Net PnL CAD"]!,
      restored: !priorNy.has(entryRow["Date and time"]!),
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

async function loadH1(path: string) {
  const cached = JSON.parse(await readFile(path, "utf8")) as { from: string; to: string; candles: ResearchCandle[] };
  if (cached.from !== H1_FROM || cached.to !== H1_TO || cached.candles.length <= 15_000) return null;
  return cached.candles.map((candle) => ({ ...candle, time: canonical(candle.time) }));
}

async function fetchH1History() {
  for (const [path, label] of [[H1_CACHE, "local cache"], [PRIOR_H1, "prior V2 H1 cache"]] as const) {
    try {
      const candles = await loadH1(path);
      if (candles) {
        if (path !== H1_CACHE) {
          await mkdir(resolve(OUT, "data"), { recursive: true });
          await writeFile(H1_CACHE, `${JSON.stringify({ from: H1_FROM, to: H1_TO, source: `copied from ${path}`, candles })}\n`);
        }
        return { candles, source: label };
      }
    } catch { /* try the next source */ }
  }
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

async function priorM1ByUtc() {
  try {
    const [tradeText, m1Text] = await Promise.all([readFile(PRIOR_TRADES, "utf8"), readFile(PRIOR_M1, "utf8")]);
    const trades = parseCsv(tradeText).filter((row) => row.leg === "11:00 LONG" && row.matched === "true");
    const cached = JSON.parse(m1Text) as { windows: Record<string, ResearchCandle[]> };
    const byUtc = new Map<string, ResearchCandle[]>();
    for (const row of trades) {
      const bars = cached.windows[row.trade_number!];
      if (bars) byUtc.set(canonical(row.resolved_utc_entry!), bars.map((bar) => ({ ...bar, time: canonical(bar.time) })));
    }
    return byUtc;
  } catch {
    return new Map<string, ResearchCandle[]>();
  }
}

async function m1Windows(trades: readonly TvTrade[], csvHash: string) {
  try {
    const cached = JSON.parse(await readFile(M1_CACHE, "utf8")) as { csvSha256: string; windows: Record<string, ResearchCandle[]> };
    if (cached.csvSha256 === csvHash && Object.keys(cached.windows).length === trades.length) {
      const windows = Object.fromEntries(Object.entries(cached.windows).map(([key, bars]) => [key, bars.map((bar) => ({ ...bar, time: canonical(bar.time) }))]));
      return { windows, source: "cache" as const };
    }
  } catch { /* Fetch missing windows. */ }
  const reused = await priorM1ByUtc();
  const windows: Record<string, ResearchCandle[]> = {};
  const missing = trades.filter((trade) => {
    const prior = reused.get(trade.entryUtc);
    if (prior?.length) { windows[String(trade.tradeNumber)] = prior; return false; }
    return true;
  });
  if (missing.length) {
    const { token, host } = oandaCredentials();
    for (let offset = 0; offset < missing.length; offset += 6) {
      const fetched = await Promise.all(missing.slice(offset, offset + 6).map(async (trade) => [String(trade.tradeNumber), await fetchM1Window(trade, token, host)] as const));
      for (const [number, bars] of fetched) windows[number] = bars;
      if (offset + 6 < missing.length) await new Promise((done) => setTimeout(done, 100));
    }
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  await writeFile(M1_CACHE, `${JSON.stringify({ csvSha256: csvHash, source: "OANDA Practice M1 MBA; reused prior V2 windows where timestamps matched", windows })}\n`);
  return { windows, source: `${trades.length - missing.length} reused from V2, ${missing.length} freshly fetched` as const };
}

function freezeGeometry(
  trade: TvTrade,
  h1ByTime: ReadonlyMap<string, ResearchCandle>,
  atrByTime: ReadonlyMap<string, number | null>,
  emaByTime: ReadonlyMap<string, number>,
) {
  const h1 = h1ByTime.get(trade.entryUtc);
  if (!h1) return { error: `OANDA H1 bar missing at ${trade.entryUtc}.` } as const;
  if (Math.abs(h1.mid.close - trade.tvEntry) > ENTRY_MATCH_PIPS * PIP) {
    return { error: `OANDA H1 mid close ${h1.mid.close} is more than ${ENTRY_MATCH_PIPS} pips from TV entry ${trade.tvEntry}.` } as const;
  }
  const prevUtc = new Date(Date.parse(trade.entryUtc) - HOUR_MS).toISOString();
  const prevH1 = h1ByTime.get(prevUtc);
  if (!prevH1) return { error: `OANDA previous H1 bar missing at ${prevUtc}.` } as const;
  const atr = atrByTime.get(trade.entryUtc) ?? null;
  const ema20 = emaByTime.get(trade.entryUtc);
  const prevEma20 = emaByTime.get(prevUtc);
  if (atr === null || !(atr > 0) || ema20 === undefined || prevEma20 === undefined) {
    return { error: `OANDA H1 ATR14/EMA20 missing at ${trade.entryUtc}.` } as const;
  }
  const structureLong = h1.mid.high > prevH1.mid.high && h1.mid.low > prevH1.mid.low;
  const emaReclaim = prevH1.mid.close <= prevEma20 && h1.mid.close > ema20;
  const candleRange = h1.mid.high - h1.mid.low;
  const oandaPenExtreme = (h1.mid.close - ema20) >= EMA_PEN_ATR_MIN * atr
    && candleRange > 0
    && h1.mid.close >= h1.mid.high - candleRange * EXTREME_CLOSE_PCT;
  return {
    trade: {
      ...trade, atr, risk: atr, stop: trade.tvEntry - atr, target: trade.tvEntry + 2 * atr, h1, prevH1, ema20, prevEma20,
      structureLong, emaReclaim, oandaPenExtreme, parityOk: structureLong && emaReclaim,
    } satisfies FrozenTrade,
  };
}

function entrySnapshot(trade: FrozenTrade, bars: readonly ResearchCandle[]) {
  const entryMinute = new Date(Date.parse(trade.decisionUtc) - MINUTE_MS).toISOString();
  const m1 = bars.find((bar) => canonical(bar.time) === entryMinute) ?? null;
  const source = m1 ?? trade.h1;
  return {
    source: m1 ? "M1_SIGNAL_CLOSE" as const : "H1_SIGNAL_CLOSE" as const,
    mid: source.mid.close, bid: source.bid.close, ask: source.ask.close,
    spreadPips: (source.ask.close - source.bid.close) / PIP,
  };
}

function replay(trade: FrozenTrade, bars: readonly ResearchCandle[], entry: number): ReplayResult | null {
  const requiredLast = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
  const usable = bars
    .filter((bar) => Date.parse(bar.time) >= Date.parse(trade.decisionUtc) && Date.parse(bar.time) < Date.parse(trade.horizonUtc))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (!usable.length || canonical(usable[0]!.time) !== trade.decisionUtc || canonical(usable.at(-1)!.time) !== requiredLast) return null;
  const pnl = (exit: number) => (exit - entry) / trade.risk;
  for (const bar of usable) {
    const price = bar.bid;
    const stopHit = price.low <= trade.stop;
    const targetHit = price.high >= trade.target;
    const spread = (bar.ask.close - bar.bid.close) / PIP;
    const exitTime = new Date(Date.parse(bar.time) + MINUTE_MS).toISOString();
    if (stopHit) {
      const exit = price.open <= trade.stop ? price.open : trade.stop;
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
  return {
    exitTime: trade.horizonUtc, exitPrice: last.bid.close, reason: "TIME_EXIT", resultR: pnl(last.bid.close),
    sameMinuteAmbiguous: false, exitSpreadPips: (last.ask.close - last.bid.close) / PIP,
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
    trades: values.length, wins: wins.length, losses: losses.length,
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
    median: median(values), maximum: Math.max(...values),
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
function pct(value: number | null) { return value == null ? "n/a" : `${value.toFixed(2)}%`; }
function signed(value: number | null | undefined, digits = 4) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}R`;
}

async function main() {
  const [csvText, pineText, priorNy] = await Promise.all([readFile(TV_CSV, "utf8"), readFile(PINE_SOURCE, "utf8"), prior1100LongNyTimes()]);
  const csvHash = sha256(csvText);
  const csvRows = parseCsv(csvText);
  assert.equal(csvRows.length, 106, "TradingView export must contain 106 rows.");
  const exitRows = csvRows.filter((row) => row.Type === "Exit long");
  const tvMoneyWins = exitRows.map((row) => +row["Net PnL CAD"]!).filter((value) => value > 0);
  const tvMoneyLosses = exitRows.map((row) => +row["Net PnL CAD"]!).filter((value) => value < 0);
  const tvExportMoney = {
    wins: tvMoneyWins.length, losses: exitRows.length - tvMoneyWins.length,
    winRatePct: tvMoneyWins.length / exitRows.length * 100,
    profitFactor: tvMoneyWins.reduce((sum, value) => sum + value, 0) / Math.abs(tvMoneyLosses.reduce((sum, value) => sum + value, 0)),
    headlineProfitFactor: 2.417,
  };
  const cohort = buildTvTrades(csvRows, priorNy);
  assert.equal(cohort.trades.length, 53);
  assert.equal(cohort.unmatched.length, 0);
  const tags = cohort.trades.reduce<Record<string, number>>((counts, trade) => {
    counts[trade.confidenceTag] = (counts[trade.confidenceTag] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(tags, { BASE: 32, PEN_EXTREME: 21 });
  const restored = cohort.trades.filter((trade) => trade.restored);
  assert.equal(restored.length, 4, "V3 must restore exactly four 11:00 LONG trades versus V2.");
  const zoneScores = timezoneScores(cohort.trades);
  assert.equal(zoneScores[0]!.originHourMatches, 53);
  const sampleNumbers = [1, 6, 26, 53];
  const samples = sampleNumbers.map((tradeNumber) => {
    const trade = cohort.trades.find((item) => item.tradeNumber === tradeNumber);
    if (!trade) throw new Error(`Sample trade ${tradeNumber} missing.`);
    assert.equal(new Date(trade.entryUtc).getUTCHours(), 11);
    return { tradeNumber: trade.tradeNumber, signal: trade.signal, tradingViewEntry: trade.entryWallTime, resolvedUtc: trade.entryUtc, restored: trade.restored };
  });
  console.log(JSON.stringify({ phase: "timezone_samples_ok", samples, zoneScores, restored: restored.map((trade) => trade.entryWallTime), tvExportMoney }, null, 2));

  const h1 = await fetchH1History();
  const h1ByTime = new Map(h1.candles.map((candle) => [canonical(candle.time), candle]));
  const atrValues = calculateAtrValues(h1.candles.map(midpoint), 14);
  const emaValues = calculateGbpusdPineEmaValues(h1.candles.map((candle) => candle.mid.close), 20);
  const atrByTime = new Map(h1.candles.map((candle, index) => [canonical(candle.time), atrValues[index] ?? null]));
  const emaByTime = new Map(h1.candles.map((candle, index) => [canonical(candle.time), emaValues[index]!]));
  const frozen: FrozenTrade[] = [];
  const geometryUnmatched = [...cohort.unmatched];
  for (const trade of cohort.trades) {
    const result = freezeGeometry(trade, h1ByTime, atrByTime, emaByTime);
    if ("error" in result) { geometryUnmatched.push({ tradeNumber: trade.tradeNumber, reason: result.error }); continue; }
    frozen.push(result.trade);
  }
  const parityMismatches = frozen.filter((trade) => !trade.parityOk);
  console.log(JSON.stringify({
    phase: "geometry", matchedGeometry: frozen.length, unmatchedGeometry: geometryUnmatched,
    parityMismatches: parityMismatches.map((trade) => ({
      tradeNumber: trade.tradeNumber, structureLong: trade.structureLong, emaReclaim: trade.emaReclaim,
    })),
    restored: frozen.filter((trade) => trade.restored).map((trade) => ({
      tradeNumber: trade.tradeNumber, entryWallTime: trade.entryWallTime, entryUtc: trade.entryUtc,
      tvEntry: trade.tvEntry, atrPips: round6(trade.atr / PIP), parityOk: trade.parityOk, tag: trade.confidenceTag,
    })),
  }, null, 2));

  const m1 = await m1Windows(frozen, csvHash);
  const rows: Array<Record<string, unknown>> = [];
  const rawTrades: Array<Record<string, unknown>> = [];
  const executionUnmatched = [...geometryUnmatched];
  for (const trade of frozen) {
    const bars = m1.windows[String(trade.tradeNumber)] ?? [];
    const snapshot = entrySnapshot(trade, bars);
    const tvResultR = (trade.tvExit - trade.tvEntry) / trade.risk;
    const executable = replay(trade, bars, snapshot.ask);
    if (!executable) {
      const requiredLast = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
      const reason = `Incomplete M1 window: ${bars.length} bars; first ${bars[0]?.time ?? "none"}, last ${bars.at(-1)?.time ?? "none"}; required ${trade.decisionUtc} through ${requiredLast}. No quote was fabricated or forward-filled.`;
      executionUnmatched.push({ tradeNumber: trade.tradeNumber, reason });
      rows.push({
        trade_number: trade.tradeNumber, leg: "11:00 LONG", direction: "LONG", origin_utc: "11:00",
        confidence_tag: trade.confidenceTag, restored: trade.restored,
        tv_entry_timestamp: trade.entryWallTime, resolved_utc_entry: trade.entryUtc,
        tv_exit_timestamp: trade.exitWallTime, resolved_utc_exit: trade.exitUtc,
        tv_entry_price: trade.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
        entry_spread_pips: round6(snapshot.spreadPips), atr_at_entry: trade.atr, initial_risk_pips: round6(trade.risk / PIP),
        original_stop: trade.stop, original_target: trade.target, tv_exit_price: trade.tvExit,
        oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exit_spread_pips: null,
        tv_result_r: round6(tvResultR), exec_result_r: null, execution_drag_r: null,
        tv_exit_reason: trade.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null,
        matched: false, unmatched_reason: reason,
      });
      continue;
    }
    const record = {
      trade_number: trade.tradeNumber, leg: "11:00 LONG", direction: "LONG", origin_utc: "11:00",
      confidence_tag: trade.confidenceTag, restored: trade.restored,
      tv_entry_timestamp: trade.entryWallTime, resolved_utc_entry: trade.entryUtc,
      tv_exit_timestamp: trade.exitWallTime, resolved_utc_exit: trade.exitUtc,
      tv_entry_price: trade.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask,
      entry_spread_pips: round6(snapshot.spreadPips), atr_at_entry: trade.atr, initial_risk_pips: round6(trade.risk / PIP),
      original_stop: trade.stop, original_target: trade.target, tv_exit_price: trade.tvExit,
      oanda_mid_exit: executable.oandaMidExit, oanda_bid_exit: executable.oandaBidExit, oanda_ask_exit: executable.oandaAskExit,
      exit_spread_pips: round6(executable.exitSpreadPips),
      tv_result_r: round6(tvResultR), exec_result_r: round6(executable.resultR),
      execution_drag_r: round6(tvResultR - executable.resultR),
      tv_exit_reason: trade.tvExitReason, exec_exit_reason: executable.reason,
      spread_changed_outcome: trade.tvExitReason !== executable.reason || (tvResultR > 0) !== (executable.resultR > 0),
      matched: true, unmatched_reason: "",
    };
    rows.push(record);
    rawTrades.push({
      ...record, m1Bars: bars.length, entrySource: snapshot.source, execExitTime: executable.exitTime,
      parityOk: trade.parityOk, structureLong: trade.structureLong, emaReclaim: trade.emaReclaim,
      oandaPenExtreme: trade.oandaPenExtreme, sameMinuteAmbiguous: executable.sameMinuteAmbiguous,
    });
  }
  rows.sort((left, right) => Number(left.trade_number) - Number(right.trade_number));
  const resolvedRows = rows.filter((row) => row.matched === true);
  const unmatchedRows = rows.filter((row) => row.matched === false);
  const midMetrics = metrics(frozen.map((trade) => (trade.tvExit - trade.tvEntry) / trade.risk));
  const execMetrics = metrics(resolvedRows.map((row) => Number(row.exec_result_r)));
  const overlapRows = resolvedRows.filter((row) => row.restored !== true);
  const restoredRows = resolvedRows.filter((row) => row.restored === true);
  const overlapMetrics = metrics(overlapRows.map((row) => Number(row.exec_result_r)));
  const restoredMetrics = metrics(restoredRows.map((row) => Number(row.exec_result_r)));
  const years = [2023, 2024, 2025, 2026].map((year) => {
    const yearRows = resolvedRows.filter((row) => new Date(String(row.resolved_utc_entry)).getUTCFullYear() === year);
    return { year, ...metrics(yearRows.map((row) => Number(row.exec_result_r))) };
  });
  const subgroups = (["BASE", "PEN_EXTREME"] as const).map((tag) => {
    const tagRows = resolvedRows.filter((row) => row.confidence_tag === tag);
    const exec = metrics(tagRows.map((row) => Number(row.exec_result_r)));
    return { tag, ...exec };
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
    slEarlier: resolvedRows.filter((row) => row.exec_exit_reason === "STOP_LOSS" && row.tv_exit_reason !== "STOP_LOSS").length,
    reasonChanged: resolvedRows.filter((row) => row.tv_exit_reason !== row.exec_exit_reason).length,
  };
  const execExpectancy = execMetrics.expectancyR ?? -Infinity;
  const classification = classify(execExpectancy);
  const verdict = verdictFor(classification);
  const restoredImprove = (restoredMetrics.expectancyR ?? 0) >= (overlapMetrics.expectancyR ?? 0);
  const strongerThanFourLeg = execExpectancy > PRIOR_V2.execExpectancyR;
  const frozenCandidate = verdict === "SURVIVES_COSTS" && strongerThanFourLeg;
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
  const yearTable = [
    "| Year | Trades | Wins | WR | PF | Total R | Expectancy R/trade |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...years.map((year) => `| ${year.year} | ${year.trades} | ${year.wins} | ${pct(year.winRatePct)} | ${fmt(year.profitFactor)} | ${fmt(year.totalR, 4)}R | ${fmt(year.expectancyR, 4)}R |`),
  ].join("\n");
  const tagTable = [
    "| Tag | Trades | WR | PF | Expectancy R/trade |",
    "|---|---:|---:|---:|---:|",
    ...subgroups.map((row) => `| ${row.tag} | ${row.trades} | ${pct(row.winRatePct)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR, 4)}R |`),
  ].join("\n");
  const restoredTable = [
    "| V3 trade | NY entry | UTC | Tag | TV R | EXEC R | EXEC reason |",
    "|---|---|---|---|---:|---:|---|",
    ...restoredRows.map((row) => `| ${row.trade_number} | ${row.tv_entry_timestamp} | ${row.resolved_utc_entry} | ${row.confidence_tag} | ${fmt(Number(row.tv_result_r), 4)} | ${fmt(Number(row.exec_result_r), 4)} | ${row.exec_exit_reason} |`),
  ].join("\n");
  const unmatchedBlock = unmatchedRows.length
    ? unmatchedRows.map((row) => `- Trade ${row.trade_number} at ${row.tv_entry_timestamp}: ${row.unmatched_reason}`).join("\n")
    : "- None. All 53 TradingView trades had a complete OANDA M1 bid/ask window.";
  const report = `# USDCAD Structure EMA Reclaim V3 11:00 LONG-only — authoritative TradingView 53-trade spread replay

## Verdict: ${verdict}

Execution classification: **${classification}**. Exact OANDA executable net expectancy for ${execMetrics.trades} matched trades is **${fmt(execMetrics.expectancyR, 4)}R/trade**. EXEC profit factor is **${fmt(execMetrics.profitFactor)}**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. PEN + EXTREME was not used as a filter.

## Matching

- TradingView trades: **53**
- Matched: **${resolvedRows.length}**
- Unmatched: **${unmatchedRows.length}**

${unmatchedBlock}

CSV composition reproduced exactly: BASE 32, PEN_EXTREME 21. TradingView money result is ${tvExportMoney.wins} wins / ${tvExportMoney.losses} losses (${fmt(tvExportMoney.winRatePct, 2)}% WR). Export CAD profit factor is ${fmt(tvExportMoney.profitFactor)}; the 2.417 headline is the TradingView UI figure. The table below is R-normalized.

The CSV timezone is **America/New_York**, with DST applied. That maps 53/53 entries onto 11:00 UTC (06:00 NY in EST, 07:00 NY in EDT). Fixed offsets fail across DST.

OANDA H1 structure+EMA20 reclaim parity: **${frozen.length - parityMismatches.length}/53**. Parity mismatches were still replayed; they were not dropped.

## Overall

${overallTable}

## Comparison to prior USDCAD V2

| Book | Trades | EXEC WR | EXEC PF | EXEC Exp R |
|---|---:|---:|---:|---:|
| V2 four-leg overall | ${PRIOR_V2.trades} | n/a | ${PRIOR_V2.execPf.toFixed(3)} | ${signed(PRIOR_V2.execExpectancyR, 3)} |
| V2 11:00 LONG subset | ${PRIOR_1100_LONG.trades} | ${PRIOR_1100_LONG.execWrPct.toFixed(2)}% | ${PRIOR_1100_LONG.execPf.toFixed(3)} | ${signed(PRIOR_1100_LONG.execExpectancyR, 3)} |
| V3 overlap with that subset | ${overlapRows.length} | ${pct(overlapMetrics.winRatePct)} | ${fmt(overlapMetrics.profitFactor)} | ${signed(overlapMetrics.expectancyR)} |
| V3 restored four | ${restoredRows.length} | ${pct(restoredMetrics.winRatePct)} | ${fmt(restoredMetrics.profitFactor)} | ${signed(restoredMetrics.expectancyR)} |
| V3 full 11:00 LONG | ${execMetrics.trades} | ${pct(execMetrics.winRatePct)} | ${fmt(execMetrics.profitFactor)} | ${signed(execMetrics.expectancyR)} |

## Four restored trades

These 11:00 LONG signals were blocked in V2 by an earlier 09:00/10:00 position and execute in V3:

${restoredTable}

Combined restored EXEC expectancy: ${signed(restoredMetrics.expectancyR)} on ${restoredRows.length} trades, total ${fmt(restoredMetrics.totalR, 4)}R. Versus the overlapping 49, the four ${restoredImprove ? "improve" : "weaken"} V3's average.

## Year stability

${yearTable}

## Metadata subgroup

Measurement only. PEN_EXTREME was not turned into a filter.

${tagTable}

## Spread

- Average / median / maximum entry spread: ${fmt(entrySpreadStats.average)} / ${fmt(entrySpreadStats.median)} / ${fmt(entrySpreadStats.maximum)} pips
- Average / median / maximum exit spread: ${fmt(exitSpreadStats.average)} / ${fmt(exitSpreadStats.median)} / ${fmt(exitSpreadStats.maximum)} pips
- Average / median / maximum execution drag: ${fmt(dragStats.average, 4)} / ${fmt(dragStats.median, 4)} / ${fmt(dragStats.maximum, 4)} R/trade
- Total execution drag R: ${fmt(dragStats.total, 4)}R

## Outcome changes

- WIN -> LOSS: ${transitions.winToLoss}
- WIN -> smaller WIN: ${transitions.winToSmallerWin}
- WIN -> TIME EXIT: ${transitions.winToTimeExit}
- LOSS -> larger LOSS: ${transitions.lossToLargerLoss}
- LOSS -> WIN: ${transitions.lossToWin}
- TP missed from executable BID: ${transitions.tpMissed}
- SL reached earlier due spread: ${transitions.slEarlier}
- Exit reason changed: ${transitions.reasonChanged}

## Method

- Authoritative cohort: TradingView export of USDCAD V3 11:00 LONG only, 53 completed trades from 2023-01-10 through 2026-08-13.
- Geometry: 1R is OANDA H1 ATR14 frozen at the 11:00 signal bar. Stop = TV close − 1 ATR. Target = TV close + 2 ATR.
- Entry: ASK at the signal-bar close. Exits: BID for TP, SL, and the close of future H1 #3.
- Same-minute TP and SL: stop first. No second spread subtraction.

## Decision

1. V3 11:00 LONG-only after costs: **${verdict}**.
2. Exact EXEC expectancy: **${signed(execMetrics.expectancyR)} /trade**.
3. Exact EXEC PF: **${fmt(execMetrics.profitFactor)}**.
4. Four restored trades: **${restoredImprove ? "improve" : "weaken"}** V3 versus the overlapping 49 (${signed(restoredMetrics.expectancyR)} vs ${signed(overlapMetrics.expectancyR)}).
5. V3 vs prior four-leg V2 (+0.010R): **${strongerThanFourLeg ? "stronger" : "not stronger"}**.
6. Frozen USDCAD research candidate: **${frozenCandidate ? "YES — V3 11:00 LONG-only should be the frozen USDCAD candidate" : "NO — do not freeze V3 as the USDCAD candidate from this run"}**.

No new hours. No optimization. No deployment. No broker orders.
`;
  const artifact = {
    generatedAt: new Date().toISOString(), verdict, classification, frozenCandidate,
    authoritativeCohort: {
      file: TV_CSV, copiedTo: resolve(OUT, "TRADINGVIEW_SOURCE.csv"), sha256: csvHash,
      rows: csvRows.length, trades: 53, tags, first: cohort.trades[0]?.entryWallTime, last: cohort.trades.at(-1)?.entryWallTime,
      tvExportMoney,
    },
    timezone: { selected: "America/New_York", dstAware: true, scores: zoneScores, validationSamples: samples },
    matching: { tradingViewTrades: 53, matched: resolvedRows.length, unmatched: unmatchedRows.length, unmatchedDetails: executionUnmatched, parityMismatches: parityMismatches.length },
    comparison: {
      priorV2: PRIOR_V2, prior1100Long: PRIOR_1100_LONG, overlap: overlapMetrics, restored: restoredMetrics,
      restoredTrades: restoredRows.map((row) => ({
        tradeNumber: row.trade_number, ny: row.tv_entry_timestamp, utc: row.resolved_utc_entry,
        tag: row.confidence_tag, tvR: row.tv_result_r, execR: row.exec_result_r, execReason: row.exec_exit_reason,
      })),
      restoredImprove, strongerThanFourLeg,
    },
    metrics: { tradingViewMid: midMetrics, oandaExecutable: execMetrics, years, subgroups },
    spread: { entryPips: entrySpreadStats, exitPips: exitSpreadStats, dragR: dragStats },
    transitions, execution: { h1Source: h1.source, m1Source: m1.source },
    trades: rawTrades,
  };
  await mkdir(OUT, { recursive: true });
  await Promise.all([
    writeFile(resolve(OUT, "REPORT.md"), report),
    writeFile(resolve(OUT, "TRADES.csv"), toCsv(rows)),
    writeFile(resolve(OUT, "RAW_RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`),
    writeFile(resolve(OUT, "TRADINGVIEW_SOURCE.csv"), csvText),
    writeFile(resolve(OUT, "PINE_SOURCE.pine"), pineText),
  ]);
  console.log(JSON.stringify({
    verdict, classification, matching: artifact.matching, metrics: artifact.metrics,
    comparison: artifact.comparison, spread: artifact.spread, transitions, frozenCandidate, output: OUT,
  }, null, 2));
}

void main();
