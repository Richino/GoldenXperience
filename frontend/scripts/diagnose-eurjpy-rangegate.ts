/**
 * Decisive test for the EURJPY 5-bar range gate. Compares the SHIPPED evaluator
 * (rangeReady requires exactly 5 of 01-05) against a Pine-faithful RELAXED
 * variant (preHigh from >=1 current-day 01-05 bar, matching `not na(preHigh)`).
 * Read-only; reimplements the relaxed logic locally; does NOT modify the strategy.
 */
import { readFileSync } from "node:fs";
import { evaluateEurjpy01To05RangeBreakV1 } from "../src/lib/strategy/strategies/eurjpy-strategy.js";
import { calculateEmaValues, calculateAtrValues } from "../src/lib/strategy/indicators.js";
import type { Candle } from "../src/types/forex.js";

const CACHE = "../research/frozen-strategies/EURJPY/oanda-h1-mid.csv";
const TV = "../research/frozen-strategies/EURJPY/tradingview-trades.csv";
const PINE_START = Date.parse("2023-01-01T00:00:00.000Z");

function loadCache(): Candle[] { return readFileSync(CACHE, "utf8").trim().split(/\r?\n/).slice(1).map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" }; }); }
function nyOffset(ms: number) { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - ms) / 60_000; }
function nyToUtc(w: string) { const [d, t] = w.trim().split(/\s+/); const [y, mo, da] = d!.split("-").map(Number); const [h, mi] = t!.split(":").map(Number); let ms = Date.UTC(y!, mo! - 1, da!, h!, mi!); for (let i = 0; i < 2; i++) ms = Date.UTC(y!, mo! - 1, da!, h!, mi!) - nyOffset(ms) * 60_000; return new Date(ms).toISOString(); }
function tvOrigins(): Set<string> { const rows = readFileSync(TV, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/); const h = rows[0]!.split(","); const tc = h.indexOf("Type"), dc = h.indexOf("Date and time"); const s = new Set<string>(); for (const r of rows.slice(1)) { const c = r.split(","); if ((c[tc] ?? "").trim().toLowerCase() === "entry long") s.add(nyToUtc((c[dc] ?? "").trim())); } return s; }

const sameUtcDay = (a: Date, b: Date) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
const exactH1 = (d: Date) => d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

/** Pine-faithful relaxed evaluation: preHigh from >=1 current-day 01-05 bar. */
function relaxedSignal(candles: Candle[], i: number): { qualified: boolean; preRangeBarCount: number; preHigh: number | null } {
  const cur = candles[i]!, ct = new Date(cur.time);
  const prev = candles[i - 1], b3 = candles[i - 3];
  const ema = calculateEmaValues(candles.slice(0, i + 1).map((c) => c.close), 20);
  const atrs = calculateAtrValues(candles.slice(0, i + 1), 14);
  const ema20 = ema[i] ?? null, ema20Back = ema[i - 3] ?? null, atr = atrs[i] ?? null;
  const rangeCandles = candles.slice(0, i + 1).filter((c) => { const t = new Date(c.time); return sameUtcDay(t, ct) && t.getUTCHours() >= 1 && t.getUTCHours() <= 5 && exactH1(t); });
  const preHigh = rangeCandles.length >= 1 ? Math.max(...rangeCandles.map((c) => c.high)) : null; // >=1 bar (Pine: not na(preHigh))
  const origin = exactH1(ct) && ct.getUTCHours() === 6;
  const ready = Boolean(prev && b3 && ema20 !== null && ema20Back !== null && atr !== null && atr > 0 && preHigh !== null);
  const qualified = Boolean(origin && ready && ema20! > ema20Back! && cur.close > prev!.high && cur.close > preHigh!);
  return { qualified, preRangeBarCount: rangeCandles.length, preHigh };
}

const candles = loadCache();
const tv = tvOrigins();
const maxTv = Math.max(...[...tv].map((t) => Date.parse(t)));
const shippedSet = new Set<string>();
const relaxedSet = new Set<string>();
const relaxedExtra: Array<Record<string, unknown>> = [];
for (let i = 0; i < candles.length; i++) {
  const t = new Date(candles[i]!.time);
  if (t.getUTCMinutes() !== 0 || t.getUTCHours() !== 6) continue;
  const ms = Date.parse(candles[i]!.time);
  if (ms < PINE_START || ms > maxTv) continue;
  if (evaluateEurjpy01To05RangeBreakV1(candles.slice(0, i + 1)).strategySignalQualified) shippedSet.add(candles[i]!.time);
  const rel = relaxedSignal(candles, i);
  if (rel.qualified) { relaxedSet.add(candles[i]!.time); if (rel.preRangeBarCount !== 5) relaxedExtra.push({ ts: candles[i]!.time, preRangeBarCount: rel.preRangeBarCount, preHigh: rel.preHigh, inTV: tv.has(candles[i]!.time) }); }
}

// Origins where the two variants disagree (i.e. partial-range days the gate blocks).
const shippedArr = [...shippedSet], relaxedArr = [...relaxedSet];
const onlyRelaxed = relaxedArr.filter((t) => !shippedSet.has(t));
const onlyShipped = shippedArr.filter((t) => !relaxedSet.has(t));
// Also: partial-range (<5) 06:00 days that had emaSlope+prevHighBreak+rangeBreak under relaxed logic.
console.log(JSON.stringify({
  windowedTvEntries: [...tv].filter((t) => Date.parse(t) >= PINE_START && Date.parse(t) <= maxTv).length,
  shippedSignals: shippedSet.size,
  relaxedSignals: relaxedSet.size,
  signalsOnlyUnderRelaxed: onlyRelaxed,
  signalsOnlyUnderShipped: onlyShipped,
  relaxedSignalsWithPartialRange: relaxedExtra,
  shippedMatchesTV: shippedArr.every((t) => tv.has(t)) && [...tv].filter((t) => Date.parse(t) >= PINE_START && Date.parse(t) <= maxTv).every((t) => shippedSet.has(t)),
  relaxedMatchesTV: relaxedArr.every((t) => tv.has(t)) && [...tv].filter((t) => Date.parse(t) >= PINE_START && Date.parse(t) <= maxTv).every((t) => relaxedSet.has(t)),
}, null, 2));
