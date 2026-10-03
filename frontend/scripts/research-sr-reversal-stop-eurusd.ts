/**
 * EUR/USD 15M — RANGE->SWING RETURN-TO-S/R WITH STOP (V10, research-only, FROZEN).
 *
 * From frozen V9: does the 15p or 20p Range->Swing return-to-S/R entry make money
 * once a stop-loss is added? Real OANDA BID/ASK. Target = original frozen S/R level.
 *
 * FROZEN from V9 (=V1-V8): S/R detection, breakout (MID penetrates L1 by >=minPenATR),
 * range->swing cohort, BID/ASK execution, spread-embedded-once, 96-bar (24h) horizon.
 * S/R stays on M15. Trade PATH runs on M5 BID/ASK for correct intrabar entry/TP/SL
 * ordering. Strict no-lookahead: entry can only trigger AFTER the M15 breakout bar
 * closes (M5 index >= breakoutBarClose).
 *
 * DIRECTION: resistance break -> SHORT toward resistance; support break -> LONG.
 *   SHORT entry SELL@BID at L1+D; TP BUY@ASK at L1 (+D pips); SL BUY@ASK at L1+D+SL (-SL).
 *   LONG  entry BUY@ASK at L1-D; TP SELL@BID at L1 (+D pips); SL SELL@BID at L1-D-SL (-SL).
 *   Win=+D, Loss=-SL (executable, spread embedded via fill streams). Same-M5-bar TP&SL
 *   = AMBIGUOUS (excluded). Neither in 24h = TIMEOUT (closed at 24h on the exit stream).
 *
 * SWING-IN-BETWEEN DIAGNOSTIC (no rule change): the indicator exposes only one swing +
 *   one range per side, so the only "swing between S/R#1 and the entry extension" is
 *   S/R#2 itself when it falls within D pips (gap<=D). Split trades by that and compare.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD"; const TIMEFRAME = "M15";
const M15C = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const M5C = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m5-mba-cache.json";
const OUT_DIR = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const WINDOW = 220, HORIZON = 96, PIP = pipSizeFor(INSTRUMENT);
const H5 = HORIZON * 3; // 96 M15 = 288 M5 bars
const TOUCH_ATR = PR.touchAtr, MIN_PEN_ATR = PR.minPenetrationAtr, ACCEPT_MIN_BARS = PR.acceptMinBars, ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const DISTANCES = [15, 20]; const STOPS = [15, 20, 25, 30, 35, 40, 50, 60];

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(M15C, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

// M5 arrays: [t, bh, bl, ah, al, bc, ac]
const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(fs.readFileSync(M5C, "utf8"));
const M = m5raw.length; const mt: string[] = new Array(M); const bh = new Float64Array(M), bl = new Float64Array(M), ah = new Float64Array(M), al = new Float64Array(M), bc = new Float64Array(M), ac = new Float64Array(M);
for (let i = 0; i < M; i++) { const r = m5raw[i]!; mt[i] = r[0]; bh[i] = r[1]; bl[i] = r[2]; ah[i] = r[3]; al[i] = r[4]; bc[i] = r[5]; ac[i] = r[6]; }
(m5raw as any).length = 0;
function lb(t: string) { let lo = 0, hi = M; while (lo < hi) { const m = (lo + hi) >> 1; if (mt[m]! < t) lo = m + 1; else hi = m; } return lo; } // first idx with time >= t

interface Brk { t0: number; side: Side; atr: number; L1: number; L2: number; k1: Kind; k2: Kind; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, side: "resistance", atr: A, L1, L2: o, k1, k2 }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, side: "support", atr: A, L1, L2: o, k1, k2 }); armedS = false; } } else if (!nearS) armedS = true;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
{ const enc: Array<{ t0: number; side: Side; L: number; atr: number }> = []; let aR = true, aS = true;
  for (let t = startT; t < n; t++) { const w = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: w, instrument: INSTRUMENT, timeframe: TIMEFRAME }); const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(w); if (!(A > 0)) continue; const nR = loc === "NEAR_RESISTANCE", nS = loc === "NEAR_SUPPORT";
    if (nR && aR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { enc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - cur < p - cur ? q : p)), atr: A }); aR = false; } } else if (!nR) aR = true;
    if (nS && aS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { enc.push({ t0: t, side: "support", L: c.reduce((p, q) => (cur - q < cur - p ? q : p)), atr: A }); aS = false; } } else if (!nS) aS = true; }
  const v: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of enc) { const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false; const end = Math.min(e.t0 + HORIZON, n - 1); for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bcx = e.side === "resistance" ? c.close - e.L : e.L - c.close; if (bcx > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bcx / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } } v[e.side].t++; if (ok) v[e.side].s++; }
  const vS = pct(v.support.s, v.support.t), vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) { console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`); process.exit(1); }
  (globalThis as any).__fid = { vS, vR };
}
const rsBreaks = breaks.filter((b) => b.k1 === "range" && b.k2 === "swing");

// ---- trade simulation on M5 ----
type OC = "win" | "loss" | "timeout" | "ambiguous" | "no_entry";
interface Trade { side: Side; D: number; SL: number; entryTime: string; pnl: number; oc: OC; mae: number; swingInBetween: boolean; touchedSwing: boolean; crossedSwing: boolean; }
const trades: Trade[] = []; let noBreakout = 0, noEntry = 0; const brokeOut: Record<Side, number> = { support: 0, resistance: 0 };

for (const b of rsBreaks) {
  const isR = b.side === "resistance"; const gap = Math.abs(b.L2 - b.L1) / PIP;
  // breakout bar tB on M15
  let tB = -1; const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen >= MIN_PEN_ATR * b.atr) { tB = j; break; } }
  if (tB < 0) { noBreakout++; continue; } brokeOut[b.side]++;
  // M5 start = AFTER the breakout M15 bar closes (no look-ahead): time = tB.time + 15min
  const closeT = new Date(new Date(raw[tB]!.time).getTime() + 15 * 60000).toISOString().replace("Z", "000000Z").replace(".000000000", ".000000000");
  const m5start = lb(new Date(new Date(raw[tB]!.time).getTime() + 15 * 60000).toISOString());
  if (m5start >= M) continue;
  for (const D of DISTANCES) {
    const entryLevel = isR ? b.L1 + D * PIP : b.L1 - D * PIP;
    // entry trigger within 288 M5 bars
    let ei = -1; const eEnd = Math.min(m5start + H5, M - 1);
    for (let k = m5start; k <= eEnd; k++) { if (isR ? bh[k]! >= entryLevel : al[k]! <= entryLevel) { ei = k; break; } }
    if (ei < 0) { noEntry++; for (const SL of STOPS) trades.push({ side: b.side, D, SL, entryTime: "", pnl: NaN, oc: "no_entry", mae: NaN, swingInBetween: gap <= D, touchedSwing: false, crossedSwing: false }); continue; }
    const spread = (ac[ei]! - bc[ei]!) / PIP; void spread;
    const tp = b.L1; const swing = b.L2;
    const rEnd = Math.min(ei + H5, M - 1);
    // swing diagnostics (path from entry): touched swing after entry, crossed swing returning (toward L1)
    const swingInBetween = gap <= D;
    for (const SL of STOPS) {
      const slLevel = isR ? entryLevel + SL * PIP : entryLevel - SL * PIP;
      let oc: OC = "timeout", pnl = 0, mae = 0, touchedSwing = false, crossedSwing = false;
      let k = ei + 1;
      for (; k <= rEnd; k++) {
        // MAE (adverse, exit-stream): short exits at ASK (loss when ask.high high); long exits at BID (loss when bid.low low)
        const adv = isR ? (ah[k]! - entryLevel) : (entryLevel - bl[k]!); if (adv > mae) mae = adv;
        if (swingInBetween) { if (isR ? al[k]! <= swing : ah[k]! >= swing) crossedSwing = true; if (isR ? ah[k]! >= swing : al[k]! <= swing) touchedSwing = true; }
        const tpTouch = isR ? al[k]! <= tp : bh[k]! >= tp;
        const slTouch = isR ? ah[k]! >= slLevel : bl[k]! <= slLevel;
        if (tpTouch && slTouch) { oc = "ambiguous"; break; }
        if (tpTouch) { oc = "win"; pnl = D; break; }
        if (slTouch) { oc = "loss"; pnl = -SL; break; }
      }
      if (oc === "timeout") { const last = Math.min(rEnd, M - 1); pnl = isR ? (entryLevel - ac[last]!) / PIP : (bc[last]! - entryLevel) / PIP; }
      trades.push({ side: b.side, D, SL, entryTime: mt[ei]!, pnl, oc, mae: mae / PIP, swingInBetween, touchedSwing, crossedSwing });
    }
  }
}

// ---- aggregation ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const years = (new Date(raw[n - 1]!.time).getTime() - new Date(raw[startT]!.time).getTime()) / (365.25 * 864e5);
function stats(list: Trade[]) {
  const res = list.filter((t) => t.oc === "win" || t.oc === "loss" || t.oc === "timeout"); // resolved (excl ambiguous, no_entry)
  const wins = res.filter((t) => t.pnl > 0), losses = res.filter((t) => t.pnl < 0);
  const w = list.filter((t) => t.oc === "win").length, l = list.filter((t) => t.oc === "loss").length, to = list.filter((t) => t.oc === "timeout").length, amb = list.filter((t) => t.oc === "ambiguous").length;
  const grossW = wins.reduce((s, t) => s + t.pnl, 0), grossL = -losses.reduce((s, t) => s + t.pnl, 0);
  const total = res.reduce((s, t) => s + t.pnl, 0);
  // chronological max drawdown (pips)
  const seq = [...res].sort((a, b) => (a.entryTime < b.entryTime ? -1 : a.entryTime > b.entryTime ? 1 : 0));
  let eq = 0, peak = 0, dd = 0; for (const t of seq) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n: res.length, winTP: w, lossSL: l, timeouts: to, amb, winRate: pct(w, w + l), avgWin: mean(wins.map((t) => t.pnl)), avgLoss: mean(losses.map((t) => t.pnl)), pf: grossL > 0 ? grossW / grossL : Infinity, exp: res.length ? total / res.length : NaN, total, dd, perYear: res.length / years };
}

const L: string[] = []; const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — RANGE->SWING RETURN-TO-S/R WITH STOP (V10, research-only, FROZEN)");
L.push(`Data: M15 MID+BID+ASK (S/R) + M5 BID/ASK (trade path, ${M} bars). ${raw[startT]!.time} -> ${raw[n - 1]!.time} (~${f2(years)}y).`);
L.push(`FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS. Range->Swing breakouts ${brokeOut.support + brokeOut.resistance} (V7-V9 = 2484).`);
L.push(`Trade path on M5 (intrabar TP/SL order resolved); entry only AFTER breakout bar closes (no look-ahead). Win=+D, Loss=-SL, Timeout=mark-out at 24h. Same-M5-bar TP&SL=ambiguous(excluded).`);
L.push("");

L.push("=".repeat(140)); L.push("MAIN — 15p & 20p entry x stop (combined support+resistance)"); L.push("=".repeat(140));
L.push(["Entry", "Stop", "Trades", "WinsTP", "LossSL", "Tmout", "Amb", "Win%", "AvgWin", "AvgLoss", "PF", "Exp/trade", "TotalPips", "MaxDD", "Trd/yr"].map((s) => s.padStart(9)).join(""));
for (const D of DISTANCES) { for (const SL of STOPS) { const s = stats(trades.filter((t) => t.D === D && t.SL === SL)); L.push([`${D}p`, `${SL}p`, `${s.n}`, `${s.winTP}`, `${s.lossSL}`, `${s.timeouts}`, `${s.amb}`, f1(s.winRate), f2(s.avgWin), f2(s.avgLoss), f2(s.pf), f2(s.exp), f1(s.total), f1(s.dd), f1(s.perYear)].map((x) => x.padStart(9)).join("")); } L.push(""); }

// per side
for (const side of ["support", "resistance"] as Side[]) {
  L.push("=".repeat(140)); L.push(`${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"} only`); L.push("=".repeat(140));
  L.push(["Entry", "Stop", "Trades", "Win%", "PF", "Exp/trade", "TotalPips", "Trd/yr"].map((s) => s.padStart(10)).join(""));
  for (const D of DISTANCES) for (const SL of STOPS) { const s = stats(trades.filter((t) => t.D === D && t.SL === SL && t.side === side)); L.push([`${D}p`, `${SL}p`, `${s.n}`, f1(s.winRate), f2(s.pf), f2(s.exp), f1(s.total), f1(s.perYear)].map((x) => x.padStart(10)).join("")); }
  L.push("");
}

// swing-in-between diagnostic
L.push("=".repeat(140)); L.push("SWING-IN-BETWEEN DIAGNOSTIC (gap<=D means S/R#2 swing lies within the entry extension). Combined. Not used as a rule."); L.push("=".repeat(140));
L.push("(Indicator exposes only one swing + one range per side, so 'swing between S/R#1 and entry' == S/R#2 within D pips. touchedSwing/crossedSwing are near-definitional for in-between and reported as a check.)");
for (const D of DISTANCES) {
  const inb = trades.filter((t) => t.D === D && t.swingInBetween && t.oc !== "no_entry");
  const out = trades.filter((t) => t.D === D && !t.swingInBetween && t.oc !== "no_entry");
  const nInb = new Set(inb.filter((t) => t.SL === STOPS[0]).map((t) => t.entryTime)).size, nOut = new Set(out.filter((t) => t.SL === STOPS[0]).map((t) => t.entryTime)).size;
  L.push(`--- ${D}p entry: swing-in-between setups ~${nInb}, no-swing-between ~${nOut} ---`);
  L.push(["Group", "Stop", "Trades", "Win%", "PF", "Exp/trade", "TotalPips"].map((s) => s.padStart(11)).join(""));
  for (const [gname, glist] of [["SwingBetween", inb], ["NoSwingBetween", out]] as Array<[string, Trade[]]>) {
    for (const SL of STOPS) { const s = stats(glist.filter((t) => t.SL === SL)); L.push([gname, `${SL}p`, `${s.n}`, f1(s.winRate), f2(s.pf), f2(s.exp), f1(s.total)].map((x) => x.padStart(11)).join("")); }
    L.push("");
  }
  // touched/crossed rates for in-between (SL-independent; use first stop)
  const one = inb.filter((t) => t.SL === STOPS[0]);
  L.push(`   in-between path checks (n=${one.length}): touchedSwing ${f1(pct(one.filter((t) => t.touchedSwing).length, one.length))}%, crossedSwingReturning ${f1(pct(one.filter((t) => t.crossedSwing).length, one.length))}%`);
  L.push("");
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-stop-report.txt"), report + "\n");
console.log(report);

const csv: string[] = [];
csv.push(["entry_time", "side", "entry_distance", "stop", "outcome", "pnl_pips", "mae_pips", "swing_in_between", "touched_swing", "crossed_swing"].join(","));
for (const t of trades) if (t.oc !== "no_entry") csv.push([t.entryTime, t.side, t.D, t.SL, t.oc, Number.isFinite(t.pnl) ? t.pnl.toFixed(2) : "", Number.isFinite(t.mae) ? t.mae.toFixed(2) : "", t.swingInBetween ? "yes" : "no", t.touchedSwing ? "yes" : "no", t.crossedSwing ? "yes" : "no"].join(","));
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-stop-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-stop-report.txt | eurusd-15m-sr-stop-events.csv`);
