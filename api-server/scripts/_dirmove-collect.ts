/**
 * direction-return-v2 — collection pass. RESEARCH ONLY.
 *
 * The EMA audit killed EMA as a timing gate: matched control bars did as well
 * or better than EMA opportunity bars, so the gate was selecting moments
 * without selecting better ones. What it did NOT kill was the small directional
 * signal itself, which replicated on sealed data (+0.0104 ATR, CI excluding
 * zero, placebo-clean) but sat at ~4.6% of the spread.
 *
 * So this pass drops the gate entirely and evaluates EVERY eligible closed bar,
 * subject only to data quality. EMA values survive as ordinary features with no
 * authority over timing or direction. The new question is whether higher
 * timeframe context and a genuine cross-sectional currency basket can lift the
 * signal, and whether predicting move MAGNITUDE lets us keep only the bars
 * where the expected move clears its own cost.
 *
 * Leakage rules, which matter more here than anywhere else because H1/H4 and
 * eleven cross-pairs are involved:
 *   - An H1 or H4 bar is visible only once it has CLOSED at or before the M15
 *     decision time. Cursors advance to the last closed bar, never the current
 *     forming one.
 *   - The eight-currency basket is computed on H1 closes only, at the same
 *     lagged H1 index for all eleven pairs, so no pair contributes a bar the
 *     others could not have seen.
 *   - Features read candles up to and including the decision bar; labels read
 *     strictly after it.
 *
 * Writes CSV. Reads the database, writes nothing to it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { calculateAtrValues, calculateEmaValues, calculateRsiValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

/** Tradeable decision pairs: the only ones with deep M15 history. */
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
/** H1 cross-section for the currency basket. Eleven pairs, eight currencies. */
const BASKET = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "AUD_USD",
                "NZD_USD", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP"] as const;
const CCY = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
const HORIZONS = [1, 3, 6, 12, 24];
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "dirmove.csv");
const M15_WINDOW = 220;

type Candle = { t: number; o: number; h: number; l: number; c: number };
type Quote = { t: number; bc: number; ac: number; bh: number; bl: number; ah: number; al: number };

async function candles(instrument: string, tf: string): Promise<Candle[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`, [instrument, tf]);
  return r.rows.map((x) => ({ t: Date.parse(x.close_time as string), o: Number(x.open), h: Number(x.high), l: Number(x.low), c: Number(x.close) }));
}
async function quotes(instrument: string): Promise<Quote[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, bid_close::float, ask_close::float, bid_high::float, bid_low::float, ask_high::float, ask_low::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument]);
  return r.rows.map((x) => ({ t: Date.parse(x.close_time as string), bc: Number(x.bid_close), ac: Number(x.ask_close),
    bh: Number(x.bid_high), bl: Number(x.bid_low), ah: Number(x.ask_high), al: Number(x.ask_low) }));
}

console.log("loading...");
const m15: Record<string, Candle[]> = {}; const h1: Record<string, Candle[]> = {};
const h4: Record<string, Candle[]> = {}; const qt: Record<string, Quote[]> = {};
for (const p of PAIRS) { [m15[p], h1[p], h4[p], qt[p]] = await Promise.all([candles(p, "M15"), candles(p, "H1"), candles(p, "H4"), quotes(p)]); }
const basketH1: Record<string, Candle[]> = {};
for (const p of BASKET) basketH1[p] = h1[p] ?? await candles(p, "H1");
console.log("loaded. basket pairs: " + BASKET.map((p) => p + "=" + basketH1[p]!.length).join(" "));

// ---- currency strength, precomputed once per H1 timestamp -------------------
// Cross-sectional: each pair's log return credits its base and debits its quote;
// a currency's score is the mean across every pair it appears in. Identical in
// construction to research-v2/carry-momentum so the two remain comparable.
const h1Index: Record<string, Map<number, number>> = {};
for (const p of BASKET) { const m = new Map<number, number>(); basketH1[p]!.forEach((c, i) => m.set(c.t, i)); h1Index[p] = m; }
const allH1Times = [...new Set(BASKET.flatMap((p) => basketH1[p]!.map((c) => c.t)))].sort((a, b) => a - b);
const strengthAt = new Map<number, Record<string, number>>();
for (const t of allH1Times) {
  const out: Record<string, number> = {};
  for (const L of [6, 24]) {
    const sum: Record<string, number> = {}; const cnt: Record<string, number> = {};
    for (const c of CCY) { sum[c] = 0; cnt[c] = 0; }
    let present = 0;
    for (const p of BASKET) {
      const i = h1Index[p]!.get(t); if (i === undefined || i < L) continue;
      const a = basketH1[p]![i - L]!.c; const b = basketH1[p]![i]!.c;
      if (!(a > 0) || !(b > 0)) continue;
      const r = Math.log(b / a);
      const base = p.slice(0, 3); const quote = p.slice(4);
      sum[base]! += r; cnt[base]! += 1; sum[quote]! -= r; cnt[quote]! += 1; present += 1;
    }
    if (present < 8) { out["_ok" + L] = 0; continue; }
    out["_ok" + L] = 1;
    for (const c of CCY) out["str" + c + L] = cnt[c]! > 0 ? sum[c]! / cnt[c]! : 0;
  }
  strengthAt.set(t, out);
}
console.log("currency strength computed for " + strengthAt.size + " H1 timestamps");

function lastClosed(arr: Candle[], atMs: number, from: number) {
  let i = from; while (i + 1 < arr.length && arr[i + 1]!.t <= atMs) i += 1; return i;
}
const ret = (c: Candle[], i: number, n: number, atr: number) => {
  const p = c[i - n]; return p && atr > 0 ? (c[i]!.c - p.c) / atr : 0;
};
function tfBlock(c: Candle[], i: number, prefix: string): Record<string, number> {
  const win = c.slice(Math.max(0, i - 219), i + 1);
  const closes = win.map((x) => x.c);
  const atr = calculateAtrValues(win.map((x) => ({ time: "", open: x.o, high: x.h, low: x.l, close: x.c, volume: 0, complete: true })) as never, 14).at(-1) ?? 0;
  if (!(atr > 0)) return {};
  const e20 = calculateEmaValues(closes, 20); const e50 = calculateEmaValues(closes, 50);
  const f = e20.at(-1) ?? null; const s = e50.at(-1) ?? null;
  const f10 = e20.at(-11) ?? null; const s10 = e50.at(-11) ?? null;
  const w20 = win.slice(-20); const hi = Math.max(...w20.map((x) => x.h)); const lo = Math.min(...w20.map((x) => x.l));
  const last = win.at(-1)!;
  const rets = closes.slice(-25).map((v, k, a) => (k ? Math.log(v / a[k - 1]!) : 0)).slice(1);
  const mu = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const rv = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length || 1));
  const atrSeries = calculateAtrValues(win.map((x) => ({ time: "", open: x.o, high: x.h, low: x.l, close: x.c, volume: 0, complete: true })) as never, 14).filter((v): v is number => typeof v === "number" && v > 0);
  return {
    [prefix + "EmaSepAtr"]: f !== null && s !== null ? (f - s) / atr : 0,
    [prefix + "EmaFastSlope"]: f !== null && f10 !== null ? (f - f10) / 10 / atr : 0,
    [prefix + "EmaSlowSlope"]: s !== null && s10 !== null ? (s - s10) / 10 / atr : 0,
    [prefix + "PriceVsFast"]: f !== null ? (last.c - f) / atr : 0,
    [prefix + "Ret1"]: ret(win, win.length - 1, 1, atr), [prefix + "Ret6"]: ret(win, win.length - 1, 6, atr),
    [prefix + "Ret24"]: ret(win, win.length - 1, 24, atr),
    [prefix + "RangePos"]: hi > lo ? (last.c - lo) / (hi - lo) : 0.5,
    [prefix + "DistHigh"]: (hi - last.c) / atr, [prefix + "DistLow"]: (last.c - lo) / atr,
    [prefix + "RealVol"]: rv,
    [prefix + "VolPct"]: atrSeries.length ? atrSeries.filter((v) => v <= atr).length / atrSeries.length : 0.5,
    [prefix + "StructUp"]: last.c > hi - (hi - lo) * 0.02 ? 1 : 0,
    [prefix + "StructDown"]: last.c < lo + (hi - lo) * 0.02 ? 1 : 0,
  };
}

const stream = createWriteStream(OUT);
let header: string[] | null = null;
let written = 0;

for (const pair of PAIRS) {
  const M = m15[pair]!; const Q = qt[pair]!;
  const qIdx = new Map<number, number>(); Q.forEach((q, i) => qIdx.set(q.t, i));
  const pip = pipSizeFor(pair as never);
  const base = pair.slice(0, 3); const quoteCcy = pair.slice(4);
  let c1 = 0; let c4 = 0; let hs = 0;

  for (let i = M15_WINDOW; i < M.length; i += 1) {
    const bar = M[i]!; const t = bar.t;
    if (t < REPLAY_START) continue;
    const qi = qIdx.get(t); if (qi === undefined) continue;
    const q = Q[qi]!;
    const spreadPips = (q.ac - q.bc) / pip;
    if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

    // data quality: intact M15 series behind the decision bar
    if ((t - M[i - 1]!.t) / 60000 > 15.5) continue;
    let gaps = 0;
    for (let k = i - 49; k <= i; k += 1) if ((M[k]!.t - M[k - 1]!.t) / 60000 > 15.5) gaps += 1;
    if (gaps > 0) continue;

    const win = M.slice(i - M15_WINDOW + 1, i + 1);
    const closes = win.map((x) => x.c);
    const asCandles = win.map((x) => ({ time: "", open: x.o, high: x.h, low: x.l, close: x.c, volume: 0, complete: true }));
    const atr = calculateAtrValues(asCandles as never, 14).at(-1) ?? 0;
    if (!(atr > 0)) continue;

    // higher timeframes: last CLOSED bar only
    c1 = lastClosed(h1[pair]!, t, c1); c4 = lastClosed(h4[pair]!, t, c4);
    if (c1 < 220 || c4 < 60) continue;
    const h1f = tfBlock(h1[pair]!, c1, "h1"); const h4f = tfBlock(h4[pair]!, c4, "h4");
    if (!Object.keys(h1f).length || !Object.keys(h4f).length) continue;

    // basket: the same last-closed H1 instant for every pair in the cross-section
    while (hs + 1 < allH1Times.length && allH1Times[hs + 1]! <= t) hs += 1;
    const st = strengthAt.get(allH1Times[hs]!);
    if (!st || !st._ok24 || !st._ok6) continue;

    const labels: Record<string, number> = {};
    let ok = true;
    for (const h of HORIZONS) {
      const fq = Q[qi + h]; const fm = M[i + h];
      if (!fq || !fm) { ok = false; break; }
      labels["midRet" + h] = (fm.c - bar.c) / atr;
      labels["absMove" + h] = Math.abs(fm.c - bar.c) / atr;
      labels["longRet" + h] = (fq.bc - q.ac) / atr;
      labels["shortRet" + h] = (q.bc - fq.ac) / atr;
      let up = 0; let dn = 0;
      for (let k = qi + 1; k <= qi + h; k += 1) {
        const z = Q[k]!; up = Math.max(up, (z.bh - q.ac) / atr); dn = Math.min(dn, (z.bl - q.ac) / atr);
      }
      labels["mfe" + h] = up; labels["mae" + h] = -dn;
    }
    if (!ok) continue;

    const e20 = calculateEmaValues(closes, 20); const e50 = calculateEmaValues(closes, 50);
    const f = e20.at(-1) ?? bar.c; const s = e50.at(-1) ?? bar.c;
    const rsi = calculateRsiValues(closes, 14).at(-1) ?? 50;
    const w20 = win.slice(-20); const hi20 = Math.max(...w20.map((x) => x.h)); const lo20 = Math.min(...w20.map((x) => x.l));
    const w50 = win.slice(-50); const hi50 = Math.max(...w50.map((x) => x.h)); const lo50 = Math.min(...w50.map((x) => x.l));
    const range = bar.h - bar.l; const body = bar.c - bar.o;
    const upW = bar.h - Math.max(bar.o, bar.c); const loW = Math.min(bar.o, bar.c) - bar.l;
    let cu = 0; let cd = 0;
    for (let k = win.length - 1; k >= 0; k -= 1) { if (win[k]!.c > win[k]!.o) cu += 1; else break; }
    for (let k = win.length - 1; k >= 0; k -= 1) { if (win[k]!.c < win[k]!.o) cd += 1; else break; }
    const seg = closes.slice(-13);
    const grossTravel = seg.slice(1).reduce((a, c, k) => a + Math.abs(c - seg[k]!), 0);
    const atrSeries = calculateAtrValues(asCandles as never, 14).filter((v): v is number => typeof v === "number" && v > 0);
    const sess = dayTradingSession(new Date(t)); const d = new Date(t);

    const row: Record<string, number | string> = {
      pair, ts: new Date(t).toISOString(),
      spreadPips, atrPips: atr / pip, spreadAtr: spreadPips / (atr / pip),
      m15EmaSepAtr: (f - s) / atr, m15PriceVsFast: (bar.c - f) / atr, m15PriceVsSlow: (bar.c - s) / atr,
      m15Ret1: ret(win, win.length - 1, 1, atr), m15Ret3: ret(win, win.length - 1, 3, atr),
      m15Ret6: ret(win, win.length - 1, 6, atr), m15Ret12: ret(win, win.length - 1, 12, atr),
      m15Ret24: ret(win, win.length - 1, 24, atr),
      m15Rsi: rsi, m15BodyAtr: body / atr, m15BodyRange: range > 0 ? body / range : 0,
      m15WickImb: range > 0 ? (upW - loW) / range : 0,
      m15ConsecUp: cu, m15ConsecDown: cd,
      m15Efficiency: grossTravel > 0 ? (seg.at(-1)! - seg[0]!) / grossTravel : 0,
      m15RangePos20: hi20 > lo20 ? (bar.c - lo20) / (hi20 - lo20) : 0.5,
      m15RangePos50: hi50 > lo50 ? (bar.c - lo50) / (hi50 - lo50) : 0.5,
      m15DistHigh20: (hi20 - bar.c) / atr, m15DistLow20: (bar.c - lo20) / atr,
      m15DistHigh50: (hi50 - bar.c) / atr, m15DistLow50: (bar.c - lo50) / atr,
      m15VolPct: atrSeries.length ? atrSeries.filter((v) => v <= atr).length / atrSeries.length : 0.5,
      m15VolExp: (atrSeries.at(-25) ?? atr) > 0 ? atr / (atrSeries.at(-25) ?? atr) : 1,
      ...h1f, ...h4f,
      xsBase6: st["str" + base + "6"] ?? 0, xsQuote6: st["str" + quoteCcy + "6"] ?? 0,
      xsDiff6: (st["str" + base + "6"] ?? 0) - (st["str" + quoteCcy + "6"] ?? 0),
      xsBase24: st["str" + base + "24"] ?? 0, xsQuote24: st["str" + quoteCcy + "24"] ?? 0,
      xsDiff24: (st["str" + base + "24"] ?? 0) - (st["str" + quoteCcy + "24"] ?? 0),
      xsUSD24: st.strUSD24 ?? 0, xsEUR24: st.strEUR24 ?? 0, xsGBP24: st.strGBP24 ?? 0, xsJPY24: st.strJPY24 ?? 0,
      xsCHF24: st.strCHF24 ?? 0, xsCAD24: st.strCAD24 ?? 0, xsAUD24: st.strAUD24 ?? 0, xsNZD24: st.strNZD24 ?? 0,
      sessLondon: sess.label === "London" ? 1 : 0,
      sessOverlap: sess.label === "London/New York overlap" ? 1 : 0,
      sessNY: sess.label === "New York" ? 1 : 0,
      sessOther: sess.label.startsWith("Outside") || sess.label.startsWith("Past") ? 1 : 0,
      hour: d.getUTCHours(), dow: d.getUTCDay(),
      ...labels,
    };
    if (!header) { header = Object.keys(row); stream.write(header.join(",") + "\n"); }
    stream.write(header.map((k) => { const v = row[k]; return typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(6) : "0") : v; }).join(",") + "\n");
    written += 1;
    if (written % 50000 === 0) console.log("  rows " + written);
  }
  console.log(pair + " done, total rows " + written);
}
// process.exit() would discard whatever is still buffered, so wait for the
// stream to actually finish before the process is allowed to go.
await new Promise<void>((resolve, reject) => { stream.on("finish", () => resolve()); stream.on("error", reject); stream.end(); });
console.log("wrote " + written + " rows to " + path.resolve(OUT));
process.exit(0);
