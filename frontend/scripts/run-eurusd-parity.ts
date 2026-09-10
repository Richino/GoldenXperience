/**
 * EURUSD "GX 1H A London Breakout Only V1 - 1 to 2 RR" Pine-parity replay.
 * Read-only OANDA PRACTICE M MID H1. Signal-parity only: no orders, no execution
 * gates, no modification of Pine/CSV. Models Pine's own Asia-range/sigA/evtA state
 * AND the flat (position_size==0) requirement with SL/TP exits and NO time exit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  evaluateEurusdStrategyTrace,
  EURUSD_STRATEGY_CONFIG,
} from "../src/lib/strategy/strategies/eurusd-strategy.js";
import type { Candle } from "../src/types/forex.js";

const INSTRUMENT = "EUR_USD";
const FETCH_START = "2022-10-01T00:00:00.000Z";
const FETCH_END = "2026-09-11T00:00:00.000Z";
const CACHE_PATH = "../research/frozen-strategies/EURUSD/oanda-h1-mid.csv";
const TV_CSV_PATH = "../research/frozen-strategies/EURUSD/tradingview-trades.csv";
const ENV_PATH = "../api-server/.env";

function unquote(v: string) { return v.trim().replace(/^["']/, "").replace(/["']$/, "").trim(); }
function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  try { const l = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((x) => x.startsWith(`${name}=`)); return l ? unquote(l.slice(name.length + 1)) || null : null; } catch { return null; }
}

async function fetchMidpointH1(token: string): Promise<Candle[]> {
  const byTime = new Map<string, Candle>(); let cursor = FETCH_START; const endMs = Date.parse(FETCH_END);
  for (let page = 0; page < 32; page += 1) {
    const params = new URLSearchParams({ price: "M", granularity: "H1", count: "5000", from: cursor });
    const res = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${INSTRUMENT}/candles?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`OANDA candle request failed: HTTP ${res.status} ${await res.text()}`);
    const payload = (await res.json()) as { candles?: Array<{ complete: boolean; time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }> };
    const raw = payload.candles ?? []; if (!raw.length) break; let reachedEnd = false;
    for (const c of raw) { const iso = new Date(c.time).toISOString(); if (Date.parse(iso) >= endMs) { reachedEnd = true; continue; } if (!c.complete) continue; byTime.set(iso, { time: iso, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, volume: c.volume, complete: true }); }
    const last = raw.at(-1)!; if (reachedEnd || raw.length < 5000) break; cursor = new Date(Date.parse(last.time) + 1).toISOString();
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
function writeCache(candles: readonly Candle[]) { mkdirSync(dirname(CACHE_PATH), { recursive: true }); writeFileSync(CACHE_PATH, `timestamp,open,high,low,close,volume,complete\n${candles.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.complete}`).join("\n")}\n`, "utf8"); }
function readCache(): Candle[] | null {
  try {
    const rows = readFileSync(CACHE_PATH, "utf8").trim().split(/\r?\n/).slice(1);
    return rows.map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" } as Candle; });
  } catch { return null; }
}
function dataQuality(candles: readonly Candle[]) {
  let incomplete = 0, duplicates = 0, outOfOrder = 0; const seen = new Set<string>(); const gaps: Array<{ from: string; hours: number }> = []; let prevMs: number | null = null;
  for (const c of candles) { if (!c.complete) incomplete += 1; if (seen.has(c.time)) duplicates += 1; else seen.add(c.time); const ms = Date.parse(c.time); if (prevMs !== null) { if (ms < prevMs) outOfOrder += 1; const g = (ms - prevMs) / 3_600_000; if (g > 1.0) { const d = new Date(prevMs).getUTCDay(); const w = d === 5 || d === 6 || d === 0; if (!(w && g <= 72)) gaps.push({ from: new Date(prevMs).toISOString(), hours: Math.round(g) }); } } prevMs = ms; }
  // Coverage of the 00:00-10:00 UTC build/eval hours
  let buildHourBars = 0; for (const c of candles) { const h = new Date(c.time).getUTCHours(); if (h >= 0 && h < 11) buildHourBars += 1; }
  return { first: candles[0]?.time ?? null, last: candles.at(-1)?.time ?? null, total: candles.length, incomplete, duplicates, outOfOrder, unexpectedGaps: gaps.length, gapSample: gaps.slice(0, 8), buildHourBars };
}

// TradingView export timezone -> UTC (America/New_York, DST-aware).
function nyOffsetMinutes(utcMs: number): number { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value])); return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcMs) / 60_000; }
function nyWallToUtcISO(wall: string): string { const [d, t] = wall.trim().split(/\s+/); const [y, mo, da] = d!.split("-").map(Number); const [h, mi] = t!.split(":").map(Number); let ms = Date.UTC(y!, mo! - 1, da!, h!, mi!); for (let i = 0; i < 2; i += 1) ms = Date.UTC(y!, mo! - 1, da!, h!, mi!) - nyOffsetMinutes(ms) * 60_000; return new Date(ms).toISOString(); }

interface TvEntry { originUtc: string; direction: "long" | "short"; wall: string }
function parseTradingViewEntries(): TvEntry[] {
  const rows = readFileSync(TV_CSV_PATH, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const h = rows[0]!.split(","); const tC = h.indexOf("Type"), dC = h.indexOf("Date and time");
  const out: TvEntry[] = [];
  for (const row of rows.slice(1)) {
    const cols = row.split(","); const type = (cols[tC] ?? "").trim().toLowerCase();
    if (type !== "entry long" && type !== "entry short") continue;
    const wall = (cols[dC] ?? "").trim();
    out.push({ originUtc: nyWallToUtcISO(wall), direction: type === "entry long" ? "long" : "short", wall });
  }
  return out.sort((a, b) => Date.parse(a.originUtc) - Date.parse(b.originUtc));
}

// Replay Pine state: enter only when flat on a trace evtA; exit on SL/TP (no time exit).
interface TsEntry { ts: string; direction: "long" | "short"; entry: number; stop: number; target: number; exitTs: string | null; exitReason: string | null }
function replay(candles: Candle[]) {
  const { rows, error } = evaluateEurusdStrategyTrace(candles);
  if (error) throw new Error(`Trace error: ${error}`);
  const entries: TsEntry[] = [];
  let open: { direction: "long" | "short"; entryIndex: number; stop: number; target: number } | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!; const c = candles[i]!;
    // (1) Exit check for an open position, starting the bar AFTER entry.
    if (open && i > open.entryIndex) {
      if (open.direction === "long") {
        const hitStop = c.low <= open.stop, hitTarget = c.high >= open.target;
        if (hitStop || hitTarget) { const e = entries[entries.length - 1]!; e.exitTs = c.time; e.exitReason = hitStop ? (hitTarget ? "BOTH" : "STOP") : "TARGET"; open = null; }
      } else {
        const hitStop = c.high >= open.stop, hitTarget = c.low <= open.target;
        if (hitStop || hitTarget) { const e = entries[entries.length - 1]!; e.exitTs = c.time; e.exitReason = hitStop ? (hitTarget ? "BOTH" : "STOP") : "TARGET"; open = null; }
      }
    }
    // (2) Entry only when flat and the Pine event fires this bar.
    if (!open && r.evtA && r.sigA !== 0 && r.entry !== null && r.stop !== null && r.target !== null) {
      const direction = r.sigA === 1 ? "long" : "short";
      entries.push({ ts: r.timestamp, direction, entry: r.entry, stop: r.stop, target: r.target, exitTs: null, exitReason: null });
      open = { direction, entryIndex: i, stop: r.stop, target: r.target };
    }
  }
  return { entries, rows };
}

async function main() {
  const report: Record<string, unknown> = {};
  report.pineStrategy = "GX 1H A London Breakout Only V1 - 1 to 2 RR";
  report.pair = "EURUSD"; report.timeframe = "H1"; report.direction = "LONG + SHORT";

  const tv = parseTradingViewEntries();
  const validWindow = tv.filter((e) => { const h = +e.originUtc.slice(11, 13); return h >= 6 && h < 11; });
  const invalid = tv.filter((e) => { const h = +e.originUtc.slice(11, 13); return !(h >= 6 && h < 11); });
  report.TRADINGVIEW_EXPORT_TIMEZONE_STATUS = "INFERRED_AMERICA_NEW_YORK (DST-aware; all entries normalize into 06-10 UTC)";
  report.tradingViewEntries = tv.length;
  report.valid0610UtcEntries = validWindow.length;
  report.invalidOriginTimes = invalid.length;
  report.invalidSample = invalid.slice(0, 8).map((e) => ({ wall: e.wall, utc: e.originUtc }));
  report.entryUtcHourDistribution = tv.reduce((a, e) => { const k = e.originUtc.slice(11, 16); a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);

  const token = environmentValue("OANDA_API_KEY") ?? environmentValue("OANDA_API_TOKEN");
  const useCache = process.argv.includes("--cache");
  let candles = useCache ? readCache() : null;
  if (candles?.length) { report.dataSource = "CACHE"; }
  else {
    if (!token) { report.OANDA_H1_DATA_FETCHED = "NO"; report.verdict = "EURUSD_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    candles = await fetchMidpointH1(token);
    if (!candles.length) { report.OANDA_H1_DATA_FETCHED = "NO"; report.verdict = "EURUSD_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    writeCache(candles); report.dataSource = "OANDA_FETCH";
  }
  report.OANDA_H1_DATA_FETCHED = "YES"; report.oandaDataPath = CACHE_PATH;
  const dq = dataQuality(candles); report.dataQuality = dq; report.candlePeriod = `${dq.first} .. ${dq.last}`; report.totalH1Candles = candles.length;

  const { entries } = replay(candles);

  // Compare within the TradingView window (by exact timestamp + direction).
  const minTv = Date.parse(validWindow[0]!.originUtc), maxTv = Date.parse(validWindow.at(-1)!.originUtc);
  const tsInWindow = entries.filter((e) => { const ms = Date.parse(e.ts); return ms >= minTv && ms <= maxTv; });
  const tsOutside = entries.filter((e) => { const ms = Date.parse(e.ts); return ms < minTv || ms > maxTv; });

  const key = (ts: string, dir: string) => `${ts}|${dir}`;
  const tvMap = new Map(validWindow.map((e) => [key(e.originUtc, e.direction), e]));
  const tsMap = new Map(tsInWindow.map((e) => [key(e.ts, e.direction), e]));
  const tvTsSet = new Set(validWindow.map((e) => e.originUtc));
  const tsTsSet = new Set(tsInWindow.map((e) => e.ts));

  const exactMatches = [...tsMap.keys()].filter((k) => tvMap.has(k));
  const tvOnly = [...tvMap.keys()].filter((k) => !tsMap.has(k));
  const tsOnly = [...tsMap.keys()].filter((k) => !tsMap.has(k) ? false : !tvMap.has(k));
  // Direction mismatches: same timestamp present on both sides but opposite direction.
  const directionMismatches = [...tvTsSet].filter((ts) => tsTsSet.has(ts) && !exactMatches.includes(key(ts, tvMap.has(key(ts, "long")) ? "long" : "short")));
  const dirMism = [...tvTsSet].filter((ts) => tsTsSet.has(ts)).filter((ts) => {
    const tvDir = validWindow.find((e) => e.originUtc === ts)!.direction;
    const tsDir = tsInWindow.find((e) => e.ts === ts)!.direction;
    return tvDir !== tsDir;
  });

  report.tradingViewEntriesInWindow = validWindow.length;
  report.typescriptEntries = entries.length;
  report.typescriptEntriesInWindow = tsInWindow.length;
  report.typescriptEntriesOutsideWindow = tsOutside.map((e) => ({ ts: e.ts, dir: e.direction }));
  report.exactMatches = exactMatches.length;
  report.tvOnly = tvOnly.sort();
  report.tsOnly = tsOnly.sort();
  report.directionMismatches = dirMism.length;
  report.directionMismatchSample = dirMism.slice(0, 10);

  const parity = validWindow.length === tsInWindow.length && tvOnly.length === 0 && tsOnly.length === 0 && dirMism.length === 0 && exactMatches.length === validWindow.length;

  if (!parity) {
    const idxByTime = new Map(candles.map((c, i) => [c.time, i]));
    const { rows } = replay(candles);
    const mismatchTs = [...new Set([...tvOnly, ...tsOnly].map((k) => k.split("|")[0]!))].sort().slice(0, 10);
    report.firstMismatchDiagnostics = mismatchTs.map((ts) => {
      const i = idxByTime.get(ts); const c = i !== undefined ? candles[i] : undefined; const p = i !== undefined && i > 0 ? candles[i - 1] : undefined; const r = i !== undefined ? rows[i] : undefined;
      return {
        timestamp: ts,
        tvExpected: tvTsSet.has(ts) ? validWindow.find((e) => e.originUtc === ts)!.direction : "none",
        tsResult: tsTsSet.has(ts) ? tsInWindow.find((e) => e.ts === ts)!.direction : "none",
        open: c?.open ?? null, high: c?.high ?? null, low: c?.low ?? null, close: c?.close ?? null, prevClose: p?.close ?? null,
        asiaHigh: r?.asiaHigh ?? null, asiaLow: r?.asiaLow ?? null, ema20: r?.ema20 ?? null, ema50: r?.ema50 ?? null, atr14: r?.atr14 ?? null,
        body: r?.body ?? null, bodyATR: r && r.atr14 ? r.body / r.atr14 : null,
        bullStructure: r?.bullStructure ?? null, bearStructure: r?.bearStructure ?? null,
        longSetup: r?.longSetup ?? null, shortSetup: r?.shortSetup ?? null, sigA: r?.sigA ?? null, evtA: r?.evtA ?? null,
      };
    });
    report.firstDifferingCondition = tvOnly.length ? "TradingView entry absent from TypeScript accepted entries." : "TypeScript accepted entry absent from TradingView export.";
  }

  report.verdict = parity ? "EURUSD_PINE_PARITY_CONFIRMED" : "EURUSD_PINE_PARITY_MISMATCH";
  console.log(JSON.stringify(report, null, 2));
  if (!parity) process.exitCode = 1;
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
