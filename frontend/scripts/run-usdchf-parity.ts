/**
 * USDCHF Bear Consensus Structure V1 Pine-parity replay (read-only OANDA M MID H1).
 * Signal-parity only: no orders, no execution gates, no modification of Pine/CSV.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateUsdchfBearConsensusStructureV1 } from "../src/lib/strategy/strategies/usdchf-strategy.js";
import type { Candle } from "../src/types/forex.js";

const INSTRUMENT = "USD_CHF";
const FETCH_START = "2022-10-01T00:00:00.000Z";
const FETCH_END = "2026-09-11T00:00:00.000Z";
const PINE_START = "2023-01-01T00:00:00.000Z";
const ORIGIN_HOUR = 11;
const CACHE_PATH = "../research/frozen-strategies/USDCHF/oanda-h1-mid.csv";
const TV_CSV_PATH = "../research/frozen-strategies/USDCHF/tradingview-trades.csv";
const ENV_PATH = "../api-server/.env";

function unquote(v: string) { return v.trim().replace(/^["']/, "").replace(/["']$/, "").trim(); }
function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  try { const l = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((x) => x.startsWith(`${name}=`)); return l ? unquote(l.slice(name.length + 1)) || null : null; } catch { return null; }
}
async function fetchMidpointH1(token: string): Promise<Candle[]> {
  const byTime = new Map<string, Candle>(); let cursor = FETCH_START; const endMs = Date.parse(FETCH_END);
  for (let page = 0; page < 16; page += 1) {
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
function dataQuality(candles: readonly Candle[]) {
  let incomplete = 0, duplicates = 0, outOfOrder = 0; const seen = new Set<string>(); const gaps: Array<{ from: string; hours: number }> = []; let prevMs: number | null = null;
  for (const c of candles) { if (!c.complete) incomplete += 1; if (seen.has(c.time)) duplicates += 1; else seen.add(c.time); const ms = Date.parse(c.time); if (prevMs !== null) { if (ms < prevMs) outOfOrder += 1; const g = (ms - prevMs) / 3_600_000; if (g > 1.0) { const d = new Date(prevMs).getUTCDay(); const w = d === 5 || d === 6 || d === 0; if (!(w && g <= 72)) gaps.push({ from: new Date(prevMs).toISOString(), hours: Math.round(g) }); } } prevMs = ms; }
  return { first: candles[0]?.time ?? null, last: candles.at(-1)?.time ?? null, total: candles.length, incomplete, duplicates, outOfOrder, unexpectedGaps: gaps.length, gapSample: gaps.slice(0, 8) };
}
function nyOffsetMinutes(utcMs: number): number { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value])); return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcMs) / 60_000; }
function nyWallToUtcISO(wall: string): string { const [d, t] = wall.trim().split(/\s+/); const [y, mo, da] = d!.split("-").map(Number); const [h, mi] = t!.split(":").map(Number); let ms = Date.UTC(y!, mo! - 1, da!, h!, mi!); for (let i = 0; i < 2; i += 1) ms = Date.UTC(y!, mo! - 1, da!, h!, mi!) - nyOffsetMinutes(ms) * 60_000; return new Date(ms).toISOString(); }
interface TvEntry { originUtc: string; direction: "short" }
function parseTradingViewEntries(): TvEntry[] { const rows = readFileSync(TV_CSV_PATH, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/); const h = rows[0]!.split(","); const tC = h.indexOf("Type"), dC = h.indexOf("Date and time"); const out: TvEntry[] = []; for (const row of rows.slice(1)) { const cols = row.split(","); if ((cols[tC] ?? "").trim().toLowerCase() !== "entry short") continue; out.push({ originUtc: nyWallToUtcISO((cols[dC] ?? "").trim()), direction: "short" }); } return out; }

async function main() {
  const report: Record<string, unknown> = {};
  const token = environmentValue("OANDA_API_KEY") ?? environmentValue("OANDA_API_TOKEN");
  const stamp = `${String(ORIGIN_HOUR).padStart(2, "0")}:00:00`;
  const tv = parseTradingViewEntries();
  const tvAt = tv.filter((e) => e.originUtc.slice(11, 19) === stamp);
  const tvNot = tv.filter((e) => e.originUtc.slice(11, 19) !== stamp);
  report.TRADINGVIEW_EXPORT_TIMEZONE_STATUS = "INFERRED_AMERICA_NEW_YORK";
  report.tradingViewEntries = tv.length; report.entriesNormalizedTo1100Utc = tvAt.length; report.entriesNotAt1100Utc = tvNot.length; report.tvNotSample = tvNot.slice(0, 8);
  if (tvNot.length > 0) { console.log(JSON.stringify({ ...report, halted: "A TradingView entry did not normalize to 11:00 UTC." }, null, 2)); process.exitCode = 1; return; }
  if (!token) { report.OANDA_H1_DATA_FETCHED = "NO"; report.verdict = "USDCHF_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }

  const candles = await fetchMidpointH1(token);
  if (!candles.length) { report.OANDA_H1_DATA_FETCHED = "NO"; report.verdict = "USDCHF_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
  writeCache(candles);
  report.OANDA_H1_DATA_FETCHED = "YES"; report.oandaDataPath = CACHE_PATH;
  const dq = dataQuality(candles); report.dataQuality = dq; report.candlePeriod = `${dq.first} .. ${dq.last}`; report.totalH1Candles = candles.length;

  const startMs = Date.parse(PINE_START);
  const signals: Array<Record<string, unknown> & { ts: string }> = [];
  for (let i = 0; i < candles.length; i += 1) {
    const t = new Date(candles[i]!.time);
    if (t.getUTCMinutes() !== 0 || t.getUTCHours() !== ORIGIN_HOUR) continue;
    if (Date.parse(candles[i]!.time) < startMs) continue;
    const ev = evaluateUsdchfBearConsensusStructureV1(candles.slice(0, i + 1));
    if (ev.strategySignalQualified) signals.push({ ts: candles[i]!.time, consensus: ev.consensus, bearStructure: ev.bearStructure, previousHigh: ev.previousHigh, previousLow: ev.previousLow, atr14: ev.atr14, voteTrend: ev.voteTrend, votePrice: ev.votePrice, voteSlope: ev.voteSlope, voteMomentum: ev.voteMomentum, signalMidClose: ev.signalMidClose });
  }

  const tvOrigins = tvAt.map((e) => e.originUtc).sort();
  const minTv = Date.parse(tvOrigins[0]!), maxTv = Date.parse(tvOrigins.at(-1)!);
  const tsInWindow = signals.filter((s) => Date.parse(s.ts) >= minTv && Date.parse(s.ts) <= maxTv);
  const tsOutside = signals.filter((s) => Date.parse(s.ts) < minTv || Date.parse(s.ts) > maxTv).map((s) => s.ts);
  const tvSet = new Set(tvOrigins), tsSet = new Set(tsInWindow.map((s) => s.ts));
  const exactMatches = [...tsSet].filter((t) => tvSet.has(t));
  const tvOnly = [...tvSet].filter((t) => !tsSet.has(t));
  const tsOnly = [...tsSet].filter((t) => !tvSet.has(t));

  report.typescriptSignalsInWindow = tsInWindow.length; report.typescriptSignalsAllFrom2023 = signals.length; report.typescriptSignalsOutsideTvWindow = tsOutside;
  report.exactMatches = exactMatches.length; report.tvOnly = tvOnly.sort(); report.tsOnly = tsOnly.sort(); report.directionMismatches = 0;
  report.consensusDistribution = tsInWindow.reduce((a, s) => { const k = String(s.consensus); a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);

  const parity = tvAt.length === tsInWindow.length && tvOnly.length === 0 && tsOnly.length === 0 && exactMatches.length === tvAt.length;
  if (!parity) {
    const candleByTime = new Map(candles.map((c) => [c.time, c]));
    const idxByTime = new Map(candles.map((c, i) => [c.time, i]));
    report.firstMismatchDiagnostics = [...new Set([...tvOnly, ...tsOnly])].sort().slice(0, 10).map((origin) => {
      const i = idxByTime.get(origin); const c = candleByTime.get(origin); const p = i !== undefined && i > 0 ? candles[i - 1] : undefined;
      const ev = i !== undefined ? evaluateUsdchfBearConsensusStructureV1(candles.slice(0, i + 1)) : null;
      return { timestamp: origin, tvExpected: tvSet.has(origin), tsResult: tsSet.has(origin), open: c?.open ?? null, high: c?.high ?? null, low: c?.low ?? null, close: c?.close ?? null, previousHigh: p?.high ?? null, previousLow: p?.low ?? null, ema20: ev?.ema20 ?? null, ema50: ev?.ema50 ?? null, ema20Back: ev?.ema20Back ?? null, atr14: ev?.atr14 ?? null, voteTrend: ev?.voteTrend, votePrice: ev?.votePrice, voteSlope: ev?.voteSlope, voteMomentum: ev?.voteMomentum, consensus: ev?.consensus ?? null, lowerHigh: c && p ? c.high < p.high : null, lowerLow: c && p ? c.low < p.low : null, bearStructure: ev?.bearStructure ?? null, strategySignalQualified: ev?.strategySignalQualified ?? null };
    });
    report.firstDifferingCondition = tvOnly.length ? "TradingView entry absent from TypeScript signals." : "TypeScript signal absent from TradingView export.";
  }
  report.verdict = parity ? "USDCHF_PINE_PARITY_CONFIRMED" : "USDCHF_PINE_PARITY_MISMATCH";
  console.log(JSON.stringify(report, null, 2));
  if (!parity) process.exitCode = 1;
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
