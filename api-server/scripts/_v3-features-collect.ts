/**
 * direction-return-v3 — additive feature collection. RESEARCH ONLY.
 *
 * Emits ONLY the new features, keyed by (pair, ts), so the frozen v2 dataset is
 * joined rather than regenerated. That keeps direction-return-v2-baseline
 * bit-identical and makes the ablation a genuine like-for-like comparison.
 *
 * New groups:
 *   strength  — currency strength done properly: five lookbacks, an H4-scale
 *               and a daily-scale read, volatility-adjustment, cross-sectional
 *               rank, rank change and acceleration, all from the 11-pair H1
 *               basket over 8 currencies.
 *   struct    — deterministic H1 and H4 market structure: fractal swings,
 *               higher-high / higher-low / lower-high / lower-low flags,
 *               distance to the last swing, structure breaks, OLS trend slope,
 *               directional efficiency.
 *   agree     — whether M15, H1 and H4 point the same way.
 *
 * Point-in-time rules are unchanged and load-bearing: an H1/H4 bar is visible
 * only once it has CLOSED at or before the decision bar, and the whole basket is
 * read at one shared lagged H1 index so no pair contributes a bar the others
 * could not have seen.
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
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const BASKET = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "AUD_USD",
                "NZD_USD", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP"] as const;
const CCY = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
const LOOKBACKS = [1, 3, 6, 12, 24] as const;
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "v3-features.csv");
const M15_WINDOW = 220;

type C = { t: number; o: number; h: number; l: number; c: number };
async function candles(inst: string, tf: string): Promise<C[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`, [inst, tf]);
  return r.rows.map((x) => ({ t: Date.parse(x.close_time as string), o: Number(x.open), h: Number(x.high), l: Number(x.low), c: Number(x.close) }));
}

console.log("loading...");
const m15: Record<string, C[]> = {}; const h1: Record<string, C[]> = {}; const h4: Record<string, C[]> = {};
for (const p of PAIRS) [m15[p], h1[p], h4[p]] = await Promise.all([candles(p, "M15"), candles(p, "H1"), candles(p, "H4")]);
const bH1: Record<string, C[]> = {};
for (const p of BASKET) bH1[p] = h1[p] ?? await candles(p, "H1");
const bIdx: Record<string, Map<number, number>> = {};
for (const p of BASKET) { const m = new Map<number, number>(); bH1[p]!.forEach((c, i) => m.set(c.t, i)); bIdx[p] = m; }
const H1T = [...new Set(BASKET.flatMap((p) => bH1[p]!.map((c) => c.t)))].sort((a, b) => a - b);
console.log("basket H1 timestamps: " + H1T.length);

// ---- currency strength per H1 timestamp, all lookbacks + ranks --------------
type Strength = { s: Record<string, Record<number, number>>; rank: Record<string, number>; rank6: Record<string, number>; vadj: Record<string, number>; ok: boolean };
const STR = new Map<number, Strength>();
for (const t of H1T) {
  const s: Record<string, Record<number, number>> = {};
  for (const c of CCY) s[c] = {};
  let ok = true;
  for (const L of LOOKBACKS) {
    const sum: Record<string, number> = {}; const cnt: Record<string, number> = {};
    for (const c of CCY) { sum[c] = 0; cnt[c] = 0; }
    let present = 0;
    for (const p of BASKET) {
      const i = bIdx[p]!.get(t); if (i === undefined || i < L) continue;
      const a = bH1[p]![i - L]!.c; const b = bH1[p]![i]!.c;
      if (!(a > 0) || !(b > 0)) continue;
      const r = Math.log(b / a);
      sum[p.slice(0, 3)]! += r; cnt[p.slice(0, 3)]! += 1;
      sum[p.slice(4)]! -= r; cnt[p.slice(4)]! += 1; present += 1;
    }
    if (present < 8) { ok = false; break; }
    for (const c of CCY) s[c]![L] = cnt[c]! > 0 ? sum[c]! / cnt[c]! : 0;
  }
  if (!ok) { STR.set(t, { s, rank: {}, rank6: {}, vadj: {}, ok: false }); continue; }
  // Volatility-adjusted: divide by the cross-sectional dispersion at this instant,
  // so "strong" means strong relative to how spread out the currencies are now.
  const v6 = CCY.map((c) => s[c]![6]!);
  const mu = v6.reduce((a, b) => a + b, 0) / v6.length;
  const sd = Math.sqrt(v6.reduce((a, b) => a + (b - mu) ** 2, 0) / v6.length) || 1e-9;
  const vadj: Record<string, number> = {};
  for (const c of CCY) vadj[c] = (s[c]![6]! - mu) / sd;
  const order = [...CCY].sort((a, b) => s[b]![6]! - s[a]![6]!);
  const rank: Record<string, number> = {};
  order.forEach((c, i) => { rank[c] = i; });
  const order24 = [...CCY].sort((a, b) => s[b]![24]! - s[a]![24]!);
  const rank6: Record<string, number> = {};
  order24.forEach((c, i) => { rank6[c] = i; });
  STR.set(t, { s, rank, rank6, vadj, ok: true });
}
console.log("strength computed");

// ---- deterministic structure, precomputed per higher-timeframe bar ----------
function structureAt(arr: C[], i: number, prefix: string): Record<string, number> {
  const win = arr.slice(Math.max(0, i - 119), i + 1);
  if (win.length < 60) return {};
  const atr = calculateAtrValues(win.map((x) => ({ time: "", open: x.o, high: x.h, low: x.l, close: x.c, volume: 0, complete: true })) as never, 14).at(-1) ?? 0;
  if (!(atr > 0)) return {};
  const last = win.at(-1)!;
  // fractal swings: an extreme that beats two neighbours on each side
  const hs: number[] = []; const ls: number[] = [];
  for (let k = 2; k < win.length - 2; k += 1) {
    let up = true; let dn = true;
    for (let j = k - 2; j <= k + 2; j += 1) {
      if (j === k) continue;
      if (win[j]!.h >= win[k]!.h) up = false;
      if (win[j]!.l <= win[k]!.l) dn = false;
    }
    if (up) hs.push(k); if (dn) ls.push(k);
  }
  const lastH = hs.length ? win[hs.at(-1)!]!.h : last.h;
  const prevH = hs.length > 1 ? win[hs.at(-2)!]!.h : lastH;
  const lastL = ls.length ? win[ls.at(-1)!]!.l : last.l;
  const prevL = ls.length > 1 ? win[ls.at(-2)!]!.l : lastL;
  const n = Math.min(48, win.length);
  const seg = win.slice(-n).map((x) => x.c);
  const mx = (n - 1) / 2; const my = seg.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0;
  seg.forEach((v, k) => { sxy += (k - mx) * (v - my); sxx += (k - mx) ** 2; });
  const slope = sxx > 0 ? sxy / sxx / atr : 0;
  const gross = seg.slice(1).reduce((a, c, k) => a + Math.abs(c - seg[k]!), 0);
  return {
    [prefix + "HH"]: lastH > prevH ? 1 : 0, [prefix + "HL"]: lastL > prevL ? 1 : 0,
    [prefix + "LH"]: lastH < prevH ? 1 : 0, [prefix + "LL"]: lastL < prevL ? 1 : 0,
    [prefix + "DistSwingHigh"]: (lastH - last.c) / atr,
    [prefix + "DistSwingLow"]: (last.c - lastL) / atr,
    [prefix + "BreakUp"]: last.c > lastH ? 1 : 0, [prefix + "BreakDown"]: last.c < lastL ? 1 : 0,
    [prefix + "Slope"]: slope,
    [prefix + "Eff"]: gross > 0 ? (seg.at(-1)! - seg[0]!) / gross : 0,
  };
}

const stream = createWriteStream(OUT);
let header: string[] | null = null; let written = 0;

for (const pair of PAIRS) {
  const M = m15[pair]!;
  const base = pair.slice(0, 3); const quote = pair.slice(4);
  const structH1 = new Map<number, Record<string, number>>();
  const structH4 = new Map<number, Record<string, number>>();
  let c1 = 0; let c4 = 0; let hs = 0;

  for (let i = M15_WINDOW; i < M.length; i += 1) {
    const t = M[i]!.t;
    if (t < REPLAY_START) continue;
    while (c1 + 1 < h1[pair]!.length && h1[pair]![c1 + 1]!.t <= t) c1 += 1;
    while (c4 + 1 < h4[pair]!.length && h4[pair]![c4 + 1]!.t <= t) c4 += 1;
    while (hs + 1 < H1T.length && H1T[hs + 1]! <= t) hs += 1;
    if (c1 < 120 || c4 < 60) continue;
    const st = STR.get(H1T[hs]!);
    if (!st || !st.ok) continue;

    if (!structH1.has(c1)) structH1.set(c1, structureAt(h1[pair]!, c1, "h1"));
    if (!structH4.has(c4)) structH4.set(c4, structureAt(h4[pair]!, c4, "h4"));
    const s1 = structH1.get(c1)!; const s4 = structH4.get(c4)!;
    if (!Object.keys(s1).length || !Object.keys(s4).length) continue;

    // M15 short-horizon direction for the agreement features
    const atrM = calculateAtrValues(M.slice(i - 60, i + 1).map((x) => ({ time: "", open: x.o, high: x.h, low: x.l, close: x.c, volume: 0, complete: true })) as never, 14).at(-1) ?? 0;
    if (!(atrM > 0)) continue;
    const m15Dir = Math.sign(M[i]!.c - M[i - 6]!.c);
    const h1Dir = Math.sign(s1.h1Slope!);
    const h4Dir = Math.sign(s4.h4Slope!);

    const row: Record<string, number | string> = { pair, ts: new Date(t).toISOString() };
    for (const L of LOOKBACKS) {
      row["strBase" + L] = st.s[base]![L]!;
      row["strQuote" + L] = st.s[quote]![L]!;
      row["strDiff" + L] = st.s[base]![L]! - st.s[quote]![L]!;
    }
    row.strVadjDiff = st.vadj[base]! - st.vadj[quote]!;
    row.strRankBase = st.rank[base]!; row.strRankQuote = st.rank[quote]!;
    row.strRankDiff = st.rank[quote]! - st.rank[base]!;          // positive favours base
    row.strRankChangeDiff = (st.rank6[quote]! - st.rank6[base]!) - (st.rank[quote]! - st.rank[base]!);
    row.strAccelDiff = (st.s[base]![6]! - st.s[quote]![6]!) - ((st.s[base]![12]! - st.s[quote]![12]!) - (st.s[base]![6]! - st.s[quote]![6]!));
    Object.assign(row, s1, s4);
    row.agreeM15H1 = m15Dir === h1Dir ? 1 : 0;
    row.agreeM15H4 = m15Dir === h4Dir ? 1 : 0;
    row.agreeH1H4 = h1Dir === h4Dir ? 1 : 0;
    row.agreeAll = (m15Dir === h1Dir && h1Dir === h4Dir) ? m15Dir : 0;

    if (!header) { header = Object.keys(row); stream.write(header.join(",") + "\n"); }
    stream.write(header.map((k) => { const v = row[k]; return typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(6) : "0") : v; }).join(",") + "\n");
    written += 1;
    if (written % 50000 === 0) console.log("  rows " + written);
  }
  console.log(pair + " done, total " + written);
}
await new Promise<void>((res, rej) => { stream.on("finish", () => res()); stream.on("error", rej); stream.end(); });
console.log("wrote " + written + " rows to " + path.resolve(OUT));
process.exit(0);
