/** Diagnose the 5 USDJPY V6 parity discrepancies. Read-only. */
import { readFileSync } from "node:fs";
import { evaluateUsdjpyStrategyTrace } from "../src/lib/strategy/strategies/usdjpy-strategy.js";
import { calculatePineEmaValues } from "../src/lib/strategy/strategies/usdjpy-strategy.js";
import { calculateAtrValues } from "../src/lib/strategy/indicators.js";
import type { Candle } from "../src/types/forex.js";

const CACHE = "../research/frozen-strategies/USDJPY/oanda-h1-mid.csv";
const TV = "../research/frozen-strategies/USDJPY/tradingview-trades.csv";
function loadCache(): Candle[] { return readFileSync(CACHE, "utf8").trim().split(/\r?\n/).slice(1).map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" }; }); }
function nyOffset(ms: number) { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - ms) / 60_000; }
function nyToUtc(w: string) { const [d, t] = w.trim().split(/\s+/); const [y, mo, da] = d!.split("-").map(Number); const [h, mi] = t!.split(":").map(Number); let ms = Date.UTC(y!, mo! - 1, da!, h!, mi!); for (let i = 0; i < 2; i++) ms = Date.UTC(y!, mo! - 1, da!, h!, mi!) - nyOffset(ms) * 60_000; return new Date(ms).toISOString(); }
function tvOrigins(): Set<string> { const rows = readFileSync(TV, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/); const h = rows[0]!.split(","); const tc = h.indexOf("Type"), dc = h.indexOf("Date and time"); const s = new Set<string>(); for (const r of rows.slice(1)) { const c = r.split(","); if ((c[tc] ?? "").toLowerCase().startsWith("entry")) s.add(nyToUtc((c[dc] ?? "").trim())); } return s; }

const candles = loadCache();
const idxByTime = new Map(candles.map((c, i) => [c.time, i]));
const tv = tvOrigins();
const traced = evaluateUsdjpyStrategyTrace(candles);
const tsSet = new Set(traced.rows.filter((r) => r.finalLongSignal).map((r) => r.timestamp));
const minTv = Math.min(...[...tv].map((t) => Date.parse(t))), maxTv = Math.max(...[...tv].map((t) => Date.parse(t)));
const tsInWin = new Set([...tsSet].filter((t) => Date.parse(t) >= minTv && Date.parse(t) <= maxTv));
const tvOnly = [...tv].filter((t) => !tsInWin.has(t)).sort();
const tsOnly = [...tsInWin].filter((t) => !tv.has(t)).sort();

const rowByTime = new Map(traced.rows.map((r) => [r.timestamp, r]));
const ema20 = calculatePineEmaValues(candles.map((c) => c.close), 20);
const ema50 = calculatePineEmaValues(candles.map((c) => c.close), 50);
const atr = calculateAtrValues(candles, 14);

// For a given UTC day, show every 11-14 candidate origin with the full V6 conditions,
// plus a Pine-faithful preHigh from >=1 of the 08-10 bars (vs the TS 3-bar gate).
function dayReport(dayIso: string) {
  const day = dayIso.slice(0, 10);
  const dayCandles = candles.filter((c) => c.time.slice(0, 10) === day);
  const range0810 = dayCandles.filter((c) => { const h = new Date(c.time).getUTCHours(); return h >= 8 && h <= 10; });
  const preHighPineFaithful = range0810.length >= 1 ? Math.max(...range0810.map((c) => c.high)) : null;
  const rangeHoursPresent = range0810.map((c) => new Date(c.time).getUTCHours());
  const origins = [11, 12, 13, 14].map((hr) => {
    const iso = `${day}T${String(hr).padStart(2, "0")}:00:00.000Z`;
    const i = idxByTime.get(iso);
    const c = i !== undefined ? candles[i] : undefined;
    const row = rowByTime.get(iso);
    if (!c || i === undefined) return { hour: hr, candleMissing: true };
    const body = Math.abs(c.close - c.open); const rng = c.high - c.low;
    const bodyR = atr[i]! > 0 ? body / atr[i]! : null;
    const closeLoc = rng > 0 ? (c.close - c.low) / rng : null;
    return {
      hour: hr, close: c.close, open: c.open, high: c.high, low: c.low,
      ema20: ema20[i], ema50: ema50[i], emaLong: (ema20[i] ?? 0) > (ema50[i] ?? 0), atr14: atr[i],
      tsRangeReady: row?.rangeReady, tsPreHigh: row?.preHigh, tsPreRangeBarCount: row?.preRangeBarCount,
      pineFaithfulPreHigh: preHighPineFaithful,
      closeGtTsPreHigh: row?.preHigh != null ? c.close > row.preHigh : null,
      closeGtPineFaithfulPreHigh: preHighPineFaithful != null ? c.close > preHighPineFaithful : null,
      bodyR, bodyPass: bodyR != null && bodyR >= 0.4, closeLoc, upper40Pass: closeLoc != null && closeLoc >= 0.6,
      tsFinalLongSignal: row?.finalLongSignal, tsTradedEarlier: row?.tradedEarlierUtcDay,
      inTV: tv.has(iso), inTS: tsInWin.has(iso),
    };
  });
  return { day, rangeHoursPresent_0810: rangeHoursPresent, rangeBarCount_0810: range0810.length, preHighPineFaithful, origins };
}

const disputedDays = [...new Set([...tvOnly, ...tsOnly].map((t) => t.slice(0, 10)))].sort();
console.log(JSON.stringify({
  tvOnly, tsOnly,
  disputedDayCount: disputedDays.length,
  disputedDays: disputedDays.map(dayReport),
}, null, 2));
