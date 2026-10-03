/**
 * EUR/USD 15M — NEXT S/R REVERSAL MAP (V24, research-only, NO P&L).
 *
 * Question: when S/R1 is reached and breaks instead of reversing, is there a
 * pre-existing farther S/R2 where price is more likely to reverse?
 *
 * S/R LOGIC (project-exact, unchanged):
 *   computeSupportResistanceLevels via assessMarketCondition
 *   → rangeHigh/rangeLow + nearest swingHigh/swingLow only.
 *   Encounter = NEAR_RESISTANCE / NEAR_SUPPORT while armed (arm/disarm de-dup).
 *   WINDOW=220, HORIZON=96, OANDA M15 MID. No session requirement.
 *
 * FREEZE at encounter t0: L1 = nearer same-side level; L2 = the OTHER exposed
 * level iff strictly beyond L1. L3 does NOT exist in project S/R (only two
 * levels per side). range→range / swing→swing are structurally impossible.
 *
 * NO LOOKAHEAD: levels taken only from candles ≤ t0; never recalculated after.
 *
 * PRIMARY path class (first decisive, mutually exclusive):
 *   REV_L1  = return ≥10p toward prior range BEFORE accepted break of L1
 *   BRK_L1  = accepted breakout of L1 (PRICE_REACTION accept rules)
 *   Then for BRK_L1 with L2: reach / REV_L2 (≥10p toward L1 before L2 accept) /
 *   BRK_L2 / STRUCTURE_ESCAPE.
 * Also report return 3/5/10/15/20p and reclaim-through-level at each stage,
 * distance buckets, type transitions, L2 penetration, times, and
 * distance-matched NON-S/R controls.
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
const CACHE =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const OUT_DIR = path.resolve(__dirname, "../research-output");
const SCRATCH =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";

const WINDOW = 220;
const HORIZON = 96;
const PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
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

interface Enc {
  t0: number;
  time: string;
  side: Side;
  atr: number;
  rangeWidth: number;
  L1: number;
  k1: Kind;
  L2: number | null;
  k2: Kind | null;
  // frozen snapshot extras for audit / controls
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
}

const encs: Enc[] = [];
let armedR = true;
let armedS = true;
const startT = WINDOW;
const auditNotes: string[] = [];
let auditFail = 0;

for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const loc = a.location;
  const cur = lv.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";
  const rw = lv.rangeHigh - lv.rangeLow;

  if (nearR && armedR) {
    const cand = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, q) => (q - cur < p - cur ? q : p));
      const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const other = k1 === "range" ? lv.swingHigh : lv.rangeHigh;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other > L1 ? other : null;
      // NO_LOOKAHEAD: L2 must come from same frozen snapshot; never from future.
      if (L2 !== null && L2 <= L1) {
        auditFail++;
        auditNotes.push(`R L2<=L1 at ${raw[t]!.time}`);
      }
      if (L2 !== null && (lv.swingHigh === null || lv.rangeHigh === null)) {
        // still ok if one missing — L2 would be null; defensive
      }
      encs.push({
        t0: t,
        time: raw[t]!.time,
        side: "resistance",
        atr: A,
        rangeWidth: rw,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
      });
      armedR = false;
    }
  } else if (!nearR) armedR = true;

  if (nearS && armedS) {
    const cand = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, q) => (cur - q < cur - p ? q : p));
      const k1: Kind = L1 === lv.rangeLow ? "range" : "swing";
      const other = k1 === "range" ? lv.swingLow : lv.rangeLow;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other < L1 ? other : null;
      if (L2 !== null && L2 >= L1) {
        auditFail++;
        auditNotes.push(`S L2>=L1 at ${raw[t]!.time}`);
      }
      encs.push({
        t0: t,
        time: raw[t]!.time,
        side: "support",
        atr: A,
        rangeWidth: rw,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
      });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

// Recompute a sample of snapshots to prove freeze matches live call at t0
{
  const sample = encs.filter((_, i) => i % Math.max(1, Math.floor(encs.length / 200)) === 0).slice(0, 200);
  for (const e of sample) {
    const window = mids.slice(e.t0 - WINDOW + 1, e.t0 + 1);
    const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
    const lv = a.levels;
    if (!lv) {
      auditFail++;
      auditNotes.push(`missing levels on recompute ${e.time}`);
      continue;
    }
    if (Math.abs(lv.rangeHigh - e.rangeHigh) > 1e-9 || Math.abs(lv.rangeLow - e.rangeLow) > 1e-9) {
      auditFail++;
      auditNotes.push(`range mismatch ${e.time}`);
    }
    const sh = lv.swingHigh;
    const sl = lv.swingLow;
    if ((sh ?? null) !== (e.swingHigh ?? null) || (sl ?? null) !== (e.swingLow ?? null)) {
      auditFail++;
      auditNotes.push(`swing mismatch ${e.time}`);
    }
    // L1/L2 must be subset of frozen snapshot only
    const okL1 =
      e.side === "resistance"
        ? e.L1 === e.rangeHigh || e.L1 === e.swingHigh
        : e.L1 === e.rangeLow || e.L1 === e.swingLow;
    if (!okL1) {
      auditFail++;
      auditNotes.push(`L1 not in snapshot ${e.time}`);
    }
    if (e.L2 !== null) {
      const okL2 =
        e.side === "resistance"
          ? e.L2 === e.rangeHigh || e.L2 === e.swingHigh
          : e.L2 === e.rangeLow || e.L2 === e.swingLow;
      if (!okL2) {
        auditFail++;
        auditNotes.push(`L2 not in snapshot ${e.time}`);
      }
      if (e.side === "resistance" && !(e.L2 > e.L1)) {
        auditFail++;
        auditNotes.push(`R2 not beyond R1 ${e.time}`);
      }
      if (e.side === "support" && !(e.L2 < e.L1)) {
        auditFail++;
        auditNotes.push(`S2 not beyond S1 ${e.time}`);
      }
    }
  }
}

// ---------- fidelity (V1 fakeout rate must stay ~81%) ----------
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);

function v1Fakeout(e: Enc): boolean {
  const w = TOUCH_ATR * e.atr;
  const top = e.L1 + w;
  const bot = e.L1 - w;
  let bb = 0;
  let adv = e.side === "resistance" ? -Infinity : Infinity;
  const end = Math.min(e.t0 + HORIZON, n - 1);
  for (let j = e.t0; j <= end; j++) {
    const c = raw[j]!.mid;
    adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low);
    const bc = e.side === "resistance" ? c.close - e.L1 : e.L1 - c.close;
    if (bc > w) bb++;
    else bb = 0;
    const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR;
    const pen = (e.side === "resistance" ? adv - e.L1 : e.L1 - adv) >= MIN_PEN_ATR * e.atr;
    const ins = e.side === "resistance" ? c.close <= top : c.close >= bot;
    if (acc) return false;
    if (pen && ins) return true;
  }
  return false;
}

{
  const v: Record<Side, { s: number; t: number }> = {
    support: { s: 0, t: 0 },
    resistance: { s: 0, t: 0 },
  };
  for (const e of encs) {
    v[e.side].t++;
    if (v1Fakeout(e)) v[e.side].s++;
  }
  const vS = pct(v.support.s, v.support.t);
  const vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) {
    console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`);
    process.exit(1);
  }
  (globalThis as { __fid?: { vS: number; vR: number } }).__fid = { vS, vR };
}

/** Scan a level from startBar: first decisive REV (return≥primaryRet before accept) vs ACCEPT break. */
function classifyLevel(
  side: Side,
  level: number,
  atr: number,
  startBar: number,
  towardIsDown: boolean, // resistance: reverse = down; support: reverse = up
): {
  touched: boolean;
  tTouch: number | null;
  broke: boolean;
  tBreak: number | null;
  revPrimary: boolean;
  tRevPrimary: number | null;
  retHit: Record<number, boolean>;
  tRet: Record<number, number | null>;
  reclaim: boolean;
  tReclaim: number | null;
  maxPenPips: number;
  tMaxPen: number | null;
} {
  const w = TOUCH_ATR * atr;
  const end = Math.min(startBar + HORIZON, n - 1);
  let touched = false;
  let tTouch: number | null = null;
  let broke = false;
  let tBreak: number | null = null;
  let revPrimary = false;
  let tRevPrimary: number | null = null;
  const retHit: Record<number, boolean> = {};
  const tRet: Record<number, number | null> = {};
  for (const r of RETS) {
    retHit[r] = false;
    tRet[r] = null;
  }
  let reclaim = false;
  let tReclaim: number | null = null;
  let maxPen = 0;
  let tMaxPen: number | null = null;
  let bb = 0;
  let peakBeyond = level; // extreme beyond level after touch
  let beyondArmed = false;

  for (let j = startBar; j <= end; j++) {
    const c = raw[j]!.mid;
    const inZone =
      side === "resistance" ? c.high >= level - w && c.low <= level + w : c.low <= level + w && c.high >= level - w;
    const beyondWick = side === "resistance" ? c.high > level + w : c.low < level - w;
    if (!touched && (inZone || beyondWick || (side === "resistance" ? c.high >= level : c.low <= level))) {
      touched = true;
      tTouch = j;
    }
    if (!touched) continue;

    const penNow = side === "resistance" ? c.high - level : level - c.low;
    if (penNow > maxPen) {
      maxPen = penNow;
      tMaxPen = j;
    }
    if (side === "resistance") {
      if (c.high > peakBeyond) peakBeyond = c.high;
    } else {
      if (c.low < peakBeyond) peakBeyond = c.low;
    }
    if (penNow >= MIN_PEN_ATR * atr) beyondArmed = true;

    // acceptance (project)
    const bc = side === "resistance" ? c.close - level : level - c.close;
    if (bc > w) bb++;
    else bb = 0;
    const acc = bb >= ACCEPT_MIN_BARS && bc / atr >= ACCEPT_MIN_DIST_ATR;
    if (!broke && acc) {
      broke = true;
      tBreak = j;
    }

    // returns toward previous range (from level, and from any beyond-extreme)
    {
      const retFromPeak =
        (towardIsDown ? peakBeyond - c.low : c.high - peakBeyond) / PIP;
      const retFromLevel = (towardIsDown ? level - c.low : c.high - level) / PIP;
      const ret = Math.max(retFromPeak, retFromLevel);
      for (const r of RETS) {
        if (!retHit[r] && ret >= r) {
          retHit[r] = true;
          tRet[r] = j;
        }
      }
      if (!revPrimary && !broke && retHit[PRIMARY_RET]) {
        revPrimary = true;
        tRevPrimary = tRet[PRIMARY_RET];
      }
    }

    // reclaim: close back through level toward prior range after meaningful pen
    if (!reclaim && beyondArmed) {
      const recl = towardIsDown ? c.close <= level : c.close >= level;
      if (recl) {
        reclaim = true;
        tReclaim = j;
      }
    }

    // stop once primary class decided
    if (broke || revPrimary) break;
  }

  // First-wins if both somehow set (should not happen after break-stop)
  if (revPrimary && broke && tRevPrimary !== null && tBreak !== null) {
    if (tRevPrimary < tBreak) broke = false;
    else revPrimary = false;
  }

  return {
    touched,
    tTouch,
    broke,
    tBreak,
    revPrimary,
    tRevPrimary,
    retHit,
    tRet,
    reclaim,
    tReclaim,
    maxPenPips: maxPen / PIP,
    tMaxPen,
  };
}

type Path =
  | "REV_L1"
  | "BRK_L1_NO_L2"
  | "BRK_L1_NO_REACH_L2"
  | "REV_L2"
  | "BRK_L2_ESCAPE"
  | "BRK_L1_L2_UNRESOLVED"
  | "L1_UNRESOLVED";

interface Ev {
  e: Enc;
  path: Path;
  v1Rev: boolean;
  l1: ReturnType<typeof classifyLevel>;
  l2: ReturnType<typeof classifyLevel> | null;
  gapPips: number;
  gapAtr: number;
  gapRangePct: number;
  // L2 penetration before reverse (if rev at L2)
  penBeforeRev: number | null;
  // times (bars)
  tBreakToL2: number | null;
  tL2ToRet3: number | null;
  tL2ToRet5: number | null;
  tL2ToRet10: number | null;
  tL2ToReclaim: number | null;
  ctrl: ReturnType<typeof classifyLevel> | null;
  ctrlGapPips: number | null;
  /** Mid-gap non-S/R phantom on with-L2 L1-breaks (fair paired control). */
  midCtrl: ReturnType<typeof classifyLevel> | null;
}

const events: Ev[] = [];
const gapPool: number[] = [];

for (const e of encs) {
  if (e.L2 !== null) {
    const g = Math.abs(e.L2 - e.L1) / PIP;
    if (g > 0) gapPool.push(g);
  }
}
gapPool.sort((a, b) => a - b);

function sampleGap(i: number): number {
  if (!gapPool.length) return 14;
  return gapPool[i % gapPool.length]!;
}

function knownNear(e: Enc, price: number): boolean {
  const w = TOUCH_ATR * e.atr;
  const levels =
    e.side === "resistance"
      ? [e.rangeHigh, e.swingHigh].filter((x): x is number => x !== null)
      : [e.rangeLow, e.swingLow].filter((x): x is number => x !== null);
  return levels.some((L) => Math.abs(L - price) <= w);
}

let ctrlIdx = 0;
for (const e of encs) {
  const towardDown = e.side === "resistance";
  const l1 = classifyLevel(e.side, e.L1, e.atr, e.t0, towardDown);
  const v1Rev = v1Fakeout(e);
  const gapPips = e.L2 !== null ? Math.abs(e.L2 - e.L1) / PIP : NaN;
  const gapAtr = e.L2 !== null ? Math.abs(e.L2 - e.L1) / e.atr : NaN;
  const gapRangePct = e.L2 !== null && e.rangeWidth > 0 ? (Math.abs(e.L2 - e.L1) / e.rangeWidth) * 100 : NaN;

  let l2: ReturnType<typeof classifyLevel> | null = null;
  let path: Path = "L1_UNRESOLVED";
  let penBeforeRev: number | null = null;
  let tBreakToL2: number | null = null;
  let tL2ToRet3: number | null = null;
  let tL2ToRet5: number | null = null;
  let tL2ToRet10: number | null = null;
  let tL2ToReclaim: number | null = null;
  let ctrl: ReturnType<typeof classifyLevel> | null = null;
  let ctrlGapPips: number | null = null;
  let midCtrl: ReturnType<typeof classifyLevel> | null = null;

  if (l1.revPrimary) {
    path = "REV_L1";
  } else if (l1.broke) {
    const tB = l1.tBreak ?? e.t0;
    if (e.L2 === null) {
      path = "BRK_L1_NO_L2";
      // distance-matched control where no known next S/R existed
      const g = sampleGap(ctrlIdx++);
      const ctrlPrice = towardDown ? e.L1 + g * PIP : e.L1 - g * PIP;
      if (!knownNear(e, ctrlPrice)) {
        ctrl = classifyLevel(e.side, ctrlPrice, e.atr, tB, towardDown);
        ctrlGapPips = g;
      }
    } else {
      l2 = classifyLevel(e.side, e.L2, e.atr, tB, towardDown);
      if (l2.tTouch !== null) tBreakToL2 = l2.tTouch - tB;
      if (l2.tRet[3] !== null && l2.tTouch !== null) tL2ToRet3 = l2.tRet[3]! - l2.tTouch;
      if (l2.tRet[5] !== null && l2.tTouch !== null) tL2ToRet5 = l2.tRet[5]! - l2.tTouch;
      if (l2.tRet[10] !== null && l2.tTouch !== null) tL2ToRet10 = l2.tRet[10]! - l2.tTouch;
      if (l2.tReclaim !== null && l2.tTouch !== null) tL2ToReclaim = l2.tReclaim - l2.tTouch;

      // Fairer control: mid-gap phantom on the SAME with-L2 events (not a known S/R)
      const midPrice = (e.L1 + e.L2) / 2;
      if (!knownNear(e, midPrice) && Math.abs(e.L2 - e.L1) / PIP >= 4) {
        midCtrl = classifyLevel(e.side, midPrice, e.atr, tB, towardDown);
      }

      if (!l2.touched) {
        path = "BRK_L1_NO_REACH_L2";
      } else if (l2.revPrimary) {
        path = "REV_L2";
        // penetration before reverse: max pen up to tRevPrimary
        if (l2.tRevPrimary !== null) {
          let maxP = 0;
          for (let j = l2.tTouch!; j <= l2.tRevPrimary; j++) {
            const c = raw[j]!.mid;
            const pen = e.side === "resistance" ? c.high - e.L2! : e.L2! - c.low;
            if (pen > maxP) maxP = pen;
          }
          penBeforeRev = maxP / PIP;
        }
      } else if (l2.broke) {
        path = "BRK_L2_ESCAPE"; // STRUCTURE_ESCAPE (no L3 in project)
      } else {
        path = "BRK_L1_L2_UNRESOLVED";
      }
    }
  } else {
    path = "L1_UNRESOLVED";
  }

  events.push({
    e,
    path,
    v1Rev,
    l1,
    l2,
    gapPips,
    gapAtr,
    gapRangePct,
    penBeforeRev,
    tBreakToL2,
    tL2ToRet3,
    tL2ToRet5,
    tL2ToRet10,
    tL2ToReclaim,
    ctrl,
    ctrlGapPips,
    midCtrl,
  });
}

const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (NO_LOOKAHEAD === "FAIL") {
  console.error("NO_LOOKAHEAD_AUDIT FAIL", auditNotes.slice(0, 10));
}

// ---------- report ----------
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;
const N = events.length;
const L: string[] = [];
const first = raw[startT]?.time;
const last = raw[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);

L.push("=".repeat(100));
L.push("EUR/USD 15M — NEXT S/R REVERSAL MAP (V24, research-only, NO P&L)");
L.push("=".repeat(100));
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R: computeSupportResistanceLevels via assessMarketCondition (range + nearest swing ONLY).`);
L.push(`Encounters: NEAR_* arm/disarm, WINDOW=${WINDOW}, HORIZON=${HORIZON}. NO session filter.`);
L.push(`FIDELITY (V1 fakeout): support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (target 81.37/81.56) -> PASS.`);
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}${auditFail ? ` (${auditFail} issues)` : ""}`);
L.push(`L3 / range→range / swing→swing: STRUCTURALLY_UNAVAILABLE (project exposes 2 levels/side).`);
L.push(`Primary reverse = first return ≥${PRIMARY_RET}p toward prior range BEFORE accepted break.`);
L.push(`Accepted break = ${ACCEPT_MIN_BARS} closes beyond zone AND ≥${ACCEPT_MIN_DIST_ATR} ATR (PRICE_REACTION).`);
L.push(`Total encounters N=${N}`);
L.push("");

const byPath: Record<Path, number> = {
  REV_L1: 0,
  BRK_L1_NO_L2: 0,
  BRK_L1_NO_REACH_L2: 0,
  REV_L2: 0,
  BRK_L2_ESCAPE: 0,
  BRK_L1_L2_UNRESOLVED: 0,
  L1_UNRESOLVED: 0,
};
for (const ev of events) byPath[ev.path]++;

const revL1 = byPath.REV_L1;
const brkL1 = N - revL1 - byPath.L1_UNRESOLVED;
const hasL2 = events.filter((ev) => ev.e.L2 !== null).length;
const brkWithL2 = events.filter((ev) => ev.l1.broke && !ev.l1.revPrimary && ev.e.L2 !== null);
const brkReachL2 = brkWithL2.filter((ev) => ev.l2?.touched);
const revL2 = byPath.REV_L2;
const brkL2 = byPath.BRK_L2_ESCAPE;
const escape = byPath.BRK_L2_ESCAPE + byPath.BRK_L1_NO_L2; // escape all *available* structure

L.push("-".repeat(100));
L.push("1–11  CHAIN ANSWERS (primary ≥10p / accept)");
L.push("-".repeat(100));
L.push(`1.  P(reversal at S/R1)                          = ${f1(pct(revL1, N))}%   (${revL1}/${N})`);
L.push(`    [also V1 fakeout]                            = ${f1(pct(events.filter((e) => e.v1Rev).length, N))}%`);
L.push(`2.  P(break S/R1) [accept, not prior 10p rev]    = ${f1(pct(brkL1, N))}%   (${brkL1}/${N})`);
L.push(`    L1 unresolved (neither)                      = ${f1(pct(byPath.L1_UNRESOLVED, N))}%`);
L.push(`3.  When S/R1 breaks, P(S/R2 available)          = ${f1(pct(brkWithL2.length, brkL1))}%   (${brkWithL2.length}/${brkL1})`);
L.push(`    Overall P(S/R2 frozen at encounter)          = ${f1(pct(hasL2, N))}%`);
L.push(`4.  When S/R1 breaks & S/R2 avail, P(reach S/R2) = ${f1(pct(brkReachL2.length, brkWithL2.length))}%   (${brkReachL2.length}/${brkWithL2.length})`);
L.push(`5.  Once S/R2 reached, P(rev at S/R2)            = ${f1(pct(revL2, brkReachL2.length))}%   (${revL2}/${brkReachL2.length})`);
L.push(`    P(rev S/R2 | S/R1 broke)                     = ${f1(pct(revL2, brkL1))}%   (${revL2}/${brkL1})`);
L.push(`6.  Once S/R2 reached, P(break S/R2)             = ${f1(pct(brkL2, brkReachL2.length))}%   (${brkL2}/${brkReachL2.length})`);
L.push(`7.  When S/R2 breaks, P(S/R3 available)          = 0.0%   (STRUCTURALLY_UNAVAILABLE)`);
L.push(`8.  P(reversal at S/R3 | …)                      = N/A`);
L.push(`9.  Combined rev at S/R1 OR S/R2                 = ${f1(pct(revL1 + revL2, N))}%   (${revL1 + revL2}/${N})`);
L.push(`10. Combined rev at S/R1 OR S/R2 OR S/R3         = ${f1(pct(revL1 + revL2, N))}%   (L3 N/A; same as #9)`);
L.push(`11. STRUCTURE_ESCAPE (% of all encounters)       = ${f1(pct(escape, N))}%`);
L.push(`    = BRK_L2_ESCAPE ${byPath.BRK_L2_ESCAPE} + BRK_L1_NO_L2 ${byPath.BRK_L1_NO_L2}`);
L.push(`    Among L1 breaks only: ${f1(pct(escape, brkL1))}%`);
L.push("");

L.push("PATH PROBABILITIES (all encounters)");
for (const p of Object.keys(byPath) as Path[]) {
  L.push(`  ${p.padEnd(24)} ${String(byPath[p]).padStart(6)}  ${f1(pct(byPath[p], N))}%`);
}
L.push("");

// Return-distance tables at L1 / L2
L.push("-".repeat(100));
L.push("RETURN DISTANCES (objective; not mutually exclusive with accept timing)");
L.push("-".repeat(100));
L.push("At S/R1 (all encounters) — ever hit return Xp toward prior range within horizon:");
L.push(["Ret", "Hit%", "N_hit"].map((s) => s.padStart(10)).join(""));
for (const r of RETS) {
  const h = events.filter((ev) => ev.l1.retHit[r]).length;
  L.push([`${r}p`, f1(pct(h, N)), `${h}`].map((s) => s.padStart(10)).join(""));
}
L.push(`Reclaim through L1 (close back thru level after pen): ${f1(pct(events.filter((ev) => ev.l1.reclaim).length, N))}%`);
L.push("");
L.push("At S/R2 (among L1-break & L2-reached):");
const reached = brkReachL2;
L.push(["Ret", "Hit%", "N_hit"].map((s) => s.padStart(10)).join(""));
for (const r of RETS) {
  const h = reached.filter((ev) => ev.l2!.retHit[r]).length;
  L.push([`${r}p`, f1(pct(h, reached.length)), `${h}`].map((s) => s.padStart(10)).join(""));
}
L.push(
  `Reclaim through L2: ${f1(pct(reached.filter((ev) => ev.l2!.reclaim).length, reached.length))}%`,
);
L.push("");

// Distances
const gaps12 = events.filter((ev) => ev.e.L2 !== null).map((ev) => ev.gapPips);
L.push("-".repeat(100));
L.push("12–13  DISTANCE BETWEEN LEVELS");
L.push("-".repeat(100));
L.push(`12. Median |S/R1→S/R2| = ${f1(median(gaps12))} pips  |  ${f2(median(events.filter((e) => e.e.L2).map((e) => e.gapAtr)))} ATR  |  ${f1(median(events.filter((e) => e.e.L2).map((e) => e.gapRangePct)))}% of range`);
L.push(`13. Median |S/R2→S/R3| = N/A (no L3)`);
L.push("");
const GAPB: Array<[string, (g: number) => boolean]> = [
  ["0-5", (g) => g > 0 && g <= 5],
  ["5-10", (g) => g > 5 && g <= 10],
  ["10-15", (g) => g > 10 && g <= 15],
  ["15-20", (g) => g > 15 && g <= 20],
  ["20-30", (g) => g > 20 && g <= 30],
  ["30-50", (g) => g > 30 && g <= 50],
  ["50+", (g) => g > 50],
];
L.push("Gap S/R1→S/R2 buckets (among L1-break with L2 reached) — P(REV_L2 | reached):");
L.push(["Bucket", "N", "RevL2%", "BrkL2%", "MedGap"].map((s) => s.padStart(10)).join(""));
for (const [name, test] of GAPB) {
  const pool = reached.filter((ev) => test(ev.gapPips));
  const rv = pool.filter((ev) => ev.path === "REV_L2").length;
  const bk = pool.filter((ev) => ev.path === "BRK_L2_ESCAPE").length;
  L.push(
    [name, `${pool.length}`, f1(pct(rv, pool.length)), f1(pct(bk, pool.length)), f1(median(pool.map((p) => p.gapPips)))]
      .map((s) => s.padStart(10))
      .join(""),
  );
}
L.push("");

// Controls
L.push("-".repeat(100));
L.push("14  S/R2 vs DISTANCE-MATCHED NON-S/R CONTROLS");
L.push("-".repeat(100));
L.push("A) No-L2 distance-matched phantoms (small N — outer-extreme selection bias risk):");
const ctrlReached = events.filter((ev) => ev.ctrl && ev.ctrl.touched);
const ctrlRev = ctrlReached.filter((ev) => ev.ctrl!.revPrimary);
const l2RevRate = pct(revL2, brkReachL2.length);
const ctrlRevRate = pct(ctrlRev.length, ctrlReached.length);
L.push(`S/R2 reached N=${brkReachL2.length}  P(rev≥10p)=${f1(l2RevRate)}%`);
L.push(`CTRL reached N=${ctrlReached.length}  P(rev≥10p)=${f1(ctrlRevRate)}%`);
L.push(`Delta (S/R2 − CTRL) = ${f1(l2RevRate - ctrlRevRate)} pp`);
L.push("");
L.push("B) Mid-gap phantom on SAME with-L2 L1-breaks (primary paired control; not a known S/R):");
const midReached = events.filter((ev) => ev.midCtrl && ev.midCtrl.touched);
const midRev = midReached.filter((ev) => ev.midCtrl!.revPrimary);
const midRevRate = pct(midRev.length, midReached.length);
const beatMid = l2RevRate - midRevRate;
L.push(`S/R2 reached N=${brkReachL2.length}  P(rev≥10p)=${f1(l2RevRate)}%`);
L.push(`MID  reached N=${midReached.length}  P(rev≥10p)=${f1(midRevRate)}%`);
L.push(`Delta (S/R2 − MID) = ${f1(beatMid)} pp`);
const beat = beatMid;
L.push(
  `Verdict vs paired mid-gap control: ${beat >= 5 ? "S/R2_BEATS_CONTROL" : beat <= -5 ? "CONTROL_BEATS_S/R2" : "NO_CLEAR_EDGE_VS_CONTROL"}`,
);
L.push("");
L.push("Return hit rates among reached — S/R2 vs MID vs no-L2 CTRL:");
L.push(["Ret", "S/R2%", "MID%", "CTRL%", "ΔS2-MID"].map((s) => s.padStart(10)).join(""));
for (const r of RETS) {
  const a = pct(brkReachL2.filter((ev) => ev.l2!.retHit[r]).length, brkReachL2.length);
  const m = pct(midReached.filter((ev) => ev.midCtrl!.retHit[r]).length, midReached.length);
  const b = pct(ctrlReached.filter((ev) => ev.ctrl!.retHit[r]).length, ctrlReached.length);
  L.push([`${r}p`, f1(a), f1(m), f1(b), f1(a - m)].map((s) => s.padStart(10)).join(""));
}
L.push("");
const paired = events.filter((ev) => ev.l2?.touched && ev.midCtrl?.touched);
const pairedL2Rev = paired.filter((ev) => ev.l2!.revPrimary).length;
const pairedMidRev = paired.filter((ev) => ev.midCtrl!.revPrimary).length;
L.push(
  `Paired (reached MID and S/R2): N=${paired.length}  P(rev S/R2)=${f1(pct(pairedL2Rev, paired.length))}%  P(rev MID)=${f1(pct(pairedMidRev, paired.length))}%  Δ=${f1(pct(pairedL2Rev, paired.length) - pct(pairedMidRev, paired.length))} pp`,
);
L.push("");

// Type transitions
L.push("-".repeat(100));
L.push("15–16  LEVEL TYPE TRANSITIONS");
L.push("-".repeat(100));
L.push("Note: only range→swing and swing→range exist. range→range / swing→swing = 0 by construction.");
L.push(
  ["combo", "N_enc", "N_brk+L2", "Reach%", "RevL2%|rch", "BrkL2%|rch", "MedGap"].map((s) => s.padStart(12)).join(""),
);
for (const [a, b] of [
  ["range", "swing"],
  ["swing", "range"],
  ["range", "range"],
  ["swing", "swing"],
] as Array<[Kind, Kind]>) {
  const pool = events.filter((ev) => ev.e.k1 === a && ev.e.k2 === b);
  const br = pool.filter((ev) => ev.l1.broke && !ev.l1.revPrimary && ev.e.L2 !== null);
  const rch = br.filter((ev) => ev.l2?.touched);
  const rv = rch.filter((ev) => ev.path === "REV_L2").length;
  const bk = rch.filter((ev) => ev.path === "BRK_L2_ESCAPE").length;
  L.push(
    [
      `${a}->${b}`,
      `${pool.length}`,
      `${br.length}`,
      f1(pct(rch.length, br.length)),
      f1(pct(rv, rch.length)),
      f1(pct(bk, rch.length)),
      f1(median(br.map((ev) => ev.gapPips))),
    ]
      .map((s) => s.padStart(12))
      .join(""),
  );
}
const rs = brkReachL2.filter((ev) => ev.e.k1 === "range" && ev.e.k2 === "swing");
const sr = brkReachL2.filter((ev) => ev.e.k1 === "swing" && ev.e.k2 === "range");
const rsRev = pct(rs.filter((ev) => ev.path === "REV_L2").length, rs.length);
const srRev = pct(sr.filter((ev) => ev.path === "REV_L2").length, sr.length);
L.push(
  `Strongest transition by P(rev|reached): ${rsRev >= srRev ? "range→swing" : "swing→range"} (${f1(Math.max(rsRev, srRev))}% vs ${f1(Math.min(rsRev, srRev))}%)`,
);
L.push("");

// Penetration at L2
L.push("-".repeat(100));
L.push("11b  PENETRATION OF S/R2 BEFORE REVERSAL (REV_L2 only)");
L.push("-".repeat(100));
const pens = events.filter((ev) => ev.path === "REV_L2" && ev.penBeforeRev !== null).map((ev) => ev.penBeforeRev!);
const PENB: Array<[string, (x: number) => boolean]> = [
  ["0-1", (x) => x >= 0 && x <= 1],
  ["1-2", (x) => x > 1 && x <= 2],
  ["2-3", (x) => x > 2 && x <= 3],
  ["3-5", (x) => x > 3 && x <= 5],
  ["5-10", (x) => x > 5 && x <= 10],
  ["10+", (x) => x > 10],
];
L.push(`N=${pens.length}  median=${f1(median(pens))}  P75=${f1(q(pens, 0.75))}  P90=${f1(q(pens, 0.9))}  P95=${f1(q(pens, 0.95))}`);
L.push(["Bucket", "N", "%"].map((s) => s.padStart(10)).join(""));
for (const [name, test] of PENB) {
  const c = pens.filter(test).length;
  L.push([name, `${c}`, f1(pct(c, pens.length))].map((s) => s.padStart(10)).join(""));
}
L.push("");

// Times
L.push("-".repeat(100));
L.push("12b  TIME (M15 bars)");
L.push("-".repeat(100));
const t12 = events.filter((ev) => ev.tBreakToL2 !== null).map((ev) => ev.tBreakToL2!);
const t3 = events.filter((ev) => ev.tL2ToRet3 !== null).map((ev) => ev.tL2ToRet3!);
const t5 = events.filter((ev) => ev.tL2ToRet5 !== null).map((ev) => ev.tL2ToRet5!);
const t10 = events.filter((ev) => ev.tL2ToRet10 !== null).map((ev) => ev.tL2ToRet10!);
const tRc = events.filter((ev) => ev.tL2ToReclaim !== null).map((ev) => ev.tL2ToReclaim!);
function timeLine(label: string, a: number[]) {
  L.push(
    `${label.padEnd(28)} N=${String(a.length).padStart(5)}  med=${f1(median(a))}  P75=${f1(q(a, 0.75))}  P90=${f1(q(a, 0.9))}`,
  );
}
timeLine("L1 break → S/R2 touch", t12);
timeLine("S/R2 → 3p return", t3);
timeLine("S/R2 → 5p return", t5);
timeLine("S/R2 → 10p return", t10);
timeLine("S/R2 → reclaim thru L2", tRc);
L.push("");

// Side split
L.push("-".repeat(100));
L.push("SIDE SPLIT");
L.push("-".repeat(100));
for (const side of ["support", "resistance"] as Side[]) {
  const pool = events.filter((ev) => ev.e.side === side);
  const r1 = pool.filter((ev) => ev.path === "REV_L1").length;
  const b1 = pool.filter((ev) => ev.l1.broke && !ev.l1.revPrimary).length;
  const r2 = pool.filter((ev) => ev.path === "REV_L2").length;
  const esc = pool.filter((ev) => ev.path === "BRK_L2_ESCAPE" || ev.path === "BRK_L1_NO_L2").length;
  L.push(
    `${side}: N=${pool.length}  revL1=${f1(pct(r1, pool.length))}%  brkL1=${f1(pct(b1, pool.length))}%  revL1|L2=${f1(pct(r1 + r2, pool.length))}%  escape=${f1(pct(esc, pool.length))}%`,
  );
}
L.push("");

// Final verdict
L.push("-".repeat(100));
L.push("17  IDEA CHECK + FINAL VERDICT");
L.push("-".repeat(100));
L.push(`Idea: "When first S/R fails, price often travels to another already-known S/R and reverses there."`);
const oftenReach = pct(brkReachL2.length, brkWithL2.length);
const revGivenReach = pct(revL2, brkReachL2.length);
const coverageGain = pct(revL2, N);
const ideaSupport =
  oftenReach >= 60 && revGivenReach >= 40 && beat >= 3
    ? "SUPPORTED"
    : oftenReach >= 50 && revGivenReach >= 30 && beat >= 0
      ? "WEAKLY_SUPPORTED"
      : "NOT_SUPPORTED";
L.push(`Reach S/R2 when available after L1 break: ${f1(oftenReach)}%`);
L.push(`Reverse at S/R2 once reached: ${f1(revGivenReach)}%`);
L.push(`Coverage gain from S/R2 (of all encounters): +${f1(coverageGain)} pp`);
L.push(`S/R2 vs control edge: ${f1(beat)} pp`);
L.push(`Idea assessment: ${ideaSupport}`);
L.push("");

let verdict: "NEXT_SR_EFFECT_FOUND" | "NEXT_SR_WEAK_EFFECT" | "NO_NEXT_SR_EFFECT";
if (beat >= 5 && revGivenReach >= 40 && coverageGain >= 5) verdict = "NEXT_SR_EFFECT_FOUND";
else if (beat >= 0 && revGivenReach >= 30 && (coverageGain >= 2 || oftenReach >= 55)) verdict = "NEXT_SR_WEAK_EFFECT";
else verdict = "NO_NEXT_SR_EFFECT";

L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(100));

const report = L.join("\n");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "eurusd-next-sr-map-v24-report.txt"), report + "\n");
fs.writeFileSync(path.join(SCRATCH, "eurusd-next-sr-map-v24-report.txt"), report + "\n");

// events CSV (compact)
const csv: string[] = [];
csv.push(
  [
    "time",
    "side",
    "k1",
    "k2",
    "L1",
    "L2",
    "gap_pips",
    "gap_atr",
    "path",
    "v1_rev",
    "l1_broke",
    "l1_rev10",
    "l2_reached",
    "l2_broke",
    "l2_rev10",
    "pen_before_rev",
    "t_break_to_l2",
  ].join(","),
);
for (const ev of events) {
  csv.push(
    [
      ev.e.time,
      ev.e.side,
      ev.e.k1,
      ev.e.k2 ?? "",
      ev.e.L1.toFixed(5),
      ev.e.L2 !== null ? ev.e.L2.toFixed(5) : "",
      Number.isFinite(ev.gapPips) ? ev.gapPips.toFixed(2) : "",
      Number.isFinite(ev.gapAtr) ? ev.gapAtr.toFixed(3) : "",
      ev.path,
      ev.v1Rev ? "yes" : "no",
      ev.l1.broke ? "yes" : "no",
      ev.l1.revPrimary ? "yes" : "no",
      ev.l2?.touched ? "yes" : "no",
      ev.l2?.broke ? "yes" : "no",
      ev.l2?.revPrimary ? "yes" : "no",
      ev.penBeforeRev !== null ? ev.penBeforeRev.toFixed(2) : "",
      ev.tBreakToL2 !== null ? String(ev.tBreakToL2) : "",
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-next-sr-map-v24-events.csv"), csv.join("\n") + "\n");
fs.writeFileSync(path.join(SCRATCH, "eurusd-next-sr-map-v24-events.csv"), csv.join("\n") + "\n");

console.log(report);
console.error(`[written] eurusd-next-sr-map-v24-report.txt | events.csv (${events.length} rows)`);
