/**
 * PRE-NEWS FOREX TEST V2  —  TEST #1  (frozen rules, 2026-09-17)
 * =============================================================
 * PRIMARY question: BEFORE a scheduled event, can we flag which events will
 * produce a BIG forex move? -> MOVE_SCORE (0..100), direction-agnostic.
 * SECONDARY question: if a big move is likely, which way? -> DIRECTION_SCORE
 * (-100..+100). Direction NEVER feeds MOVE_SCORE.
 *
 * Pairs: popular majors only — EURUSD GBPUSD USDJPY USDCAD AUDUSD NZDUSD USDCHF.
 * A pair is tested only when the event affects one of its two currencies; USD
 * events map to all seven.
 *
 * STRICT NO-LOOKAHEAD: for event T only M1 candles that CLOSE at/before T are
 * used (time+60s <= T). No Actual values. Post-news candles read only in the
 * post-news phase, after MOVE_SCORE and DIRECTION_SCORE are frozen.
 *
 * All weights/thresholds are FROZEN in the FROZEN block. Do not retune after
 * seeing outcomes. Appends one row per (event,pair) to
 *   research-output/pre-news-forex-test-v2.csv   (forward dataset)
 */
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

// =====================  FROZEN V2 CONSTANTS  =====================
const FROZEN = {
  // ---- MOVE_SCORE component weights (sum = 100) ----
  W_IMPORTANCE: 25,
  W_EVENTTYPE: 15,
  W_SIMULTANEOUS: 10,
  W_ACTIVITY: 15,
  W_EXTENSION: 15,
  W_COMPRESSION: 10,
  W_SRCOMP: 10,
  // ---- importance -> [0,1] ----
  IMPORTANCE: { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.25 } as Record<string, number>,
  // ---- event-type volatility propensity -> [0,1] ----
  TYPE_VOL: { CENTRAL_BANK: 1.0, EMPLOYMENT: 0.9, INFLATION: 0.8, GDP: 0.8,
    MANUFACTURING: 0.6, TRADE: 0.5, CONSUMER: 0.5, HOUSING: 0.4, OTHER: 0.3 } as Record<string, number>,
  SIMULT_CAP: 4,                 // simultaneous count normalized by this
  ACTIVITY_RECENT_MIN: 60,
  ACTIVITY_BASELINE_MIN: 480,    // 8h baseline
  ATR_PERIOD: 14,
  EXTENSION_SAT: 2.0,            // extension norm that saturates the component
  SRCOMP_ATR_SPAN: 40,          // S/R range in ATRs at/below which "trapped" ramps up
  SPREAD_ELEVATED_MULT: 1.5,    // reporting only (not scored)
  SPREAD_EXTREME_MULT: 3.0,
  // ---- MOVE classes ----
  CLASS: [[0, 39, "LOW_MOVE_EXPECTED"], [40, 59, "MODERATE_MOVE_EXPECTED"],
    [60, 79, "BIG_MOVE_CANDIDATE"], [80, 100, "VERY_BIG_MOVE_CANDIDATE"]] as const,
  // ---- DIRECTION (secondary) — same blend as V1, output *100 ----
  D_W_FUND: 0.30, D_W_TREND: 0.20, D_W_RELSTR: 0.30, D_W_MOM: 0.20,
  D_MOM_NORM_PIPS: 15,
  D_UNKNOWN_BELOW: 0.20,        // |composite| below => UNKNOWN
  D_FUND_PCT_CLAMP: 0.30,
  D_SR_NEAR_PIPS: 5,            // S/R location tilt threshold
  D_SR_TILT: 0.10,             // conviction tilt when pressed against a level
  STRENGTH_WINDOWS_MIN: [15, 30, 60] as const,
  // ---- big-move thresholds (report all; never pick one after the fact) ----
  HIT_PIPS: [5, 10, 15, 20, 30, 40] as const,
  HEADLINE_HORIZON_MIN: 30,    // canonical horizon for HIT flags & grouping
};
// ================================================================

const OUT_DIR = path.resolve(__dirname, "../research-output");
const CSV = path.join(OUT_DIR, "pre-news-forex-test-v2.csv");
const JSON_OUT = path.join(OUT_DIR, "pre-news-forex-test-v2-2026-09-17.json");

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; volume: number; complete: boolean; mid: OHLC; bid: OHLC; ask: OHLC };
const ms = (iso: string) => Date.parse(iso.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
const pipSize = (i: string) => (i.includes("JPY") ? 0.01 : 0.0001);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, d = 1) => (x == null || Number.isNaN(x) ? NaN : Number(x.toFixed(d)));
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function ema(vals: number[], p: number): number[] { const k = 2 / (p + 1); const o: number[] = []; let pr = vals[0]!; for (let i = 0; i < vals.length; i++) { pr = i === 0 ? vals[0]! : vals[i]! * k + pr * (1 - k); o.push(pr); } return o; }
const preOnly = (cs: RC[], T: number) => cs.filter((c) => c.complete && ms(c.time) + 60_000 <= T);
function midCloseAt(cs: RC[], t: number): number | null { let b: RC | null = null; for (const c of cs) if (ms(c.time) <= t && (!b || ms(c.time) > ms(b.time))) b = c; return b ? b.mid.close : null; }

// ---------- events (forecast/previous only; impact + type per release) ----------
type Rel = { ccy: string; name: string; impact: "HIGH" | "MEDIUM" | "LOW"; type: keyof typeof FROZEN.TYPE_VOL;
  forecast?: number; previous?: number; polarity?: 1 | -1; weight?: number };
type Ev = { id: string; label: string; etTime: string; utc: string; releases: Rel[]; note?: string };
const U = (hhmm: string) => `2026-09-17T${hhmm}:00.000Z`;   // ET(EDT,-4)+4 = UTC
const MAJORS = ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"];
const CCY_TO_PAIR: Record<string, string> = { EUR: "EUR_USD", GBP: "GBP_USD", JPY: "USD_JPY", CAD: "USD_CAD", AUD: "AUD_USD", NZD: "NZD_USD", CHF: "USD_CHF" };

const EVENTS: Ev[] = [
  { id: "EUR_CPI", label: "EUR Final CPI / Core CPI y/y", etTime: "05:00", utc: U("09:00"), releases: [
    { ccy: "EUR", name: "Final Core CPI y/y", impact: "MEDIUM", type: "INFLATION", forecast: 2.4, previous: 2.4, polarity: 1, weight: 0.8 },
    { ccy: "EUR", name: "Final CPI y/y", impact: "MEDIUM", type: "INFLATION", forecast: 3.3, previous: 3.3, polarity: 1, weight: 0.8 },
  ] },
  { id: "GBP_BOE", label: "GBP BoE Rate / Votes / MPS", etTime: "07:00", utc: U("11:00"), releases: [
    { ccy: "GBP", name: "Official Bank Rate", impact: "HIGH", type: "CENTRAL_BANK", forecast: 3.75, previous: 3.75, polarity: 1, weight: 1.0 },
    { ccy: "GBP", name: "MPC Vote (hikes 3-0-6)", impact: "HIGH", type: "CENTRAL_BANK", forecast: 3, previous: 3, polarity: 1, weight: 0.6 },
    { ccy: "GBP", name: "Monetary Policy Summary", impact: "HIGH", type: "CENTRAL_BANK" },
  ] },
  { id: "USDCAD_830", label: "USD Philly/Claims/Permits/Starts + CAD IPPI/RMPI/NHPI/FSP", etTime: "08:30", utc: U("12:30"), releases: [
    { ccy: "USD", name: "Philly Fed Mfg", impact: "HIGH", type: "MANUFACTURING", forecast: 31.3, previous: 47.4, polarity: 1, weight: 1.0 },
    { ccy: "USD", name: "Unemployment Claims", impact: "HIGH", type: "EMPLOYMENT", forecast: 207, previous: 206, polarity: -1, weight: 0.8 },
    { ccy: "USD", name: "Building Permits", impact: "MEDIUM", type: "HOUSING", forecast: 1.40, previous: 1.43, polarity: 1, weight: 0.5 },
    { ccy: "USD", name: "Housing Starts", impact: "MEDIUM", type: "HOUSING", forecast: 1.32, previous: 1.31, polarity: 1, weight: 0.5 },
    { ccy: "CAD", name: "IPPI m/m", impact: "MEDIUM", type: "INFLATION" },
    { ccy: "CAD", name: "RMPI m/m", impact: "MEDIUM", type: "INFLATION" },
    { ccy: "CAD", name: "NHPI m/m", impact: "MEDIUM", type: "HOUSING" },
    { ccy: "CAD", name: "Foreign Securities Purchases", impact: "LOW", type: "TRADE" },
  ] },
  { id: "USD_PHS", label: "USD Pending Home Sales m/m", etTime: "10:00", utc: U("14:00"), releases: [
    { ccy: "USD", name: "Pending Home Sales m/m", impact: "MEDIUM", type: "HOUSING", forecast: -0.2, previous: -2.6, polarity: 1, weight: 0.4 },
  ] },
  { id: "AUD_CBLI", label: "AUD CB Leading Index m/m", etTime: "10:30", utc: U("14:30"), releases: [
    { ccy: "AUD", name: "CB Leading Index m/m", impact: "LOW", type: "OTHER" },
  ] },
  { id: "NZD_FPI_TB", label: "NZD FPI m/m / Trade Balance", etTime: "18:45", utc: U("22:45"), releases: [
    { ccy: "NZD", name: "FPI m/m", impact: "MEDIUM", type: "INFLATION" },
    { ccy: "NZD", name: "Trade Balance", impact: "MEDIUM", type: "TRADE" },
  ] },
  { id: "JPY_BOJ", label: "JPY BoJ Rate / MPS / National Core CPI", etTime: "19:30", utc: U("23:30"), releases: [
    { ccy: "JPY", name: "BoJ Policy Rate ceiling", impact: "HIGH", type: "CENTRAL_BANK", forecast: 1.25, previous: 1.00, polarity: 1, weight: 1.0 },
    { ccy: "JPY", name: "Monetary Policy Statement", impact: "HIGH", type: "CENTRAL_BANK" },
    { ccy: "JPY", name: "National Core CPI y/y", impact: "HIGH", type: "INFLATION", forecast: 1.8, previous: 1.8, polarity: 1, weight: 0.7 },
  ] },
];

// pair -> which currencies of this event affect it (for simultaneous count + impact/type)
function relsForPair(ev: Ev, pair: string): Rel[] {
  const base = pair.slice(0, 3), quote = pair.slice(4, 7);
  return ev.releases.filter((r) => r.ccy === base || r.ccy === quote);
}
// which pairs to test for an event: each affected currency -> its major; USD -> all majors
function pairsForEvent(ev: Ev): string[] {
  const ccys = new Set(ev.releases.map((r) => r.ccy));
  const set = new Set<string>();
  for (const c of ccys) { if (c === "USD") MAJORS.forEach((m) => set.add(m)); else if (CCY_TO_PAIR[c]) set.add(CCY_TO_PAIR[c]); }
  return [...set];
}

// ---------- currency strength (multi-cross, direction only) ----------
const STRENGTH_CROSSES: Record<string, string[]> = {
  EUR: ["EUR_USD", "EUR_GBP", "EUR_JPY", "EUR_CHF"],
  GBP: ["GBP_USD", "EUR_GBP", "GBP_JPY", "GBP_CHF"],
  USD: ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"],
  CAD: ["USD_CAD", "CAD_JPY", "EUR_CAD", "GBP_CAD", "AUD_CAD"],
  AUD: ["AUD_USD", "AUD_JPY", "EUR_AUD", "GBP_AUD", "AUD_CAD"],
  NZD: ["NZD_USD", "NZD_JPY", "EUR_NZD", "GBP_NZD", "AUD_NZD"],
  JPY: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "NZD_JPY", "CAD_JPY"],
  CHF: ["USD_CHF", "EUR_CHF", "GBP_CHF"],
};
function currencyStrength(ccy: string, data: Map<string, RC[]>, T: number): number {
  const crosses = STRENGTH_CROSSES[ccy] ?? []; const perW: number[] = [];
  for (const w of FROZEN.STRENGTH_WINDOWS_MIN) {
    const parts: number[] = [];
    for (const cross of crosses) {
      const cs = data.get(cross); if (!cs) continue;
      const now = midCloseAt(cs, T - 60_000), then = midCloseAt(cs, T - 60_000 - w * 60_000);
      if (now == null || then == null || then === 0) continue;
      const orient = cross.startsWith(ccy + "_") ? 1 : cross.endsWith("_" + ccy) ? -1 : 0;
      if (orient) parts.push(((now - then) / then) * orient);
    }
    if (parts.length) perW.push(mean(parts));
  }
  if (!perW.length) return 0;
  return clamp(mean(perW) / 0.0015, -1, 1);
}

function fundamentalScore(ccy: string, rels: Rel[]): number {
  const rel = rels.filter((r) => r.ccy === ccy && r.forecast != null && r.previous != null);
  if (!rel.length) return 0;
  let num = 0, den = 0;
  for (const r of rel) {
    const w = r.weight ?? 0.5;
    if (r.forecast === r.previous) { den += w; continue; }
    const pct = clamp((r.forecast! - r.previous!) / Math.abs(r.previous! || 1e-9), -FROZEN.D_FUND_PCT_CLAMP, FROZEN.D_FUND_PCT_CLAMP);
    num += w * (r.polarity ?? 1) * pct; den += w;
  }
  return den === 0 ? 0 : clamp((num / den) / FROZEN.D_FUND_PCT_CLAMP, -1, 1);
}

function trendScore(pre: RC[]): number {
  if (pre.length < 55) return 0;
  const closes = pre.map((c) => c.mid.close); const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const n = closes.length, price = closes[n - 1]!; let s = 0;
  s += sign(e20[n - 1]! - e20[n - 11]!) * 0.25;
  s += sign(e50[n - 1]! - e50[n - 11]!) * 0.20;
  s += sign(price - e20[n - 1]!) * 0.15;
  s += sign(price - e50[n - 1]!) * 0.15;
  const recent = pre.slice(n - 20, n), prior = pre.slice(n - 40, n - 20);
  if (prior.length && recent.length) {
    const rh = Math.max(...recent.map((c) => c.mid.high)), ph = Math.max(...prior.map((c) => c.mid.high));
    const rl = Math.min(...recent.map((c) => c.mid.low)), pl = Math.min(...prior.map((c) => c.mid.low));
    if (rh > ph && rl > pl) s += 0.25; else if (rh < ph && rl < pl) s -= 0.25;
    else if (rh > ph || rl > pl) s += 0.10; else if (rh < ph || rl < pl) s -= 0.10;
  }
  return clamp(s, -1, 1);
}

// ---------- baseline vol / extension / compression ----------
function volFeatures(pre: RC[], inst: string, T: number) {
  const ps = pipSize(inst);
  const rng = (c: RC) => (c.mid.high - c.mid.low) / ps;
  const recent = mean(pre.slice(-FROZEN.ACTIVITY_RECENT_MIN).map(rng));
  const baseArr = pre.filter((c) => ms(c.time) <= T - 60 * 60_000).slice(-FROZEN.ACTIVITY_BASELINE_MIN);
  const baselineAvg = mean(baseArr.map(rng));
  const activityRatio = baselineAvg ? recent / baselineAvg : NaN;
  // ATR14 (M1, mid) in pips
  let atr = NaN;
  if (pre.length > FROZEN.ATR_PERIOD) {
    const trs: number[] = [];
    for (let i = 1; i < pre.length; i++) { const c = pre[i]!.mid, p = pre[i - 1]!.mid; trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))); }
    atr = mean(trs.slice(-FROZEN.ATR_PERIOD)) / ps;
  }
  // normal xM displacement & range medians from baseline (rolling)
  const bc = baseArr;
  const normDisp: Record<number, number> = {}, normRange: Record<number, number> = {};
  for (const x of [15, 30, 60]) {
    const disp: number[] = [], rr: number[] = [];
    for (let i = x; i < bc.length; i++) {
      disp.push(Math.abs(bc[i]!.mid.close - bc[i - x]!.mid.close) / ps);
      const seg = bc.slice(i - x, i + 1);
      rr.push((Math.max(...seg.map((c) => c.mid.high)) - Math.min(...seg.map((c) => c.mid.low))) / ps);
    }
    normDisp[x] = median(disp); normRange[x] = median(rr);
  }
  // current xM displacement (extension) & range (compression)
  const preN = (x: number) => {
    const ref = midCloseAt(pre, T - 60_000), past = midCloseAt(pre, T - 60_000 - x * 60_000);
    return ref != null && past != null ? (ref - past) / ps : NaN;
  };
  const curRange = (x: number) => { const seg = pre.slice(-x); return seg.length ? (Math.max(...seg.map((c) => c.mid.high)) - Math.min(...seg.map((c) => c.mid.low))) / ps : NaN; };
  const pre5 = preN(5), pre15 = preN(15), pre30 = preN(30), pre60 = preN(60);
  const extN = (x: number, v: number) => (normDisp[x] ? Math.abs(v) / normDisp[x] : NaN);
  const pre15atr = extN(15, pre15), pre30atr = extN(30, pre30), pre60atr = extN(60, pre60);
  // compression: current range / normal range, averaged; compressed when <1
  const compRatios = [15, 30, 60].map((x) => (normRange[x] ? curRange(x) / normRange[x] : NaN)).filter((v) => Number.isFinite(v));
  const compRatio = mean(compRatios);
  const compressionScore = Number.isFinite(compRatio) ? clamp(1 - compRatio, 0, 1) : 0; // 0..1
  return { activityRatio, atr, baselineAvg, recent,
    pre5, pre15, pre30, pre60, pre15atr, pre30atr, pre60atr,
    curRange15: curRange(15), curRange30: curRange(30), curRange60: curRange(60),
    normRange, compRatio, compressionScore };
}

async function srFeatures(pre: RC[], inst: string, atrPips: number) {
  const { computeSupportResistanceLevels } = await import("../src/lib/strategy/support-resistance");
  const candles = pre.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: true }));
  const lv = computeSupportResistanceLevels(candles as any, inst as any);
  const ps = pipSize(inst);
  if (!lv) return { support: null, resistance: null, distSupport: NaN, distResistance: NaN, srRangePips: NaN, srCompScore: 0 };
  const cur = lv.current;
  const res = Math.min(...[lv.rangeHigh, lv.swingHigh].filter((x): x is number => x != null && x > cur));
  const sup = Math.max(...[lv.rangeLow, lv.swingLow].filter((x): x is number => x != null && x < cur));
  const distR = Number.isFinite(res) ? (res - cur) / ps : NaN, distS = Number.isFinite(sup) ? (cur - sup) / ps : NaN;
  const srRange = Number.isFinite(res) && Number.isFinite(sup) ? (res - sup) / ps : NaN;
  const srRangeAtr = srRange / (atrPips || 1);
  const srCompScore = Number.isFinite(srRangeAtr) ? clamp((FROZEN.SRCOMP_ATR_SPAN - srRangeAtr) / FROZEN.SRCOMP_ATR_SPAN, 0, 1) : 0;
  return { support: Number.isFinite(sup) ? sup : null, resistance: Number.isFinite(res) ? res : null, distSupport: distS, distResistance: distR, srRangePips: srRange, srCompScore };
}

function spreadInfo(pre: RC[], inst: string) {
  const ps = pipSize(inst); const sp = (c: RC) => (c.ask.close - c.bid.close) / ps;
  const cur = pre.at(-1) ? sp(pre.at(-1)!) : NaN;
  const a5 = mean(pre.slice(-5).map(sp)), a15 = mean(pre.slice(-15).map(sp));
  const baseMed = median(pre.slice(-FROZEN.ACTIVITY_BASELINE_MIN).map(sp));
  const cls = baseMed && cur >= baseMed * FROZEN.SPREAD_EXTREME_MULT ? "EXTREME" : baseMed && cur >= baseMed * FROZEN.SPREAD_ELEVATED_MULT ? "ELEVATED" : "NORMAL";
  return { current: cur, avg5: a5, avg15: a15, baselineMedian: baseMed, cls };
}

// ---------- post-news ----------
function postNews(cs: RC[], T: number, inst: string) {
  const ps = pipSize(inst); const ref = midCloseAt(cs, T - 60_000);
  const out: Record<string, any> = {};
  for (const h of [1, 3, 5, 10, 15, 30, 60]) {
    const at = midCloseAt(cs, T + h * 60_000);
    const win = cs.filter((c) => ms(c.time) > T && ms(c.time) <= T + h * 60_000);
    const net = ref != null && at != null ? (at - ref) / ps : NaN;
    const up = ref != null && win.length ? (Math.max(...win.map((c) => c.mid.high)) - ref) / ps : NaN;
    const dn = ref != null && win.length ? (ref - Math.min(...win.map((c) => c.mid.low))) / ps : NaN;
    const maxUp = Math.max(0, up), maxDn = Math.max(0, dn);
    out[`${h}m`] = { net, mfeUp: maxUp, mfeDown: maxDn, maxAbs: Math.max(maxUp, maxDn) };
  }
  return { ref, ...out };
}
const moveClass = (s: number) => (FROZEN.CLASS.find(([lo, hi]) => s >= (lo as number) && s <= (hi as number))?.[2] ?? "LOW_MOVE_EXPECTED");

async function fetchAll(insts: string[]) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const map = new Map<string, RC[]>();
  for (const inst of insts) {
    const batch: RC[] = await getResearchCandles(inst, "M1", 2880, { to: "2026-09-18T02:00:00.000Z" });
    map.set(inst, batch.filter((c) => c.complete).sort((a, b) => ms(a.time) - ms(b.time)));
    process.stderr.write(`fetched ${inst}: ${map.get(inst)!.length}\n`);
  }
  return map;
}

async function main() {
  const insts = Array.from(new Set([...MAJORS, ...Object.values(STRENGTH_CROSSES).flat()]));
  const data = await fetchAll(insts);
  const rows: any[] = []; const detail: any[] = [];

  for (const ev of EVENTS) {
    const T = ms(ev.utc);
    for (const pair of pairsForEvent(ev)) {
      const cs = data.get(pair)!; const pre = preOnly(cs, T);
      const base = pair.slice(0, 3), quote = pair.slice(4, 7);
      const rels = relsForPair(ev, pair);
      const simultaneous = rels.length;
      const importance = rels.reduce((m, r) => Math.max(m, FROZEN.IMPORTANCE[r.impact]!), 0);
      const impactLabel = rels.some((r) => r.impact === "HIGH") ? "HIGH" : rels.some((r) => r.impact === "MEDIUM") ? "MEDIUM" : "LOW";
      const typeVol = rels.reduce((m, r) => Math.max(m, FROZEN.TYPE_VOL[r.type]!), 0);
      const primaryType = rels.slice().sort((a, b) => FROZEN.TYPE_VOL[b.type]! - FROZEN.TYPE_VOL[a.type]!)[0]?.type ?? "OTHER";

      const v = volFeatures(pre, pair, T);
      const sr = await srFeatures(pre, pair, v.atr);
      const spr = spreadInfo(pre, pair);

      // ---- MOVE_SCORE (direction-agnostic) ----
      const cImp = importance;                                   // 0..1
      const cType = typeVol;                                     // 0..1
      const cSim = clamp(simultaneous / FROZEN.SIMULT_CAP, 0, 1);
      const cAct = Number.isFinite(v.activityRatio) ? clamp((v.activityRatio - 0.5) / 1.5, 0, 1) : 0;
      const extMax = Math.max(v.pre15atr || 0, v.pre30atr || 0, v.pre60atr || 0);
      const cExt = clamp(extMax / FROZEN.EXTENSION_SAT, 0, 1);
      const cComp = v.compressionScore;                          // 0..1
      const cSr = sr.srCompScore;                                // 0..1
      const moveScore = Math.round(
        FROZEN.W_IMPORTANCE * cImp + FROZEN.W_EVENTTYPE * cType + FROZEN.W_SIMULTANEOUS * cSim +
        FROZEN.W_ACTIVITY * cAct + FROZEN.W_EXTENSION * cExt + FROZEN.W_COMPRESSION * cComp + FROZEN.W_SRCOMP * cSr);
      const mClass = moveClass(moveScore);

      // ---- DIRECTION_SCORE (secondary, independent) ----
      const fBase = fundamentalScore(base, rels), fQuote = fundamentalScore(quote, rels);
      const fundPair = clamp(fBase - fQuote, -1, 1);
      const trend = trendScore(pre);
      const sBase = currencyStrength(base, data, T), sQuote = currencyStrength(quote, data, T);
      const relStr = clamp(sBase - sQuote, -2, 2);
      const momScore = clamp((v.pre30 || 0) / FROZEN.D_MOM_NORM_PIPS, -1, 1);
      let dComposite = FROZEN.D_W_FUND * fundPair + FROZEN.D_W_TREND * trend + FROZEN.D_W_RELSTR * (relStr / 2) + FROZEN.D_W_MOM * momScore;
      // S/R location tilt
      if (Number.isFinite(sr.distResistance) && sr.distResistance < FROZEN.D_SR_NEAR_PIPS) dComposite -= FROZEN.D_SR_TILT;
      if (Number.isFinite(sr.distSupport) && sr.distSupport < FROZEN.D_SR_NEAR_PIPS) dComposite += FROZEN.D_SR_TILT;
      dComposite = clamp(dComposite, -1, 1);
      const direction = Math.abs(dComposite) < FROZEN.D_UNKNOWN_BELOW ? "UNKNOWN" : dComposite > 0 ? "LONG" : "SHORT";
      const directionScore = Math.round(dComposite * 100);

      // ---- FREEZE done. Reveal post-news. ----
      const post = postNews(cs, T, pair);
      const hz = FROZEN.HEADLINE_HORIZON_MIN;
      const headMax = post[`${hz}m`].maxAbs;
      const hits: Record<string, number> = {};
      for (const p of FROZEN.HIT_PIPS) hits[`hit${p}`] = Number.isFinite(headMax) && headMax >= p ? 1 : 0;
      const dirCorr = (h: string) => { if (direction === "UNKNOWN") return ""; const net = post[h].net; if (!Number.isFinite(net)) return "NA"; return (direction === "LONG" ? net > 0 : net < 0) ? "Y" : "N"; };

      const rec = {
        date: "2026-09-17", event: ev.id, label: ev.label, timeET: ev.etTime, utc: ev.utc,
        currency: [...new Set(rels.map((r) => r.ccy))].join("+"), pair, impact: impactLabel,
        eventType: primaryType, simultaneous,
        pre5: round(v.pre5), pre15: round(v.pre15), pre30: round(v.pre30), pre60: round(v.pre60),
        pre15atr: round(v.pre15atr, 2), pre30atr: round(v.pre30atr, 2), pre60atr: round(v.pre60atr, 2),
        activityRatio: round(v.activityRatio, 2), atrPipsM1: round(v.atr, 2),
        compressionScore: round(v.compressionScore * 100), compRatio: round(v.compRatio, 2),
        srSupport: sr.support, srResistance: sr.resistance, srRangePips: round(sr.srRangePips), srCompression: round(sr.srCompScore * 100),
        distSupport: round(sr.distSupport), distResistance: round(sr.distResistance),
        spreadCur: round(spr.current, 2), spreadAvg5: round(spr.avg5, 2), spreadAvg15: round(spr.avg15, 2), spreadBaseMed: round(spr.baselineMedian, 2), spreadClass: spr.cls,
        // move-score breakdown (transparency)
        c_imp: round(cImp, 2), c_type: round(cType, 2), c_sim: round(cSim, 2), c_act: round(cAct, 2), c_ext: round(cExt, 2), c_comp: round(cComp, 2), c_sr: round(cSr, 2),
        moveScore, moveClass: mClass,
        fundPair: round(fundPair, 2), trendScore: round(trend, 2), relStrength: round(relStr, 2), momScore: round(momScore, 2),
        direction, directionScore,
        post5net: round(post["5m"].net), post5max: round(post["5m"].maxAbs),
        post15net: round(post["15m"].net), post15max: round(post["15m"].maxAbs),
        post30net: round(post["30m"].net), post30max: round(post["30m"].maxAbs),
        post60net: round(post["60m"].net), post60max: round(post["60m"].maxAbs),
        mfeUp30: round(post["30m"].mfeUp), mfeDown30: round(post["30m"].mfeDown),
        ...hits,
        dir5: dirCorr("5m"), dir15: dirCorr("15m"), dir30: dirCorr("30m"), dir60: dirCorr("60m"),
        preCandles: pre.length, lastPreCandle: pre.at(-1)?.time ?? null,
      };
      rows.push(rec); detail.push({ ...rec, postFull: post });
    }
  }

  // ---- write CSV + JSON ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cols = Object.keys(rows[0]!); const esc = (x: any) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, cols.join(",") + "\n");
  fs.appendFileSync(CSV, rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n") + "\n");
  fs.writeFileSync(JSON_OUT, JSON.stringify({ frozen: FROZEN, rows: detail }, null, 2));

  // ---- print table ----
  const P = (s: any, w: number) => String(s ?? "").padEnd(w).slice(0, w);
  const Rj = (s: any, w: number) => String(s ?? "").padStart(w);
  console.log("\n===== PRE-NEWS FOREX TEST V2 #1 — 2026-09-17 (frozen) =====\n");
  const head = [P("EVENT", 11), P("ET", 5), P("PAIR", 8), P("IMP", 4), P("TYPE", 12), Rj("SIM", 3),
    Rj("p30atr", 6), Rj("act", 4), Rj("cmp", 4), Rj("srC", 4), Rj("MOVE", 4), P("MOVECLASS", 22), P("DIR", 8), Rj("DSC", 5),
    Rj("30max", 6), Rj("60max", 6), P("hits@30(10/15/20/30/40)", 24)].join(" ");
  console.log(head); console.log("-".repeat(head.length));
  for (const r of rows) {
    console.log([P(r.event, 11), P(r.timeET, 5), P(r.pair, 8), P(r.impact, 4), P(r.eventType, 12), Rj(r.simultaneous, 3),
      Rj(r.pre30atr, 6), Rj(r.activityRatio, 4), Rj(r.compressionScore, 4), Rj(r.srCompression, 4), Rj(r.moveScore, 4), P(r.moveClass, 22), P(r.direction, 8), Rj(r.directionScore, 5),
      Rj(r.post30max, 6), Rj(r.post60max, 6), P(`${r.hit10}/${r.hit15}/${r.hit20}/${r.hit30}/${r.hit40}`, 24)].join(" "));
  }

  // ---- MOVE_SCORE group analysis ----
  const groups: [number, number, string][] = [[0, 39, "0-39 LOW"], [40, 59, "40-59 MOD"], [60, 79, "60-79 BIG"], [80, 100, "80-100 VBIG"]];
  console.log("\n----- MOVE_SCORE groups vs actual MAX move (pips) -----");
  console.log("group          n   avg5max avg15max avg30max avg60max  med30max  %10 %15 %20 %30 %40");
  for (const [lo, hi, name] of groups) {
    const g = rows.filter((r) => r.moveScore >= lo && r.moveScore <= hi);
    if (!g.length) { console.log(`${name.padEnd(14)} 0`); continue; }
    const pc = (k: string) => Math.round(100 * mean(g.map((r) => r[k])));
    console.log([name.padEnd(14), String(g.length).padStart(2),
      round(mean(g.map((r) => r.post5max))).toString().padStart(7), round(mean(g.map((r) => r.post15max))).toString().padStart(8),
      round(mean(g.map((r) => r.post30max))).toString().padStart(8), round(mean(g.map((r) => r.post60max))).toString().padStart(8),
      round(median(g.map((r) => r.post30max))).toString().padStart(9),
      String(pc("hit10")).padStart(4), String(pc("hit15")).padStart(4), String(pc("hit20")).padStart(4), String(pc("hit30")).padStart(4), String(pc("hit40")).padStart(4)].join(" "));
  }

  // ---- HIGH vs MEDIUM impact ----
  console.log("\n----- impact: avg 30m MAX move -----");
  for (const imp of ["HIGH", "MEDIUM", "LOW"]) {
    const g = rows.filter((r) => r.impact === imp); if (!g.length) continue;
    console.log(`${imp.padEnd(7)} n=${g.length}  avg30max=${round(mean(g.map((r) => r.post30max)))}  med30max=${round(median(g.map((r) => r.post30max)))}`);
  }

  // ---- simultaneous count ----
  console.log("\n----- simultaneous releases vs avg 30m MAX -----");
  const bySim = new Map<number, any[]>(); rows.forEach((r) => { const k = r.simultaneous; bySim.set(k, [...(bySim.get(k) ?? []), r]); });
  [...bySim.keys()].sort((a, b) => a - b).forEach((k) => { const g = bySim.get(k)!; console.log(`sim=${k}  n=${g.length}  avg30max=${round(mean(g.map((r) => r.post30max)))}`); });

  // ---- extension buckets: continuation vs reversal ----
  console.log("\n----- pre-30m extension (ATR) buckets: continuation vs reversal (30m net) -----");
  const buckets: [number, number, string][] = [[0, 0.5, "<0.5"], [0.5, 1.0, "0.5-1.0"], [1.0, 1.5, "1.0-1.5"], [1.5, 2.0, "1.5-2.0"], [2.0, 99, ">2.0"]];
  for (const [lo, hi, name] of buckets) {
    const g = rows.filter((r) => Number.isFinite(r.pre30atr) && r.pre30atr >= lo && r.pre30atr < hi && Math.abs(r.pre30) > 0.5);
    if (!g.length) { console.log(`${name.padEnd(8)} n=0`); continue; }
    const cont = g.filter((r) => sign(r.post30net) === sign(r.pre30) && sign(r.post30net) !== 0).length;
    const rev = g.filter((r) => sign(r.post30net) === -sign(r.pre30) && sign(r.post30net) !== 0).length;
    console.log(`${name.padEnd(8)} n=${g.length}  cont=${Math.round(100 * cont / g.length)}%  rev=${Math.round(100 * rev / g.length)}%  avg30max=${round(mean(g.map((r) => r.post30max)))}`);
  }

  // ---- direction accuracy (separate) ----
  console.log("\n----- DIRECTION accuracy (separate from MOVE_SCORE) -----");
  const dcalls = rows.filter((r) => r.direction !== "UNKNOWN");
  const acc = (h: string) => { const g = dcalls.filter((r) => r[h] === "Y" || r[h] === "N"); const w = g.filter((r) => r[h] === "Y").length; return g.length ? `${w}/${g.length}=${round(100 * w / g.length)}%` : "n/a"; };
  console.log(`calls=${dcalls.length} (LONG ${dcalls.filter((r) => r.direction === "LONG").length}, SHORT ${dcalls.filter((r) => r.direction === "SHORT").length}, UNKNOWN ${rows.length - dcalls.length})`);
  console.log(`5m ${acc("dir5")}  15m ${acc("dir15")}  30m ${acc("dir30")}  60m ${acc("dir60")}`);

  // ---- pair with largest news moves ----
  console.log("\n----- pair vs avg 30m MAX -----");
  const byPair = new Map<string, any[]>(); rows.forEach((r) => byPair.set(r.pair, [...(byPair.get(r.pair) ?? []), r]));
  [...byPair.entries()].map(([p, g]) => [p, mean(g.map((r) => r.post30max)), g.length] as const).sort((a, b) => (b[1] as number) - (a[1] as number))
    .forEach(([p, m, n]) => console.log(`${p}  n=${n}  avg30max=${round(m as number)}`));

  console.log(`\nCSV: ${CSV}\nJSON: ${JSON_OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
