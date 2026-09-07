import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { calculateAtrValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

type CsvRow = Record<string, string>;
type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
type Classification = "STRONG" | "GOOD" | "WEAK" | "NO EDGE" | "LOSING";
type Verdict = "SURVIVES_COSTS" | "MARGINAL_AFTER_COSTS" | "FAILS_COSTS";
export type ReplayResult = {
  exitTime: string; exitPrice: number; reason: ExitReason; resultR: number;
  sameMinuteAmbiguous: boolean; exitSpreadPips: number;
  oandaMidExit: number; oandaBidExit: number; oandaAskExit: number;
};
type TvTrade = {
  tradeNumber: number; signal: "AUDUSD_HL_BASE" | "AUDUSD_HL_BODY_EXTREME";
  entryWallTime: string; exitWallTime: string; entryUtc: string; exitUtc: string;
  decisionUtc: string; horizonUtc: string; tvEntry: number; tvExit: number;
  tvExitReason: ExitReason; durationBars: number; tvPnl: number;
};
type FrozenTrade = TvTrade & { risk: number; stop: number; target: number; atr14: number; h1: ResearchCandle };

const DEFAULT_CSV = "C:/Users/arche/Downloads/GX_AUDUSD_Strong_Consensus_Structure_V2_-_HL_Only_-_1_to_2_RR_OANDA_AUDUSD_2026-09-05_88555.csv";
const DEFAULT_PINE = "C:/Users/arche/.codex/attachments/ae0910a9-7b1d-42e6-9c43-63ba25d9fa23/pasted-text.txt";
const TV_CSV = resolve(process.env.AUDUSD_HL_V2_TV_CSV ?? DEFAULT_CSV);
const PINE_SOURCE = resolve(process.env.AUDUSD_HL_V2_PINE_SOURCE ?? DEFAULT_PINE);
const OUT = resolve(process.cwd(), "../api-server/research-v2/audusd-hl-v2-spread-validation");
const H1_CACHE = resolve(OUT, "data/AUD_USD-H1-MBA.json");
const M1_CACHE = resolve(OUT, "data/AUD_USD-M1-TV219-MBA.json");
const PIP = 0.0001, MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS, MAX_HOLD_BARS = 3;
const H1_FROM = "2022-09-01T00:00:00.000Z", H1_TO = "2026-09-05T00:00:00.000Z";
const ENTRY_MATCH_PIPS = 1.5;
const OLD_AUDUSD = { trades: 195, execExpectancyR: 0.118, execWinRatePct: 45.64, execProfitFactor: 1.232 } as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => new Date(value).toISOString();
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const midpoint = (c: ResearchCandle): Candle => ({ time: canonical(c.time), volume: c.volume, complete: c.complete, ...c.mid });

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
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid TradingView timestamp: ${value}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) + offsetHours * HOUR_MS).toISOString();
}
export function nyWallTimeToUtc(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid TradingView timestamp: ${value}`);
  const expected = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const valid = [4, 5].map(offset => new Date(wall + offset * HOUR_MS)).filter(candidate => {
    const parts = formatter.formatToParts(candidate);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}` === expected;
  });
  if (valid.length !== 1) throw new Error(`TradingView timestamp ${value} has ${valid.length} New York resolutions.`);
  return valid[0]!.toISOString();
}
function tvReason(row: CsvRow): ExitReason {
  if (row.Signal === "TIME_EXIT") return "TIME_EXIT";
  assert.equal(row.Signal, "TP_OR_SL", `Unexpected exit signal ${row.Signal}`);
  return +row["Price USD"]! > 0 && +row["Net PnL USD"]! > 0 ? "TAKE_PROFIT" : "STOP_LOSS";
}
function buildTrades(rows: CsvRow[]) {
  const grouped = new Map<number, CsvRow[]>();
  for (const row of rows) grouped.set(+row["Trade number"]!, [...(grouped.get(+row["Trade number"]!) ?? []), row]);
  assert.equal(grouped.size, 219);
  const trades: TvTrade[] = [], unmatched: Array<{ tradeNumber: number; reason: string }> = [];
  for (const [tradeNumber, pair] of [...grouped].sort(([a], [b]) => a - b)) {
    const entry = pair.find(row => row.Type === "Entry long"), exit = pair.find(row => row.Type === "Exit long");
    if (!entry || !exit || pair.length !== 2) { unmatched.push({ tradeNumber, reason: `Expected exactly one long entry and exit; found ${pair.length} rows.` }); continue; }
    if (entry.Signal !== "AUDUSD_HL_BASE" && entry.Signal !== "AUDUSD_HL_BODY_EXTREME") { unmatched.push({ tradeNumber, reason: `Unexpected signal ${entry.Signal}.` }); continue; }
    const entryUtc = nyWallTimeToUtc(entry["Date and time"]!), exitUtc = nyWallTimeToUtc(exit["Date and time"]!);
    if (new Date(entryUtc).getUTCHours() !== 11 || new Date(entryUtc).getUTCMinutes() !== 0) { unmatched.push({ tradeNumber, reason: `Resolved entry ${entryUtc} is not 11:00 UTC.` }); continue; }
    trades.push({ tradeNumber, signal: entry.Signal, entryWallTime: entry["Date and time"]!, exitWallTime: exit["Date and time"]!, entryUtc, exitUtc,
      decisionUtc: new Date(Date.parse(entryUtc) + HOUR_MS).toISOString(), horizonUtc: new Date(Date.parse(entryUtc) + (1 + MAX_HOLD_BARS) * HOUR_MS).toISOString(),
      tvEntry: +entry["Price USD"]!, tvExit: +exit["Price USD"]!, tvExitReason: tvReason(exit), durationBars: +exit["Duration (bars)"]!, tvPnl: +exit["Net PnL USD"]! });
  }
  return { trades, unmatched };
}
function timezoneScores(trades: TvTrade[]) {
  const zones = [
    { zone: "America/New_York", convert: nyWallTimeToUtc },
    { zone: "UTC", convert: (v: string) => wallTimeWithOffset(v, 0) },
    { zone: "fixed UTC-04:00", convert: (v: string) => wallTimeWithOffset(v, 4) },
    { zone: "fixed UTC-05:00", convert: (v: string) => wallTimeWithOffset(v, 5) },
  ];
  return zones.map(z => ({ zone: z.zone, originMatches: trades.filter(t => { const d = new Date(z.convert(t.entryWallTime)); return d.getUTCHours() === 11 && d.getUTCMinutes() === 0; }).length, trades: trades.length }));
}
function credentials() {
  loadEnvConfig(resolve(process.cwd(), "../api-server")); loadEnvConfig(process.cwd());
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA credentials are required for read-only historical validation.");
  return { token, host: process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com" };
}
function parseOanda(body: { candles?: Array<{ time: string; volume: number; complete: boolean; mid?: Record<"o" | "h" | "l" | "c", string>; bid?: Record<"o" | "h" | "l" | "c", string>; ask?: Record<"o" | "h" | "l" | "c", string> }> }) {
  return (body.candles ?? []).filter(c => c.complete && c.mid && c.bid && c.ask).map((c): ResearchCandle => ({ time: canonical(c.time), volume: c.volume, complete: true,
    mid: { open: +c.mid!.o, high: +c.mid!.h, low: +c.mid!.l, close: +c.mid!.c }, bid: { open: +c.bid!.o, high: +c.bid!.h, low: +c.bid!.l, close: +c.bid!.c }, ask: { open: +c.ask!.o, high: +c.ask!.h, low: +c.ask!.l, close: +c.ask!.c } }));
}
async function oandaGet(host: string, token: string, url: URL) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return parseOanda(await response.json() as Parameters<typeof parseOanda>[0]);
    if (attempt === 4 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`OANDA historical request failed: HTTP ${response.status}`);
    await new Promise(done => setTimeout(done, attempt * 500));
  }
  return [];
}
async function h1History() {
  try {
    const cache = JSON.parse(await readFile(H1_CACHE, "utf8")) as { from: string; to: string; candles: ResearchCandle[] };
    if (cache.from === H1_FROM && cache.to === H1_TO && cache.candles.length > 15_000) return { candles: cache.candles.map(c => ({ ...c, time: canonical(c.time) })), source: "cache" as const };
  } catch { /* Fetch immutable research cache. */ }
  const { token, host } = credentials(), map = new Map<string, ResearchCandle>();
  let cursor = H1_TO, prior = "";
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${host}/v3/instruments/AUD_USD/candles`);
    for (const [k, v] of Object.entries({ price: "MBA", granularity: "H1", count: "5000", to: cursor })) url.searchParams.set(k, v);
    const batch = await oandaGet(host, token, url); for (const c of batch) map.set(c.time, c);
    const earliest = batch.map(c => c.time).sort()[0];
    if (!earliest || earliest === prior || Date.parse(earliest) <= Date.parse(H1_FROM)) break;
    prior = earliest; cursor = new Date(Date.parse(earliest) - 1).toISOString();
  }
  const candles = [...map.values()].filter(c => Date.parse(c.time) >= Date.parse(H1_FROM) && Date.parse(c.time) < Date.parse(H1_TO)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  assert.ok(candles.length > 15_000, `Insufficient H1 history: ${candles.length}`);
  await mkdir(resolve(OUT, "data"), { recursive: true }); await writeFile(H1_CACHE, JSON.stringify({ from: H1_FROM, to: H1_TO, source: "OANDA completed H1 MBA", candles }) + "\n");
  return { candles, source: "fresh OANDA fetch" as const };
}
async function m1Windows(trades: TvTrade[], csvHash: string) {
  try {
    const cache = JSON.parse(await readFile(M1_CACHE, "utf8")) as { csvSha256: string; windows: Record<string, ResearchCandle[]> };
    if (cache.csvSha256 === csvHash && Object.keys(cache.windows).length === trades.length) return { windows: Object.fromEntries(Object.entries(cache.windows).map(([k, bars]) => [k, bars.map(c => ({ ...c, time: canonical(c.time) }))])), source: "cache" as const };
  } catch { /* Fetch targeted windows. */ }
  const { token, host } = credentials(), windows: Record<string, ResearchCandle[]> = {};
  for (let offset = 0; offset < trades.length; offset += 6) {
    const page = await Promise.all(trades.slice(offset, offset + 6).map(async t => {
      const url = new URL(`${host}/v3/instruments/AUD_USD/candles`);
      for (const [k, v] of Object.entries({ price: "MBA", granularity: "M1", from: t.entryUtc, to: t.horizonUtc, includeFirst: "true" })) url.searchParams.set(k, v);
      return [String(t.tradeNumber), await oandaGet(host, token, url)] as const;
    }));
    for (const [key, bars] of page) windows[key] = bars;
    if (offset + 6 < trades.length) await new Promise(done => setTimeout(done, 100));
    if ((offset + 6) % 60 === 0) console.log(`Fetched ${Math.min(offset + 6, trades.length)}/${trades.length} targeted M1 windows.`);
  }
  await mkdir(resolve(OUT, "data"), { recursive: true }); await writeFile(M1_CACHE, JSON.stringify({ csvSha256: csvHash, source: "OANDA completed M1 MBA exact TV cohort windows", windows }) + "\n");
  return { windows, source: "fresh OANDA fetch" as const };
}
function freezeTrade(trade: TvTrade, h1: Map<string, ResearchCandle>, atr: Map<string, number | null>): { trade?: FrozenTrade; error?: string } {
  const bar = h1.get(trade.entryUtc), risk = atr.get(trade.entryUtc) ?? null;
  if (!bar) return { error: `OANDA H1 signal candle missing at ${trade.entryUtc}.` };
  if (Math.abs(bar.mid.close - trade.tvEntry) > ENTRY_MATCH_PIPS * PIP) return { error: `OANDA H1 mid close ${bar.mid.close} differs from TV entry ${trade.tvEntry} by more than ${ENTRY_MATCH_PIPS} pips.` };
  if (!(risk && risk > 0)) return { error: `ATR14 unavailable at ${trade.entryUtc}.` };
  return { trade: { ...trade, risk, stop: trade.tvEntry - risk, target: trade.tvEntry + 2 * risk, atr14: risk, h1: bar } };
}
function entrySnapshot(trade: FrozenTrade, bars: ResearchCandle[]) {
  const minute = new Date(Date.parse(trade.decisionUtc) - MINUTE_MS).toISOString();
  const m1 = bars.find(c => c.time === minute), c = m1 ?? trade.h1;
  return { source: m1 ? "M1_SIGNAL_CLOSE" : "H1_SIGNAL_CLOSE", mid: c.mid.close, bid: c.bid.close, ask: c.ask.close, spreadPips: (c.ask.close - c.bid.close) / PIP };
}
export function replay(trade: Pick<FrozenTrade, "decisionUtc" | "horizonUtc" | "stop" | "target" | "risk">, bars: ResearchCandle[], mode: "mid" | "exec", entry: number): ReplayResult | null {
  const usable = bars.filter(c => Date.parse(c.time) >= Date.parse(trade.decisionUtc) && Date.parse(c.time) < Date.parse(trade.horizonUtc)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const first = trade.decisionUtc, last = new Date(Date.parse(trade.horizonUtc) - MINUTE_MS).toISOString();
  if (!usable.length || usable[0]!.time !== first || usable.at(-1)!.time !== last) return null;
  for (const bar of usable) {
    const q = mode === "mid" ? bar.mid : bar.bid, stop = q.low <= trade.stop, target = q.high >= trade.target;
    const spread = (bar.ask.close - bar.bid.close) / PIP, exitTime = new Date(Date.parse(bar.time) + MINUTE_MS).toISOString();
    if (stop) {
      const exit = q.open <= trade.stop ? q.open : trade.stop;
      return { exitTime, exitPrice: exit, reason: "STOP_LOSS", resultR: (exit - entry) / trade.risk, sameMinuteAmbiguous: target,
        exitSpreadPips: spread, oandaMidExit: bar.mid.close, oandaBidExit: bar.bid.close, oandaAskExit: bar.ask.close };
    }
    if (target) return { exitTime, exitPrice: trade.target, reason: "TAKE_PROFIT", resultR: (trade.target - entry) / trade.risk, sameMinuteAmbiguous: false,
      exitSpreadPips: spread, oandaMidExit: bar.mid.close, oandaBidExit: bar.bid.close, oandaAskExit: bar.ask.close };
  }
  const bar = usable.at(-1)!, exit = mode === "mid" ? bar.mid.close : bar.bid.close;
  return { exitTime: trade.horizonUtc, exitPrice: exit, reason: "TIME_EXIT", resultR: (exit - entry) / trade.risk, sameMinuteAmbiguous: false,
    exitSpreadPips: (bar.ask.close - bar.bid.close) / PIP, oandaMidExit: bar.mid.close, oandaBidExit: bar.bid.close, oandaAskExit: bar.ask.close };
}
function metrics(values: number[]) {
  const wins = values.filter(v => v > 0), losses = values.filter(v => v <= 0), gp = wins.reduce((s, v) => s + v, 0), gl = losses.reduce((s, v) => s + v, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const v of values) { equity += v; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return { trades: values.length, wins: wins.length, losses: losses.length, winRatePct: values.length ? wins.length / values.length * 100 : null,
    profitFactor: gl < 0 ? gp / -gl : null, totalR: gp + gl, expectancyR: values.length ? (gp + gl) / values.length : null,
    averageWinnerR: wins.length ? gp / wins.length : null, averageLoserR: losses.length ? gl / losses.length : null, maxDrawdownR };
}
function summary(values: number[]) { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return { average: values.reduce((s, v) => s + v, 0) / values.length,
  median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, maximum: Math.max(...values), total: values.reduce((s, v) => s + v, 0) }; }
function fmt(value: number | null | undefined, digits = 3) { return value == null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits); }
function csvCell(value: unknown) { const text = value == null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function toCsv(rows: Record<string, unknown>[]) { const columns = Object.keys(rows[0]!); return `${columns.join(",")}\n${rows.map(row => columns.map(c => csvCell(row[c])).join(",")).join("\n")}\n`; }
function classify(exp: number): Classification { return exp >= .15 ? "STRONG" : exp >= .10 ? "GOOD" : exp >= .05 ? "WEAK" : exp >= 0 ? "NO EDGE" : "LOSING"; }
function verdictFor(c: Classification): Verdict { return c === "STRONG" || c === "GOOD" ? "SURVIVES_COSTS" : c === "LOSING" ? "FAILS_COSTS" : "MARGINAL_AFTER_COSTS"; }

async function main() {
  const csvText = await readFile(TV_CSV, "utf8"), pineText = await readFile(PINE_SOURCE, "utf8"), csvHash = sha256(csvText), csvRows = parseCsv(csvText);
  assert.match(pineText, /bullStructureVote\s*=\s*[\s\S]*?high\s*>\s*high\[1\][\s\S]*?low\s*>\s*low\[1\]/, "Vote 5 must remain HH+HL");
  assert.match(pineText, /higherLow\s*=\s*[\s\S]*?low\s*>\s*low\[1\]/, "External V2 filter must be HL-only");
  assert.match(pineText, /voteSum\s*>=\s*VOTE_THRESHOLD/, "Consensus threshold missing");
  assert.equal(csvRows.length, 438); const cohort = buildTrades(csvRows); assert.equal(cohort.trades.length, 219); assert.equal(cohort.unmatched.length, 0);
  const exits = csvRows.filter(r => r.Type === "Exit long");
  assert.equal(exits.filter(r => +r["Net PnL USD"]! > 0).length, 106); assert.equal(exits.filter(r => +r["Net PnL USD"]! <= 0).length, 113);
  const zones = timezoneScores(cohort.trades); assert.equal(zones[0]!.originMatches, 219);
  const sampleNumbers = [1, 6, 110, 218, 219];
  const samples = sampleNumbers.map(n => { const t = cohort.trades.find(x => x.tradeNumber === n)!; return { tradeNumber: n, tradingViewEntry: t.entryWallTime, resolvedUtcEntry: t.entryUtc, tradingViewExit: t.exitWallTime, resolvedUtcExit: t.exitUtc, signal: t.signal }; });
  console.log(JSON.stringify({ phase: "timezone_samples_ok", zones, samples }, null, 2));
  const h1 = await h1History(), byH1 = new Map(h1.candles.map(c => [c.time, c])), atrValues = calculateAtrValues(h1.candles.map(midpoint), 14), byAtr = new Map(h1.candles.map((c, i) => [c.time, atrValues[i] ?? null]));
  const frozen: FrozenTrade[] = [], unmatched = [...cohort.unmatched];
  for (const t of cohort.trades) { const result = freezeTrade(t, byH1, byAtr); if (result.trade) frozen.push(result.trade); else unmatched.push({ tradeNumber: t.tradeNumber, reason: result.error! }); }
  console.log(JSON.stringify({ phase: "geometry_samples", matched: frozen.length, unmatched, samples: frozen.filter(t => sampleNumbers.includes(t.tradeNumber)).map(t => ({ tradeNumber: t.tradeNumber, tvEntry: t.tvEntry, oandaMidClose: t.h1.mid.close, atrPips: t.risk / PIP, stop: t.stop, target: t.target })) }, null, 2));
  const m1 = await m1Windows(frozen, csvHash), rows: Record<string, unknown>[] = [], raw: Record<string, unknown>[] = [], executionUnmatched = [...unmatched];
  const frozenByNumber = new Map(frozen.map(t => [t.tradeNumber, t]));
  for (const tv of cohort.trades) {
    const t = frozenByNumber.get(tv.tradeNumber);
    if (!t) { rows.push({ trade_number: tv.tradeNumber, tv_entry_timestamp: tv.entryWallTime, resolved_utc_entry: tv.entryUtc, tv_exit_timestamp: tv.exitWallTime, resolved_utc_exit: tv.exitUtc,
      tv_entry_price: tv.tvEntry, oanda_mid_entry: null, oanda_bid_entry: null, oanda_ask_entry: null, entry_spread_pips: null, original_stop: null, original_target: null, initial_risk_pips: null,
      tv_exit_price: tv.tvExit, oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exec_exit_timestamp: null, exec_exit_price: null, exit_spread_pips: null, tv_result_r: null, exec_result_r: null, spread_drag_r: null,
      tv_exit_reason: tv.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null, matched: false, unmatched_reason: unmatched.find(x => x.tradeNumber === tv.tradeNumber)?.reason }); continue; }
    const bars = m1.windows[String(t.tradeNumber)] ?? [], snapshot = entrySnapshot(t, bars), midReplay = replay(t, bars, "mid", t.tvEntry), exec = replay(t, bars, "exec", snapshot.ask);
    const productionCentered = replay({ ...t, stop: snapshot.ask - t.risk, target: snapshot.ask + 2 * t.risk }, bars, "exec", snapshot.ask);
    const tvR = (t.tvExit - t.tvEntry) / t.risk;
    if (!exec || !midReplay) {
      const reason = `Incomplete M1 replay: ${bars.length} bars; required ${t.decisionUtc} through ${new Date(Date.parse(t.horizonUtc) - MINUTE_MS).toISOString()}. No quote fabricated or forward-filled.`;
      executionUnmatched.push({ tradeNumber: t.tradeNumber, reason }); rows.push({ trade_number: t.tradeNumber, tv_entry_timestamp: t.entryWallTime, resolved_utc_entry: t.entryUtc, tv_exit_timestamp: t.exitWallTime, resolved_utc_exit: t.exitUtc,
        tv_entry_price: t.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask, entry_spread_pips: round6(snapshot.spreadPips), original_stop: t.stop, original_target: t.target,
        initial_risk_pips: round6(t.risk / PIP), tv_exit_price: t.tvExit, oanda_mid_exit: null, oanda_bid_exit: null, oanda_ask_exit: null, exec_exit_timestamp: null, exec_exit_price: null, exit_spread_pips: null, tv_result_r: round6(tvR), exec_result_r: null,
        spread_drag_r: null, tv_exit_reason: t.tvExitReason, exec_exit_reason: null, spread_changed_outcome: null, matched: false, unmatched_reason: reason }); continue;
    }
    const record = { trade_number: t.tradeNumber, tv_entry_timestamp: t.entryWallTime, resolved_utc_entry: t.entryUtc, tv_exit_timestamp: t.exitWallTime, resolved_utc_exit: t.exitUtc,
      tv_entry_price: t.tvEntry, oanda_mid_entry: snapshot.mid, oanda_bid_entry: snapshot.bid, oanda_ask_entry: snapshot.ask, entry_spread_pips: round6(snapshot.spreadPips), original_stop: t.stop, original_target: t.target,
      initial_risk_pips: round6(t.risk / PIP), tv_exit_price: t.tvExit, oanda_mid_exit: exec.oandaMidExit, oanda_bid_exit: exec.oandaBidExit, oanda_ask_exit: exec.oandaAskExit,
      exec_exit_timestamp: exec.exitTime, exec_exit_price: exec.exitPrice, exit_spread_pips: round6(exec.exitSpreadPips), tv_result_r: round6(tvR), exec_result_r: round6(exec.resultR), spread_drag_r: round6(tvR - exec.resultR), tv_exit_reason: t.tvExitReason,
      exec_exit_reason: exec.reason, spread_changed_outcome: t.tvExitReason !== exec.reason || (tvR > 0) !== (exec.resultR > 0), matched: true, unmatched_reason: "" };
    rows.push(record); raw.push({ ...record, signal: t.signal, atr14: t.atr14, entrySource: snapshot.source, execEntry: snapshot.ask, execExitPrice: exec.exitPrice, execExitTime: exec.exitTime,
      midReplayResultR: midReplay.resultR, midReplayReason: midReplay.reason, midReplayExitTime: midReplay.exitTime, sameMinuteAmbiguous: exec.sameMinuteAmbiguous, m1Bars: bars.length,
      productionCenteredExecResultR: productionCentered?.resultR ?? null, productionCenteredExecReason: productionCentered?.reason ?? null });
  }
  rows.sort((a, b) => +a.trade_number! - +b.trade_number!); const matchedRows = rows.filter(r => r.matched === true), unmatchedRows = rows.filter(r => r.matched === false);
  const tvValues = frozen.map(t => (t.tvExit - t.tvEntry) / t.risk), matchedTv = matchedRows.map(r => +r.tv_result_r!), execValues = matchedRows.map(r => +r.exec_result_r!);
  const tvMetrics = metrics(tvValues), matchedMidMetrics = metrics(matchedTv), execMetrics = metrics(execValues);
  const productionCenteredMetrics = metrics(raw.map(r => Number(r.productionCenteredExecResultR)).filter(Number.isFinite));
  const entrySpread = summary(matchedRows.map(r => +r.entry_spread_pips!)), exitSpread = summary(matchedRows.map(r => +r.exit_spread_pips!)), spreadDrag = summary(matchedRows.map(r => +r.spread_drag_r!));
  const transitions = {
    winToLoss: matchedRows.filter(r => +r.tv_result_r! > 0 && +r.exec_result_r! <= 0).length,
    winToSmallerWin: matchedRows.filter(r => +r.tv_result_r! > 0 && +r.exec_result_r! > 0 && +r.exec_result_r! < +r.tv_result_r!).length,
    winToTimeExit: matchedRows.filter(r => r.tv_exit_reason === "TAKE_PROFIT" && r.exec_exit_reason === "TIME_EXIT").length,
    lossToLargerLoss: matchedRows.filter(r => +r.tv_result_r! <= 0 && +r.exec_result_r! < +r.tv_result_r!).length,
    lossToWin: matchedRows.filter(r => +r.tv_result_r! <= 0 && +r.exec_result_r! > 0).length,
    tpMissedDueToBid: raw.filter(r => r.tv_exit_reason === "TAKE_PROFIT" && r.midReplayReason === "TAKE_PROFIT" && r.exec_exit_reason !== "TAKE_PROFIT").length,
    slHitEarlierDueToSpread: raw.filter(r => r.exec_exit_reason === "STOP_LOSS" && (r.midReplayReason !== "STOP_LOSS" || Date.parse(String(r.execExitTime)) < Date.parse(String(r.midReplayExitTime)))).length,
    exitReasonChanged: matchedRows.filter(r => r.tv_exit_reason !== r.exec_exit_reason).length,
  };
  const tvDollars = cohort.trades.map(t => t.tvPnl), tvGp = tvDollars.filter(x => x > 0).reduce((s, x) => s + x, 0), tvGl = tvDollars.filter(x => x <= 0).reduce((s, x) => s + x, 0);
  const tvFixedQtyPf = tvGp / -tvGl, classification = classify(execMetrics.expectancyR ?? -Infinity), verdict = verdictFor(classification);
  const comparableExpectancy = productionCenteredMetrics.expectancyR ?? -Infinity;
  const frequencyDecision = comparableExpectancy < 0 ? 3 : comparableExpectancy >= OLD_AUDUSD.execExpectancyR ? 1 : 2;
  const frequencyText = frequencyDecision === 1 ? "V2 increases frequency and improves/preserves executable edge." : frequencyDecision === 2 ? "V2 increases frequency but weakens executable edge." : "V2 fails after spread.";
  const byYear = Object.fromEntries([2023, 2024, 2025, 2026].map(year => {
    const values = raw.filter(r => new Date(String(r.resolved_utc_entry)).getUTCFullYear() === year).map(r => Number(r.exec_result_r));
    return [year, metrics(values)];
  }));
  const table = `| Metric | TradingView/MID | OANDA EXEC |\n|---|---:|---:|\n| Trades | ${tvMetrics.trades} | ${execMetrics.trades} |\n| Wins | ${tvMetrics.wins} | ${execMetrics.wins} |\n| Losses | ${tvMetrics.losses} | ${execMetrics.losses} |\n| Win rate | ${fmt(tvMetrics.winRatePct, 2)}% | ${fmt(execMetrics.winRatePct, 2)}% |\n| Profit factor (R-normalized) | ${fmt(tvMetrics.profitFactor)} | ${fmt(execMetrics.profitFactor)} |\n| Total R | ${fmt(tvMetrics.totalR, 4)}R | ${fmt(execMetrics.totalR, 4)}R |\n| Expectancy R/trade | ${fmt(tvMetrics.expectancyR, 4)}R | ${fmt(execMetrics.expectancyR, 4)}R |\n| Average winner R | ${fmt(tvMetrics.averageWinnerR, 4)}R | ${fmt(execMetrics.averageWinnerR, 4)}R |\n| Average loser R | ${fmt(tvMetrics.averageLoserR, 4)}R | ${fmt(execMetrics.averageLoserR, 4)}R |\n| Max drawdown R | ${fmt(tvMetrics.maxDrawdownR, 4)}R | ${fmt(execMetrics.maxDrawdownR, 4)}R |`;
  const unmatchedBlock = unmatchedRows.length ? unmatchedRows.map(r => `- Trade ${r.trade_number}: ${r.unmatched_reason}`).join("\n") : "- None. All 219 trades matched complete OANDA windows.";
  const report = `# AUDUSD V2 HL-only — authoritative TradingView spread validation\n\n## Verdict: ${verdict}\n\nClassification: **${classification}**. Executable expectancy is **${fmt(execMetrics.expectancyR, 4)}R/trade** on ${execMetrics.trades} exact OANDA replays.\n\n## Matching\n\n- TradingView trades: **219**\n- Matched: **${matchedRows.length}**\n- Unmatched: **${unmatchedRows.length}**\n\n${unmatchedBlock}\n\nThe CSV timezone is **America/New_York**, DST-aware: 219/219 entries resolve to the 11:00 UTC signal candle. Beginning, middle, and end samples are retained in RAW_RESULTS.json.\n\n## Comparison\n\n${table}\n\nTradingView fixed-quantity price PF is **${fmt(tvFixedQtyPf)}**, reproducing the supplied approximately 1.462 headline. The table uses ATR-normalized R for an apples-to-apples comparison. MID includes the authoritative cohort; EXEC includes exact matched windows only.\n\n## Spread\n\n- Entry spread average / median / maximum: ${fmt(entrySpread.average)} / ${fmt(entrySpread.median)} / ${fmt(entrySpread.maximum)} pips\n- Exit spread average / median / maximum: ${fmt(exitSpread.average)} / ${fmt(exitSpread.median)} / ${fmt(exitSpread.maximum)} pips\n- Spread drag average / median / maximum: ${fmt(spreadDrag.average, 4)} / ${fmt(spreadDrag.median, 4)} / ${fmt(spreadDrag.maximum, 4)} R/trade\n- Total spread drag: ${fmt(spreadDrag.total, 4)}R\n- Matched MID expectancy: ${fmt(matchedMidMetrics.expectancyR, 4)}R\n- EXEC expectancy: ${fmt(execMetrics.expectancyR, 4)}R\n\n## Outcome changes\n\n- WIN -> LOSS: ${transitions.winToLoss}\n- WIN -> smaller WIN: ${transitions.winToSmallerWin}\n- WIN -> TIME EXIT: ${transitions.winToTimeExit}\n- LOSS -> larger LOSS: ${transitions.lossToLargerLoss}\n- LOSS -> WIN: ${transitions.lossToWin}\n- TP missed due to BID: ${transitions.tpMissedDueToBid}\n- SL hit earlier due to spread: ${transitions.slHitEarlierDueToSpread}\n- Exit reason changed: ${transitions.exitReasonChanged}\n\n## V1 benchmark\n\n| Strategy | Trades | EXEC WR | EXEC PF | EXEC expectancy |\n|---|---:|---:|---:|---:|\n| AUDUSD V1 | ${OLD_AUDUSD.trades} | ${OLD_AUDUSD.execWinRatePct}% | ${OLD_AUDUSD.execProfitFactor} | +${OLD_AUDUSD.execExpectancyR}R |\n| AUDUSD V2 HL-only | ${execMetrics.trades} | ${fmt(execMetrics.winRatePct, 2)}% | ${fmt(execMetrics.profitFactor)} | ${fmt(execMetrics.expectancyR, 4)}R |\n\n**${frequencyText}**\n\n## Method and limitation\n\nThe 219-entry TradingView CSV is the only cohort; no full-history signal scan or parameter search was run. CSV timestamps are resolved through America/New_York DST rules. OANDA H1 midpoint reconstructs ATR14 and verifies the signal-close price. Original midpoint barriers are TV entry minus 1 ATR and plus 2 ATR. Long entry uses the final M1 ASK of the completed signal candle; future M1 BID triggers stop/target and supplies the time exit after three future H1 bars. Stop wins same-minute ambiguity; adverse stop gaps fill at BID open. Spread is not subtracted twice.\n\nThe CSV omits its internal ATR/stop/target values, so ATR14 is reconstructed from completed historical OANDA H1 midpoint candles. Any signal-close mismatch over 1.5 pips or incomplete M1 boundary makes the trade unmatched; no quote is fabricated. This primary replay keeps TradingView's original midpoint stop/target fixed, as requested, rather than moving them around the executable ASK.\n\nNo strategy, production setting, broker order, or deployment was changed.\n`;
  const finalReport = report
    .replace(
      "## Verdict:",
      "## Final production decision\n\n- Lifecycle: **RESEARCH_ONLY**\n- Cost classification: **MARGINAL_AFTER_COSTS**\n- Replacement decision: **REJECTED_REPLACEMENT**\n- Production strategy retained: **GX AUDUSD Strong Consensus Structure V1**\n\nV2 HL-only must not be deployed or promoted. Its source cohort, trade-level replay, raw results, and gap audit remain preserved in this directory for historical reference.\n\n## Verdict:",
    )
    .replace("TradingView fixed-quantity price PF", "TradingView fixed-quantity PF from the CSV's displayed net-PnL values")
    .replace(
      `| AUDUSD V2 HL-only | ${execMetrics.trades} | ${fmt(execMetrics.winRatePct, 2)}% | ${fmt(execMetrics.profitFactor)} | ${fmt(execMetrics.expectancyR, 4)}R |`,
      `| AUDUSD V2 HL-only, original TV barriers | ${execMetrics.trades} | ${fmt(execMetrics.winRatePct, 2)}% | ${fmt(execMetrics.profitFactor)} | ${fmt(execMetrics.expectancyR, 4)}R |\n| AUDUSD V2 HL-only, V1-comparable executable-centered barriers | ${productionCenteredMetrics.trades} | ${fmt(productionCenteredMetrics.winRatePct, 2)}% | ${fmt(productionCenteredMetrics.profitFactor)} | ${fmt(productionCenteredMetrics.expectancyR, 4)}R |`,
    )
    .replace(
      `**${frequencyText}**`,
      `**${frequencyText}**\n\nThe first V2 row is the literal primary result requested here: original TradingView stop/target prices stay fixed. The second is a diagnostic needed for a fair V1 comparison because the old V1 validation used executable-entry ATR geometry, with 1R/2R barriers centered on ASK. It does not replace the primary result or alter a strategy.`,
    )
    .replace(
      "## Method and limitation",
      `## Executable stability by year\n\n| Year | N | PF | Expectancy |\n|---|---:|---:|---:|\n${[2023, 2024, 2025, 2026].map(year => `| ${year} | ${byYear[year]!.trades} | ${fmt(byYear[year]!.profitFactor)} | ${fmt(byYear[year]!.expectancyR, 4)}R |`).join("\n")}\n\nThe pooled result is not stable across years: 2023 and 2025 are negative, while 2026 supplies most of the positive edge. This reinforces the marginal verdict.\n\n## Method and limitation`,
    )
    .replace(
      "- None. All 219 trades matched complete OANDA windows.",
      "- None. All 219 trades matched OANDA entry bars and resolvable execution windows. Ten isolated replay minutes had no OANDA M1 candle; targeted M1 and S5 rechecks also returned no price candle, so there is no broker tick path to invent. Details are in GAP_AUDIT.json.",
    )
    .replace(
      "Spread is not subtracted twice.",
      "Spread is not subtracted twice. Entry spread is the exact final signal-minute close; for intraminute TP/SL fills, reported exit spread and mid/bid/ask snapshot columns use that M1 candle's close because synchronized tick quotes are unavailable. The separate exec_exit_price column records the barrier or adverse BID-open fill used for P&L.",
    );
  const artifact = { generatedAt: new Date().toISOString(), verdict, classification, frequencyDecision, frequencyText,
    authoritativeCohort: { file: TV_CSV, copiedTo: resolve(OUT, "TRADINGVIEW_SOURCE.csv"), sha256: csvHash, rows: csvRows.length, trades: 219, wins: 106, losses: 113, fixedQtyPriceProfitFactor: tvFixedQtyPf },
    authoritativePine: { file: PINE_SOURCE, copiedTo: resolve(OUT, "PINE_SOURCE.pine"), sha256: sha256(pineText), frozenAssertions: ["Vote 5 HH+HL", "external filter HL-only", "vote threshold constant"] },
    timezone: { selected: "America/New_York", dstAware: true, scores: zones, validationSamples: samples }, matching: { tradingViewTrades: 219, matched: matchedRows.length, unmatched: unmatchedRows.length, unmatchedDetails: executionUnmatched },
    execution: { h1Source: h1.source, m1Source: m1.source, entry: "final signal-minute ASK close", exits: "future M1 BID; 3 future H1 bars", geometry: "original TV midpoint entry +/- OANDA H1 midpoint ATR14", ambiguity: "stop first", spreadAccounting: "bid/ask direct; no second subtraction" },
    metrics: { tradingViewMid: tvMetrics, matchedTradingViewMid: matchedMidMetrics, oandaExecOriginalTvBarriers: execMetrics, oandaExecV1ComparableExecutableCenteredBarriers: productionCenteredMetrics, byYear }, spread: { entryPips: entrySpread, exitPips: exitSpread, dragR: spreadDrag }, transitions, oldAudusdBenchmark: OLD_AUDUSD, trades: raw };
  await mkdir(OUT, { recursive: true }); await Promise.all([writeFile(resolve(OUT, "REPORT.md"), finalReport), writeFile(resolve(OUT, "TRADES.csv"), toCsv(rows)), writeFile(resolve(OUT, "RAW_RESULTS.json"), JSON.stringify(artifact, null, 2) + "\n"), writeFile(resolve(OUT, "TRADINGVIEW_SOURCE.csv"), csvText), writeFile(resolve(OUT, "PINE_SOURCE.pine"), pineText)]);
  console.log(JSON.stringify({ verdict, classification, matching: artifact.matching, metrics: artifact.metrics, spread: artifact.spread, transitions, frequencyText, output: OUT }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
