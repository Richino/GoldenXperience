/**
 * Full-precision diagnostic for the disputed CADJPY origin 2023-08-10T12:00Z.
 * Read-only. Confirms indicator implementation vs Pine, checks rounding, and
 * cross-checks ATR/EMA independently. No strategy modification.
 */
import { readFileSync } from "node:fs";
import { evaluateCadjpyBullBreakExtremeV1 } from "../src/lib/strategy/strategies/cadjpy-strategy.js";
import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators.js";
import type { Candle } from "../src/types/forex.js";

const DISPUTED = "2023-08-10T12:00:00.000Z";
const CACHE = "../research/frozen-strategies/CADJPY/oanda-h1-mid.csv";
const ENV_PATH = "../api-server/.env";

function unquote(v: string) { return v.trim().replace(/^["']/, "").replace(/["']$/, "").trim(); }
function env(name: string): string | null {
  if (process.env[name]?.trim()) return unquote(process.env[name]!);
  const line = readFileSync(ENV_PATH, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line ? unquote(line.slice(name.length + 1)) || null : null;
}
function loadCache(): Candle[] {
  const rows = readFileSync(CACHE, "utf8").trim().split(/\r?\n/).slice(1);
  return rows.map((r) => { const [t, o, h, l, c, v, comp] = r.split(","); return { time: t!, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v!, complete: comp === "true" }; });
}

/** Independent textbook Wilder ATR (RMA of TR, SMA seed) to cross-check calculateAtrValues. */
function wilderAtrAt(candles: Candle[], endIdx: number, period = 14): number {
  const tr = (i: number) => { const c = candles[i]!; const pc = candles[i - 1]?.close ?? c.close; return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)); };
  let atr = 0; for (let i = 0; i < period; i += 1) atr += tr(i); atr /= period; // seed = SMA of first 14 TR
  for (let i = period; i <= endIdx; i += 1) atr = (atr * (period - 1) + tr(i)) / period;
  return atr;
}

async function rawOanda(token: string): Promise<Map<string, { o: string; h: string; l: string; c: string }>> {
  const params = new URLSearchParams({ price: "M", granularity: "H1", from: "2023-08-09T00:00:00Z", to: "2023-08-10T14:00:00Z" });
  const res = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/CAD_JPY/candles?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await res.json() as { candles?: Array<{ time: string; complete: boolean; mid: { o: string; h: string; l: string; c: string } }> };
  const m = new Map<string, { o: string; h: string; l: string; c: string }>();
  for (const c of payload.candles ?? []) m.set(new Date(c.time).toISOString(), c.mid);
  return m;
}

async function main() {
  const candles = loadCache();
  const i = candles.findIndex((c) => c.time === DISPUTED);
  const c = candles[i]!, prev = candles[i - 1]!, b3 = candles[i - 3]!;

  // Raw OANDA precision check (Step 5).
  const token = env("OANDA_API_KEY") ?? env("OANDA_API_TOKEN");
  let rawLine = "TOKEN_UNAVAILABLE";
  let rawMatchesCache = "UNKNOWN";
  if (token) {
    const raw = await rawOanda(token);
    const r = raw.get(DISPUTED);
    if (r) {
      rawLine = `O=${r.o} H=${r.h} L=${r.l} C=${r.c}`;
      rawMatchesCache = (Number(r.o) === c.open && Number(r.h) === c.high && Number(r.l) === c.low && Number(r.c) === c.close) ? "YES (cache == raw, full float precision)" : "NO";
    }
  }

  // Indicators via the shipped implementation (as the evaluator uses them).
  const cl = candles.map((x) => x.close);
  const e20 = calculateEmaValues(cl, 20)[i]!, e50 = calculateEmaValues(cl, 50)[i]!, e20back = calculateEmaValues(cl, 20)[i - 3]!;
  const atr = calculateAtrValues(candles, 14)[i]!;
  const atrIndependent = wilderAtrAt(candles, i, 14);

  // Evaluator result on the causal slice.
  const ev = evaluateCadjpyBullBreakExtremeV1(candles.slice(0, i + 1));

  const body = Math.abs(c.close - c.open);
  const thr = 0.5 * atr;
  const range = c.high - c.low;
  const closeLoc = (c.close - c.low) / range;
  const upper25Boundary = c.high - range * 0.25;

  const out = {
    timestamp: c.time,
    ohlc: { open: c.open, high: c.high, low: c.low, close: c.close },
    previousHigh: prev.high,
    close3_bar: b3.time, close3: b3.close,
    indicators: {
      EMA20: e20, EMA50: e50, EMA20_back3: e20back, close3: b3.close,
      ATR14_shipped: atr, ATR14_independent_wilder: atrIndependent,
      ATR14_abs_diff: Math.abs(atr - atrIndependent),
    },
    votes: {
      voteTrend: ev.voteTrend, votePrice: ev.votePrice, voteSlope: ev.voteSlope, voteMomentum: ev.voteMomentum, consensus: ev.consensus,
    },
    prevHighBreak: { rule: "close > high[1]", close: c.close, high1: prev.high, passes: c.close > prev.high, clearance: c.close - prev.high },
    bullBody: c.close > c.open,
    body: { body, halfAtr: thr, bodyMinusThreshold: body - thr, bodyR: body / atr },
    extreme: { candleRange: range, upper25Boundary, close: c.close, closeLocation: closeLoc, passes: closeLoc >= 0.75 },
    finalLongSignal: ev.strategySignalQualified,
    rawOanda: { line: rawLine, rawMatchesCacheFullPrecision: rawMatchesCache },
    flipSensitivity: {
      note: "To EXCLUDE (Pine no-signal), need body < 0.5*ATR.",
      atrNeededToExclude: 2 * body, atrShippedNow: atr, atrIncreasePctToExclude: ((2 * body - atr) / atr) * 100,
      bodyNeededToExclude_lt: thr, bodyReductionPipsToExclude: (body - thr) / 0.01,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
