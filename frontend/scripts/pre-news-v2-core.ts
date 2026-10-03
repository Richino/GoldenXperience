/**
 * FROZEN V2 CORE — verbatim copy of the scoring logic in
 * scripts/pre-news-forex-test-v2.ts (constants, feature functions, MOVE_SCORE
 * and DIRECTION assembly). Extracted ONLY so the historical validation driver
 * can reuse the EXACT same math without re-running the live day-1 script.
 *
 * DO NOT change any formula, weight, threshold, normalization, or class cutoff
 * here. A regression check (scripts/_v2-core-regression.ts) asserts this core
 * reproduces the frozen day-1 CSV numbers byte-for-byte.
 */
export type OHLC = { open: number; high: number; low: number; close: number };
export type RC = { time: string; volume: number; complete: boolean; mid: OHLC; bid: OHLC; ask: OHLC };

export const FROZEN = {
  W_IMPORTANCE: 25, W_EVENTTYPE: 15, W_SIMULTANEOUS: 10, W_ACTIVITY: 15,
  W_EXTENSION: 15, W_COMPRESSION: 10, W_SRCOMP: 10,
  IMPORTANCE: { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.25 } as Record<string, number>,
  TYPE_VOL: { CENTRAL_BANK: 1.0, EMPLOYMENT: 0.9, INFLATION: 0.8, GDP: 0.8,
    MANUFACTURING: 0.6, TRADE: 0.5, CONSUMER: 0.5, HOUSING: 0.4, OTHER: 0.3 } as Record<string, number>,
  SIMULT_CAP: 4, ACTIVITY_RECENT_MIN: 60, ACTIVITY_BASELINE_MIN: 480, ATR_PERIOD: 14,
  EXTENSION_SAT: 2.0, SRCOMP_ATR_SPAN: 40, SPREAD_ELEVATED_MULT: 1.5, SPREAD_EXTREME_MULT: 3.0,
  CLASS: [[0, 39, "LOW_MOVE_EXPECTED"], [40, 59, "MODERATE_MOVE_EXPECTED"],
    [60, 79, "BIG_MOVE_CANDIDATE"], [80, 100, "VERY_BIG_MOVE_CANDIDATE"]] as const,
  D_W_FUND: 0.30, D_W_TREND: 0.20, D_W_RELSTR: 0.30, D_W_MOM: 0.20,
  D_MOM_NORM_PIPS: 15, D_UNKNOWN_BELOW: 0.20, D_FUND_PCT_CLAMP: 0.30,
  D_SR_NEAR_PIPS: 5, D_SR_TILT: 0.10, STRENGTH_WINDOWS_MIN: [15, 30, 60] as const,
  HIT_PIPS: [5, 10, 15, 20, 30, 40] as const, HEADLINE_HORIZON_MIN: 30,
};

export const ms = (iso: string) => Date.parse(iso.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
export const pipSize = (i: string) => (i.includes("JPY") ? 0.01 : 0.0001);
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const round = (x: number, d = 1) => (x == null || Number.isNaN(x) ? NaN : Number(x.toFixed(d)));
export const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export function ema(vals: number[], p: number): number[] { const k = 2 / (p + 1); const o: number[] = []; let pr = vals[0]!; for (let i = 0; i < vals.length; i++) { pr = i === 0 ? vals[0]! : vals[i]! * k + pr * (1 - k); o.push(pr); } return o; }
export const preOnly = (cs: RC[], T: number) => cs.filter((c) => c.complete && ms(c.time) + 60_000 <= T);
export function midCloseAt(cs: RC[], t: number): number | null { let b: RC | null = null; for (const c of cs) if (ms(c.time) <= t && (!b || ms(c.time) > ms(b.time))) b = c; return b ? b.mid.close : null; }

export const STRENGTH_CROSSES: Record<string, string[]> = {
  EUR: ["EUR_USD", "EUR_GBP", "EUR_JPY", "EUR_CHF"],
  GBP: ["GBP_USD", "EUR_GBP", "GBP_JPY", "GBP_CHF"],
  USD: ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"],
  CAD: ["USD_CAD", "CAD_JPY", "EUR_CAD", "GBP_CAD", "AUD_CAD"],
  AUD: ["AUD_USD", "AUD_JPY", "EUR_AUD", "GBP_AUD", "AUD_CAD"],
  NZD: ["NZD_USD", "NZD_JPY", "EUR_NZD", "GBP_NZD", "AUD_NZD"],
  JPY: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "NZD_JPY", "CAD_JPY"],
  CHF: ["USD_CHF", "EUR_CHF", "GBP_CHF"],
};
export function currencyStrength(ccy: string, data: Map<string, RC[]>, T: number): number {
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

export function trendScore(pre: RC[]): number {
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

export function volFeatures(pre: RC[], inst: string, T: number) {
  const ps = pipSize(inst);
  const rng = (c: RC) => (c.mid.high - c.mid.low) / ps;
  const recent = mean(pre.slice(-FROZEN.ACTIVITY_RECENT_MIN).map(rng));
  const baseArr = pre.filter((c) => ms(c.time) <= T - 60 * 60_000).slice(-FROZEN.ACTIVITY_BASELINE_MIN);
  const baselineAvg = mean(baseArr.map(rng));
  const activityRatio = baselineAvg ? recent / baselineAvg : NaN;
  let atr = NaN;
  if (pre.length > FROZEN.ATR_PERIOD) {
    const trs: number[] = [];
    for (let i = 1; i < pre.length; i++) { const c = pre[i]!.mid, p = pre[i - 1]!.mid; trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))); }
    atr = mean(trs.slice(-FROZEN.ATR_PERIOD)) / ps;
  }
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
  const preN = (x: number) => {
    const ref = midCloseAt(pre, T - 60_000), past = midCloseAt(pre, T - 60_000 - x * 60_000);
    return ref != null && past != null ? (ref - past) / ps : NaN;
  };
  const curRange = (x: number) => { const seg = pre.slice(-x); return seg.length ? (Math.max(...seg.map((c) => c.mid.high)) - Math.min(...seg.map((c) => c.mid.low))) / ps : NaN; };
  const pre5 = preN(5), pre15 = preN(15), pre30 = preN(30), pre60 = preN(60);
  const extN = (x: number, v: number) => (normDisp[x] ? Math.abs(v) / normDisp[x] : NaN);
  const pre15atr = extN(15, pre15), pre30atr = extN(30, pre30), pre60atr = extN(60, pre60);
  const compRatios = [15, 30, 60].map((x) => (normRange[x] ? curRange(x) / normRange[x] : NaN)).filter((v) => Number.isFinite(v));
  const compRatio = mean(compRatios);
  const compressionScore = Number.isFinite(compRatio) ? clamp(1 - compRatio, 0, 1) : 0;
  return { activityRatio, atr, baselineAvg, recent,
    pre5, pre15, pre30, pre60, pre15atr, pre30atr, pre60atr,
    curRange15: curRange(15), curRange30: curRange(30), curRange60: curRange(60),
    normRange, compRatio, compressionScore };
}

export async function srFeatures(pre: RC[], inst: string, atrPips: number) {
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

export function spreadInfo(pre: RC[], inst: string) {
  const ps = pipSize(inst); const sp = (c: RC) => (c.ask.close - c.bid.close) / ps;
  const cur = pre.at(-1) ? sp(pre.at(-1)!) : NaN;
  const a5 = mean(pre.slice(-5).map(sp)), a15 = mean(pre.slice(-15).map(sp));
  const baseMed = median(pre.slice(-FROZEN.ACTIVITY_BASELINE_MIN).map(sp));
  const cls = baseMed && cur >= baseMed * FROZEN.SPREAD_EXTREME_MULT ? "EXTREME" : baseMed && cur >= baseMed * FROZEN.SPREAD_ELEVATED_MULT ? "ELEVATED" : "NORMAL";
  return { current: cur, avg5: a5, avg15: a15, baselineMedian: baseMed, cls };
}

export function fundamentalScoreFromReleases(rels: { forecast?: number; previous?: number; polarity?: 1 | -1; weight?: number }[]): number {
  const rel = rels.filter((r) => r.forecast != null && r.previous != null);
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

export function postNews(cs: RC[], T: number, inst: string) {
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
export const moveClass = (s: number) => (FROZEN.CLASS.find(([lo, hi]) => s >= (lo as number) && s <= (hi as number))?.[2] ?? "LOW_MOVE_EXPECTED");

/**
 * MOVE_SCORE + DIRECTION assembly — extracted verbatim from the v2 main() loop.
 * meta carries the calendar-derived inputs (importance 0..1, typeVol 0..1,
 * simultaneous count, fundBase/fundQuote in [-1,1]).
 */
export async function computeRow(opts: {
  pair: string; cs: RC[]; data: Map<string, RC[]>; T: number;
  importance: number; typeVol: number; simultaneous: number; fBase: number; fQuote: number;
}) {
  const { pair, cs, data, T, importance, typeVol, simultaneous, fBase, fQuote } = opts;
  const pre = preOnly(cs, T);
  const base = pair.slice(0, 3), quote = pair.slice(4, 7);
  const v = volFeatures(pre, pair, T);
  const sr = await srFeatures(pre, pair, v.atr);
  const spr = spreadInfo(pre, pair);

  const cImp = importance, cType = typeVol;
  const cSim = clamp(simultaneous / FROZEN.SIMULT_CAP, 0, 1);
  const cAct = Number.isFinite(v.activityRatio) ? clamp((v.activityRatio - 0.5) / 1.5, 0, 1) : 0;
  const extMax = Math.max(v.pre15atr || 0, v.pre30atr || 0, v.pre60atr || 0);
  const cExt = clamp(extMax / FROZEN.EXTENSION_SAT, 0, 1);
  const cComp = v.compressionScore, cSr = sr.srCompScore;
  const moveScore = Math.round(
    FROZEN.W_IMPORTANCE * cImp + FROZEN.W_EVENTTYPE * cType + FROZEN.W_SIMULTANEOUS * cSim +
    FROZEN.W_ACTIVITY * cAct + FROZEN.W_EXTENSION * cExt + FROZEN.W_COMPRESSION * cComp + FROZEN.W_SRCOMP * cSr);
  const mClass = moveClass(moveScore);

  const fundPair = clamp(fBase - fQuote, -1, 1);
  const trend = trendScore(pre);
  const sBase = currencyStrength(base, data, T), sQuote = currencyStrength(quote, data, T);
  const relStr = clamp(sBase - sQuote, -2, 2);
  const momScore = clamp((v.pre30 || 0) / FROZEN.D_MOM_NORM_PIPS, -1, 1);
  let dComposite = FROZEN.D_W_FUND * fundPair + FROZEN.D_W_TREND * trend + FROZEN.D_W_RELSTR * (relStr / 2) + FROZEN.D_W_MOM * momScore;
  if (Number.isFinite(sr.distResistance) && sr.distResistance < FROZEN.D_SR_NEAR_PIPS) dComposite -= FROZEN.D_SR_TILT;
  if (Number.isFinite(sr.distSupport) && sr.distSupport < FROZEN.D_SR_NEAR_PIPS) dComposite += FROZEN.D_SR_TILT;
  dComposite = clamp(dComposite, -1, 1);
  const direction = Math.abs(dComposite) < FROZEN.D_UNKNOWN_BELOW ? "UNKNOWN" : dComposite > 0 ? "LONG" : "SHORT";
  const directionScore = Math.round(dComposite * 100);

  const post = postNews(cs, T, pair);
  const hz = FROZEN.HEADLINE_HORIZON_MIN, headMax = post[`${hz}m`].maxAbs;
  const hits: Record<string, number> = {};
  for (const p of FROZEN.HIT_PIPS) hits[`hit${p}`] = Number.isFinite(headMax) && headMax >= p ? 1 : 0;
  const dirCorr = (h: string) => { if (direction === "UNKNOWN") return ""; const net = post[h].net; if (!Number.isFinite(net)) return "NA"; return (direction === "LONG" ? net > 0 : net < 0) ? "Y" : "N"; };

  return {
    base, quote, v, sr, spr,
    cImp, cType, cSim, cAct, cExt, cComp, cSr, moveScore, moveClass: mClass,
    fundPair, trend, relStr, momScore, direction, directionScore, post, hits, dirCorr,
    preCandles: pre.length, lastPreCandle: pre.at(-1)?.time ?? null,
  };
}
