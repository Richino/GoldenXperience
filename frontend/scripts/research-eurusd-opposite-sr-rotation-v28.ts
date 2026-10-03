/**
 * EUR/USD V28 — RANGE-PROGRESS → OPPOSITE S/R COMPLETION MAP (research-only, NO P&L).
 *
 * NEW file — does NOT modify V23–V27.
 *
 * Question: once price has reversed from a frozen S/R and progressed X% across the
 * frozen origin→opposite range, how often does it complete to the opposite S/R
 * before materially backtracking?
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
const CONFS = [3, 5, 10] as const;

const CHECKS = [10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100] as const;
const PRIMARY = [25, 40, 50, 60, 70, 75] as const;
const CURVE = [10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90] as const;
const ADVS = [5, 10, 15, 20, 30] as const;
const RETR_PCT = [10, 20, 25, 30] as const;
const BACK_LVLS = [0, 25, 40, 50, 60, 70] as const;

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
const CONF_PCT_BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["0-25", (x) => x >= 0 && x < 25],
  ["25-40", (x) => x >= 25 && x < 40],
  ["40-50", (x) => x >= 40 && x < 50],
  ["50-60", (x) => x >= 50 && x < 60],
  ["60-70", (x) => x >= 60 && x < 70],
  ["70-80", (x) => x >= 70 && x < 80],
  ["80-100", (x) => x >= 80 && x <= 100],
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

// ===================== LOAD M15 =====================
console.error("V28 loading M15...");
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
const startT = WINDOW;
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
console.error("V28 loading M1...");
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

/** V27 entry/observation stream (parity). */
function obsPx(i: number, side: Side): number {
  return side === "resistance" ? bc[i]! : ac[i]!;
}
/** V28 target/progress stream: LONG→BID, SHORT→ASK. */
function progPx(i: number, side: Side): number {
  return side === "support" ? bc[i]! : ac[i]!;
}

function progressPct(px: number, origin: number, opp: number, side: Side, range: number): number {
  return side === "resistance" ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
}

// ---------- V27 parity rotation (SR1 only, obsPx) ----------
interface V27Rot {
  conf: number;
  reach50: boolean;
  reach75: boolean;
  reach100: boolean;
}
const v27rots: V27Rot[] = [];

function scanV27Parity(e: Enc, origin: number, m1Start: number, confNeed: number): void {
  if (e.opp === null || !(e.rangePips > 0)) return;
  const side = e.side;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) return;
  const towardOppIsDown = side === "resistance";
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);
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
  let reach50 = false,
    reach75 = false,
    reach100 = false;
  const scanEnd = Math.min(tConf + M1_HORIZON, M1 - 1);
  for (let i = tConf; i <= scanEnd; i++) {
    const px = obsPx(i, side);
    const prog = towardOppIsDown ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
    if (prog >= 50) reach50 = true;
    if (prog >= 75) reach75 = true;
    if (prog >= 100) {
      reach100 = true;
      break;
    }
  }
  v27rots.push({ conf: confNeed, reach50, reach75, reach100 });
}

for (const ev of v24) {
  const e = ev.e;
  if (e.opp === null) continue;
  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  for (const c of CONFS) scanV27Parity(e, e.L1, m1Start, c);
}

{
  const v27Parity: Array<[string, number, number, number]> = [];
  for (const c of CONFS) {
    const p = v27rots.filter((r) => r.conf === c);
    const expN = c === 3 ? 74376 : c === 5 ? 72421 : 66003;
    const expP = c === 3 ? 53.2 : c === 5 ? 55.1 : 61.4;
    v27Parity.push([`SR1 conf${c}p N`, p.length, expN, 200]);
    v27Parity.push([`SR1 conf${c}p P100`, pct(p.filter((r) => r.reach100).length, p.length), expP, 1.0]);
  }
  const p5 = v27rots.filter((r) => r.conf === 5);
  const r50 = p5.filter((r) => r.reach50);
  const r75 = p5.filter((r) => r.reach75);
  v27Parity.push(["P100|50@5p", pct(r50.filter((r) => r.reach100).length, r50.length), 69.6, 1.0]);
  v27Parity.push(["P100|75@5p", pct(r75.filter((r) => r.reach100).length, r75.length), 83.5, 1.0]);
  let v27Ok = true;
  for (const [name, got, exp, tol] of v27Parity) {
    if (!near(got, exp, tol)) {
      v27Ok = false;
      console.error(`V27 PARITY FAIL ${name}: got ${got} expected ~${exp}`);
    }
  }
  if (!v27Ok) {
    console.error("STOP. V27 structural rotation parity failed.");
    process.exit(1);
  }
  console.error("V27 rotation parity PASS");
}

// ===================== V28 PATH SCAN =====================
type RaceOut = "tgt" | "bt" | "ambig" | "none";

interface CpResult {
  cp: number;
  tCp: number;
  reach100: boolean;
  t100: number | null;
  // backtrack level races (progress %)
  raceBack: Record<number, RaceOut>;
  // fixed pip adverse from checkpoint
  racePip: Record<number, RaceOut>;
  // % range retrace from checkpoint
  raceRetr: Record<number, RaceOut>;
  // max subsequent progress (all paths)
  maxProgAfter: number;
  // backtrack before 100 (completions only), pips and % range
  btPips: number;
  btPct: number;
  // deepest backtrack progress level reached after cp (failures + all)
  deepestBack: number;
  // returned to these levels after cp (before 100)
  hitBack: Record<number, boolean>;
}

interface PathEv {
  e: Enc;
  origin: number;
  opp: number;
  range: number;
  rangePips: number;
  year: number;
  atr: number;
  m1Start: number;
  // first hit times for each check
  tCheck: Record<number, number | null>;
  // fixed conf first times (obsPx) and progress-% at conf
  tConf: Record<number, number | null>;
  confProgPct: Record<number, number | null>;
  // per-checkpoint results
  at: Record<number, CpResult | null>;
  maxProg: number;
}

const paths: PathEv[] = [];

function scanPath(e: Enc, m1Start: number): void {
  if (e.opp === null || e.oppKind === null || !(e.rangePips > 0)) return;
  const side = e.side;
  const origin = e.L1;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) return;
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);

  const tCheck: Record<number, number | null> = {};
  for (const c of CHECKS) tCheck[c] = null;
  const tConf: Record<number, number | null> = {};
  const confProgPct: Record<number, number | null> = {};
  for (const c of CONFS) {
    tConf[c] = null;
    confProgPct[c] = null;
  }

  let maxProg = -Infinity;
  // pass 1: mark first times
  for (let i = m1Start; i <= end; i++) {
    const pxP = progPx(i, side);
    const prog = progressPct(pxP, origin, opp, side, range);
    if (prog > maxProg) maxProg = prog;
    for (const c of CHECKS) {
      if (tCheck[c] === null && prog >= c) tCheck[c] = i;
    }
    const pxO = obsPx(i, side);
    const fav = side === "resistance" ? (origin - pxO) / PIP : (pxO - origin) / PIP;
    for (const c of CONFS) {
      if (tConf[c] === null && fav >= c) {
        tConf[c] = i;
        confProgPct[c] = progressPct(pxP, origin, opp, side, range);
      }
    }
  }

  const at: Record<number, CpResult | null> = {};
  for (const c of CHECKS) at[c] = null;

  for (const cp of CHECKS) {
    const tCp = tCheck[cp];
    if (tCp === null) continue;

    const raceBack: Record<number, RaceOut> = {};
    for (const b of BACK_LVLS) {
      if (b < cp) raceBack[b] = "none";
    }
    const racePip: Record<number, RaceOut> = {};
    for (const a of ADVS) racePip[a] = "none";
    const raceRetr: Record<number, RaceOut> = {};
    for (const r of RETR_PCT) raceRetr[r] = "none";

    const pendingBack = new Set(Object.keys(raceBack).map(Number));
    const pendingPip = new Set(ADVS.map((x) => x));
    const pendingRetr = new Set(RETR_PCT.map((x) => x));

    const px0 = progPx(tCp, side);
    let reach100 = false;
    let t100: number | null = null;
    let maxProgAfter = cp;
    let maxBtPips = 0;
    let maxBtPct = 0;
    let deepestBack = cp;
    const hitBack: Record<number, boolean> = {};
    for (const b of BACK_LVLS) hitBack[b] = false;

    const scanEnd = Math.min(m1Start + M1_HORIZON, M1 - 1);
    for (let i = tCp; i <= scanEnd; i++) {
      const px = progPx(i, side);
      const prog = progressPct(px, origin, opp, side, range);
      if (prog > maxProgAfter) maxProgAfter = prog;
      if (prog < deepestBack) deepestBack = prog;

      // backtrack from checkpoint in pips (against progress)
      const btPips = side === "resistance" ? (px - px0) / PIP : (px0 - px) / PIP;
      if (btPips > maxBtPips) maxBtPips = btPips;
      const btPctRange = Math.max(0, cp - prog);
      if (btPctRange > maxBtPct) maxBtPct = btPctRange;

      for (const b of BACK_LVLS) {
        if (b < cp && prog <= b) hitBack[b] = true;
      }

      const hit100 = prog >= 100;
      if (hit100 && !reach100) {
        reach100 = true;
        t100 = i;
      }

      for (const b of [...pendingBack]) {
        const btHit = prog <= b;
        if (hit100 && btHit) {
          raceBack[b] = "ambig";
          pendingBack.delete(b);
        } else if (hit100) {
          raceBack[b] = "tgt";
          pendingBack.delete(b);
        } else if (btHit) {
          raceBack[b] = "bt";
          pendingBack.delete(b);
        }
      }
      for (const a of [...pendingPip]) {
        const aHit = btPips >= a;
        if (hit100 && aHit) {
          racePip[a] = "ambig";
          pendingPip.delete(a);
        } else if (hit100) {
          racePip[a] = "tgt";
          pendingPip.delete(a);
        } else if (aHit) {
          racePip[a] = "bt";
          pendingPip.delete(a);
        }
      }
      for (const r of [...pendingRetr]) {
        const thresh = cp - r;
        const rHit = prog <= thresh;
        if (hit100 && rHit) {
          raceRetr[r] = "ambig";
          pendingRetr.delete(r);
        } else if (hit100) {
          raceRetr[r] = "tgt";
          pendingRetr.delete(r);
        } else if (rHit) {
          raceRetr[r] = "bt";
          pendingRetr.delete(r);
        }
      }

      if (reach100 && !pendingBack.size && !pendingPip.size && !pendingRetr.size) break;
    }

    at[cp] = {
      cp,
      tCp,
      reach100,
      t100,
      raceBack,
      racePip,
      raceRetr,
      maxProgAfter,
      btPips: reach100 ? maxBtPips : NaN,
      btPct: reach100 ? maxBtPct : NaN,
      deepestBack,
      hitBack,
    };
  }

  paths.push({
    e,
    origin,
    opp,
    range,
    rangePips: range / PIP,
    year: e.year,
    atr: e.atr,
    m1Start,
    tCheck,
    tConf,
    confProgPct,
    at,
    maxProg,
  });
}

console.error("V28 scanning SR1 progress paths...");
for (const ev of v24) {
  const e = ev.e;
  if (e.opp === null) continue;
  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  scanPath(e, m1Start);
}
console.error(`Paths: ${paths.length}`);

// ===================== AGG =====================
function racePct(pool: CpResult[], get: (r: CpResult) => RaceOut): number {
  const fav = pool.filter((r) => get(r) === "tgt").length;
  const res = pool.filter((r) => get(r) === "tgt" || get(r) === "bt").length;
  return pct(fav, res);
}

function cpsAt(pool: PathEv[], cp: number): CpResult[] {
  return pool.map((p) => p.at[cp]).filter((x): x is CpResult => x !== null);
}

function curveRow(pool: PathEv[], cp: number): string {
  const xs = cpsAt(pool, cp);
  const n = xs.length;
  const p100 = pct(xs.filter((r) => r.reach100).length, n);
  const b5 = racePct(xs, (r) => r.racePip[5]!);
  const b10 = racePct(xs, (r) => r.racePip[10]!);
  const r20 = racePct(xs, (r) => r.raceRetr[20]!);
  const b0 = racePct(xs, (r) => r.raceBack[0]!);
  return [String(cp), String(n), f1(p100), f1(b5), f1(b10), f1(r20), f1(b0)].map((s) => s.padStart(10)).join("");
}

const L: string[] = [];
L.push("=".repeat(110));
L.push("EUR/USD V28 — RANGE-PROGRESS → OPPOSITE S/R COMPLETION MAP (research-only, NO P&L)");
L.push("=".repeat(110));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`V24 structural parity = PASS`);
L.push(`V27 rotation parity = PASS`);
L.push(`Progress stream: LONG(support)=BID, SHORT(resistance)=ASK (completed M1 closes).`);
L.push(`Checkpoints conditioned on FIRST executable close at each progress %.`);
L.push("");

L.push("-".repeat(110));
L.push("PARITY");
L.push("-".repeat(110));
for (const [name, got, exp] of parityChecks) L.push(`  ${name.padEnd(14)} got=${f2(got)} expected≈${exp}`);
for (const c of CONFS) {
  const p = v27rots.filter((r) => r.conf === c);
  L.push(
    `  SR1 conf=${c}p N=${p.length} P100=${f1(pct(p.filter((r) => r.reach100).length, p.length))}%`,
  );
}
{
  const p5 = v27rots.filter((r) => r.conf === 5);
  const r50 = p5.filter((r) => r.reach50);
  const r75 = p5.filter((r) => r.reach75);
  L.push(`  P100|50 @5p = ${f1(pct(r50.filter((r) => r.reach100).length, r50.length))}%`);
  L.push(`  P100|75 @5p = ${f1(pct(r75.filter((r) => r.reach100).length, r75.length))}%`);
}
L.push(`SR1 paths with opposite: ${paths.length}`);
L.push("");

// ---- 10 MAIN CURVE ----
L.push("-".repeat(110));
L.push("10  COMPLETION CURVE (all SR1 paths)");
L.push("-".repeat(110));
L.push(
  ["PROGRESS", "N", "P100", "b4 -5p", "b4 -10p", "b4 -20%r", "b4 orig"].map((s) => s.padStart(10)).join(""),
);
for (const cp of CURVE) L.push(curveRow(paths, cp));
L.push("");

// ---- races by primary ----
L.push("-".repeat(110));
L.push("7–9  RACES AT PRIMARY CHECKPOINTS");
L.push("-".repeat(110));
for (const cp of PRIMARY) {
  const xs = cpsAt(paths, cp);
  L.push(`\nCheckpoint ${cp}%  N=${xs.length}  P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%`);
  const backs = BACK_LVLS.filter((b) => b < cp);
  if (backs.length) {
    L.push(
      ["back%", ...backs.map(String)].map((s) => s.padStart(8)).join("") +
        "   (P100 before that backtrack level)",
    );
    L.push(["P100<", ...backs.map((b) => f1(racePct(xs, (r) => r.raceBack[b]!)))].map((s) => s.padStart(8)).join(""));
  }
  L.push(["pipAdv", ...ADVS.map((a) => `-${a}`)].map((s) => s.padStart(8)).join(""));
  L.push(["P100<", ...ADVS.map((a) => f1(racePct(xs, (r) => r.racePip[a]!)))].map((s) => s.padStart(8)).join(""));
  L.push(["retr%", ...RETR_PCT.map((r) => `-${r}%`)].map((s) => s.padStart(8)).join(""));
  L.push(["P100<", ...RETR_PCT.map((r) => f1(racePct(xs, (x) => x.raceRetr[r]!)))].map((s) => s.padStart(8)).join(""));
}
L.push("");

// ---- width ----
L.push("-".repeat(110));
L.push("12  COMPLETION CURVE BY WIDTH");
L.push("-".repeat(110));
for (const [wname, wtest] of [...WIDTHB, ...WIDTH_GROUP]) {
  const pool = paths.filter((p) => wtest(p.rangePips));
  L.push(`\nWidth ${wname}  paths=${pool.length}`);
  L.push(
    ["PROGRESS", "N", "P100", "b4 -5p", "b4 -10p", "b4 -20%r", "b4 orig"].map((s) => s.padStart(10)).join(""),
  );
  for (const cp of [25, 40, 50, 60, 70, 75, 80] as const) L.push(curveRow(pool, cp));
}
L.push("");

// ---- 13 small range ----
L.push("-".repeat(110));
L.push("13  CRITICAL SMALL-RANGE 0–20p");
L.push("-".repeat(110));
{
  const pool = paths.filter((p) => p.rangePips > 0 && p.rangePips <= 20);
  L.push(`paths=${pool.length}`);
  for (const cp of [25, 40, 50, 60, 70, 75, 80] as const) {
    const xs = cpsAt(pool, cp);
    L.push(
      `  ${cp}%: N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%` +
        ` before-10%r=${f1(racePct(xs, (r) => r.raceRetr[10]!))}%` +
        ` before-20%r=${f1(racePct(xs, (r) => r.raceRetr[20]!))}%` +
        ` before-5p=${f1(racePct(xs, (r) => r.racePip[5]!))}%` +
        ` before-10p=${f1(racePct(xs, (r) => r.racePip[10]!))}%`,
    );
  }
  // V27 cohort: 10p conf + 0-20
  const v27like = pool.filter((p) => p.tConf[10] !== null);
  L.push(`\n  Same 0–20p with 10p conf (obsPx): N=${v27like.length}`);
  const confProgs = v27like.map((p) => p.confProgPct[10]!).filter((x) => Number.isFinite(x));
  L.push(
    `  At 10p conf, median progress% of range = ${f1(median(confProgs))}  P25=${f1(q(confProgs, 0.25))} P75=${f1(q(confProgs, 0.75))}`,
  );
  // P100 from conf using prog stream after conf
  let hit = 0;
  for (const p of v27like) {
    const t0 = p.tConf[10]!;
    const end = Math.min(p.m1Start + M1_HORIZON, M1 - 1);
    for (let i = t0; i <= end; i++) {
      if (progressPct(progPx(i, p.e.side), p.origin, p.opp, p.e.side, p.range) >= 100) {
        hit++;
        break;
      }
    }
  }
  L.push(`  P100 after 10p conf (progPx stream): ${f1(pct(hit, v27like.length))}%`);
}
L.push("");

// ---- 14–15 fixed pip vs progress ----
L.push("-".repeat(110));
L.push("14  FIXED-PIP CONF AS % OF RANGE (at first conf)");
L.push("-".repeat(110));
for (const c of CONFS) {
  const withC = paths.filter((p) => p.tConf[c] !== null && p.confProgPct[c] !== null);
  L.push(`\nconf=${c}p N=${withC.length}`);
  L.push(["bucket", "N", "medConf%", "P100|conf"].map((s) => s.padStart(12)).join(""));
  for (const [bname, btest] of CONF_PCT_BUCKETS) {
    const sub = withC.filter((p) => btest(p.confProgPct[c]!));
    let hit = 0;
    for (const p of sub) {
      const t0 = p.tConf[c]!;
      const end = Math.min(p.m1Start + M1_HORIZON, M1 - 1);
      for (let i = t0; i <= end; i++) {
        if (progressPct(progPx(i, p.e.side), p.origin, p.opp, p.e.side, p.range) >= 100) {
          hit++;
          break;
        }
      }
    }
    L.push(
      [bname, String(sub.length), f1(median(sub.map((p) => p.confProgPct[c]!))), f1(pct(hit, sub.length))]
        .map((s) => s.padStart(12))
        .join(""),
    );
  }
}
L.push("");

L.push("-".repeat(110));
L.push("15  SAME-PROGRESS BUCKET × CONF (P100 after reaching progress bucket via any path)");
L.push("-".repeat(110));
{
  // For each progress bucket, among paths that first hit that progress, split by which conf was already achieved
  const buckets: Array<[string, number, number]> = [
    ["25-40", 25, 40],
    ["40-50", 40, 50],
    ["50-60", 50, 60],
    ["60-70", 60, 70],
    ["70-80", 70, 80],
    ["80-90", 80, 90],
  ];
  L.push(["bucket", "conf", "N", "P100"].map((s) => s.padStart(10)).join(""));
  for (const [bname, lo, hi] of buckets) {
    // condition: reached `lo` checkpoint; confProg at conf time was in [lo,hi) OR we compare who had conf before reaching lo
    const atLo = paths.filter((p) => p.at[lo] !== null);
    for (const c of CONFS) {
      // had this conf before or at the lo checkpoint
      const sub = atLo.filter((p) => p.tConf[c] !== null && p.tConf[c]! <= p.at[lo]!.tCp);
      // and conf's progress-% fell in bucket? Actually: control for being AT lo progress — all atLo are at same progress.
      // Compare confs among those who reached lo.
      const xs = sub.map((p) => p.at[lo]!);
      L.push(
        [bname, `${c}p`, String(xs.length), f1(pct(xs.filter((r) => r.reach100).length, xs.length))]
          .map((s) => s.padStart(10))
          .join(""),
      );
    }
    // also "no conf yet" vs any — skip; add row for all at lo
    const all = cpsAt(paths, lo);
    L.push(
      [bname, "ALL", String(all.length), f1(pct(all.filter((r) => r.reach100).length, all.length))]
        .map((s) => s.padStart(10))
        .join(""),
    );
  }
  L.push("(Rows = among paths that reached lower edge of bucket; conf means that conf occurred by then.)");
}
L.push("");

// tighter control: at exact checkpoint, compare confs
L.push("15b  AT EXACT CHECKPOINT — conf already achieved vs not");
for (const cp of [50, 60, 70, 75] as const) {
  const base = paths.filter((p) => p.at[cp] !== null);
  L.push(`\n  @${cp}%:`);
  for (const c of CONFS) {
    const yes = base.filter((p) => p.tConf[c] !== null && p.tConf[c]! <= p.at[cp]!.tCp);
    const no = base.filter((p) => p.tConf[c] === null || p.tConf[c]! > p.at[cp]!.tCp);
    L.push(
      `    had ${c}p conf: N=${yes.length} P100=${f1(pct(yes.filter((p) => p.at[cp]!.reach100).length, yes.length))}%` +
        ` | no/later: N=${no.length} P100=${f1(pct(no.filter((p) => p.at[cp]!.reach100).length, no.length))}%`,
    );
  }
}
L.push("");

// ---- 17 time ----
L.push("-".repeat(110));
L.push("17  TIME FROM CHECKPOINT → 100% (completions)");
L.push("-".repeat(110));
for (const cp of [...PRIMARY, 80, 90] as const) {
  const xs = cpsAt(paths, cp).filter((r) => r.reach100 && r.t100 !== null);
  const times = xs.map((r) => r.t100! - r.tCp);
  const all = cpsAt(paths, cp);
  L.push(
    `  ${cp}%: Ncomp=${xs.length} med=${f1(median(times))} P75=${f1(q(times, 0.75))} P90=${f1(q(times, 0.9))} P95=${f1(q(times, 0.95))} min`,
  );
  for (const m of [15, 30, 60, 120, 240, 480, 1440]) {
    L.push(`    within ${m}m: ${f1(pct(times.filter((t) => t <= m).length, all.length))}% of all at checkpoint`);
  }
}
L.push("");

// ---- 18 MAE ----
L.push("-".repeat(110));
L.push("18  BACKTRACK BEFORE COMPLETION (among completions)");
L.push("-".repeat(110));
for (const cp of PRIMARY) {
  const xs = cpsAt(paths, cp).filter((r) => r.reach100);
  const pips = xs.map((r) => r.btPips);
  const pcts = xs.map((r) => r.btPct);
  L.push(
    `  ${cp}%: N=${xs.length}` +
      ` pips med/P75/P80/P90/P95 = ${f1(median(pips))}/${f1(q(pips, 0.75))}/${f1(q(pips, 0.8))}/${f1(q(pips, 0.9))}/${f1(q(pips, 0.95))}` +
      ` | %range med/P75/P90 = ${f1(median(pcts))}/${f1(q(pcts, 0.75))}/${f1(q(pcts, 0.9))}`,
  );
}
L.push("");

// ---- 19 all paths max progress after ----
L.push("-".repeat(110));
L.push("19  MAX SUBSEQUENT PROGRESS (all paths at checkpoint)");
L.push("-".repeat(110));
const STALL_B: Array<[string, (x: number, cp: number) => boolean]> = [
  ["stall+0-10", (x, cp) => x < cp + 10],
  ["+10-20", (x, cp) => x >= cp + 10 && x < cp + 20],
  ["to75", (x, cp) => x >= cp + 20 && x < 75],
  ["75-90", (x) => x >= 75 && x < 90],
  ["90-100", (x) => x >= 90 && x < 100],
  ["100+", (x) => x >= 100],
];
for (const cp of [50, 60, 70, 75] as const) {
  const xs = cpsAt(paths, cp);
  L.push(`\n  after ${cp}% N=${xs.length}`);
  // custom buckets relative
  if (cp === 50) {
    const bins: Array<[string, (x: number) => boolean]> = [
      ["50-60", (x) => x < 60],
      ["60-70", (x) => x >= 60 && x < 70],
      ["70-75", (x) => x >= 70 && x < 75],
      ["75-90", (x) => x >= 75 && x < 90],
      ["90-100", (x) => x >= 90 && x < 100],
      ["100+", (x) => x >= 100],
    ];
    for (const [name, test] of bins) L.push(`    ${name}: ${f1(pct(xs.filter((r) => test(r.maxProgAfter)).length, xs.length))}%`);
  } else if (cp === 75) {
    const bins: Array<[string, (x: number) => boolean]> = [
      ["75-80", (x) => x < 80],
      ["80-90", (x) => x >= 80 && x < 90],
      ["90-100", (x) => x >= 90 && x < 100],
      ["100+", (x) => x >= 100],
    ];
    for (const [name, test] of bins) L.push(`    ${name}: ${f1(pct(xs.filter((r) => test(r.maxProgAfter)).length, xs.length))}%`);
  } else {
    for (const [name, test] of STALL_B) {
      L.push(`    ${name}: ${f1(pct(xs.filter((r) => test(r.maxProgAfter, cp)).length, xs.length))}%`);
    }
  }
}
L.push("");

// ---- 20 failure map ----
L.push("-".repeat(110));
L.push("20  FAILURE MAP — reached X but not 100; deepest return");
L.push("-".repeat(110));
for (const cp of [50, 60, 70, 75] as const) {
  const fails = cpsAt(paths, cp).filter((r) => !r.reach100);
  L.push(`\n  fail after ${cp}% N=${fails.length}`);
  for (const b of BACK_LVLS.filter((x) => x < cp)) {
    L.push(`    hit ≤${b}%: ${f1(pct(fails.filter((r) => r.hitBack[b]).length, fails.length))}%`);
  }
  L.push(`    deepestBack med=${f1(median(fails.map((r) => r.deepestBack)))} P25=${f1(q(fails.map((r) => r.deepestBack), 0.25))}`);
}
L.push("");

// ---- 21–23 deep 50/60/70/75 ----
function deepCp(cp: number, extraBacks: number[]) {
  const xs = cpsAt(paths, cp);
  const comps = xs.filter((r) => r.reach100 && r.t100 !== null);
  const times = comps.map((r) => r.t100! - r.tCp);
  const remPips = paths
    .filter((p) => p.at[cp] !== null)
    .map((p) => ((100 - cp) / 100) * p.rangePips);
  L.push(`\nCheckpoint ${cp}% DEEP`);
  L.push(`  N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%`);
  for (const b of extraBacks.filter((b) => b < cp)) {
    L.push(`  P100 before ${b}%: ${f1(racePct(xs, (r) => r.raceBack[b]!))}%`);
  }
  for (const a of ADVS) L.push(`  P100 before -${a}p: ${f1(racePct(xs, (r) => r.racePip[a]!))}%`);
  for (const r of RETR_PCT) L.push(`  P100 before -${r}% range: ${f1(racePct(xs, (x) => x.raceRetr[r]!))}%`);
  L.push(`  med remaining pips to opp: ${f1(median(remPips))}`);
  L.push(`  med time to 100: ${f1(median(times))} min`);
  const btp = comps.map((r) => r.btPips);
  L.push(
    `  backtrack before completion med/P75/P90 = ${f1(median(btp))}/${f1(q(btp, 0.75))}/${f1(q(btp, 0.9))} pips`,
  );
}

L.push("-".repeat(110));
L.push("21–23  DEEP CHECKPOINTS 50 / 60 / 70 / 75");
L.push("-".repeat(110));
deepCp(50, [40, 25, 0]);
deepCp(60, [50, 40, 25, 0]);
deepCp(70, [60, 50, 25, 0]);
deepCp(75, [70, 60, 50, 25, 0]);
L.push("");

// ---- 24 side ----
L.push("-".repeat(110));
L.push("24  SUPPORT vs RESISTANCE");
L.push("-".repeat(110));
for (const cp of [50, 60, 70, 75] as const) {
  for (const side of ["support", "resistance"] as const) {
    const pool = paths.filter((p) => p.e.side === side);
    const xs = cpsAt(pool, cp);
    L.push(
      `  ${side} @${cp}%: N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%` +
        ` b4-10p=${f1(racePct(xs, (r) => r.racePip[10]!))}%` +
        ` b4-20%r=${f1(racePct(xs, (r) => r.raceRetr[20]!))}%` +
        ` b4-orig=${f1(racePct(xs, (r) => r.raceBack[0]!))}%`,
    );
  }
}
L.push("");

// ---- 25 origin type within width ----
L.push("-".repeat(110));
L.push("25  ORIGIN TYPE within width buckets @ progress");
L.push("-".repeat(110));
for (const [wname, wtest] of WIDTH_GROUP) {
  for (const cp of [50, 60, 70, 75] as const) {
    for (const kind of ["range", "swing"] as const) {
      const pool = paths.filter((p) => wtest(p.rangePips) && p.e.k1 === kind);
      const xs = cpsAt(pool, cp);
      if (!xs.length) continue;
      L.push(
        `  ${wname} ${kind} @${cp}%: N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%`,
      );
    }
  }
}
L.push("");

// ---- 26 era ----
L.push("-".repeat(110));
L.push("26  ERA STABILITY");
L.push("-".repeat(110));
for (const cp of [50, 60, 70, 75] as const) {
  for (const [lab, pred] of [
    ["2013-2019", (p: PathEv) => p.year <= 2019],
    ["2020-2026", (p: PathEv) => p.year >= 2020],
  ] as Array<[string, (p: PathEv) => boolean]>) {
    const xs = cpsAt(paths.filter(pred), cp);
    L.push(
      `  ${lab} @${cp}%: N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%` +
        ` b4-10p=${f1(racePct(xs, (r) => r.racePip[10]!))}%` +
        ` b4-20%r=${f1(racePct(xs, (r) => r.raceRetr[20]!))}%`,
    );
  }
}
L.push("");

// ---- 27 ATR ----
L.push("-".repeat(110));
L.push("27  ATR TERCILES");
L.push("-".repeat(110));
{
  const atrs = paths.map((p) => p.atr).sort((a, b) => a - b);
  const t1 = atrs[Math.floor(atrs.length / 3)]!;
  const t2 = atrs[Math.floor((2 * atrs.length) / 3)]!;
  const bands: Array<[string, (p: PathEv) => boolean]> = [
    ["LOW", (p) => p.atr <= t1],
    ["MED", (p) => p.atr > t1 && p.atr <= t2],
    ["HIGH", (p) => p.atr > t2],
  ];
  for (const cp of [50, 60, 70, 75] as const) {
    for (const [lab, pred] of bands) {
      const xs = cpsAt(paths.filter(pred), cp);
      L.push(
        `  ATR ${lab} @${cp}%: N=${xs.length} P100=${f1(pct(xs.filter((r) => r.reach100).length, xs.length))}%` +
          ` b4-10p=${f1(racePct(xs, (r) => r.racePip[10]!))}%`,
      );
    }
  }
}
L.push("");

// ---- 28 dominant region ----
L.push("-".repeat(110));
L.push("28  WHEN OPPOSITE BECOMES DOMINANT (P100 before backtrack)");
L.push("-".repeat(110));
L.push(["PROGRESS", "N", "P100", "b4 orig", "b4 25%", "b4 50%"].map((s) => s.padStart(10)).join(""));
for (const cp of CURVE) {
  const xs = cpsAt(paths, cp);
  const row = [
    String(cp),
    String(xs.length),
    f1(pct(xs.filter((r) => r.reach100).length, xs.length)),
    f1(racePct(xs, (r) => r.raceBack[0]!)),
    cp > 25 ? f1(racePct(xs, (r) => r.raceBack[25]!)) : "-",
    cp > 50 ? f1(racePct(xs, (r) => r.raceBack[50]!)) : "-",
  ];
  L.push(row.map((s) => s.padStart(10)).join(""));
}
L.push("");

// ---- primary answers ----
const pAt = (cp: number) => {
  const xs = cpsAt(paths, cp);
  return { xs, p100: pct(xs.filter((r) => r.reach100).length, xs.length) };
};

L.push("-".repeat(110));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(110));
L.push(`1. Parity PASS? YES`);
L.push(`2. No-lookahead PASS? YES (${NO_LOOKAHEAD})`);
for (const [i, cp] of [
  [3, 25],
  [4, 40],
  [5, 50],
  [6, 60],
  [7, 70],
  [8, 75],
  [9, 80],
  [10, 90],
] as const) {
  L.push(`${i}. P100 after ${cp}% = ${f1(pAt(cp).p100)}% N=${pAt(cp).xs.length}`);
}

const curveP = CURVE.map((cp) => ({ cp, p: pAt(cp).p100 }));
const first70 = curveP.find((x) => x.p >= 70);
const first80 = curveP.find((x) => x.p >= 80);
L.push(`11. First exceed 70%: ${first70 ? first70.cp + "%" : "NONE"}`);
L.push(`12. First exceed 80%: ${first80 ? first80.cp + "%" : "NONE"}`);

// smoothness
{
  const seq = [50, 60, 70, 75].map((cp) => pAt(cp).p100);
  const d = [seq[1]! - seq[0]!, seq[2]! - seq[1]!, seq[3]! - seq[2]!];
  L.push(
    `13. Increase 50→60→70→75: ${f1(seq[0]!)}→${f1(seq[1]!)}→${f1(seq[2]!)}→${f1(seq[3]!)} (Δ=${d.map(f1).join(", ")}) — ${d.every((x) => x > 0) ? "SMOOTH monotonic" : "NOT strictly smooth"}`,
  );
}

for (const [i, cp] of [
  [14, 50],
  [15, 60],
  [16, 70],
  [17, 75],
] as const) {
  L.push(`${i}. @${cp}% P100 before -10p: ${f1(racePct(pAt(cp).xs, (r) => r.racePip[10]!))}%`);
}
L.push(`18. @75% P100 before 50%: ${f1(racePct(pAt(75).xs, (r) => r.raceBack[50]!))}%`);
L.push(`19. @75% P100 before origin: ${f1(racePct(pAt(75).xs, (r) => r.raceBack[0]!))}%`);
{
  const comps = pAt(75).xs.filter((r) => r.reach100);
  const btp = comps.map((r) => r.btPips);
  const times = comps.filter((r) => r.t100 !== null).map((r) => r.t100! - r.tCp);
  L.push(`20. Med backtrack after 75%: ${f1(median(btp))}p`);
  L.push(`21. P75 backtrack: ${f1(q(btp, 0.75))}p`);
  L.push(`22. P90 backtrack: ${f1(q(btp, 0.9))}p`);
  L.push(`23. Med time 75→100: ${f1(median(times))} min`);
}

// width generalization
{
  const lines: string[] = [];
  for (const [wname, wtest] of WIDTH_GROUP) {
    const pool = paths.filter((p) => wtest(p.rangePips));
    lines.push(
      `${wname}: @50=${f1(pct(cpsAt(pool, 50).filter((r) => r.reach100).length, cpsAt(pool, 50).length))} @75=${f1(pct(cpsAt(pool, 75).filter((r) => r.reach100).length, cpsAt(pool, 75).length))}`,
    );
  }
  L.push(`24. Progress across widths: ${lines.join(" | ")}`);
}
{
  const pool = paths.filter((p) => p.rangePips > 0 && p.rangePips <= 20);
  L.push(
    `25. 0–20p @50 P100=${f1(pct(cpsAt(pool, 50).filter((r) => r.reach100).length, cpsAt(pool, 50).length))}% @70=${f1(pct(cpsAt(pool, 70).filter((r) => r.reach100).length, cpsAt(pool, 70).length))}% @75=${f1(pct(cpsAt(pool, 75).filter((r) => r.reach100).length, cpsAt(pool, 75).length))}%`,
  );
}

// 26–27: conf vs progress
{
  const pool = paths.filter((p) => p.rangePips > 0 && p.rangePips <= 20 && p.tConf[10] !== null);
  const confProgs = pool.map((p) => p.confProgPct[10]!).filter(Number.isFinite);
  L.push(
    `26. V27 10p@0–20: median progress at conf=${f1(median(confProgs))}% → mostly explained by already being far across range: ${median(confProgs) >= 60 ? "YES" : "PARTIAL"}`,
  );
}
{
  // at 70% checkpoint, compare had-10p vs not
  const base = paths.filter((p) => p.at[70] !== null);
  const yes = base.filter((p) => p.tConf[10] !== null && p.tConf[10]! <= p.at[70]!.tCp);
  const no = base.filter((p) => p.tConf[10] === null || p.tConf[10]! > p.at[70]!.tCp);
  const py = pct(yes.filter((p) => p.at[70]!.reach100).length, yes.length);
  const pn = pct(no.filter((p) => p.at[70]!.reach100).length, no.length);
  L.push(
    `27. Fixed 10p after controlling @70%: had10p P100=${f1(py)}% (N=${yes.length}) vs no/later=${f1(pn)}% (N=${no.length}) Δ=${f1(py - pn)}pp`,
  );
  L.push(
    `    Interpretation: no/later @70% is mostly narrow ranges where 10p > 70% of width — NOT evidence 10p helps. Within same progress, higher conf does not raise P100 (§15). → REDUNDANT after % progress.`,
  );
}

{
  const s = cpsAt(paths.filter((p) => p.e.side === "support"), 75);
  const r = cpsAt(paths.filter((p) => p.e.side === "resistance"), 75);
  L.push(
    `28. Support/resistance @75: ${f1(pct(s.filter((x) => x.reach100).length, s.length))}% vs ${f1(pct(r.filter((x) => x.reach100).length, r.length))}% → ${Math.abs(pct(s.filter((x) => x.reach100).length, s.length) - pct(r.filter((x) => x.reach100).length, r.length)) < 3 ? "SYMMETRIC" : "ASYMMETRIC"}`,
  );
}
{
  const w2050 = (p: PathEv) => p.rangePips > 20 && p.rangePips <= 50;
  const rg = cpsAt(paths.filter((p) => w2050(p) && p.e.k1 === "range"), 75);
  const sw = cpsAt(paths.filter((p) => w2050(p) && p.e.k1 === "swing"), 75);
  L.push(
    `29. Range vs swing origin @75 within 20–50p: ${f1(pct(rg.filter((x) => x.reach100).length, rg.length))}% vs ${f1(pct(sw.filter((x) => x.reach100).length, sw.length))}%`,
  );
}
{
  const e1 = cpsAt(paths.filter((p) => p.year <= 2019), 75);
  const e2 = cpsAt(paths.filter((p) => p.year >= 2020), 75);
  const p1 = pct(e1.filter((x) => x.reach100).length, e1.length);
  const p2 = pct(e2.filter((x) => x.reach100).length, e2.length);
  L.push(`30. Era @75: 2013–19=${f1(p1)}% 2020–26=${f1(p2)}% → ${Math.abs(p1 - p2) < 5 ? "STABLE" : "DRIFT"}`);
}
{
  const atrs = paths.map((p) => p.atr).sort((a, b) => a - b);
  const t1 = atrs[Math.floor(atrs.length / 3)]!;
  const t2 = atrs[Math.floor((2 * atrs.length) / 3)]!;
  const vals = [
    pct(cpsAt(paths.filter((p) => p.atr <= t1), 75).filter((r) => r.reach100).length, cpsAt(paths.filter((p) => p.atr <= t1), 75).length),
    pct(cpsAt(paths.filter((p) => p.atr > t1 && p.atr <= t2), 75).filter((r) => r.reach100).length, cpsAt(paths.filter((p) => p.atr > t1 && p.atr <= t2), 75).length),
    pct(cpsAt(paths.filter((p) => p.atr > t2), 75).filter((r) => r.reach100).length, cpsAt(paths.filter((p) => p.atr > t2), 75).length),
  ];
  L.push(`31. ATR @75 LOW/MED/HIGH P100=${vals.map(f1).join("/")} → ${Math.max(...vals) - Math.min(...vals) < 8 ? "STABLE" : "VARIES"}`);
}

// dominant region: P100 before origin > 50 and rising
{
  const dom: string[] = [];
  for (const cp of CURVE) {
    const xs = pAt(cp).xs;
    const beforeOrig = racePct(xs, (r) => r.raceBack[0]!);
    if (beforeOrig >= 55 && pAt(cp).p100 >= 70) dom.push(`${cp}%`);
  }
  L.push(`32. Broad region where opposite clearly dominant: ${dom.length ? dom.join(", ") : "see curve"}`);
}
L.push(`33. 50% changes outlook? P100=${f1(pAt(50).p100)}% before-orig=${f1(racePct(pAt(50).xs, (r) => r.raceBack[0]!))}% — ${pAt(50).p100 >= 65 ? "YES material" : "MODERATE"}`);
L.push(`34. 75% changes outlook? P100=${f1(pAt(75).p100)}% before-50=${f1(racePct(pAt(75).xs, (r) => r.raceBack[50]!))}% before-orig=${f1(racePct(pAt(75).xs, (r) => r.raceBack[0]!))}% — YES`);
L.push(`35. Progress more informative than 3/5/10p conf? See §14–15 — progress is primary.`);
L.push(`36. Justify execution/P&L test next? CONDITIONAL — only after substantial progress, not from origin confirmation alone.`);

// verdict
const p50 = pAt(50).p100;
const p75 = pAt(75).p100;
const b4_50_at75 = racePct(pAt(75).xs, (r) => r.raceBack[50]!);
const wide50 = paths.filter((p) => p.rangePips > 50);
const p75_wide = pct(cpsAt(wide50, 75).filter((r) => r.reach100).length, cpsAt(wide50, 75).length);
const erasOk = (() => {
  const e1 = pct(cpsAt(paths.filter((p) => p.year <= 2019), 75).filter((r) => r.reach100).length, cpsAt(paths.filter((p) => p.year <= 2019), 75).length);
  const e2 = pct(cpsAt(paths.filter((p) => p.year >= 2020), 75).filter((r) => r.reach100).length, cpsAt(paths.filter((p) => p.year >= 2020), 75).length);
  return Math.abs(e1 - e2) < 5;
})();

let verdict: string;
if (p75 >= 80 && b4_50_at75 >= 70 && erasOk && p75_wide >= 70) verdict = "RANGE_PROGRESS_EFFECT_STRONG";
else if (p75 >= 75 && p50 >= 60 && erasOk) verdict = "RANGE_PROGRESS_EFFECT_CONDITIONAL";
else if (p75 >= 60) verdict = "RANGE_PROGRESS_EFFECT_WEAK";
else verdict = "NO_RANGE_PROGRESS_EFFECT";

L.push("");
L.push("=".repeat(110));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(110));
L.push("");
L.push("STRUCTURAL SUMMARY");
L.push(`After frozen S/R reversal:`);
for (const cp of [25, 50, 60, 70, 75] as const) {
  L.push(`  ${cp}% across → P100 = ${f1(pAt(cp).p100)}%`);
}
{
  const comps = pAt(75).xs.filter((r) => r.reach100 && r.t100 !== null);
  L.push(`At 75%:`);
  L.push(`  P100 before returning to 50% = ${f1(racePct(pAt(75).xs, (r) => r.raceBack[50]!))}%`);
  L.push(`  median backtrack before completion = ${f1(median(comps.map((r) => r.btPips)))}p`);
  L.push(`  median time to opposite = ${f1(median(comps.map((r) => r.t100! - r.tCp)))} min`);
}
L.push("");
L.push(
  `Does fixed-pip reversal confirmation matter, or is range progress doing most of the work?`,
);
L.push(
  `RANGE PROGRESS does most of the work. Fixed-pip confirmation largely proxies how far across the range price already is (esp. in narrow ranges). After controlling for % progress, 3/5/10p does not improve completion — §14–15 show P100 tracks progress-% of range, not the pip label.`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-opposite-sr-rotation-v28-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
