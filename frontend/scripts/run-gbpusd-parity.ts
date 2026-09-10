/**
 * GBPUSD 30M Dual-Origin V2 Pine-parity replay (read-only OANDA Practice M30 MID).
 * Computes raw signals via `evaluateGbpusdStrategyTrace`, then simulates the
 * Pine's TradingView-hedging block (opposite-direction blocked while a leg is
 * open) + 6-bar M30 exits to derive ACTUAL entries, and compares both levels to
 * the canonical CSV. No orders, no execution gates, no modification of Pine/CSV.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateGbpusdStrategyTrace } from "../src/lib/strategy/strategies/gbpusd-strategy.js";
import type { Candle } from "../src/types/forex.js";

const INSTRUMENT = "GBP_USD";
const FETCH_START = "2024-09-01T00:00:00.000Z";
const FETCH_END = "2026-09-06T00:00:00.000Z";
const MAX_HOLD = 6;
const CACHE_PATH = "../research/frozen-strategies/GBPUSD/oanda-m30-mid.csv";
const TV_CSV_PATH = "../research/frozen-strategies/GBPUSD/tradingview-trades.csv";
const ENV_PATH = "../api-server/.env";

function unquote(v: string) { return v.trim().replace(/^["']/, "").replace(/["']$/, "").trim(); }
function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  try { const l = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((x) => x.startsWith(`${name}=`)); return l ? unquote(l.slice(name.length + 1)) || null : null; } catch { return null; }
}
async function fetchM30(token: string): Promise<Candle[]> {
  const byTime = new Map<string, Candle>(); let cursor = FETCH_START; const endMs = Date.parse(FETCH_END);
  for (let page = 0; page < 24; page += 1) {
    const params = new URLSearchParams({ price: "M", granularity: "M30", count: "5000", from: cursor });
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
  let incomplete = 0, duplicates = 0, outOfOrder = 0; const seen = new Set<string>(); let prevMs: number | null = null; const gaps: Array<{ from: string; hours: number }> = [];
  for (const c of candles) { if (!c.complete) incomplete += 1; if (seen.has(c.time)) duplicates += 1; else seen.add(c.time); const ms = Date.parse(c.time); if (prevMs !== null) { if (ms < prevMs) outOfOrder += 1; const g = (ms - prevMs) / 3_600_000; if (g > 0.5) { const d = new Date(prevMs).getUTCDay(); const w = d === 5 || d === 6 || d === 0; if (!(w && g <= 72)) gaps.push({ from: new Date(prevMs).toISOString(), hours: +g.toFixed(1) }); } } prevMs = ms; }
  return { first: candles[0]?.time ?? null, last: candles.at(-1)?.time ?? null, total: candles.length, incomplete, duplicates, outOfOrder, unexpectedGaps: gaps.length, gapSample: gaps.slice(0, 8) };
}
function nyOffsetMinutes(utcMs: number): number { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value])); return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcMs) / 60_000; }
function nyWallToUtcISO(wall: string): string { const [d, t] = wall.trim().split(/\s+/); const [y, mo, da] = d!.split("-").map(Number); const [h, mi] = t!.split(":").map(Number); let ms = Date.UTC(y!, mo! - 1, da!, h!, mi!); for (let i = 0; i < 2; i += 1) ms = Date.UTC(y!, mo! - 1, da!, h!, mi!) - nyOffsetMinutes(ms) * 60_000; return new Date(ms).toISOString(); }

interface TvEntry { originUtc: string; direction: "long" | "short"; origin: "1030" | "1100"; tag: string; key: string }
function parseTradingViewEntries(): TvEntry[] {
  const rows = readFileSync(TV_CSV_PATH, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/); const h = rows[0]!.split(","); const tC = h.indexOf("Type"), dC = h.indexOf("Date and time"), sC = h.indexOf("Signal");
  const out: TvEntry[] = [];
  for (const row of rows.slice(1)) { const cols = row.split(","); const type = (cols[tC] ?? "").trim().toLowerCase(); if (!type.startsWith("entry")) continue; const originUtc = nyWallToUtcISO((cols[dC] ?? "").trim()); const dir = type.includes("short") ? "short" : "long"; const t = new Date(originUtc); const origin = t.getUTCHours() === 10 && t.getUTCMinutes() === 30 ? "1030" : t.getUTCHours() === 11 && t.getUTCMinutes() === 0 ? "1100" : ("bad" as any); out.push({ originUtc, direction: dir, origin, tag: (cols[sC] ?? "").trim(), key: `${originUtc}|${origin}|${dir}` }); }
  return out;
}

// Simulate the Pine hedging block + 6-bar M30 exits over MID candles to derive actual entries.
interface RawSig { ts: string; origin: "1030" | "1100"; direction: "long" | "short"; entry: number; stop: number; target: number; index: number }
function simulateEntries(candles: Candle[], raws: RawSig[]): { entries: RawSig[]; blocked: RawSig[] } {
  const byIndex = new Map(raws.map((r) => [r.index, r]));
  interface Leg { origin: string; dir: 1 | -1; entryIndex: number; exitIndex: number }
  const open: Leg[] = [];
  const entries: RawSig[] = []; const blocked: RawSig[] = [];
  // Precompute each raw signal's exit index via a forward 6-bar scan (mid OHLC, stop-first).
  function exitIndex(r: RawSig): number {
    for (let s = 1; s <= MAX_HOLD; s += 1) {
      const c = candles[r.index + s]; if (!c) return r.index + MAX_HOLD; // assume held to horizon if data runs out
      const stopHit = r.direction === "long" ? c.low <= r.stop : c.high >= r.stop;
      const targetHit = r.direction === "long" ? c.high >= r.target : c.low <= r.target;
      if (stopHit || targetHit) return r.index + s; // stop-first ambiguity doesn't change the exit bar
    }
    return r.index + MAX_HOLD;
  }
  const sorted = [...raws].sort((a, b) => a.index - b.index || (a.origin < b.origin ? -1 : 1));
  for (const r of sorted) {
    // free legs that have exited strictly before this origin bar
    for (let i = open.length - 1; i >= 0; i -= 1) if (open[i]!.exitIndex < r.index) open.splice(i, 1);
    const net = open.reduce((s, l) => s + l.dir, 0);
    const dir: 1 | -1 = r.direction === "long" ? 1 : -1;
    const sameOriginOpen = open.some((l) => l.origin === r.origin);
    const allowed = !sameOriginOpen && (dir === 1 ? net >= 0 : net <= 0);
    if (allowed) { entries.push(r); open.push({ origin: r.origin, dir, entryIndex: r.index, exitIndex: exitIndex(r) }); }
    else blocked.push(r);
  }
  return { entries, blocked };
}

async function main() {
  const report: Record<string, unknown> = {};
  const token = environmentValue("OANDA_API_KEY") ?? environmentValue("OANDA_API_TOKEN");
  const tv = parseTradingViewEntries();
  report.TRADINGVIEW_EXPORT_TIMEZONE_STATUS = "INFERRED_AMERICA_NEW_YORK";
  report.tradingViewEntries = tv.length;
  report.tvBreakdown = tv.reduce((a, e) => { const k = `${e.origin}_${e.direction}`; a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const badOrigin = tv.filter((e) => e.origin !== "1030" && e.origin !== "1100");
  report.entriesNotAtValidOrigin = badOrigin.length; report.badOriginSample = badOrigin.slice(0, 5);
  if (!token) { report.OANDA_M30_DATA_FETCHED = "NO"; report.verdict = "GBPUSD_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }

  const candles = await fetchM30(token);
  if (!candles.length) { report.OANDA_M30_DATA_FETCHED = "NO"; report.verdict = "GBPUSD_PARITY_BLOCKED_NO_MARKET_DATA"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
  writeCache(candles);
  report.OANDA_M30_DATA_FETCHED = "YES"; report.oandaDataPath = CACHE_PATH;
  const dq = dataQuality(candles); report.dataQuality = dq; report.candlePeriod = `${dq.first} .. ${dq.last}`; report.totalM30Candles = candles.length;

  const traced = evaluateGbpusdStrategyTrace(candles);
  if (traced.error) { report.replayError = traced.error; report.verdict = "GBPUSD_PINE_PARITY_MISMATCH"; console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
  const indexByTs = new Map(traced.rows.map((r, i) => [r.timestamp, i]));
  const rawSignals: RawSig[] = traced.rows.filter((r) => r.rawLongSignal || r.rawShortSignal).map((r) => ({ ts: r.timestamp, origin: r.originCode as "1030" | "1100", direction: r.rawLongSignal ? "long" : "short", entry: r.signalKey ? (r.rawLongSignal ? r.preRangeHigh! : r.preRangeLow!) : 0, stop: r.stop!, target: r.target!, index: indexByTs.get(r.timestamp)! }));

  // Window to the TV export period.
  const tvOrigins = tv.map((e) => e.originUtc).sort();
  const minTv = Date.parse(tvOrigins[0]!), maxTv = Date.parse(tvOrigins.at(-1)!);
  const rawInWindow = rawSignals.filter((r) => Date.parse(r.ts) >= minTv && Date.parse(r.ts) <= maxTv);

  // Level 1: RAW signal parity (pre-blocking).
  const tvKeys = new Set(tv.map((e) => e.key));
  const rawKey = (r: RawSig) => `${r.ts}|${r.origin}|${r.direction}`;
  const rawInWinKeys = new Set(rawInWindow.map(rawKey));
  report.rawSignals_inWindow = rawInWindow.length;
  report.rawSignals_allHistory = rawSignals.length;
  report.raw_exactMatches = [...rawInWinKeys].filter((k) => tvKeys.has(k)).length;
  report.raw_tvOnly = [...tvKeys].filter((k) => !rawInWinKeys.has(k)).length;
  report.raw_tsOnly = [...rawInWinKeys].filter((k) => !tvKeys.has(k)).length;

  // Level 2: ACTUAL entries after hedging block + exits.
  const { entries, blocked } = simulateEntries(candles, rawSignals);
  const entriesInWindow = entries.filter((r) => Date.parse(r.ts) >= minTv && Date.parse(r.ts) <= maxTv);
  const entryKeys = new Set(entriesInWindow.map(rawKey));
  const exactMatches = [...entryKeys].filter((k) => tvKeys.has(k));
  const tvOnly = [...tvKeys].filter((k) => !entryKeys.has(k));
  const tsOnly = [...entryKeys].filter((k) => !tvKeys.has(k));
  report.blockedCount_allHistory = blocked.length;
  report.actualEntries_inWindow = entriesInWindow.length;
  report.entry_exactMatches = exactMatches.length;
  report.entry_tvOnly = tvOnly.sort();
  report.entry_tsOnly = tsOnly.sort();
  report.entryBreakdown = entriesInWindow.reduce((a, e) => { const k = `${e.origin}_${e.direction}`; a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);

  const parity = tvOnly.length === 0 && tsOnly.length === 0 && exactMatches.length === tv.length;
  report.verdict = parity ? "GBPUSD_PINE_PARITY_CONFIRMED" : "GBPUSD_PINE_PARITY_MISMATCH";
  console.log(JSON.stringify(report, null, 2));
  if (!parity) process.exitCode = 1;
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
