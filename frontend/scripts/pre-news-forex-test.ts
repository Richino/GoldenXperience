/**
 * PRE-NEWS FOREX TEST  —  TEST #1  (frozen rules, 2026-09-17)
 * ===========================================================
 * Question: using ONLY information that existed BEFORE each scheduled news
 * event, could we have identified a useful directional bias for the affected
 * pair?  NOT a normal backtest, NOT a post-news prediction.
 *
 * STRICT NO-LEAKAGE: for an event at time T, the pre-news analysis may only see
 * M1 candles whose COMPLETE candle closes at or before T (a candle stamped
 * `time` covers [time, time+60s); it is admissible iff time+60s <= T, i.e.
 * time <= T-60s). No Actual values are ever used. Post-news candles are only
 * read in Phase 10 AFTER the decision is frozen.
 *
 * All formulas/thresholds below are FROZEN for the forward experiment. Do not
 * retune them after seeing outcomes. Constants live in the FROZEN block.
 *
 * Data: OANDA M1 candles, price="MBA" (mid for direction, bid/ask for spread),
 * via the project's getResearchCandles. Creds from api-server/.env.
 *
 * Output: prints report + appends a row per (event,pair) to
 *   research-output/pre-news-forex-test.csv
 */
import fs from "node:fs";
import path from "node:path";

// ---- OANDA creds (same loader the other research scripts use) ----
const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

// =====================  FROZEN CONSTANTS (TEST #1)  =====================
const FROZEN = {
  MOMENTUM_NORM_PIPS: 15,        // 30m pre-news move that maps to |momentum|=1
  W_FUND: 0.30,                  // composite weights
  W_TREND: 0.20,
  W_RELSTR: 0.30,
  W_MOM: 0.20,
  DECISION_THRESHOLD: 0.20,      // |composite| below this => NO_TRADE
  CONF_GAIN: 120,                // confidence = min(100, |composite|*CONF_GAIN) then gates
  FUND_PCT_CLAMP: 0.30,          // clamp per-release (fc-prev)/|prev|
  STRENGTH_WINDOWS_MIN: [15, 30, 60] as const, // currency-strength lookbacks
  ACTIVITY_RECENT_MIN: 60,       // recent avg M1 range window
  ACTIVITY_BASELINE_MIN: 480,    // baseline avg M1 range window (8h before event)
  ATR_PERIOD: 14,                // ATR on M1
  SR_NEAR_PIPS: 5,               // "no room" if target level within this
  SPREAD_ELEVATED_MULT: 1.5,     // vs baseline median spread
  SPREAD_EXTREME_MULT: 3.0,
};
// =======================================================================

const OUT_DIR = path.resolve(__dirname, "../research-output");
const CSV = path.join(OUT_DIR, "pre-news-forex-test.csv");
const JSON_OUT = path.join(OUT_DIR, "pre-news-forex-test-2026-09-17.json");

// ---------- helpers ----------
type RC = { time: string; volume: number; complete: boolean;
  mid: OHLC; bid: OHLC; ask: OHLC };
type OHLC = { open: number; high: number; low: number; close: number };

const ms = (iso: string) => Date.parse(iso.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
const isoUTC = (t: number) => new Date(t).toISOString();
const pipSize = (inst: string) => (inst.includes("JPY") ? 0.01 : 0.0001);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, d = 1) => (x == null || Number.isNaN(x) ? NaN : Number(x.toFixed(d)));
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

function ema(vals: number[], period: number): number[] {
  const k = 2 / (period + 1); const out: number[] = []; let prev = vals[0]!;
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0]! : vals[i]! * k + prev * (1 - k); out.push(prev); }
  return out;
}
// candle admissible for event T iff it closes at/before T: ms(time)+60000 <= T
const preOnly = (cs: RC[], T: number) => cs.filter((c) => c.complete && ms(c.time) + 60_000 <= T);
// nearest completed candle at-or-before a target time (for point reads)
function midCloseAt(cs: RC[], t: number): number | null {
  let best: RC | null = null;
  for (const c of cs) { if (ms(c.time) <= t && (!best || ms(c.time) > ms(best.time))) best = c; }
  return best ? best.mid.close : null;
}

// ---------- EVENT CONFIG (frozen; forecast/previous only, NO actuals) ----------
// polarity: +1 => higher value is currency-positive, -1 => currency-negative.
// weight: relative importance (impact) of the release.
type Release = { ccy: string; name: string; forecast: number; previous: number; polarity: 1 | -1; weight: number };
type EventCfg = {
  id: string; label: string; etTime: string; utc: string;   // event UTC ISO
  pairs: string[];                                            // test pairs
  releases: Release[];                                        // numeric releases (may be empty)
  note?: string;
};

// 2026-09-17 is EDT (America/New_York, UTC-4). ET+4h = UTC.
const U = (hhmm: string) => `2026-09-17T${hhmm}:00.000Z`;
const EVENTS: EventCfg[] = [
  { id: "EUR_CPI", label: "EUR Final CPI / Core CPI y/y", etTime: "05:00", utc: U("09:00"), pairs: ["EUR_USD"],
    releases: [
      { ccy: "EUR", name: "Final Core CPI y/y", forecast: 2.4, previous: 2.4, polarity: 1, weight: 0.8 },
      { ccy: "EUR", name: "Final CPI y/y", forecast: 3.3, previous: 3.3, polarity: 1, weight: 0.8 },
    ], note: "Final readings, fc==prev => neutral fundamental." },

  { id: "GBP_BOE", label: "GBP BoE Rate / Votes / MPS", etTime: "07:00", utc: U("11:00"), pairs: ["GBP_USD"],
    releases: [
      { ccy: "GBP", name: "Official Bank Rate", forecast: 3.75, previous: 3.75, polarity: 1, weight: 1.0 },
      { ccy: "GBP", name: "MPC vote (hike count 3-0-6)", forecast: 3, previous: 3, polarity: 1, weight: 0.6 },
    ], note: "Hold expected (fc==prev). Statement text unseen — not predicted." },

  { id: "CADUSD_830", label: "USD Philly Fed/Claims/Permits/Starts (+ CAD unforecast)", etTime: "08:30", utc: U("12:30"), pairs: ["USD_CAD"],
    releases: [
      { ccy: "USD", name: "Philly Fed Mfg", forecast: 31.3, previous: 47.4, polarity: 1, weight: 1.0 },
      { ccy: "USD", name: "Unemployment Claims", forecast: 207, previous: 206, polarity: -1, weight: 0.8 },
      { ccy: "USD", name: "Building Permits", forecast: 1.40, previous: 1.43, polarity: 1, weight: 0.5 },
      { ccy: "USD", name: "Housing Starts", forecast: 1.32, previous: 1.31, polarity: 1, weight: 0.5 },
      // CAD: Foreign Securities Purchases / IPPI / NHPI / RMPI — no forecast/previous => omitted (neutral).
    ] },

  { id: "USD_PHS", label: "USD Pending Home Sales m/m", etTime: "10:00", utc: U("14:00"),
    pairs: ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD"],
    releases: [ { ccy: "USD", name: "Pending Home Sales m/m", forecast: -0.2, previous: -2.6, polarity: 1, weight: 0.4 } ] },

  { id: "AUD_CBLI", label: "AUD CB Leading Index m/m", etTime: "10:30", utc: U("14:30"), pairs: ["AUD_USD"],
    releases: [], note: "No forecast/previous => neutral fundamental." },

  { id: "NZD_FPI_TB", label: "NZD FPI m/m / Trade Balance", etTime: "18:45", utc: U("22:45"), pairs: ["NZD_USD"],
    releases: [], note: "No forecast/previous => neutral fundamental." },

  { id: "JPY_BOJ", label: "JPY BoJ Rate / Core CPI / MPS", etTime: "19:30", utc: U("23:30"), pairs: ["USD_JPY"],
    releases: [
      // BoJ ceiling raised <1.00% -> <1.25% => hike expected => JPY-positive.
      { ccy: "JPY", name: "BoJ Policy Rate ceiling", forecast: 1.25, previous: 1.00, polarity: 1, weight: 1.0 },
      { ccy: "JPY", name: "National Core CPI y/y", forecast: 1.8, previous: 1.8, polarity: 1, weight: 0.7 },
    ], note: "Rate ceiling up => JPY-positive; CPI fc==prev." },
];

// currency -> crosses used for strength (frozen list from the brief)
const STRENGTH_CROSSES: Record<string, string[]> = {
  EUR: ["EUR_USD", "EUR_GBP", "EUR_JPY", "EUR_CHF"],
  GBP: ["GBP_USD", "EUR_GBP", "GBP_JPY", "GBP_CHF"],
  USD: ["EUR_USD", "GBP_USD", "USD_JPY", "USD_CAD", "AUD_USD", "NZD_USD", "USD_CHF"],
  CAD: ["USD_CAD", "CAD_JPY", "EUR_CAD", "GBP_CAD", "AUD_CAD"],
  AUD: ["AUD_USD", "AUD_JPY", "EUR_AUD", "GBP_AUD", "AUD_CAD"],
  NZD: ["NZD_USD", "NZD_JPY", "EUR_NZD", "GBP_NZD", "AUD_NZD"],
  JPY: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "NZD_JPY", "CAD_JPY"],
};

// ---------- data fetch ----------
async function fetchAll(insts: string[]): Promise<Map<string, RC[]>> {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const map = new Map<string, RC[]>();
  for (const inst of insts) {
    // ~2 days of M1 up to just after the last event's +60m window
    const batch: RC[] = await getResearchCandles(inst, "M1", 2880, { to: "2026-09-18T02:00:00.000Z" });
    map.set(inst, batch.filter((c) => c.complete).sort((a, b) => ms(a.time) - ms(b.time)));
    process.stderr.write(`fetched ${inst}: ${map.get(inst)!.length} M1 candles\n`);
  }
  return map;
}

// ---------- currency strength ----------
// For a currency, average signed % change across its crosses over each window,
// orienting so positive = currency strengthening. base of pair strengthening
// when pair up (+); quote strengthening when pair down (-). Combine the 3
// windows equally into a score in [-1,1] via tanh-like normalization.
function currencyStrength(ccy: string, data: Map<string, RC[]>, T: number): number {
  const crosses = STRENGTH_CROSSES[ccy] ?? [];
  const perWindow: number[] = [];
  for (const w of FROZEN.STRENGTH_WINDOWS_MIN) {
    const parts: number[] = [];
    for (const cross of crosses) {
      const cs = data.get(cross); if (!cs) continue;
      const now = midCloseAt(cs, T - 60_000);          // last close strictly before T
      const then = midCloseAt(cs, T - 60_000 - w * 60_000);
      if (now == null || then == null || then === 0) continue;
      const pct = (now - then) / then;                 // pair % change
      const orient = cross.startsWith(ccy + "_") ? 1 : cross.endsWith("_" + ccy) ? -1 : 0;
      if (orient === 0) continue;
      parts.push(pct * orient);
    }
    if (parts.length) perWindow.push(parts.reduce((a, b) => a + b, 0) / parts.length);
  }
  if (!perWindow.length) return 0;
  const avgPct = perWindow.reduce((a, b) => a + b, 0) / perWindow.length; // avg fractional move
  // 0.15% average cross move => saturate to 1.0
  return clamp(avgPct / 0.0015, -1, 1);
}

// ---------- fundamental expectation ----------
function fundamentalScore(ccy: string, releases: Release[]): number {
  const rel = releases.filter((r) => r.ccy === ccy);
  if (!rel.length) return 0;
  let num = 0, den = 0;
  for (const r of rel) {
    if (r.forecast === r.previous) { den += r.weight; continue; } // neutral contribution
    const pct = clamp((r.forecast - r.previous) / Math.abs(r.previous || 1e-9), -FROZEN.FUND_PCT_CLAMP, FROZEN.FUND_PCT_CLAMP);
    num += r.weight * r.polarity * pct;
    den += r.weight;
  }
  if (den === 0) return 0;
  const avg = num / den;                       // in [-CLAMP, CLAMP]
  return clamp(avg / FROZEN.FUND_PCT_CLAMP, -1, 1);
}

// ---------- pre-news momentum ----------
function preMomentumPips(cs: RC[], T: number, inst: string) {
  const ref = midCloseAt(cs, T - 60_000);
  const out: Record<string, number> = {};
  for (const m of [5, 15, 30, 60, 120]) {
    const past = midCloseAt(cs, T - 60_000 - m * 60_000);
    out[`PRE_${m}M`] = ref != null && past != null ? (ref - past) / pipSize(inst) : NaN;
  }
  return out;
}

// ---------- trend ----------
function trendScore(pre: RC[]): number {
  if (pre.length < 55) return 0;
  const closes = pre.map((c) => c.mid.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const n = closes.length;
  const price = closes[n - 1]!;
  let s = 0;
  // ema slopes over last 10 bars
  s += sign(e20[n - 1]! - e20[n - 11]!) * 0.25;
  s += sign(e50[n - 1]! - e50[n - 11]!) * 0.20;
  s += sign(price - e20[n - 1]!) * 0.15;
  s += sign(price - e50[n - 1]!) * 0.15;
  // higher-highs/higher-lows over last ~20 vs prior ~20 (swing structure)
  const seg = (a: number, b: number) => pre.slice(a, b);
  const recent = seg(n - 20, n), prior = seg(n - 40, n - 20);
  if (prior.length && recent.length) {
    const hh = Math.max(...recent.map((c) => c.mid.high)) > Math.max(...prior.map((c) => c.mid.high));
    const hl = Math.min(...recent.map((c) => c.mid.low)) > Math.min(...prior.map((c) => c.mid.low));
    const lh = Math.max(...recent.map((c) => c.mid.high)) < Math.max(...prior.map((c) => c.mid.high));
    const ll = Math.min(...recent.map((c) => c.mid.low)) < Math.min(...prior.map((c) => c.mid.low));
    if (hh && hl) s += 0.25; else if (lh && ll) s -= 0.25;
    else if (hh || hl) s += 0.10; else if (lh || ll) s -= 0.10;
  }
  return clamp(s, -1, 1);
}

// ---------- volatility / positioning ----------
function activity(pre: RC[], inst: string) {
  const ps = pipSize(inst);
  const rng = (c: RC) => (c.mid.high - c.mid.low) / ps;
  const lastN = (n: number) => pre.slice(-n);
  const avg = (arr: RC[]) => (arr.length ? arr.reduce((a, c) => a + rng(c), 0) / arr.length : NaN);
  const recent = avg(lastN(FROZEN.ACTIVITY_RECENT_MIN));
  const baseline = avg(lastN(FROZEN.ACTIVITY_BASELINE_MIN));
  const ratio = baseline ? recent / baseline : NaN;
  // ATR14 on M1 (mid true range)
  let atr = NaN;
  if (pre.length > FROZEN.ATR_PERIOD) {
    const trs: number[] = [];
    for (let i = 1; i < pre.length; i++) {
      const c = pre[i]!.mid, p = pre[i - 1]!.mid;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    atr = (trs.slice(-FROZEN.ATR_PERIOD).reduce((a, b) => a + b, 0) / FROZEN.ATR_PERIOD) / ps;
  }
  const range = (n: number) => {
    const s = lastN(n); if (!s.length) return NaN;
    return (Math.max(...s.map((c) => c.mid.high)) - Math.min(...s.map((c) => c.mid.low))) / ps;
  };
  const cls = ratio < 0.75 ? "QUIET" : ratio <= 1.25 ? "NORMAL" : ratio <= 2.0 ? "ELEVATED" : "EXTREME";
  return { ratio, cls, atr, recentAvgRange: recent, baselineAvgRange: baseline,
    range15: range(15), range30: range(30), range60: range(60) };
}

// ---------- spread ----------
function spreadInfo(pre: RC[], inst: string) {
  const ps = pipSize(inst);
  const sp = (c: RC) => (c.ask.close - c.bid.close) / ps;
  const last = pre.at(-1);
  const cur = last ? sp(last) : NaN;
  const avgOf = (n: number) => { const s = pre.slice(-n); return s.length ? s.reduce((a, c) => a + sp(c), 0) / s.length : NaN; };
  const a5 = avgOf(5), a15 = avgOf(15);
  const baseArr = pre.slice(-FROZEN.ACTIVITY_BASELINE_MIN).map(sp).sort((a, b) => a - b);
  const baseMed = baseArr.length ? baseArr[Math.floor(baseArr.length / 2)]! : NaN;
  const cls = baseMed && cur >= baseMed * FROZEN.SPREAD_EXTREME_MULT ? "EXTREME"
    : baseMed && cur >= baseMed * FROZEN.SPREAD_ELEVATED_MULT ? "ELEVATED" : "NORMAL";
  return { current: cur, avg5: a5, avg15: a15, baselineMedian: baseMed, cls };
}

// ---------- S/R (reuse project logic) ----------
async function srRoom(pre: RC[], inst: string) {
  const { computeSupportResistanceLevels } = await import("../src/lib/strategy/support-resistance");
  const candles = pre.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: true }));
  const lv = computeSupportResistanceLevels(candles as any, inst as any);
  if (!lv) return null;
  const ps = pipSize(inst);
  const cur = lv.current;
  const res = Math.min(...[lv.rangeHigh, lv.swingHigh].filter((x): x is number => x != null && x > cur));
  const sup = Math.max(...[lv.rangeLow, lv.swingLow].filter((x): x is number => x != null && x < cur));
  return {
    support: Number.isFinite(sup) ? sup : null, resistance: Number.isFinite(res) ? res : null,
    distToSupportPips: Number.isFinite(sup) ? (cur - sup) / ps : NaN,
    distToResistancePips: Number.isFinite(res) ? (res - cur) / ps : NaN,
  };
}

// ---------- post-news (Phase 10) ----------
function postNews(cs: RC[], T: number, inst: string, call: "LONG" | "SHORT" | "NO_TRADE") {
  const ps = pipSize(inst);
  const ref = midCloseAt(cs, T - 60_000); // frozen pre-news reference
  const res: Record<string, any> = {};
  const dirMul = call === "SHORT" ? -1 : 1; // for MFE/MAE orientation (favorable = in call direction)
  for (const h of [1, 3, 5, 10, 15, 30, 60]) {
    const at = midCloseAt(cs, T + h * 60_000);
    // window candles (T, T+h]
    const win = cs.filter((c) => ms(c.time) > T && ms(c.time) <= T + h * 60_000);
    const net = ref != null && at != null ? (at - ref) / ps : NaN;
    const hi = win.length ? Math.max(...win.map((c) => c.mid.high)) : NaN;
    const lo = win.length ? Math.min(...win.map((c) => c.mid.low)) : NaN;
    const mfe = ref != null ? (call === "SHORT" ? (ref - lo) : (hi - ref)) / ps : NaN;
    const mae = ref != null ? (call === "SHORT" ? (hi - ref) : (ref - lo)) / ps : NaN;
    res[`${h}m`] = { netPips: net, direction: net > 0 ? "UP" : net < 0 ? "DOWN" : "FLAT", mfePips: mfe, maePips: mae };
  }
  return res;
}

// ---------- MAIN ----------
async function main() {
  const insts = Array.from(new Set([
    ...Object.values(STRENGTH_CROSSES).flat(),
    ...EVENTS.flatMap((e) => e.pairs),
  ]));
  const data = await fetchAll(insts);

  const rows: any[] = [];
  const detail: any[] = [];

  for (const ev of EVENTS) {
    const T = ms(ev.utc);
    for (const pair of ev.pairs) {
      const cs = data.get(pair)!;
      const pre = preOnly(cs, T);
      const base = pair.slice(0, 3), quote = pair.slice(4, 7);

      // Phase 1
      const fBase = fundamentalScore(base, ev.releases);
      const fQuote = fundamentalScore(quote, ev.releases);
      const fundPair = clamp(fBase - fQuote, -1, 1); // >0 bullish pair
      // Phase 2
      const mom = preMomentumPips(cs, T, pair);
      const momScore = clamp((mom.PRE_30M || 0) / FROZEN.MOMENTUM_NORM_PIPS, -1, 1);
      // Phase 3
      const trend = trendScore(pre);
      // Phase 4
      const sBase = currencyStrength(base, data, T);
      const sQuote = currencyStrength(quote, data, T);
      // Phase 5
      const relStr = clamp(sBase - sQuote, -2, 2); // [-2,2]
      // Phase 6
      const act = activity(pre, pair);
      // Phase 7
      const sr = await srRoom(pre, pair);
      // Phase 8
      const spr = spreadInfo(pre, pair);

      // Phase 9 — freeze decision
      const composite =
        FROZEN.W_FUND * fundPair +
        FROZEN.W_TREND * trend +
        FROZEN.W_RELSTR * (relStr / 2) +
        FROZEN.W_MOM * momScore;
      let call: "LONG" | "SHORT" | "NO_TRADE" =
        composite >= FROZEN.DECISION_THRESHOLD ? "LONG" :
        composite <= -FROZEN.DECISION_THRESHOLD ? "SHORT" : "NO_TRADE";
      let conf = Math.min(100, Math.abs(composite) * FROZEN.CONF_GAIN);
      // gates
      if (spr.cls === "EXTREME") { call = "NO_TRADE"; conf = 0; }
      else if (spr.cls === "ELEVATED") conf -= 15;
      if (call === "LONG" && sr && sr.distToResistancePips < FROZEN.SR_NEAR_PIPS) conf -= 15;
      if (call === "SHORT" && sr && sr.distToSupportPips < FROZEN.SR_NEAR_PIPS) conf -= 15;
      if (act.cls === "EXTREME") conf -= 10; // already extended -> may be late
      conf = Math.max(0, Math.round(conf));

      const fundBiasLabel = fundPair > 0.05 ? "LONG" : fundPair < -0.05 ? "SHORT" : "NEUTRAL";
      const posBias = (0.5 * (relStr / 2) + 0.3 * trend + 0.2 * momScore); // positioning-only
      const posBiasLabel = posBias > 0.1 ? "LONG" : posBias < -0.1 ? "SHORT" : "NEUTRAL";

      // Phase 10 — reveal post-news (after freezing)
      const post = postNews(cs, T, pair, call);
      const corr = (h: string) => {
        if (call === "NO_TRADE") return "";
        const net = post[h].netPips;
        if (!Number.isFinite(net)) return "NA";
        return (call === "LONG" ? net > 0 : net < 0) ? "Y" : "N";
      };
      // reversal check: spike (1m/3m) vs 30m/60m settle
      const spike = post["3m"].netPips;
      const settle = post["30m"].netPips;
      const reversed = Number.isFinite(spike) && Number.isFinite(settle) && sign(spike) !== 0 && sign(settle) !== sign(spike);

      const rec = {
        date: "2026-09-17", event: ev.id, label: ev.label, etTime: ev.etTime, utc: ev.utc, pair,
        base, quote,
        fundBase: round(fBase, 3), fundQuote: round(fQuote, 3), fundPair: round(fundPair, 3), fundBias: fundBiasLabel,
        trendScore: round(trend, 3),
        strengthBase: round(sBase, 3), strengthQuote: round(sQuote, 3), relStrength: round(relStr, 3),
        pre5: round(mom.PRE_5M), pre15: round(mom.PRE_15M), pre30: round(mom.PRE_30M), pre60: round(mom.PRE_60M), pre120: round(mom.PRE_120M),
        momScore: round(momScore, 3),
        activityRatio: round(act.ratio, 2), activityClass: act.cls, atrPipsM1: round(act.atr, 2),
        range15: round(act.range15), range30: round(act.range30), range60: round(act.range60),
        srSupport: sr?.support ?? null, srResistance: sr?.resistance ?? null,
        distSupportPips: round(sr?.distToSupportPips ?? NaN), distResistancePips: round(sr?.distToResistancePips ?? NaN),
        spreadCur: round(spr.current, 2), spreadAvg5: round(spr.avg5, 2), spreadAvg15: round(spr.avg15, 2),
        spreadBaseMed: round(spr.baselineMedian, 2), spreadClass: spr.cls,
        posBias: posBiasLabel,
        composite: round(composite, 3), call, confidence: conf,
        post1: round(post["1m"].netPips), post3: round(post["3m"].netPips), post5: round(post["5m"].netPips),
        post10: round(post["10m"].netPips), post15: round(post["15m"].netPips), post30: round(post["30m"].netPips), post60: round(post["60m"].netPips),
        mfe15: round(post["15m"].mfePips), mae15: round(post["15m"].maePips),
        mfe60: round(post["60m"].mfePips), mae60: round(post["60m"].maePips),
        corr5: corr("5m"), corr15: corr("15m"), corr30: corr("30m"), corr60: corr("60m"),
        spikeReversed: reversed,
        preCandles: pre.length, lastPreCandle: pre.at(-1)?.time ?? null,
      };
      rows.push(rec);
      detail.push({ ...rec, postFull: post });
    }
  }

  // ---- write CSV (append-friendly) ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cols = Object.keys(rows[0]!);
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = cols.join(",");
  const lines = rows.map((r) => cols.map((c) => esc(r[c])).join(","));
  const existed = fs.existsSync(CSV);
  if (!existed) fs.writeFileSync(CSV, header + "\n");
  fs.appendFileSync(CSV, lines.join("\n") + "\n");
  fs.writeFileSync(JSON_OUT, JSON.stringify({ frozen: FROZEN, events: EVENTS, rows: detail }, null, 2));

  // ---- print compact table ----
  const P = (s: any, w: number) => String(s ?? "").padEnd(w).slice(0, w);
  const R = (s: any, w: number) => String(s ?? "").padStart(w);
  console.log("\n================ PRE-NEWS FOREX TEST #1 — 2026-09-17 (frozen rules) ================\n");
  const th = [P("EVENT", 11), P("ETET", 6), P("PAIR", 8), P("FUND", 8), R("TREND", 6), R("BASE", 6), R("QUOT", 6), R("REL", 6),
    R("P60", 6), R("P30", 6), R("P15", 6), R("ACT", 5), P("SRroom", 8), R("SPRD", 5), P("CALL", 8), R("CONF", 4),
    R("po5", 6), R("po15", 6), R("po30", 6), R("po60", 6), P("5/15/30/60", 12)].join(" ");
  console.log(th);
  console.log("-".repeat(th.length));
  for (const r of rows) {
    const room = r.call === "SHORT" ? `${r.distSupportPips}s` : `${r.distResistancePips}r`;
    console.log([
      P(r.event, 11), P(r.etTime, 6), P(r.pair, 8), P(r.fundBias, 8), R(r.trendScore, 6),
      R(r.strengthBase, 6), R(r.strengthQuote, 6), R(r.relStrength, 6),
      R(r.pre60, 6), R(r.pre30, 6), R(r.pre15, 6), R(r.activityRatio, 5), P(room, 8), R(r.spreadCur, 5),
      P(r.call, 8), R(r.confidence, 4), R(r.post5, 6), R(r.post15, 6), R(r.post30, 6), R(r.post60, 6),
      P(`${r.corr5||"-"}/${r.corr15||"-"}/${r.corr30||"-"}/${r.corr60||"-"}`, 12),
    ].join(" "));
  }

  // ---- summary ----
  const calls = rows.filter((r) => r.call !== "NO_TRADE");
  const longs = calls.filter((r) => r.call === "LONG"), shorts = calls.filter((r) => r.call === "SHORT");
  const acc = (h: string) => {
    const g = calls.filter((r) => r[h] === "Y" || r[h] === "N");
    const w = g.filter((r) => r[h] === "Y").length;
    return g.length ? `${w}/${g.length} = ${round((100 * w) / g.length)}%` : "n/a";
  };
  console.log("\n---------------- SUMMARY ----------------");
  console.log(`Total directional calls: ${calls.length}  (LONG ${longs.length}, SHORT ${shorts.length}, NO_TRADE ${rows.length - calls.length})`);
  console.log(`5m accuracy:  ${acc("corr5")}`);
  console.log(`15m accuracy: ${acc("corr15")}`);
  console.log(`30m accuracy: ${acc("corr30")}`);
  console.log(`60m accuracy: ${acc("corr60")}`);
  console.log(`\nCSV appended: ${CSV}`);
  console.log(`JSON detail:  ${JSON_OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
