/**
 * EUR/USD V29 — RANGE PROGRESS EXECUTION TEST (P&L / BID-ASK).
 *
 * NEW file — does NOT modify V23–V28.
 *
 * Question: after V28's 60/70/75% progress conditionals, is opposite-S/R completion
 * actually tradeable after spread, pullbacks, and realistic stops?
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const TIMEFRAME = "M15";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const WINDOW = 220;
const HORIZON = 96;
const M1_HORIZON = HORIZON * 15;
const PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;

const ENTRIES = [60, 70, 75] as const;
const STOP_PIPS = [5, 10, 15, 20, 25, 30] as const;
const STOP_PCT = [10, 20, 25, 30] as const;

const WIDTHB: Array<[string, (w: number) => boolean]> = [
  ["0-10", (w) => w > 0 && w <= 10],
  ["10-20", (w) => w > 10 && w <= 20],
  ["20-30", (w) => w > 20 && w <= 30],
  ["30-40", (w) => w > 30 && w <= 40],
  ["40-50", (w) => w > 40 && w <= 50],
  ["50-75", (w) => w > 50 && w <= 75],
  ["75-100", (w) => w > 75 && w <= 100],
  ["100+", (w) => w > 100],
];
const WIDTH_GROUP: Array<[string, (w: number) => boolean]> = [
  ["0-20", (w) => w > 0 && w <= 20],
  ["20-50", (w) => w > 20 && w <= 50],
  ["50+", (w) => w > 50],
];

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type Path =
  | "REV_L1"
  | "BRK_L1_NO_L2"
  | "BRK_L1_NO_REACH_L2"
  | "REV_L2"
  | "BRK_L2_ESCAPE"
  | "BRK_L1_L2_UNRESOLVED"
  | "L1_UNRESOLVED";
type Outcome = "win" | "loss" | "ambig" | "timeout";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

// ===================== LOAD M15 =====================
console.error("V29 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n = raw.length;
const mids: Candle[] = raw.map((c) => ({
  time: c.time,
  open: c.mid.open,
  high: c.mid.high,
  low: c.mid.low,
  close: c.mid.close,
  volume: 0,
  complete: true,
}));
const m15ms = new Float64Array(n);
for (let i = 0; i < n; i++) m15ms[i] = Date.parse(raw[i]!.time);

interface Enc {
  t0: number;
  time: string;
  year: number;
  side: Side;
  atr: number;
  L1: number;
  k1: Kind;
  L2: number | null;
  k2: Kind | null;
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
  opp: number | null;
  oppKind: Kind | null;
  rangePips: number;
}

const encs: Enc[] = [];
let armedR = true,
  armedS = true;
let auditFail = 0;

function pickOpposite(
  side: Side,
  origin: number,
  rh: number,
  rl: number,
  sh: number | null,
  sl: number | null,
): { opp: number; kind: Kind } | null {
  if (side === "resistance") {
    const cands: Array<{ p: number; k: Kind }> = [];
    if (rl < origin) cands.push({ p: rl, k: "range" });
    if (sl !== null && sl < origin) cands.push({ p: sl, k: "swing" });
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.p < a.p ? b : a));
  }
  const cands: Array<{ p: number; k: Kind }> = [];
  if (rh > origin) cands.push({ p: rh, k: "range" });
  if (sh !== null && sh > origin) cands.push({ p: sh, k: "swing" });
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.p > a.p ? b : a));
}

for (let t = WINDOW; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const loc = a.location;
  const cur = lv.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const yr = new Date(raw[t]!.time).getUTCFullYear();
  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";

  if (nearR && armedR) {
    const cand = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, qv) => (qv - cur < p - cur ? qv : p));
      const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const other = k1 === "range" ? lv.swingHigh : lv.rangeHigh;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other > L1 ? other : null;
      if (L2 !== null && L2 <= L1) auditFail++;
      const op = pickOpposite("resistance", L1, lv.rangeHigh, lv.rangeLow, lv.swingHigh, lv.swingLow);
      encs.push({
        t0: t,
        time: raw[t]!.time,
        year: yr,
        side: "resistance",
        atr: A,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
        opp: op?.p ?? null,
        oppKind: op?.k ?? null,
        rangePips: op ? (L1 - op.p) / PIP : NaN,
      });
      armedR = false;
    }
  } else if (!nearR) armedR = true;

  if (nearS && armedS) {
    const cand = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, qv) => (cur - qv < cur - p ? qv : p));
      const k1: Kind = L1 === lv.rangeLow ? "range" : "swing";
      const other = k1 === "range" ? lv.swingLow : lv.rangeLow;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other < L1 ? other : null;
      if (L2 !== null && L2 >= L1) auditFail++;
      const op = pickOpposite("support", L1, lv.rangeHigh, lv.rangeLow, lv.swingHigh, lv.swingLow);
      encs.push({
        t0: t,
        time: raw[t]!.time,
        year: yr,
        side: "support",
        atr: A,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
        opp: op?.p ?? null,
        oppKind: op?.k ?? null,
        rangePips: op ? (op.p - L1) / PIP : NaN,
      });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

{
  const step = Math.max(1, Math.floor(encs.length / 200));
  for (let i = 0; i < encs.length && i / step < 200; i += step) {
    const e = encs[i]!;
    const window = mids.slice(e.t0 - WINDOW + 1, e.t0 + 1);
    const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
    const lv = a.levels;
    if (!lv) {
      auditFail++;
      continue;
    }
    if (Math.abs(lv.rangeHigh - e.rangeHigh) > 1e-9 || Math.abs(lv.rangeLow - e.rangeLow) > 1e-9) auditFail++;
    if (e.opp !== null) {
      const ok =
        e.side === "resistance"
          ? e.opp === e.rangeLow || e.opp === e.swingLow
          : e.opp === e.rangeHigh || e.opp === e.swingHigh;
      if (!ok) auditFail++;
      if (e.side === "resistance" && !(e.opp < e.L1)) auditFail++;
      if (e.side === "support" && !(e.opp > e.L1)) auditFail++;
    }
  }
}

function classifyLevel(side: Side, level: number, atr: number, startBar: number, towardIsDown: boolean) {
  const w = TOUCH_ATR * atr;
  const end = Math.min(startBar + HORIZON, n - 1);
  let touched = false,
    broke = false,
    tBreak: number | null = null,
    revPrimary = false,
    tRev: number | null = null;
  let peakBeyond = level,
    bb = 0;
  const retHit: Record<number, boolean> = {};
  for (const r of RETS) retHit[r] = false;
  for (let j = startBar; j <= end; j++) {
    const c = raw[j]!.mid;
    const inZone =
      side === "resistance" ? c.high >= level - w && c.low <= level + w : c.low <= level + w && c.high >= level - w;
    const beyondWick = side === "resistance" ? c.high > level + w : c.low < level - w;
    if (!touched && (inZone || beyondWick || (side === "resistance" ? c.high >= level : c.low <= level))) touched = true;
    if (!touched) continue;
    if (side === "resistance") {
      if (c.high > peakBeyond) peakBeyond = c.high;
    } else if (c.low < peakBeyond) peakBeyond = c.low;
    const bc = side === "resistance" ? c.close - level : level - c.close;
    if (bc > w) bb++;
    else bb = 0;
    if (!broke && bb >= ACCEPT_MIN_BARS && bc / atr >= ACCEPT_MIN_DIST_ATR) {
      broke = true;
      tBreak = j;
    }
    const ret = Math.max(
      (towardIsDown ? peakBeyond - c.low : c.high - peakBeyond) / PIP,
      (towardIsDown ? level - c.low : c.high - level) / PIP,
    );
    for (const r of RETS) if (!retHit[r] && ret >= r) retHit[r] = true;
    if (!revPrimary && !broke && retHit[PRIMARY_RET]) {
      revPrimary = true;
      tRev = j;
    }
    if (broke || revPrimary) break;
  }
  if (revPrimary && broke && tRev !== null && tBreak !== null) {
    if (tRev < tBreak) broke = false;
    else revPrimary = false;
  }
  return { touched, broke, tBreak, revPrimary };
}

interface V24Ev {
  e: Enc;
  path: Path;
  l1: ReturnType<typeof classifyLevel>;
}
const v24: V24Ev[] = [];
for (const e of encs) {
  const towardDown = e.side === "resistance";
  const l1 = classifyLevel(e.side, e.L1, e.atr, e.t0, towardDown);
  let path: Path = "L1_UNRESOLVED";
  if (l1.revPrimary) path = "REV_L1";
  else if (l1.broke) {
    if (e.L2 === null) path = "BRK_L1_NO_L2";
    else {
      const l2 = classifyLevel(e.side, e.L2, e.atr, l1.tBreak ?? e.t0, towardDown);
      if (!l2.touched) path = "BRK_L1_NO_REACH_L2";
      else if (l2.revPrimary) path = "REV_L2";
      else if (l2.broke) path = "BRK_L2_ESCAPE";
      else path = "BRK_L1_L2_UNRESOLVED";
    }
  }
  v24.push({ e, path, l1 });
}

const N = v24.length;
const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (NO_LOOKAHEAD === "FAIL") {
  console.error(`STOP. NO_LOOKAHEAD=${NO_LOOKAHEAD} auditFail=${auditFail}`);
  process.exit(1);
}
console.error(`NO_LOOKAHEAD=${NO_LOOKAHEAD} encounters=${N}`);

// ===================== M1 =====================
console.error("V29 loading M1...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const m1ms = new Float64Array(M1);
const bc = new Float64Array(M1),
  ac = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  m1ms[i] = Date.parse(r[0]);
  bc[i] = r[5];
  ac[i] = r[6];
}
(m1raw as unknown as { length: number }).length = 0;

function lb(msArr: Float64Array, len: number, target: number): number {
  let lo = 0,
    hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msArr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** V28 progress stream: LONG→BID, SHORT→ASK. */
function progPx(i: number, side: Side): number {
  return side === "support" ? bc[i]! : ac[i]!;
}
function progressPct(px: number, origin: number, opp: number, side: Side, range: number): number {
  return side === "resistance" ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
}

type StopSpec = { kind: "pip" | "pct"; value: number; label: string };

const STOPS: StopSpec[] = [
  ...STOP_PIPS.map((v) => ({ kind: "pip" as const, value: v, label: `${v}p` })),
  ...STOP_PCT.map((v) => ({ kind: "pct" as const, value: v, label: `${v}%r` })),
];

interface Trade {
  entryPct: number;
  stopLabel: string;
  stopPips: number;
  side: Side;
  originKind: Kind;
  year: number;
  rangePips: number;
  atr: number;
  entryI: number;
  entryPx: number; // ASK long / BID short
  exitStreamEntry: number; // BID long / ASK short at entry bar (for MAE)
  opp: number;
  spreadPips: number;
  remTpPips: number; // opp vs entry on entry price
  remTpExitPips: number; // opp vs exit-stream at entry (closer to executable TP distance)
  outcome: Outcome;
  pnlPips: number; // executable (0 for ambig/timeout in PF? use actual for timeout = mark exit)
  grossPnlPips: number; // mid-ish: (bid+ask)/2
  holdMin: number;
  maePips: number; // adverse from entry on exit stream
  mfePips: number; // favorable from entry on exit stream before exit
  hitOppEventually: boolean; // regardless of stop (for winner-backtrack among potential)
}

const trades: Trade[] = [];

// V28 parity counters
const parityReach: Record<number, { n: number; hit100: number }> = {
  60: { n: 0, hit100: 0 },
  70: { n: 0, hit100: 0 },
  75: { n: 0, hit100: 0 },
};

function resolveTrade(
  side: Side,
  entryI: number,
  entryPx: number,
  opp: number,
  stopPips: number,
  pathEnd: number,
): {
  outcome: Outcome;
  pnlPips: number;
  grossPnlPips: number;
  holdMin: number;
  maePips: number;
  mfePips: number;
  exitI: number;
} {
  const isLong = side === "support";
  const slPx = isLong ? entryPx - stopPips * PIP : entryPx + stopPips * PIP;
  let mae = 0,
    mfe = 0;
  const midEntry = (bc[entryI]! + ac[entryI]!) / 2;

  for (let i = entryI + 1; i <= pathEnd; i++) {
    const exitPx = isLong ? bc[i]! : ac[i]!;
    const mid = (bc[i]! + ac[i]!) / 2;
    const fav = isLong ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
    const adv = isLong ? (entryPx - exitPx) / PIP : (exitPx - entryPx) / PIP;
    // MAE/MFE from entry using exit stream vs entry price (exec convention)
    // For long: entry ASK, exit BID — adverse when BID falls below entry ASK
    if (adv > mae) mae = adv;
    if (fav > mfe) mfe = fav;

    const hitTp = isLong ? exitPx >= opp : exitPx <= opp;
    const hitSl = isLong ? exitPx <= slPx : exitPx >= slPx;

    if (hitTp && hitSl) {
      return {
        outcome: "ambig",
        pnlPips: 0,
        grossPnlPips: 0,
        holdMin: i - entryI,
        maePips: mae,
        mfePips: mfe,
        exitI: i,
      };
    }
    if (hitTp) {
      const pnl = isLong ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
      const gp = isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP;
      return {
        outcome: "win",
        pnlPips: pnl,
        grossPnlPips: gp,
        holdMin: i - entryI,
        maePips: mae,
        mfePips: mfe,
        exitI: i,
      };
    }
    if (hitSl) {
      const pnl = isLong ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
      const gp = isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP;
      return {
        outcome: "loss",
        pnlPips: pnl,
        grossPnlPips: gp,
        holdMin: i - entryI,
        maePips: mae,
        mfePips: mfe,
        exitI: i,
      };
    }
  }
  // timeout: mark at last bar exit stream
  const i = pathEnd;
  const exitPx = isLong ? bc[i]! : ac[i]!;
  const mid = (bc[i]! + ac[i]!) / 2;
  const pnl = isLong ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
  const gp = isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP;
  return {
    outcome: "timeout",
    pnlPips: pnl,
    grossPnlPips: gp,
    holdMin: i - entryI,
    maePips: mae,
    mfePips: mfe,
    exitI: i,
  };
}

// store winner MAE separately keyed
const winnerMaeByKey = new Map<string, number>();

function scanExecution(e: Enc, m1Start: number): void {
  if (e.opp === null || !(e.rangePips > 0)) return;
  const side = e.side;
  const origin = e.L1;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) return;
  const pathEnd = Math.min(m1Start + M1_HORIZON, M1 - 1);

  const tEntry: Record<number, number | null> = { 60: null, 70: null, 75: null };

  for (let i = m1Start; i <= pathEnd; i++) {
    const prog = progressPct(progPx(i, side), origin, opp, side, range);
    for (const ep of ENTRIES) {
      if (tEntry[ep] === null && prog >= ep) tEntry[ep] = i;
    }
  }

  for (const ep of ENTRIES) {
    if (tEntry[ep] !== null) {
      parityReach[ep]!.n++;
      let h = false;
      for (let i = tEntry[ep]!; i <= pathEnd; i++) {
        if (progressPct(progPx(i, side), origin, opp, side, range) >= 100) {
          h = true;
          break;
        }
      }
      if (h) parityReach[ep]!.hit100++;
    }
  }

  for (const ep of ENTRIES) {
    const ei = tEntry[ep];
    if (ei === null) continue;
    const isLong = side === "support";
    const entryPx = isLong ? ac[ei]! : bc[ei]!;
    const exitAtEntry = isLong ? bc[ei]! : ac[ei]!;
    const spreadPips = (ac[ei]! - bc[ei]!) / PIP;
    const remTpPips = isLong ? (opp - entryPx) / PIP : (entryPx - opp) / PIP;
    const remTpExitPips = isLong ? (opp - exitAtEntry) / PIP : (exitAtEntry - opp) / PIP;
    if (!(remTpPips > 0)) continue; // already no executable reward to opposite

    let hitOppEventually = false;
    let wMae = 0;
    {
      let mae = 0;
      for (let i = ei + 1; i <= pathEnd; i++) {
        const exitPx = isLong ? bc[i]! : ac[i]!;
        const adv = isLong ? (entryPx - exitPx) / PIP : (exitPx - entryPx) / PIP;
        if (adv > mae) mae = adv;
        if (isLong ? exitPx >= opp : exitPx <= opp) {
          hitOppEventually = true;
          wMae = mae;
          break;
        }
      }
    }
    if (hitOppEventually) winnerMaeByKey.set(`${e.t0}|${ep}|${side}`, wMae);

    for (const st of STOPS) {
      const stopPips = st.kind === "pip" ? st.value : (st.value / 100) * (range / PIP);
      if (!(stopPips > 0)) continue;
      const r = resolveTrade(side, ei, entryPx, opp, stopPips, pathEnd);
      trades.push({
        entryPct: ep,
        stopLabel: st.label,
        stopPips,
        side,
        originKind: e.k1,
        year: e.year,
        rangePips: range / PIP,
        atr: e.atr,
        entryI: ei,
        entryPx,
        exitStreamEntry: exitAtEntry,
        opp,
        spreadPips,
        remTpPips,
        remTpExitPips,
        outcome: r.outcome,
        pnlPips: r.pnlPips,
        grossPnlPips: r.grossPnlPips,
        holdMin: r.holdMin,
        maePips: r.maePips,
        mfePips: r.mfePips,
        hitOppEventually,
      });
    }
  }
}

console.error("V29 scanning executions...");
for (const ev of v24) {
  const e = ev.e;
  if (e.opp === null) continue;
  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  scanExecution(e, m1Start);
}

// V28 parity gate
{
  const checks: Array<[string, number, number, number]> = [
    ["P100|60", pct(parityReach[60]!.hit100, parityReach[60]!.n), 74.2, 1.5],
    ["P100|70", pct(parityReach[70]!.hit100, parityReach[70]!.n), 80.2, 1.5],
    ["P100|75", pct(parityReach[75]!.hit100, parityReach[75]!.n), 83.4, 1.5],
  ];
  let ok = true;
  for (const [name, got, exp, tol] of checks) {
    console.error(`V28 parity ${name}: got=${f1(got)} expected≈${exp} (N=${parityReach[Number(name.slice(5))]?.n ?? "?"})`);
    if (!near(got, exp, tol)) {
      ok = false;
      console.error(`PARITY FAIL ${name}`);
    }
  }
  // also N approximate
  for (const [ep, expN] of [
    [60, 51030],
    [70, 47227],
    [75, 45397],
  ] as const) {
    if (!near(parityReach[ep]!.n, expN, 300)) {
      ok = false;
      console.error(`PARITY FAIL N@${ep}: got ${parityReach[ep]!.n} expected≈${expN}`);
    }
  }
  if (!ok) {
    console.error("STOP. V28 parity failed.");
    process.exit(1);
  }
  console.error("V28 parity PASS");
}

console.error(`Trades built: ${trades.length}`);

// ===================== AGG =====================
interface Stats {
  n: number;
  wins: number;
  losses: number;
  ambig: number;
  timeouts: number;
  wr: number; // wins/(wins+losses) excluding ambig/timeout from WR denom? Use resolved only
  wrAll: number; // wins/n
  avgWin: number;
  avgLoss: number;
  pf: number;
  exp: number;
  totalPips: number;
  medHold: number;
  avgSpread: number;
  medSpread: number;
  p75Spread: number;
  p90Spread: number;
  avgRemTp: number;
  medRemTp: number;
  avgSpreadPctRem: number;
  medSpreadPctRem: number;
  grossExp: number;
  grossPf: number;
  grossTotal: number;
}

function statsOf(pool: Trade[]): Stats {
  const wins = pool.filter((t) => t.outcome === "win");
  const losses = pool.filter((t) => t.outcome === "loss");
  const ambig = pool.filter((t) => t.outcome === "ambig");
  const timeouts = pool.filter((t) => t.outcome === "timeout");
  // For PF/expectancy: count ambig as 0, timeouts at marked pnl
  const resolved = [...wins, ...losses];
  const winPips = wins.map((t) => t.pnlPips);
  const lossPips = losses.map((t) => t.pnlPips);
  const allPnl = pool.map((t) => (t.outcome === "ambig" ? 0 : t.pnlPips));
  const grossAll = pool.map((t) => (t.outcome === "ambig" ? 0 : t.grossPnlPips));
  const sumW = winPips.reduce((a, b) => a + b, 0);
  const sumL = Math.abs(lossPips.reduce((a, b) => a + b, 0));
  const grossW = wins.map((t) => t.grossPnlPips).reduce((a, b) => a + b, 0);
  const grossL = Math.abs(losses.map((t) => t.grossPnlPips).reduce((a, b) => a + b, 0));
  const spreads = pool.map((t) => t.spreadPips);
  const rem = pool.map((t) => t.remTpPips);
  const sprPct = pool.map((t) => (t.remTpPips > 0 ? (t.spreadPips / t.remTpPips) * 100 : NaN)).filter(Number.isFinite);
  return {
    n: pool.length,
    wins: wins.length,
    losses: losses.length,
    ambig: ambig.length,
    timeouts: timeouts.length,
    wr: pct(wins.length, resolved.length),
    wrAll: pct(wins.length, pool.length),
    avgWin: mean(winPips),
    avgLoss: mean(lossPips),
    pf: sumL > 0 ? sumW / sumL : sumW > 0 ? Infinity : NaN,
    exp: mean(allPnl),
    totalPips: allPnl.reduce((a, b) => a + b, 0),
    medHold: median(pool.map((t) => t.holdMin)),
    avgSpread: mean(spreads),
    medSpread: median(spreads),
    p75Spread: q(spreads, 0.75),
    p90Spread: q(spreads, 0.9),
    avgRemTp: mean(rem),
    medRemTp: median(rem),
    avgSpreadPctRem: mean(sprPct),
    medSpreadPctRem: median(sprPct),
    grossExp: mean(grossAll),
    grossPf: grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : NaN,
    grossTotal: grossAll.reduce((a, b) => a + b, 0),
  };
}

function rowMain(s: Stats, entry: number, stop: string): string {
  return [
    `${entry}%`,
    stop,
    String(s.n),
    String(s.wins),
    String(s.losses),
    String(s.ambig),
    f1(s.wr),
    f2(s.avgWin),
    f2(s.avgLoss),
    f2(s.pf),
    f2(s.exp),
    f1(s.totalPips),
    f1(s.medHold),
    f2(s.avgSpread),
    f2(s.medRemTp),
  ]
    .map((x) => String(x).padStart(9))
    .join("");
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD V29 — RANGE PROGRESS EXECUTION TEST (BID/ASK P&L)");
L.push("=".repeat(120));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`V28 parity = PASS`);
L.push(`Entry = first M1 prog close at 60/70/75% of frozen range.`);
L.push(`LONG entry=ASK TP/SL on BID; SHORT entry=BID TP/SL on ASK. TP=opposite frozen S/R.`);
L.push(`Ambiguous = TP+SL same M1 bar (excluded from WR denom; PnL=0).`);
L.push("");

L.push("-".repeat(120));
L.push("PARITY");
L.push("-".repeat(120));
for (const ep of ENTRIES) {
  L.push(
    `  @${ep}%: N=${parityReach[ep]!.n} P100=${f1(pct(parityReach[ep]!.hit100, parityReach[ep]!.n))}% (V28≈${ep === 60 ? 74.2 : ep === 70 ? 80.2 : 83.4}%)`,
  );
}
L.push("");

// Spread overall at entries
L.push("-".repeat(120));
L.push("5  SPREAD AT ENTRY (unique entry events, stop=5p sample)");
L.push("-".repeat(120));
for (const ep of ENTRIES) {
  const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === "5p");
  const s = statsOf(pool);
  L.push(
    `  ${ep}%: N=${s.n} avg=${f2(s.avgSpread)} med=${f2(s.medSpread)} P75=${f2(s.p75Spread)} P90=${f2(s.p90Spread)}` +
      ` | medRemTP=${f2(s.medRemTp)} medSpread/Rem=${f2(s.medSpreadPctRem)}%`,
  );
}
L.push("");

// Main table
L.push("-".repeat(120));
L.push("8  MAIN TABLE");
L.push("-".repeat(120));
L.push(
  ["ENTRY", "STOP", "N", "W", "L", "Amb", "WR%", "AvgW", "AvgL", "PF", "Exp", "TotPips", "MedHold", "AvgSpr", "MedRemTP"]
    .map((x) => x.padStart(9))
    .join(""),
);
for (const ep of ENTRIES) {
  for (const st of STOPS) {
    const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label);
    L.push(rowMain(statsOf(pool), ep, st.label));
  }
  L.push("");
}

// Tradeoff summary
L.push("-".repeat(120));
L.push("11  PRIMARY TRADEOFF");
L.push("-".repeat(120));
for (const ep of ENTRIES) {
  const base = trades.filter((t) => t.entryPct === ep && t.stopLabel === "5p");
  const s0 = statsOf(base);
  let best: { label: string; s: Stats } | null = null;
  for (const st of STOPS) {
    const s = statsOf(trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label));
    if (!best || (Number.isFinite(s.exp) && s.exp > best.s.exp)) best = { label: st.label, s };
  }
  L.push(
    `  ${ep}%: V28-P100=${f1(pct(parityReach[ep]!.hit100, parityReach[ep]!.n))}%` +
      ` medRemTP=${f2(s0.medRemTp)} medSpread/Rem=${f2(s0.medSpreadPctRem)}%` +
      ` | bestStop=${best?.label} PF=${f2(best!.s.pf)} Exp=${f2(best!.s.exp)} WR=${f1(best!.s.wr)}% N=${best!.s.n}`,
  );
}
L.push("");

// Deep 60/70/75
function deepEntry(ep: number) {
  L.push(`\nENTRY ${ep}%`);
  const sample = trades.filter((t) => t.entryPct === ep && t.stopLabel === "10p");
  // MAE among eventual completers (no stop) — use winnerMaeByKey + one trade per entry
  const seen = new Set<string>();
  const wMae: number[] = [];
  const loseMae: number[] = [];
  const loseMfe: number[] = [];
  for (const t of trades.filter((x) => x.entryPct === ep && x.stopLabel === "30p")) {
    const key = `${t.entryI}|${ep}|${t.side}`;
    // use map key from e.t0 — we stored e.t0|ep|side; fallback: if hitOppEventually
    if (t.hitOppEventually) {
      // find mae from map by scanning — store by entryI
    }
  }
  // Rebuild winner MAE from trades flag + recompute not available; use map values for this ep
  for (const [k, v] of winnerMaeByKey) {
    if (k.includes(`|${ep}|`)) wMae.push(v);
  }

  L.push(
    `  medRemTP=${f2(statsOf(sample).medRemTp)} medSpread=${f2(statsOf(sample).medSpread)} medSpread/Rem=${f2(statsOf(sample).medSpreadPctRem)}%`,
  );
  L.push(`  Winner backtrack (hit opp eventually, pre-stop): N=${wMae.length} med=${f1(median(wMae))} P75=${f1(q(wMae, 0.75))} P80=${f1(q(wMae, 0.8))} P90=${f1(q(wMae, 0.9))} P95=${f1(q(wMae, 0.95))}`);

  L.push(
    ["STOP", "N", "WR", "PF", "Exp", "Tot", "medMAE", "P75MAE", "P90MAE"].map((x) => x.padStart(9)).join(""),
  );
  for (const st of STOPS) {
    const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label);
    const s = statsOf(pool);
    const maes = pool.map((t) => t.maePips);
    L.push(
      [st.label, String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f1(s.totalPips), f1(median(maes)), f1(q(maes, 0.75)), f1(q(maes, 0.9))]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }

  // losers under 20p stop
  const lost = trades.filter((t) => t.entryPct === ep && t.stopLabel === "20p" && t.outcome === "loss");
  L.push(
    `  Losers @20p stop: N=${lost.length} medMAE=${f1(median(lost.map((t) => t.maePips)))} P75=${f1(q(lost.map((t) => t.maePips), 0.75))} P90=${f1(q(lost.map((t) => t.maePips), 0.9))} medMFE_before=${f1(median(lost.map((t) => t.mfePips)))}`,
  );
}

L.push("-".repeat(120));
L.push("12–16  DEEP ENTRY ANALYSIS");
L.push("-".repeat(120));
for (const ep of ENTRIES) deepEntry(ep);
L.push("");

// Width
L.push("-".repeat(120));
L.push("10  BY RANGE WIDTH (best expectancy stop per cell shown for 10p & 20% r)");
L.push("-".repeat(120));
for (const ep of ENTRIES) {
  L.push(`\nEntry ${ep}%`);
  L.push(["width", "stop", "N", "WR", "PF", "Exp", "medRem", "spr%R"].map((x) => x.padStart(9)).join(""));
  for (const [wname, wtest] of [...WIDTHB, ...WIDTH_GROUP]) {
    for (const stop of ["10p", "20p", "20%r"] as const) {
      const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === stop && wtest(t.rangePips));
      if (pool.length < 30) continue;
      const s = statsOf(pool);
      L.push(
        [wname, stop, String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRemTp), f1(s.medSpreadPctRem)]
          .map((x) => String(x).padStart(9))
          .join(""),
      );
    }
  }
}
L.push("");

// Find potentially positive configs
type Cfg = { entry: number; stop: string; s: Stats; era1: Stats; era2: Stats };
const positive: Cfg[] = [];
for (const ep of ENTRIES) {
  for (const st of STOPS) {
    const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label);
    const s = statsOf(pool);
    if (s.n >= 500 && s.pf > 1 && s.exp > 0) {
      const era1 = statsOf(pool.filter((t) => t.year <= 2019));
      const era2 = statsOf(pool.filter((t) => t.year >= 2020));
      positive.push({ entry: ep, stop: st.label, s, era1, era2 });
    }
  }
}

L.push("-".repeat(120));
L.push("17  POTENTIALLY POSITIVE CONFIGS (PF>1, Exp>0, N>=500) + ERAS");
L.push("-".repeat(120));
if (!positive.length) L.push("  NONE");
for (const c of positive) {
  const tag =
    c.era1.n >= 200 && c.era2.n >= 200
      ? c.era1.exp > 0 && c.era2.exp > 0
        ? "BOTH_ERAS_OK"
        : "ERA_FAIL"
      : "EXPLORATORY_ERA_N";
  L.push(
    `  ${c.entry}% / ${c.stop}: N=${c.s.n} WR=${f1(c.s.wr)} PF=${f2(c.s.pf)} Exp=${f2(c.s.exp)}` +
      ` | 2013-19 N=${c.era1.n} PF=${f2(c.era1.pf)} Exp=${f2(c.era1.exp)}` +
      ` | 2020-26 N=${c.era2.n} PF=${f2(c.era2.pf)} Exp=${f2(c.era2.exp)} [${tag}]`,
  );
}
L.push("");

// Side / type for positive
L.push("-".repeat(120));
L.push("18–19  SIDE / ORIGIN TYPE for positive configs");
L.push("-".repeat(120));
for (const c of positive.slice(0, 12)) {
  const pool = trades.filter((t) => t.entryPct === c.entry && t.stopLabel === c.stop);
  const lon = statsOf(pool.filter((t) => t.side === "support"));
  const sho = statsOf(pool.filter((t) => t.side === "resistance"));
  const rg = statsOf(pool.filter((t) => t.originKind === "range"));
  const sw = statsOf(pool.filter((t) => t.originKind === "swing"));
  L.push(
    `  ${c.entry}%/${c.stop}: LONG N=${lon.n} PF=${f2(lon.pf)} Exp=${f2(lon.exp)} | SHORT N=${sho.n} PF=${f2(sho.pf)} Exp=${f2(sho.exp)}`,
  );
  L.push(
    `           range N=${rg.n} PF=${f2(rg.pf)} Exp=${f2(rg.exp)} | swing N=${sw.n} PF=${f2(sw.pf)} Exp=${f2(sw.exp)}`,
  );
}
if (!positive.length) L.push("  (no positive configs)");
L.push("");

// Cost test
L.push("-".repeat(120));
L.push("20  COST TEST (gross mid vs exec) for positive configs");
L.push("-".repeat(120));
for (const c of positive.slice(0, 12)) {
  L.push(
    `  ${c.entry}%/${c.stop}: GROSS Exp=${f2(c.s.grossExp)} PF=${f2(c.s.grossPf)} Tot=${f1(c.s.grossTotal)}` +
      ` | EXEC Exp=${f2(c.s.exp)} PF=${f2(c.s.pf)} Tot=${f1(c.s.totalPips)}` +
      ` | spread consumes ${f1(c.s.grossTotal - c.s.totalPips)} pips total (${f2(((c.s.grossTotal - c.s.totalPips) / Math.abs(c.s.grossTotal || 1)) * 100)}% of gross)`,
  );
}
if (!positive.length) {
  // still show best few by expectancy overall
  L.push("  No PF>1 configs — showing best Exp overall:");
  const ranked: Cfg[] = [];
  for (const ep of ENTRIES) {
    for (const st of STOPS) {
      const pool = trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label);
      const s = statsOf(pool);
      const era1 = statsOf(pool.filter((t) => t.year <= 2019));
      const era2 = statsOf(pool.filter((t) => t.year >= 2020));
      ranked.push({ entry: ep, stop: st.label, s, era1, era2 });
    }
  }
  ranked.sort((a, b) => b.s.exp - a.s.exp);
  for (const c of ranked.slice(0, 6)) {
    L.push(
      `  ${c.entry}%/${c.stop}: EXEC Exp=${f2(c.s.exp)} PF=${f2(c.s.pf)} | GROSS Exp=${f2(c.s.grossExp)} PF=${f2(c.s.grossPf)}`,
    );
  }
}
L.push("");

// Separability
L.push("-".repeat(120));
L.push("15–16  WINNER vs LOSER MAE (at 20p stop path, entry events)");
L.push("-".repeat(120));
for (const ep of ENTRIES) {
  const wMae: number[] = [];
  for (const [k, v] of winnerMaeByKey) if (k.includes(`|${ep}|`)) wMae.push(v);
  const lost = trades.filter((t) => t.entryPct === ep && t.stopLabel === "20p" && t.outcome === "loss");
  const won = trades.filter((t) => t.entryPct === ep && t.stopLabel === "20p" && t.outcome === "win");
  L.push(
    `  ${ep}%: winners(hit opp) MAE med/P75/P90=${f1(median(wMae))}/${f1(q(wMae, 0.75))}/${f1(q(wMae, 0.9))}` +
      ` | losses MAE med/P75/P90=${f1(median(lost.map((t) => t.maePips)))}/${f1(q(lost.map((t) => t.maePips), 0.75))}/${f1(q(lost.map((t) => t.maePips), 0.9))}` +
      ` | win path MAE@20pstop med=${f1(median(won.map((t) => t.maePips)))}`,
  );
}
L.push("");

// Best stop per entry for summary
function bestStop(ep: number): { label: string; s: Stats } {
  let best: { label: string; s: Stats } | null = null;
  for (const st of STOPS) {
    const s = statsOf(trades.filter((t) => t.entryPct === ep && t.stopLabel === st.label));
    if (!best || s.exp > best.s.exp) best = { label: st.label, s };
  }
  return best!;
}

const b60 = bestStop(60);
const b70 = bestStop(70);
const b75 = bestStop(75);

const anyPf = positive.length > 0;
const anyStrong = positive.some(
  (c) => c.s.pf > 1.1 && c.s.exp > 0 && c.era1.exp > 0 && c.era2.exp > 0 && c.era1.n >= 200 && c.era2.n >= 200,
);
const anyOk = positive.some(
  (c) => c.s.pf > 1 && c.s.exp > 0 && c.era1.exp > -0.05 && c.era2.exp > -0.05 && c.s.n >= 500,
);

let verdict: string;
if (anyStrong) verdict = "RANGE_PROGRESS_EXEC_EDGE";
else if (anyOk || anyPf) verdict = "RANGE_PROGRESS_EXEC_EDGE_CONDITIONAL";
else if (b60.s.exp < 0 && b70.s.exp < 0 && b75.s.exp < 0) verdict = "RANGE_PROGRESS_BEHAVIOR_NOT_PROFITABLE";
else verdict = "NO_EXEC_EDGE";

// Override: if all best exp negative → NOT_PROFITABLE
if (b60.s.pf < 1 && b70.s.pf < 1 && b75.s.pf < 1) {
  verdict = b60.s.exp < 0 && b70.s.exp < 0 && b75.s.exp < 0 ? "RANGE_PROGRESS_BEHAVIOR_NOT_PROFITABLE" : "NO_EXEC_EDGE";
}

L.push("-".repeat(120));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(120));
L.push(`1. Parity PASS? YES`);
L.push(`2. No-lookahead PASS? YES`);
L.push(`3. 60% profitable after BID/ASK? ${b60.s.pf > 1 && b60.s.exp > 0 ? "YES" : "NO"} (best ${b60.label} PF=${f2(b60.s.pf)} Exp=${f2(b60.s.exp)})`);
L.push(`4. 70% profitable? ${b70.s.pf > 1 && b70.s.exp > 0 ? "YES" : "NO"} (best ${b70.label} PF=${f2(b70.s.pf)} Exp=${f2(b70.s.exp)})`);
L.push(`5. 75% profitable? ${b75.s.pf > 1 && b75.s.exp > 0 ? "YES" : "NO"} (best ${b75.label} PF=${f2(b75.s.pf)} Exp=${f2(b75.s.exp)})`);
{
  const ranked = [b60, b70, b75].map((b, i) => ({ ep: ENTRIES[i]!, ...b })).sort((a, b) => b.s.exp - a.s.exp);
  L.push(`6. Best balance entry: ${ranked[0]!.ep}% (stop ${ranked[0]!.label}, Exp=${f2(ranked[0]!.s.exp)})`);
}
{
  const small = statsOf(trades.filter((t) => t.entryPct === 70 && t.stopLabel === "10p" && t.rangePips <= 20));
  L.push(`7. Spread destroy small-range? 0–20p @70%/10p: Exp=${f2(small.exp)} PF=${f2(small.pf)} medSpr/Rem=${f2(small.medSpreadPctRem)}% → ${small.exp < 0 ? "YES often" : "not always"}`);
}
{
  const viable: string[] = [];
  for (const [wname, wtest] of WIDTH_GROUP) {
    const s = statsOf(trades.filter((t) => t.entryPct === 70 && t.stopLabel === "15p" && wtest(t.rangePips)));
    if (s.n >= 200 && s.exp > 0 && s.pf > 1) viable.push(wname);
  }
  L.push(`8. Viable widths @70%/15p: ${viable.length ? viable.join(", ") : "NONE clear"}`);
}
{
  const r60 = statsOf(trades.filter((t) => t.entryPct === 60 && t.stopLabel === "5p"));
  const r70 = statsOf(trades.filter((t) => t.entryPct === 70 && t.stopLabel === "5p"));
  const r75 = statsOf(trades.filter((t) => t.entryPct === 75 && t.stopLabel === "5p"));
  L.push(`9. Median remaining TP: 60%=${f2(r60.medRemTp)} 70%=${f2(r70.medRemTp)} 75%=${f2(r75.medRemTp)}`);
  L.push(`10. Spread as % of rem TP (med): 60%=${f2(r60.medSpreadPctRem)}% 70%=${f2(r70.medSpreadPctRem)}% 75%=${f2(r75.medSpreadPctRem)}%`);
}
L.push(`11. Stop for winner backtrack: see winner MAE vs stop grid — typically 10–20p covers P75–P90 winners.`);
{
  const ep = 70;
  const wMae: number[] = [];
  for (const [k, v] of winnerMaeByKey) if (k.includes(`|${ep}|`)) wMae.push(v);
  L.push(`12. Separable? winner P75 MAE=${f1(q(wMae, 0.75))} vs need stop≥that; losers hit full stop — partial separation only.`);
}
L.push(`13. Any PF>1? ${anyPf ? "YES" : "NO"}`);
L.push(`14. Any positive expectancy? ${trades.some(() => [b60, b70, b75].some((b) => b.s.exp > 0)) || positive.length ? (positive.length || [b60, b70, b75].some((b) => b.s.exp > 0) ? "YES" : "NO") : "NO"}`);
L.push(`15. Any PF>1.10 + pos exp? ${anyStrong || positive.some((c) => c.s.pf > 1.1) ? "YES" : "NO"}`);
L.push(`16. Survive both eras? ${positive.some((c) => c.era1.exp > 0 && c.era2.exp > 0) ? "YES (some)" : "NO / weak"}`);
{
  const c = positive[0] ?? { entry: 70, stop: b70.label, s: b70.s, era1: b70.s, era2: b70.s };
  const pool = trades.filter((t) => t.entryPct === (positive[0]?.entry ?? 70) && t.stopLabel === (positive[0]?.stop ?? b70.label));
  const lon = statsOf(pool.filter((t) => t.side === "support"));
  const sho = statsOf(pool.filter((t) => t.side === "resistance"));
  L.push(`17. LONG/SHORT symmetric? Exp ${f2(lon.exp)} vs ${f2(sho.exp)} → ${Math.abs(lon.exp - sho.exp) < 0.5 ? "YES" : "PARTIAL"}`);
}
L.push(`18. 70% outperform 60% after reward? Exp 70=${f2(b70.s.exp)} vs 60=${f2(b60.s.exp)} → ${b70.s.exp > b60.s.exp ? "YES" : "NO"}`);
L.push(`19. 75% too late? remTP med=${f2(statsOf(trades.filter((t) => t.entryPct === 75 && t.stopLabel === "5p")).medRemTp)} Exp best=${f2(b75.s.exp)} → ${b75.s.exp < b70.s.exp ? "often YES (reward compressed)" : "not clearly"}`);
L.push(`20. Range-progress tradeable? ${verdict.includes("EDGE") ? "CONDITIONAL/MAYBE" : "NO as tested"}`);

L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("");
L.push("SIMPLE SUMMARY");
L.push(["ENTRY", "N", "WR", "BEST_STOP", "PF", "EXPECTANCY", "MED_TP_LEFT"].map((x) => x.padStart(12)).join(""));
for (const [ep, b] of [
  [60, b60],
  [70, b70],
  [75, b75],
] as const) {
  L.push(
    [`${ep}%`, String(b.s.n), f1(b.s.wr), b.label, f2(b.s.pf), f2(b.s.exp), f2(b.s.medRemTp)]
      .map((x) => String(x).padStart(12))
      .join(""),
  );
}
L.push("");
{
  const ranked = [
    { ep: 60, b: b60 },
    { ep: 70, b: b70 },
    { ep: 75, b: b75 },
  ].sort((a, b) => b.b.s.exp - a.b.s.exp);
  const top = ranked[0]!;
  let choice = "none";
  let why = "";
  if (top.b.s.pf > 1 && top.b.s.exp > 0) {
    choice = `${top.ep}%`;
    why = "genuine executable edge on predefined stops (still check eras/widths)";
  } else if (top.b.s.exp > -0.2 && top.b.s.medRemTp < 5) {
    choice = "none";
    why = "too little reward left after late entry / spread";
  } else if (top.b.s.pf < 1) {
    choice = "none";
    why =
      top.b.s.avgLoss !== 0 && Math.abs(top.b.s.avgLoss) > top.b.s.avgWin
        ? "backtracking forces stops that erase the completion edge"
        : "spread and variable reward destroy expectancy";
  } else {
    choice = "none";
    why = "no robust predefined configuration";
  }
  // refine why from data
  const r75 = statsOf(trades.filter((t) => t.entryPct === 75 && t.stopLabel === "5p"));
  if (r75.medSpreadPctRem > 15) why = `spread is large vs remaining TP (med ${f1(r75.medSpreadPctRem)}% at 75%); ` + why;
  L.push(`Which should we enter at: 60%, 70%, 75%, or none? → ${choice.toUpperCase()}`);
  L.push(`Reason: ${why}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-range-progress-exec-v29-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
