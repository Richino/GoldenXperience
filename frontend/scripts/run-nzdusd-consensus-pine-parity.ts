/**
 * NZDUSD Bull Consensus Structure V1 Pine-parity historical replay.
 * Read-only OANDA Practice MIDPOINT data. Signal-parity validation only:
 * no orders, no execution gates, no modification of the canonical Pine/CSV.
 *
 * Fetches NZD_USD H1 midpoint candles, caches them, replays the CURRENT
 * `evaluateNzdusdBullConsensusStructureV1` evaluator per 11:00 UTC origin,
 * and compares against the canonical TradingView entries (America/New_York -> UTC).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateNzdusdBullConsensusStructureV1 } from "../src/lib/strategy/strategies/nzdusd-consensus-strategy.js";
import type { Candle } from "../src/types/forex.js";

const INSTRUMENT = "NZD_USD";
const FETCH_START = "2022-10-01T00:00:00.000Z";
const FETCH_END = "2026-09-06T00:00:00.000Z";
const PINE_START = "2023-01-01T00:00:00.000Z"; // Pine startTime boundary
const CACHE_PATH = "../research/frozen-strategies/NZDUSD/oanda-h1-mid.csv";
const TV_CSV_PATH = "../research/frozen-strategies/NZDUSD/tradingview-trades.csv";
const ENV_PATH = "../api-server/.env";

function unquote(value: string): string {
  return value.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
}
function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  try {
    const line = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((v) => v.startsWith(`${name}=`));
    return line ? unquote(line.slice(name.length + 1)) || null : null;
  } catch { return null; }
}

async function fetchMidpointH1(token: string): Promise<Candle[]> {
  const byTime = new Map<string, Candle>();
  let cursor = FETCH_START;
  const endMs = Date.parse(FETCH_END);
  for (let page = 0; page < 16; page += 1) {
    const params = new URLSearchParams({ price: "M", granularity: "H1", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${INSTRUMENT}/candles?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`OANDA midpoint candle request failed: HTTP ${response.status} ${await response.text()}`);
    const payload = (await response.json()) as { candles?: Array<{ complete: boolean; time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }> };
    const raw = payload.candles ?? [];
    if (!raw.length) break;
    let reachedEnd = false;
    for (const c of raw) {
      const iso = new Date(c.time).toISOString();
      if (Date.parse(iso) >= endMs) { reachedEnd = true; continue; }
      if (!c.complete) continue;
      byTime.set(iso, { time: iso, open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c), volume: c.volume, complete: true });
    }
    const last = raw.at(-1)!;
    if (reachedEnd || raw.length < 5000) break;
    cursor = new Date(Date.parse(last.time) + 1).toISOString();
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function writeCache(candles: readonly Candle[]): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const header = "timestamp,open,high,low,close,volume,complete";
  const lines = candles.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.complete}`);
  writeFileSync(CACHE_PATH, `${header}\n${lines.join("\n")}\n`, "utf8");
}

function dataQuality(candles: readonly Candle[]) {
  let incomplete = 0, duplicates = 0, outOfOrder = 0;
  const seen = new Set<string>();
  const gaps: Array<{ from: string; to: string; hours: number }> = [];
  let prevMs: number | null = null;
  for (const c of candles) {
    if (!c.complete) incomplete += 1;
    if (seen.has(c.time)) duplicates += 1; else seen.add(c.time);
    const ms = Date.parse(c.time);
    if (prevMs !== null) {
      if (ms < prevMs) outOfOrder += 1;
      const gapH = (ms - prevMs) / 3_600_000;
      if (gapH > 1.0) {
        const fromDay = new Date(prevMs).getUTCDay();
        const isWeekend = fromDay === 5 || fromDay === 6 || fromDay === 0;
        if (!(isWeekend && gapH <= 72)) gaps.push({ from: new Date(prevMs).toISOString(), to: c.time, hours: Math.round(gapH) });
      }
    }
    prevMs = ms;
  }
  return { first: candles[0]?.time ?? null, last: candles.at(-1)?.time ?? null, total: candles.length, incomplete, duplicates, outOfOrder, unexpectedGaps: gaps.length, unexpectedGapSample: gaps.slice(0, 10) };
}

function nyOffsetMinutes(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return (asUTC - utcMs) / 60_000;
}
function nyWallToUtcISO(wall: string): string {
  const [datePart, timePart] = wall.trim().split(/\s+/);
  const [y, mo, d] = datePart!.split("-").map(Number);
  const [h, mi] = timePart!.split(":").map(Number);
  let utcMs = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 2; i += 1) utcMs = Date.UTC(y!, mo! - 1, d!, h!, mi!) - nyOffsetMinutes(utcMs) * 60_000;
  return new Date(utcMs).toISOString();
}

interface TvEntry { originUtc: string; wall: string; signal: string }
function parseTradingViewEntries(): TvEntry[] {
  const text = readFileSync(TV_CSV_PATH, "utf8").replace(/^﻿/, "");
  const rows = text.trim().split(/\r?\n/);
  const header = rows[0]!.split(",");
  const typeCol = header.indexOf("Type");
  const timeCol = header.indexOf("Date and time");
  const sigCol = header.indexOf("Signal");
  const entries: TvEntry[] = [];
  for (const row of rows.slice(1)) {
    const cols = row.split(",");
    if ((cols[typeCol] ?? "").trim().toLowerCase() !== "entry long") continue;
    const wall = (cols[timeCol] ?? "").trim();
    entries.push({ wall, originUtc: nyWallToUtcISO(wall), signal: (cols[sigCol] ?? "").trim() });
  }
  return entries;
}

async function main() {
  const report: Record<string, unknown> = {};
  const token = environmentValue("OANDA_API_KEY") ?? environmentValue("OANDA_API_TOKEN");

  const tvEntries = parseTradingViewEntries();
  const tvAt1100 = tvEntries.filter((e) => e.originUtc.slice(11, 19) === "11:00:00");
  const tvNot1100 = tvEntries.filter((e) => e.originUtc.slice(11, 19) !== "11:00:00");
  report.TRADINGVIEW_EXPORT_TIMEZONE_STATUS = "INFERRED_AMERICA_NEW_YORK";
  report.tradingViewEntries = tvEntries.length;
  report.entriesNormalizedTo1100Utc = tvAt1100.length;
  report.entriesNotAt1100Utc = tvNot1100.length;
  report.tvNot1100Sample = tvNot1100.slice(0, 10);
  if (tvNot1100.length > 0) {
    console.log(JSON.stringify({ ...report, halted: "A TradingView entry did not normalize to 11:00 UTC." }, null, 2));
    process.exitCode = 1; return;
  }

  if (!token) {
    report.OANDA_H1_DATA_FETCHED = "NO";
    report.verdict = "NZDUSD_PARITY_BLOCKED_NO_MARKET_DATA";
    console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return;
  }

  const candles = await fetchMidpointH1(token);
  if (candles.length === 0) {
    report.OANDA_H1_DATA_FETCHED = "NO";
    report.verdict = "NZDUSD_PARITY_BLOCKED_NO_MARKET_DATA";
    console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return;
  }
  writeCache(candles);
  report.OANDA_H1_DATA_FETCHED = "YES";
  report.oandaDataPath = CACHE_PATH;
  const dq = dataQuality(candles);
  report.dataQuality = dq;
  report.candlePeriod = `${dq.first} .. ${dq.last}`;
  report.totalH1Candles = candles.length;

  // Replay: evaluate the current evaluator at each completed 11:00 UTC origin.
  const startMs = Date.parse(PINE_START);
  const signals: Array<{ ts: string; consensus: number | null; ema20: number | null; ema50: number | null; ema20Back: number | null; closeThreeBarsAgo: number | null; atr14: number | null; voteTrend: number | null; votePrice: number | null; voteSlope: number | null; voteMomentum: number | null; higherHigh: boolean; higherLow: boolean; signalMidClose: number | null }> = [];
  for (let i = 0; i < candles.length; i += 1) {
    const t = new Date(candles[i]!.time);
    if (t.getUTCMinutes() !== 0 || t.getUTCHours() !== 11) continue;
    if (Date.parse(candles[i]!.time) < startMs) continue;
    const ev = evaluateNzdusdBullConsensusStructureV1(candles.slice(0, i + 1));
    if (ev.strategySignalQualified) {
      signals.push({ ts: candles[i]!.time, consensus: ev.consensus, ema20: ev.ema20, ema50: ev.ema50, ema20Back: ev.ema20Back, closeThreeBarsAgo: ev.closeThreeBarsAgo, atr14: ev.atr14, voteTrend: ev.voteTrend, votePrice: ev.votePrice, voteSlope: ev.voteSlope, voteMomentum: ev.voteMomentum, higherHigh: ev.higherHigh, higherLow: ev.higherLow, signalMidClose: ev.signalMidClose });
    }
  }

  const tvOrigins = tvAt1100.map((e) => e.originUtc).sort();
  const maxTv = Date.parse(tvOrigins.at(-1)!);
  const tsInWindow = signals.filter((s) => Date.parse(s.ts) >= startMs && Date.parse(s.ts) <= maxTv);
  const tsOutsideWindow = signals.filter((s) => Date.parse(s.ts) > maxTv).map((s) => s.ts);

  const tvSet = new Set(tvOrigins);
  const tsSet = new Set(tsInWindow.map((s) => s.ts));
  const exactMatches = [...tsSet].filter((t) => tvSet.has(t));
  const tvOnly = [...tvSet].filter((t) => !tsSet.has(t));
  const tsOnly = [...tsSet].filter((t) => !tvSet.has(t));

  report.typescriptSignalsInWindow = tsInWindow.length;
  report.typescriptSignalsAllHistoryFrom2023 = signals.length;
  report.typescriptSignalsAfterLastTvEntry = tsOutsideWindow;
  report.exactMatches = exactMatches.length;
  report.tvOnly = tvOnly;
  report.tsOnly = tsOnly;
  report.directionMismatches = 0; // both sides are long-only
  report.consensusDistributionInWindow = tsInWindow.reduce((a, s) => { const k = String(s.consensus); a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);

  const parity = tvAt1100.length === tsInWindow.length && tvOnly.length === 0 && tsOnly.length === 0 && exactMatches.length === tvAt1100.length;

  if (!parity) {
    const byTs = new Map(signals.map((s) => [s.ts, s]));
    const candleByTime = new Map(candles.map((c) => [c.time, c]));
    const prevByTime = new Map<string, Candle>();
    for (let i = 1; i < candles.length; i += 1) prevByTime.set(candles[i]!.time, candles[i - 1]!);
    const mismatches = [...new Set([...tvOnly, ...tsOnly])].sort().slice(0, 10);
    report.firstMismatchDiagnostics = mismatches.map((origin) => {
      const s = byTs.get(origin);
      const c = candleByTime.get(origin);
      const p = prevByTime.get(origin);
      return {
        timestamp: origin,
        tvExpected: tvSet.has(origin), tsResult: tsSet.has(origin),
        open: c?.open ?? null, high: c?.high ?? null, low: c?.low ?? null, close: c?.close ?? null,
        previousHigh: p?.high ?? null, previousLow: p?.low ?? null,
        ema20: s?.ema20 ?? null, ema50: s?.ema50 ?? null, ema20Back: s?.ema20Back ?? null, closeThreeBarsAgo: s?.closeThreeBarsAgo ?? null, atr14: s?.atr14 ?? null,
        voteTrend: s?.voteTrend ?? null, votePrice: s?.votePrice ?? null, voteSlope: s?.voteSlope ?? null, voteMomentum: s?.voteMomentum ?? null, consensus: s?.consensus ?? null,
        higherHigh: s?.higherHigh ?? null, higherLow: s?.higherLow ?? null,
      };
    });
    report.firstDifferingCondition = tvOnly.length ? "TradingView entry absent from TypeScript signals (see diagnostics)." : "TypeScript signal absent from TradingView export (see diagnostics).";
  }

  report.verdict = parity ? "NZDUSD_PINE_PARITY_CONFIRMED" : "NZDUSD_PINE_PARITY_MISMATCH";
  console.log(JSON.stringify(report, null, 2));
  if (!parity) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
