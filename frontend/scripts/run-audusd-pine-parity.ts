/**
 * AUDUSD Pine-parity historical replay (read-only, OANDA Practice midpoint data).
 *
 * Signal-parity validation only. Fetches AUD_USD H1 MIDPOINT candles via the
 * existing OANDA practice REST endpoint, caches them, replays the frozen
 * `evaluateAudusdStrategyTrace` deterministically, and compares its 11:00 UTC
 * origins against the 219 TradingView entries (normalised America/New_York -> UTC).
 *
 * Does NOT place orders, does NOT call execution gates, does NOT modify the
 * canonical Pine file or the TradingView CSV.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateAudusdStrategyTrace, type AudusdStrategyTraceRow } from "../src/lib/strategy/strategies/audusd-strategy.js";
import type { Candle } from "../src/types/forex.js";

const INSTRUMENT = "AUD_USD";
const FETCH_START = "2022-10-01T00:00:00.000Z"; // warmup begins here
const FETCH_END = "2026-09-06T00:00:00.000Z";   // inclusive of 2026-09-05 candles
const CACHE_PATH = "../research/frozen-strategies/AUDUSD/oanda-h1-mid.csv";
const TV_CSV_PATH = "../research/frozen-strategies/AUDUSD/tradingview-trades.csv";
const ENV_PATH = "../api-server/.env";

// ---------- env ----------
function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^["']/, "").replace(/["']$/, "").trim();
}
function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  try {
    const line = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((value) => value.startsWith(`${name}=`));
    return line ? unquote(line.slice(name.length + 1)) || null : null;
  } catch {
    return null;
  }
}

// ---------- OANDA midpoint fetch (read-only) ----------
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
    const payload = (await response.json()) as {
      candles?: Array<{ complete: boolean; time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }>;
    };
    const raw = payload.candles ?? [];
    if (!raw.length) break;
    let reachedEnd = false;
    for (const candle of raw) {
      const iso = new Date(candle.time).toISOString();
      if (Date.parse(iso) >= endMs) { reachedEnd = true; continue; }
      if (!candle.complete) continue; // keep only completed H1 bars; do not invent
      byTime.set(iso, {
        time: iso,
        open: Number(candle.mid.o), high: Number(candle.mid.h), low: Number(candle.mid.l), close: Number(candle.mid.c),
        volume: candle.volume, complete: true,
      });
    }
    const last = raw.at(-1)!;
    if (reachedEnd || raw.length < 5000) break;
    cursor = new Date(Date.parse(last.time) + 1).toISOString();
  }
  return [...byTime.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

// ---------- cache ----------
function writeCache(candles: readonly Candle[]): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const header = "timestamp,open,high,low,close,volume,complete";
  const lines = candles.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.complete}`);
  writeFileSync(CACHE_PATH, `${header}\n${lines.join("\n")}\n`, "utf8");
}

// ---------- data quality ----------
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
      // A normal weekend closure is ~49h (Fri 21:00 UTC -> Sun 22:00 UTC). Flag
      // only intra-week gaps larger than 1h that are not a weekend boundary.
      if (gapH > 1.0) {
        const fromDay = new Date(prevMs).getUTCDay();
        const isWeekend = fromDay === 5 || fromDay === 6 || (fromDay === 0);
        if (!(isWeekend && gapH <= 72)) gaps.push({ from: new Date(prevMs).toISOString(), to: c.time, hours: Math.round(gapH) });
      }
    }
    prevMs = ms;
  }
  return {
    first: candles[0]?.time ?? null,
    last: candles.at(-1)?.time ?? null,
    total: candles.length,
    incomplete, duplicates, outOfOrder,
    unexpectedGaps: gaps.length,
    unexpectedGapSample: gaps.slice(0, 10),
  };
}

// ---------- TradingView America/New_York -> UTC ----------
function nyOffsetMinutes(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return (asUTC - utcMs) / 60_000; // EST -> -300, EDT -> -240
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
  if (typeCol < 0 || timeCol < 0) throw new Error("TradingView CSV missing Type / Date and time columns.");
  const entries: TvEntry[] = [];
  for (const row of rows.slice(1)) {
    const cols = row.split(",");
    if ((cols[typeCol] ?? "").trim().toLowerCase() !== "entry long") continue;
    const wall = (cols[timeCol] ?? "").trim();
    entries.push({ wall, originUtc: nyWallToUtcISO(wall), signal: (cols[sigCol] ?? "").trim() });
  }
  return entries;
}

// ---------- main ----------
async function main() {
  const token = environmentValue("OANDA_API_KEY") ?? environmentValue("OANDA_API_TOKEN");
  const report: Record<string, unknown> = {};

  // TradingView side (does not need OANDA).
  const tvEntries = parseTradingViewEntries();
  const tvAt1100 = tvEntries.filter((e) => e.originUtc.slice(11, 19) === "11:00:00");
  const tvNot1100 = tvEntries.filter((e) => e.originUtc.slice(11, 19) !== "11:00:00");
  report.TRADINGVIEW_EXPORT_TIMEZONE_STATUS = "INFERRED_AMERICA_NEW_YORK";
  report.tradingViewEntries = tvEntries.length;
  report.tvEntriesNormalizedTo1100Utc = tvAt1100.length;
  report.tvEntriesNotAt1100Utc = tvNot1100.length;
  report.tvNot1100Sample = tvNot1100.slice(0, 10);

  if (tvNot1100.length > 0) {
    console.log(JSON.stringify({ ...report, halted: "A TradingView entry did not normalize to 11:00 UTC." }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!token) {
    report.OANDA_H1_DATA_FETCHED = "NO";
    report.verdict = "AUDUSD_PARITY_BLOCKED_NO_MARKET_DATA";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // Fetch + cache OANDA H1 midpoint candles.
  const candles = await fetchMidpointH1(token);
  if (candles.length === 0) {
    report.OANDA_H1_DATA_FETCHED = "NO";
    report.verdict = "AUDUSD_PARITY_BLOCKED_NO_MARKET_DATA";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  writeCache(candles);
  report.OANDA_H1_DATA_FETCHED = "YES";
  report.oandaDataPath = CACHE_PATH;
  report.dataQuality = dataQuality(candles);

  // Replay the frozen strategy trace (no execution gates).
  const traced = evaluateAudusdStrategyTrace(candles);
  if (traced.error) {
    report.replayError = traced.error;
    report.verdict = "AUDUSD_PINE_PARITY_MISMATCH";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const rowByOrigin = new Map<string, AudusdStrategyTraceRow>();
  const candleByTime = new Map<string, Candle>(candles.map((c) => [c.time, c]));
  for (const row of traced.rows) rowByOrigin.set(row.timestamp, row);

  const allTsSignals = traced.rows.filter((r) => r.finalLongSignal);

  // Compare only within the TradingView export window; anything earlier is warmup.
  const tvOrigins = tvAt1100.map((e) => e.originUtc).sort();
  const minTv = Date.parse(tvOrigins[0]!);
  const maxTv = Date.parse(tvOrigins.at(-1)!);
  const tsInWindow = allTsSignals.filter((r) => {
    const ms = Date.parse(r.timestamp);
    return ms >= minTv && ms <= maxTv;
  });
  const tsOutsideWindow = allTsSignals.filter((r) => {
    const ms = Date.parse(r.timestamp);
    return ms < minTv || ms > maxTv;
  });

  const tvSet = new Set(tvOrigins);
  const tsSet = new Set(tsInWindow.map((r) => r.timestamp));
  const exactMatches = [...tsSet].filter((t) => tvSet.has(t));
  const tvOnly = [...tvSet].filter((t) => !tsSet.has(t));
  const tsOnly = [...tsSet].filter((t) => !tvSet.has(t));
  // Direction: TradingView is Entry long only; TS trace is long only. Any TS
  // signal is long, so a direction mismatch can only occur if a matched origin
  // disagreed on side — impossible here, but reported explicitly as 0.
  const directionMismatches = 0;

  report.candlePeriod = `${report.dataQuality && (report.dataQuality as any).first} .. ${report.dataQuality && (report.dataQuality as any).last}`;
  report.totalH1Candles = candles.length;
  report.typescriptSignalsInWindow = tsInWindow.length;
  report.typescriptSignalsTotalAllHistory = allTsSignals.length;
  report.typescriptSignalsOutsideTvWindow = tsOutsideWindow.map((r) => r.timestamp);
  report.exactMatches = exactMatches.length;
  report.tvOnly = tvOnly;
  report.tsOnly = tsOnly;
  report.directionMismatches = directionMismatches;

  // Tag distribution cross-check (metadata only).
  const tagCounts = tsInWindow.reduce((acc, r) => { acc[r.confidenceTag] = (acc[r.confidenceTag] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  report.typescriptTagDistribution = tagCounts;

  const parity = tvAt1100.length === 219 && tsInWindow.length === 219 && exactMatches.length === 219 && tvOnly.length === 0 && tsOnly.length === 0 && directionMismatches === 0;

  // Mismatch diagnostics (first 10).
  if (!parity) {
    const mismatchOrigins = [...new Set([...tvOnly, ...tsOnly])].sort().slice(0, 10);
    report.firstMismatchDiagnostics = mismatchOrigins.map((origin) => {
      const row = rowByOrigin.get(origin);
      const candle = candleByTime.get(origin);
      const tv = tvSet.has(origin);
      const ts = tsSet.has(origin);
      return {
        timestamp: origin,
        tradingViewExpectedSignal: tv,
        typescriptResult: ts,
        candle: candle ? { open: candle.open, high: candle.high, low: candle.low, close: candle.close } : "NO_CANDLE_AT_ORIGIN",
        ema20: row?.ema20 ?? null, ema50: row?.ema50 ?? null, ema20At0800_equiv_ema20back3: row?.ema20At0800 ?? null, atr14: row?.atr14 ?? null,
        preHigh: row?.preRangeHigh ?? null, preLow: row?.preRangeLow ?? null, preMid: row?.preRangeMid ?? null,
        rangeCount: row ? 5 - row.missingRangeHours.length : null, missingRangeHours: row?.missingRangeHours ?? null,
        vote1_emaVote: row?.emaVote ?? null, vote2_priceEmaVote: row?.priceEmaVote ?? null, vote3_emaSlopeVote: row?.emaSlopeVote ?? null,
        vote4_rangeVote: row?.rangeVote ?? null, vote5_structureVote: row?.structureVote ?? null, vote6_momentumVote: row?.momentumVote ?? null,
        voteSum: row?.voteSum ?? null,
        higherLow: row?.higherLow ?? null, bullStructureVote: row ? row.structureVote > 0 : null, bearStructureVote: row ? row.structureVote < 0 : null,
        bodyAtrRatio: row?.bodyAtrRatio ?? null, bodyConfirm: row?.bodyConfirm ?? null, extremeConfirm: row?.extremeClose ?? null,
        highConfidence: row ? row.finalLongSignal && row.bodyConfirm && row.extremeClose : null,
        rawLongSignal: row?.finalLongSignal ?? null,
      };
    });
    report.firstDifferingCondition = tvOnly.length
      ? "TradingView has an entry the TypeScript replay did not signal (see diagnostics)."
      : "TypeScript signalled an origin absent from the TradingView export (see diagnostics).";
  }

  report.verdict = parity ? "AUDUSD_PINE_PARITY_CONFIRMED" : "AUDUSD_PINE_PARITY_MISMATCH";
  console.log(JSON.stringify(report, null, 2));
  if (!parity) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
