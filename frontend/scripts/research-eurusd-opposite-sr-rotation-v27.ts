/**
 * EUR/USD V27 — S/R REVERSAL → OPPOSITE-SIDE ROTATION MAP (research-only, NO P&L).
 *
 * NEW file — does NOT modify V23–V26.
 *
 * Question: after a confirmed S/R reversal, how often does executable price rotate
 * across the frozen range to the opposite pre-frozen S/R — and vs what adverse?
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
const M1_HORIZON = HORIZON * 15; // after confirmation
const PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const ACCEPT_MIN_BARS_M1 = ACCEPT_MIN_BARS * 15;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;
const CONFS = [3, 5, 10] as const;
const TGTS = [25, 50, 75, 100, 110, 125] as const;
const ADVS = [5, 10, 15, 20, 30] as const;
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

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

// ===================== LOAD =====================
console.error("V27 loading M15...");
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
  /** Frozen opposite-side S/R (outer). */
  opp: number | null;
  oppKind: Kind | null;
  rangePips: number; // |L1 - opp|
}

const encs: Enc[] = [];
let armedR = true,
  armedS = true;
const startT = WINDOW;
let auditFail = 0;

function pickOpposite(side: Side, origin: number, rh: number, rl: number, sh: number | null, sl: number | null): { opp: number; kind: Kind } | null {
  if (side === "resistance") {
    const cands: Array<{ p: number; k: Kind }> = [];
    if (rl < origin) cands.push({ p: rl, k: "range" });
    if (sl !== null && sl < origin) cands.push({ p: sl, k: "swing" });
    if (!cands.length) return null;
    // outer support = lowest
    return cands.reduce((a, b) => (b.p < a.p ? b : a));
  }
  const cands: Array<{ p: number; k: Kind }> = [];
  if (rh > origin) cands.push({ p: rh, k: "range" });
  if (sh !== null && sh > origin) cands.push({ p: sh, k: "swing" });
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.p > a.p ? b : a));
}

for (let t = startT; t < n; t++) {
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

// freeze audit sample
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
  l2: ReturnType<typeof classifyLevel> | null;
}
const v24: V24Ev[] = [];
for (const e of encs) {
  const towardDown = e.side === "resistance";
  const l1 = classifyLevel(e.side, e.L1, e.atr, e.t0, towardDown);
  let l2: ReturnType<typeof classifyLevel> | null = null;
  let path: Path = "L1_UNRESOLVED";
  if (l1.revPrimary) path = "REV_L1";
  else if (l1.broke) {
    if (e.L2 === null) path = "BRK_L1_NO_L2";
    else {
      l2 = classifyLevel(e.side, e.L2, e.atr, l1.tBreak ?? e.t0, towardDown);
      if (!l2.touched) path = "BRK_L1_NO_REACH_L2";
      else if (l2.revPrimary) path = "REV_L2";
      else if (l2.broke) path = "BRK_L2_ESCAPE";
      else path = "BRK_L1_L2_UNRESOLVED";
    }
  }
  v24.push({ e, path, l1, l2 });
}

const byPath: Record<Path, number> = {
  REV_L1: 0,
  BRK_L1_NO_L2: 0,
  BRK_L1_NO_REACH_L2: 0,
  REV_L2: 0,
  BRK_L2_ESCAPE: 0,
  BRK_L1_L2_UNRESOLVED: 0,
  L1_UNRESOLVED: 0,
};
for (const ev of v24) byPath[ev.path]++;
const N = v24.length;
const revL1 = byPath.REV_L1;
const brkL1 = N - revL1 - byPath.L1_UNRESOLVED;
const brkWithL2 = v24.filter((ev) => ev.l1.broke && !ev.l1.revPrimary && ev.e.L2 !== null);
const brkReachL2 = brkWithL2.filter((ev) => ev.l2?.touched);
const revL2 = byPath.REV_L2;

const parityChecks: Array<[string, number, number, number]> = [
  ["N", N, 75959, 50],
  ["revL1%", pct(revL1, N), 71.7, 0.6],
  ["brkL1%", pct(brkL1, N), 25.7, 0.6],
  ["brkWithL2", brkWithL2.length, 18698, 50],
  ["reachL2", brkReachL2.length, Math.round(18698 * 0.698), 100],
  ["revL2|reach%", pct(revL2, brkReachL2.length), 75.3, 1.0],
];
let parityOk = true;
for (const [name, got, exp, tol] of parityChecks) {
  if (!near(got, exp, tol)) {
    parityOk = false;
    console.error(`PARITY FAIL ${name}: got ${got} expected ~${exp}`);
  }
}
const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (!parityOk || NO_LOOKAHEAD === "FAIL") {
  console.error(`STOP. PARITY=${parityOk} NO_LOOKAHEAD=${NO_LOOKAHEAD}`);
  process.exit(1);
}
console.error(`V24 PARITY PASS | NO_LOOKAHEAD=${NO_LOOKAHEAD}`);

// ===================== M1 =====================
console.error("V27 loading M1...");
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

/** Observation price for progress toward opposite / confirmation. */
function obsPx(i: number, side: Side): number {
  // resistance short → BID; support long → ASK
  return side === "resistance" ? bc[i]! : ac[i]!;
}
/** Adverse beyond origin uses same executable side. */
function advPx(i: number, side: Side): number {
  return obsPx(i, side);
}

interface RotEv {
  cohort: "SR1" | "SR2";
  e: Enc;
  origin: number;
  originKind: Kind;
  opp: number;
  oppKind: Kind;
  rangePips: number;
  conf: number;
  tConf: number;
  year: number;
  // reach
  reach: Record<number, boolean>;
  tReach: Record<number, number | null>;
  // race target vs adverse
  race: Record<string, "tgt" | "adv" | "ambig" | "none">;
  // MAE before each target (only if reached)
  maeBefore: Record<number, number>;
  maxProgressPct: number;
  // stall (if never 100)
  stalled: boolean;
}

const rots: RotEv[] = [];

function scanRotation(
  cohort: "SR1" | "SR2",
  e: Enc,
  origin: number,
  originKind: Kind,
  m1Start: number,
  confNeed: number,
): void {
  if (e.opp === null || e.oppKind === null || !(e.rangePips > 0)) return;
  const side = e.side;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) return;
  const towardOppIsDown = side === "resistance"; // short from resistance
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);

  // find confirmation: move confNeed pips from origin toward opposite
  let tConf = -1;
  for (let i = m1Start; i <= end; i++) {
    const px = obsPx(i, side);
    const fav = towardOppIsDown ? (origin - px) / PIP : (px - origin) / PIP;
    if (fav >= confNeed) {
      tConf = i;
      break;
    }
  }
  if (tConf < 0) return;

  const reach: Record<number, boolean> = {};
  const tReach: Record<number, number | null> = {};
  for (const t of TGTS) {
    reach[t] = false;
    tReach[t] = null;
  }
  const maeBefore: Record<number, number> = {};
  for (const t of TGTS) maeBefore[t] = 0;

  const race: Record<string, "tgt" | "adv" | "ambig" | "none"> = {};
  for (const t of [25, 50, 75, 100] as const) {
    for (const a of ADVS) race[`t${t}_a${a}`] = "none";
  }
  const pending = new Set(Object.keys(race));

  let maxAdv = 0;
  let maxProg = 0;
  let peakFavPx = obsPx(tConf, side);

  const scanEnd = Math.min(tConf + M1_HORIZON, M1 - 1);
  for (let i = tConf; i <= scanEnd; i++) {
    const px = obsPx(i, side);
    // progress toward opposite (0..100+)
    const prog =
      towardOppIsDown ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
    if (prog > maxProg) maxProg = prog;

    // adverse beyond origin
    const adv = towardOppIsDown ? (px - origin) / PIP : (origin - px) / PIP;
    if (adv > maxAdv) maxAdv = adv;

    // update peak in fav direction for MAE tracking from confirmation
    if (towardOppIsDown) {
      if (px < peakFavPx) peakFavPx = px;
    } else if (px > peakFavPx) peakFavPx = px;

    for (const t of TGTS) {
      if (!reach[t] && prog >= t) {
        reach[t] = true;
        tReach[t] = i;
        maeBefore[t] = maxAdv; // max adverse seen before/at this bar
      }
    }

    for (const key of [...pending]) {
      const m = /^t(\d+)_a(\d+)$/.exec(key)!;
      const tNeed = Number(m[1]);
      const aNeed = Number(m[2]);
      const tHit = prog >= tNeed;
      const aHit = adv >= aNeed;
      if (tHit && aHit) {
        race[key] = "ambig";
        pending.delete(key);
      } else if (tHit) {
        race[key] = "tgt";
        pending.delete(key);
      } else if (aHit) {
        race[key] = "adv";
        pending.delete(key);
      }
    }
  }

  rots.push({
    cohort,
    e,
    origin,
    originKind,
    opp,
    oppKind: e.oppKind,
    rangePips: range / PIP,
    conf: confNeed,
    tConf,
    year: e.year,
    reach,
    tReach,
    race,
    maeBefore,
    maxProgressPct: maxProg,
    stalled: !reach[100],
  });
}

// Cohort A: all encounters with opposite — confirm from encounter M15 close
for (const ev of v24) {
  const e = ev.e;
  if (e.opp === null) continue;
  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  for (const c of CONFS) scanRotation("SR1", e, e.L1, e.k1, m1Start, c);
}

// Cohort B: L1 accepted break, reach L2, confirm from L2 toward opposite
for (const ev of brkWithL2) {
  const e = ev.e;
  if (e.opp === null || e.L2 === null) continue;
  const tBreak = ev.l1.tBreak ?? e.t0;
  const breakCloseMs = m15ms[tBreak]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;

  // must reach L2 first (exec), then confirm from L2
  const L2 = e.L2;
  const side = e.side;
  const w = TOUCH_ATR * e.atr;
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);
  let tTouch = -1;
  for (let i = m1Start; i <= end; i++) {
    const px = obsPx(i, side);
    const hit = side === "resistance" ? px >= L2 - w : px <= L2 + w;
    if (hit) {
      tTouch = i;
      break;
    }
  }
  if (tTouch < 0) continue;

  // opposite range for SR2 origin = |L2 - opp|
  const e2: Enc = {
    ...e,
    L1: L2,
    k1: e.k2 ?? "swing",
    rangePips: Math.abs(L2 - e.opp) / PIP,
  };
  for (const c of CONFS) scanRotation("SR2", e2, L2, e.k2 ?? "swing", tTouch, c);
}

console.error(`Rotations built: ${rots.length}`);

// ===================== AGG HELPERS =====================
function summarize(pool: RotEv[], label: string, lines: string[]) {
  if (!pool.length) {
    lines.push(`${label}: N=0`);
    return;
  }
  lines.push(`${label}: N=${pool.length}`);
  const row = ["conf", "N", "P25", "P50", "P75", "P100", "P110", "P125", "medT100", "P75T100"];
  lines.push(row.map((s) => s.padStart(8)).join(""));
  for (const c of CONFS) {
    const p = pool.filter((r) => r.conf === c);
    const times = p.filter((r) => r.tReach[100] != null).map((r) => r.tReach[100]! - r.tConf);
    lines.push(
      [
        `${c}p`,
        `${p.length}`,
        f1(pct(p.filter((r) => r.reach[25]).length, p.length)),
        f1(pct(p.filter((r) => r.reach[50]).length, p.length)),
        f1(pct(p.filter((r) => r.reach[75]).length, p.length)),
        f1(pct(p.filter((r) => r.reach[100]).length, p.length)),
        f1(pct(p.filter((r) => r.reach[110]).length, p.length)),
        f1(pct(p.filter((r) => r.reach[125]).length, p.length)),
        f1(median(times)),
        f1(q(times, 0.75)),
      ]
        .map((s) => s.padStart(8))
        .join(""),
    );
  }
}

function raceTable(pool: RotEv[], conf: number, lines: string[]) {
  const p = pool.filter((r) => r.conf === conf);
  lines.push(`Race conf=${conf}p  N=${p.length}  (cell = P(target FIRST vs adverse), ambig excluded)`);
  lines.push(["tgt\\adv", ...ADVS.map((a) => `+${a}`)].map((s) => String(s).padStart(8)).join(""));
  for (const t of [25, 50, 75, 100] as const) {
    const row = [`${t}%`];
    for (const a of ADVS) {
      const key = `t${t}_a${a}`;
      const fav = p.filter((r) => r.race[key] === "tgt").length;
      const res = p.filter((r) => r.race[key] === "tgt" || r.race[key] === "adv").length;
      row.push(f1(pct(fav, res)));
    }
    lines.push(row.map((s) => s.padStart(8)).join(""));
  }
}

function maeTable(pool: RotEv[], conf: number, lines: string[]) {
  const p = pool.filter((r) => r.conf === conf);
  lines.push(`MAE before target (among those who reached) conf=${conf}p`);
  lines.push(["tgt", "N", "med", "P75", "P80", "P90", "P95"].map((s) => s.padStart(8)).join(""));
  for (const t of [25, 50, 75, 100] as const) {
    const xs = p.filter((r) => r.reach[t]).map((r) => r.maeBefore[t]!);
    lines.push(
      [`${t}%`, `${xs.length}`, f1(median(xs)), f1(q(xs, 0.75)), f1(q(xs, 0.8)), f1(q(xs, 0.9)), f1(q(xs, 0.95))]
        .map((s) => s.padStart(8))
        .join(""),
    );
  }
}

// ===================== REPORT =====================
const L: string[] = [];
L.push("=".repeat(110));
L.push("EUR/USD V27 — S/R REVERSAL → OPPOSITE-SIDE ROTATION MAP (research-only, NO P&L)");
L.push("=".repeat(110));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`V24 structural parity = PASS`);
L.push(`Opposite = outer frozen opposite-side S/R (resistance→lowest support; support→highest resistance).`);
L.push(`Confirm = M1 exec move Xp from origin toward opposite. Progress = % of |origin−opposite|.`);
L.push(`Adverse = pips beyond origin against reversal (same exec stream).`);
L.push("");

L.push("-".repeat(110));
L.push("PARITY");
L.push("-".repeat(110));
for (const [name, got, exp] of parityChecks) L.push(`  ${name.padEnd(14)} got=${f2(got)} expected≈${exp}`);
L.push(`Encounters with frozen opposite: ${encs.filter((e) => e.opp !== null).length}/${N}`);
L.push("");

const sr1 = rots.filter((r) => r.cohort === "SR1");
const sr2 = rots.filter((r) => r.cohort === "SR2");

L.push("-".repeat(110));
L.push("7  PRIMARY — S/R1 REVERSAL → OPPOSITE");
L.push("-".repeat(110));
summarize(sr1, "SR1 all", L);
L.push("");
for (const c of CONFS) {
  raceTable(sr1, c, L);
  L.push("");
  maeTable(sr1, c, L);
  L.push("");
}

L.push("-".repeat(110));
L.push("S/R2 REVERSAL → OPPOSITE (after L1 break + L2 reach)");
L.push("-".repeat(110));
summarize(sr2, "SR2 all", L);
L.push("");
raceTable(sr2, 5, L);
L.push("");
maeTable(sr2, 5, L);
L.push("");

// MFE distribution
L.push("-".repeat(110));
L.push("11  MAX RANGE PROGRESS DISTRIBUTION (all paths)");
L.push("-".repeat(110));
const PROG_B: Array<[string, (x: number) => boolean]> = [
  ["<25", (x) => x < 25],
  ["25-50", (x) => x >= 25 && x < 50],
  ["50-75", (x) => x >= 50 && x < 75],
  ["75-100", (x) => x >= 75 && x < 100],
  ["100-125", (x) => x >= 100 && x < 125],
  ["125+", (x) => x >= 125],
];
for (const cohort of ["SR1", "SR2"] as const) {
  for (const c of CONFS) {
    const p = rots.filter((r) => r.cohort === cohort && r.conf === c);
    L.push(`${cohort} conf=${c}p N=${p.length}`);
    for (const [name, test] of PROG_B) {
      L.push(`  ${name.padEnd(8)} ${f1(pct(p.filter((r) => test(r.maxProgressPct)).length, p.length))}%`);
    }
  }
}
L.push("");

// Width breakdown
L.push("-".repeat(110));
L.push("12  RANGE WIDTH — SR1 conf=5p");
L.push("-".repeat(110));
L.push(["width", "N", "P25", "P50", "P75", "P100", "medMAE", "P90MAE"].map((s) => s.padStart(8)).join(""));
for (const [name, test] of WIDTHB) {
  const p = sr1.filter((r) => r.conf === 5 && test(r.rangePips));
  const mae = p.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!);
  L.push(
    [
      name,
      `${p.length}`,
      f1(pct(p.filter((r) => r.reach[25]).length, p.length)),
      f1(pct(p.filter((r) => r.reach[50]).length, p.length)),
      f1(pct(p.filter((r) => r.reach[75]).length, p.length)),
      f1(pct(p.filter((r) => r.reach[100]).length, p.length)),
      f1(median(mae)),
      f1(q(mae, 0.9)),
    ]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push("");

L.push("13  PRACTICAL WIDTH COHORTS — SR1");
for (const [name, test] of [
  ["20-50", (w: number) => w > 20 && w <= 50],
  ["30-75", (w: number) => w > 30 && w <= 75],
  ["50-100", (w: number) => w > 50 && w <= 100],
] as Array<[string, (w: number) => boolean]>) {
  summarize(
    sr1.filter((r) => test(r.rangePips)),
    `SR1 ${name}`,
    L,
  );
}
L.push("");

L.push("-".repeat(110));
L.push("14  SR1 vs SR2 (conf=5p, by width)");
L.push("-".repeat(110));
L.push(["width", "c", "N", "P100", "medMAE", "P90MAE"].map((s) => s.padStart(8)).join(""));
for (const [name, test] of WIDTHB) {
  for (const cohort of ["SR1", "SR2"] as const) {
    const p = rots.filter((r) => r.cohort === cohort && r.conf === 5 && test(r.rangePips));
    const mae = p.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!);
    L.push(
      [name, cohort, `${p.length}`, f1(pct(p.filter((r) => r.reach[100]).length, p.length)), f1(median(mae)), f1(q(mae, 0.9))]
        .map((s) => s.padStart(8))
        .join(""),
    );
  }
}
L.push("");

// Type / side within width 20-50
L.push("-".repeat(110));
L.push("15–17  TYPE / SIDE within width 20–50p, conf=5p, SR1");
L.push("-".repeat(110));
{
  const base = sr1.filter((r) => r.conf === 5 && r.rangePips > 20 && r.rangePips <= 50);
  for (const [lab, pred] of [
    ["origin range", (r: RotEv) => r.originKind === "range"],
    ["origin swing", (r: RotEv) => r.originKind === "swing"],
    ["opp range", (r: RotEv) => r.oppKind === "range"],
    ["opp swing", (r: RotEv) => r.oppKind === "swing"],
    ["support→R", (r: RotEv) => r.e.side === "support"],
    ["resistance→S", (r: RotEv) => r.e.side === "resistance"],
  ] as Array<[string, (r: RotEv) => boolean]>) {
    const p = base.filter(pred);
    L.push(
      `  ${lab}: N=${p.length} P100=${f1(pct(p.filter((r) => r.reach[100]).length, p.length))}% medMAE=${f1(median(p.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!)))}`,
    );
  }
}
L.push("");

// Time
L.push("-".repeat(110));
L.push("18  TIME TO TARGETS — SR1 conf=5p");
L.push("-".repeat(110));
{
  const p = sr1.filter((r) => r.conf === 5);
  for (const t of [25, 50, 75, 100] as const) {
    const xs = p.filter((r) => r.tReach[t] != null).map((r) => r.tReach[t]! - r.tConf);
    L.push(
      `  ${t}%: N=${xs.length} med=${f1(median(xs))} P75=${f1(q(xs, 0.75))} P90=${f1(q(xs, 0.9))} P95=${f1(q(xs, 0.95))} min`,
    );
  }
  const t100 = p.filter((r) => r.tReach[100] != null).map((r) => r.tReach[100]! - r.tConf);
  for (const h of [60, 120, 240, 480, 720, 1440]) {
    L.push(`  P100 within ${h / 60}h: ${f1(pct(t100.filter((x) => x <= h).length, p.length))}% of all confs`);
  }
}
L.push("");

// Stall
L.push("-".repeat(110));
L.push("19  FAILED ROTATIONS (no P100) — max progress — SR1 conf=5p");
L.push("-".repeat(110));
{
  const fail = sr1.filter((r) => r.conf === 5 && !r.reach[100]);
  L.push(`N fail=${fail.length}`);
  for (const [name, test] of [
    ["<25", (x: number) => x < 25],
    ["25-50", (x: number) => x >= 25 && x < 50],
    ["50-75", (x: number) => x >= 50 && x < 75],
    ["75-100", (x: number) => x >= 75 && x < 100],
  ] as Array<[string, (x: number) => boolean]>) {
    L.push(`  ${name}: ${f1(pct(fail.filter((r) => test(r.maxProgressPct)).length, fail.length))}%`);
  }
}
L.push("");

// Conditionals
L.push("-".repeat(110));
L.push("20–21  PATH CONDITIONALS — SR1");
L.push("-".repeat(110));
for (const c of CONFS) {
  const p = sr1.filter((r) => r.conf === c);
  const r25 = p.filter((r) => r.reach[25]);
  const r50 = p.filter((r) => r.reach[50]);
  const r75 = p.filter((r) => r.reach[75]);
  L.push(`conf=${c}p:`);
  L.push(`  P(50|25)=${f1(pct(r25.filter((r) => r.reach[50]).length, r25.length))}%`);
  L.push(`  P(75|25)=${f1(pct(r25.filter((r) => r.reach[75]).length, r25.length))}%`);
  L.push(`  P(100|25)=${f1(pct(r25.filter((r) => r.reach[100]).length, r25.length))}%`);
  L.push(`  P(75|50)=${f1(pct(r50.filter((r) => r.reach[75]).length, r50.length))}%`);
  L.push(`  P(100|50)=${f1(pct(r50.filter((r) => r.reach[100]).length, r50.length))}%`);
  L.push(`  P(100|75)=${f1(pct(r75.filter((r) => r.reach[100]).length, r75.length))}%`);
}
L.push("");

// Return to origin after progress
L.push("-".repeat(110));
L.push("22  AFTER REACHING X%: return-to-origin FIRST vs reach-100 FIRST — SR1 conf=5p");
L.push("-".repeat(110));
{
  const p = sr1.filter((r) => r.conf === 5);
  for (const t of [25, 50, 75] as const) {
    let retFirst = 0,
      oppFirst = 0,
      n = 0;
    for (const r of p) {
      if (!r.reach[t] || r.tReach[t] == null) continue;
      n++;
      const start = r.tReach[t]!;
      const end = Math.min(start + M1_HORIZON, M1 - 1);
      const towardOppIsDown = r.e.side === "resistance";
      let outcome: "ret" | "opp" | "none" = "none";
      for (let i = start + 1; i <= end; i++) {
        const px = obsPx(i, r.e.side);
        const back = towardOppIsDown ? px >= r.origin : px <= r.origin;
        const atOpp = towardOppIsDown ? px <= r.opp : px >= r.opp;
        if (back && atOpp) {
          outcome = "none";
          break;
        }
        if (atOpp) {
          outcome = "opp";
          break;
        }
        if (back) {
          outcome = "ret";
          break;
        }
      }
      if (outcome === "ret") retFirst++;
      if (outcome === "opp") oppFirst++;
    }
    L.push(`  after ${t}%: N=${n} returnOriginFirst=${f1(pct(retFirst, n))}% oppFirst=${f1(pct(oppFirst, n))}%`);
  }
}
L.push("");

// Stability
L.push("-".repeat(110));
L.push("23–24  ERA / ATR — SR1 conf=5p width 20–50");
L.push("-".repeat(110));
{
  const base = sr1.filter((r) => r.conf === 5 && r.rangePips > 20 && r.rangePips <= 50);
  for (const [lab, pred] of [
    ["2013-2019", (r: RotEv) => r.year <= 2019],
    ["2020-2026", (r: RotEv) => r.year >= 2020],
  ] as Array<[string, (r: RotEv) => boolean]>) {
    const p = base.filter(pred);
    L.push(
      `  ${lab}: N=${p.length} P25=${f1(pct(p.filter((r) => r.reach[25]).length, p.length))} P50=${f1(pct(p.filter((r) => r.reach[50]).length, p.length))} P75=${f1(pct(p.filter((r) => r.reach[75]).length, p.length))} P100=${f1(pct(p.filter((r) => r.reach[100]).length, p.length))}`,
    );
  }
  const atrs = base.map((r) => r.e.atr).sort((a, b) => a - b);
  const t1 = atrs[Math.floor(atrs.length / 3)] ?? 0;
  const t2 = atrs[Math.floor((2 * atrs.length) / 3)] ?? 0;
  for (const [lab, pred] of [
    ["LOW", (r: RotEv) => r.e.atr <= t1],
    ["MED", (r: RotEv) => r.e.atr > t1 && r.e.atr <= t2],
    ["HIGH", (r: RotEv) => r.e.atr > t2],
  ] as Array<[string, (r: RotEv) => boolean]>) {
    const p = base.filter(pred);
    const mae = p.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!);
    L.push(
      `  ATR ${lab}: N=${p.length} P100=${f1(pct(p.filter((r) => r.reach[100]).length, p.length))}% medMAE=${f1(median(mae))}`,
    );
  }
}
L.push("");

// 70% hunt
L.push("-".repeat(110));
L.push("27–28  >=70% P100 COHORT HUNT (broad, N>=500, both eras)");
L.push("-".repeat(110));
type Cand = {
  name: string;
  pool: RotEv[];
  p100: number;
  era1: number;
  era2: number;
};
const cands: Cand[] = [];
const huntDefs: Array<[string, (r: RotEv) => boolean]> = [];
for (const cohort of ["SR1", "SR2"] as const) {
  for (const c of CONFS) {
    huntDefs.push([`${cohort} conf=${c}p ALL`, (r) => r.cohort === cohort && r.conf === c]);
    for (const [wn, wt] of [
      ["w20-50", (w: number) => w > 20 && w <= 50],
      ["w30-75", (w: number) => w > 30 && w <= 75],
      ["w10-30", (w: number) => w > 10 && w <= 30],
      ["w0-20", (w: number) => w > 0 && w <= 20],
      ["w50-100", (w: number) => w > 50 && w <= 100],
    ] as Array<[string, (w: number) => boolean]>) {
      huntDefs.push([
        `${cohort} conf=${c}p ${wn}`,
        (r) => r.cohort === cohort && r.conf === c && wt(r.rangePips),
      ]);
    }
  }
}
for (const [name, pred] of huntDefs) {
  const pool = rots.filter(pred);
  if (pool.length < 500) continue;
  const p100 = pct(pool.filter((r) => r.reach[100]).length, pool.length);
  const e1 = pool.filter((r) => r.year <= 2019);
  const e2 = pool.filter((r) => r.year >= 2020);
  if (e1.length < 200 || e2.length < 200) continue;
  const era1 = pct(e1.filter((r) => r.reach[100]).length, e1.length);
  const era2 = pct(e2.filter((r) => r.reach[100]).length, e2.length);
  if (p100 >= 70 && era1 >= 65 && era2 >= 65) cands.push({ name, pool, p100, era1, era2 });
}
if (!cands.length) {
  L.push("NO broad N>=500 cohort with P100>=70% stable across both eras (era floors 65%).");
  // show best near-misses
  const scored = huntDefs
    .map(([name, pred]) => {
      const pool = rots.filter(pred);
      const p100 = pct(pool.filter((r) => r.reach[100]).length, pool.length);
      return { name, n: pool.length, p100 };
    })
    .filter((x) => x.n >= 500)
    .sort((a, b) => b.p100 - a.p100)
    .slice(0, 8);
  L.push("Top near-misses by raw P100:");
  for (const s of scored) L.push(`  ${s.name}: N=${s.n} P100=${f1(s.p100)}%`);
} else {
  for (const c of cands) {
    L.push(`FOUND: ${c.name}`);
    L.push(`  N=${c.pool.length} P100=${f1(c.p100)}% era13-19=${f1(c.era1)}% era20-26=${f1(c.era2)}%`);
    const mae = c.pool.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!);
    const t100 = c.pool.filter((r) => r.tReach[100] != null).map((r) => r.tReach[100]! - r.tConf);
    L.push(
      `  medMAE=${f1(median(mae))} P75MAE=${f1(q(mae, 0.75))} P90MAE=${f1(q(mae, 0.9))} medTime100=${f1(median(t100))}m`,
    );
    for (const a of ADVS) {
      const key = `t100_a${a}`;
      const fav = c.pool.filter((r) => r.race[key] === "tgt").length;
      const res = c.pool.filter((r) => r.race[key] === "tgt" || r.race[key] === "adv").length;
      L.push(`  P100 before +${a}p adverse: ${f1(pct(fav, res))}% (Nres=${res})`);
    }
    const sides = {
      support: c.pool.filter((r) => r.e.side === "support").length,
      resistance: c.pool.filter((r) => r.e.side === "resistance").length,
    };
    L.push(`  support N=${sides.support} resistance N=${sides.resistance}`);
    L.push(`  med rangePips=${f1(median(c.pool.map((r) => r.rangePips)))}`);
  }
}
L.push("");

// Primary answers
const sr1c3 = sr1.filter((r) => r.conf === 3);
const sr1c5 = sr1.filter((r) => r.conf === 5);
const sr1c10 = sr1.filter((r) => r.conf === 10);
const sr2c3 = sr2.filter((r) => r.conf === 3);
const sr2c5 = sr2.filter((r) => r.conf === 5);
const sr2c10 = sr2.filter((r) => r.conf === 10);

function p100(p: RotEv[]) {
  return pct(p.filter((r) => r.reach[100]).length, p.length);
}
function pX(p: RotEv[], t: number) {
  return pct(p.filter((r) => r.reach[t]).length, p.length);
}

const bestWidth = WIDTHB.map(([name, test]) => {
  const p = sr1c5.filter((r) => test(r.rangePips));
  return { name, n: p.length, p100: p100(p) };
}).sort((a, b) => b.p100 - a.p100)[0];

const ideaRace10 = (() => {
  const p = sr1c5;
  const key = "t100_a10";
  const fav = p.filter((r) => r.race[key] === "tgt").length;
  const res = p.filter((r) => r.race[key] === "tgt" || r.race[key] === "adv").length;
  return pct(fav, res);
})();
const ideaRace20 = (() => {
  const p = sr1c5;
  const key = "t100_a20";
  const fav = p.filter((r) => r.race[key] === "tgt").length;
  const res = p.filter((r) => r.race[key] === "tgt" || r.race[key] === "adv").length;
  return pct(fav, res);
})();

L.push("-".repeat(110));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(110));
L.push(`1. No-lookahead: ${NO_LOOKAHEAD}`);
L.push(`2. SR1 conf 3p N=${sr1c3.length}`);
L.push(`3. SR1 conf 5p N=${sr1c5.length}`);
L.push(`4. SR1 conf 10p N=${sr1c10.length}`);
L.push(`5–8. SR1 3p → P25/50/75/100 = ${f1(pX(sr1c3, 25))} / ${f1(pX(sr1c3, 50))} / ${f1(pX(sr1c3, 75))} / ${f1(p100(sr1c3))}%`);
L.push(`9. SR1 5p → P100 = ${f1(p100(sr1c5))}%`);
L.push(`10. SR1 10p → P100 = ${f1(p100(sr1c10))}%`);
L.push(`11. SR2 3p → P100 = ${f1(p100(sr2c3))}% N=${sr2c3.length}`);
L.push(`12. SR2 5p → P100 = ${f1(p100(sr2c5))}% N=${sr2c5.length}`);
L.push(`13. SR2 10p → P100 = ${f1(p100(sr2c10))}% N=${sr2c10.length}`);
L.push(`14. Highest P100 width (SR1 5p): ${bestWidth?.name} (${f1(bestWidth?.p100 ?? NaN)}%, N=${bestWidth?.n})`);
L.push(`15. Broad N>=500 & P100>=70% both eras: ${cands.length ? "YES" : "NO"}`);
L.push(`16. Reproduces both eras: ${cands.length ? "YES (see FOUND)" : "N/A"}`);
if (cands[0]) {
  const mae = cands[0].pool.filter((r) => r.reach[100]).map((r) => r.maeBefore[100]!);
  L.push(`17–19. That cohort med/P75/P90 MAE: ${f1(median(mae))} / ${f1(q(mae, 0.75))} / ${f1(q(mae, 0.9))}`);
} else {
  L.push(`17–19. N/A (no 70% cohort)`);
}
L.push(`20. SR1 5p P100 before +10 adverse: ${f1(ideaRace10)}%`);
L.push(`21. Before +20: ${f1(ideaRace20)}%`);
{
  const key = "t100_a30";
  const fav = sr1c5.filter((r) => r.race[key] === "tgt").length;
  const res = sr1c5.filter((r) => r.race[key] === "tgt" || r.race[key] === "adv").length;
  L.push(`22. Before +30: ${f1(pct(fav, res))}%`);
}
{
  const xs = sr1c5.filter((r) => r.tReach[100] != null).map((r) => r.tReach[100]! - r.tConf);
  L.push(`23. Med time to opposite (SR1 5p): ${f1(median(xs))} min`);
  L.push(`24. P100 within 4h: ${f1(pct(xs.filter((x) => x <= 240).length, sr1c5.length))}%`);
  L.push(`25. Within 8h: ${f1(pct(xs.filter((x) => x <= 480).length, sr1c5.length))}%`);
  L.push(`26. Within 24h: ${f1(pct(xs.filter((x) => x <= 1440).length, sr1c5.length))}%`);
}
{
  const r50 = sr1c5.filter((r) => r.reach[50]);
  const r75 = sr1c5.filter((r) => r.reach[75]);
  L.push(`27. P100|50: ${f1(pct(r50.filter((r) => r.reach[100]).length, r50.length))}%`);
  L.push(`28. P100|75: ${f1(pct(r75.filter((r) => r.reach[100]).length, r75.length))}%`);
}
L.push(`29. Failed stalls: see section 19`);
L.push(`30. SR1 vs SR2 P100 (5p): ${f1(p100(sr1c5))}% vs ${f1(p100(sr2c5))}%`);
L.push(`31–32. See type/side section`);
const strongEnough = cands.length > 0 && ideaRace10 >= 55;
L.push(`33. Justify execution testing: ${strongEnough ? "CONDITIONAL YES" : "NOT YET"}`);
const idea =
  p100(sr1c5) >= 55 && ideaRace10 >= 50
    ? "PARTIAL"
    : p100(sr1c5) >= 70 && ideaRace10 >= 60
      ? "YES"
      : "NO";
L.push(`34. User idea (entry less important): ${idea}`);
L.push(
  `    Reason: raw P100 SR1@5p=${f1(p100(sr1c5))}%, but P(P100 before +10 adverse)=${f1(ideaRace10)}%, before +20=${f1(ideaRace20)}%.`,
);
L.push("");

let verdict: "OPPOSITE_SR_ROTATION_STRONG" | "OPPOSITE_SR_ROTATION_CONDITIONAL" | "OPPOSITE_SR_ROTATION_WEAK" | "OPPOSITE_SR_ROTATION_NOT_FOUND";
if (NO_LOOKAHEAD === "PASS" && cands.length && ideaRace10 >= 55 && p100(sr1c5) >= 70) {
  verdict = "OPPOSITE_SR_ROTATION_STRONG";
} else if (NO_LOOKAHEAD === "PASS" && (p100(sr1c5) >= 45 || (bestWidth && bestWidth.p100 >= 55))) {
  const condProgress =
    pct(sr1c5.filter((r) => r.reach[50]).filter((r) => r.reach[100]).length, sr1c5.filter((r) => r.reach[50]).length) >=
    70;
  verdict = condProgress || (bestWidth && bestWidth.p100 >= 60) ? "OPPOSITE_SR_ROTATION_CONDITIONAL" : "OPPOSITE_SR_ROTATION_WEAK";
} else if (p100(sr1c5) < 30) {
  verdict = "OPPOSITE_SR_ROTATION_NOT_FOUND";
} else {
  verdict = "OPPOSITE_SR_ROTATION_WEAK";
}

L.push("=".repeat(110));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(110));

const report = L.join("\n");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "eurusd-opposite-sr-rotation-v27-report.txt"), report + "\n");
fs.writeFileSync(path.join(PAD, "eurusd-opposite-sr-rotation-v27-report.txt"), report + "\n");
console.log(report);
console.error(`[written] eurusd-opposite-sr-rotation-v27-report.txt (${rots.length} rotation events)`);
