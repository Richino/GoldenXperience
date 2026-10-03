/**
 * EUR/USD V22 — EARLY M1 REVERSAL EXECUTION (research-only).
 *
 * V18–V21 FROZEN. No new signal discovery. No entry-rule optimization.
 *
 * Frozen V21 rules (T+2, still ≥3p outside):
 *   PRIMARY: mom_dying — last 1m AND last 3m completed M1 returns ≤0 in breakout dir
 *   ALT:     toward≥2 — ≥2 consecutive completed M1 candles toward S/R
 *
 * Entry: fade immediately after required completed M1 info is available
 *   support→LONG @ ASK close | resistance→SHORT @ BID close
 * BID/ASK exits. One trade / frozen level / session (primary).
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import {
  LONDON_TIME_ZONE,
  NEW_YORK_TIME_ZONE,
  TOKYO_TIME_ZONE,
  localMinutes,
} from "../src/lib/strategy/session";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const OUT_DIR = PAD;
const WINDOW = 220;
const TOUCH_ATR = PR.touchAtr;
const DUP_PIP = 1;
const M15_BAR_MIN = 15;
const M5_BAR_MIN = 5;
const M1_BAR_MIN = 1;
const D_PIP = 3;
const CP = 2;
const EXTRA_H_M1 = 4 * 60;
const YEARS_SPAN = 2026 - 2013 + 1;
const V20_MED_ENTRY = -0.6;
const V20_AVG_SPREAD = 1.52;
const V20_MED_MAE = 17.2;
const V20_REACH = { reclaim: 93.9, pct25: 73.6, pct50: 58.1, pct75: 46.9, pct100: 39.2 };

type SessionName = "ASIA" | "LONDON" | "NEW_YORK";
type Side = "support" | "resistance";
type LevelType = "range" | "swing";
type Dir = "long" | "short";
type Period = "discovery" | "validation";
type OC = "win" | "loss" | "timeout" | "ambiguous";
type RuleName = "PRIMARY" | "ALT";
type TpKind = "reclaim" | "pct25" | "pct50" | "pct75" | "pct100";
type SlKind =
  | "struct_0.10"
  | "struct_0.25"
  | "struct_0.50"
  | "range_25"
  | "range_50"
  | "range_75"
  | "range_100"
  | "atr_1"
  | "atr_2"
  | "atr_3"
  | "fixed_10"
  | "fixed_20"
  | "fixed_30"
  | "fixed_45";
type Horizon = "session" | "plus4h";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

interface FrozenLevel {
  side: Side;
  type: LevelType;
  price: number;
}
interface SessionSnap {
  session: SessionName;
  openMs: number;
  closeMs: number;
  atr: number;
  levels: FrozenLevel[];
  year: number;
}
interface Ev3 {
  session: SessionName;
  side: Side;
  type: LevelType;
  year: number;
  period: Period;
  level: number;
  opposite: number | null;
  outer: number | null;
  rangeWidthPips: number;
  rangeValid: boolean;
  atr: number;
  m5Idx: number;
  m5CloseMs: number;
  returned: boolean;
  t0Idx: number;
  sessionEndM1: number;
  openMs: number;
}
interface Setup {
  rule: RuleName;
  session: SessionName;
  side: Side;
  type: LevelType;
  dir: Dir;
  year: number;
  period: Period;
  level: number;
  opposite: number | null;
  outer: number | null;
  rangeWidthPips: number;
  rangeValid: boolean;
  atr: number;
  t0Idx: number;
  fillIdx: number;
  signalMs: number;
  fillMs: number;
  entry: number;
  spreadPips: number;
  entryPenPips: number;
  extremePenPips: number;
  penBucket: string;
  widthBucket: string;
  sessionEndIdx: number;
  plus4EndIdx: number;
  returned: boolean; // V21 LABEL B
  momDying: boolean;
  toward2: boolean;
}

interface Acc {
  n: number;
  wins: number;
  losses: number;
  timeouts: number;
  amb: number;
  sumPnl: number;
  sumWin: number;
  sumLoss: number;
  winsP: number[];
  lossP: number[];
  mae: number[];
  mfe: number[];
  hold: number[];
  spreads: number[];
  years: Map<number, { n: number; wins: number; sumPnl: number; sumWin: number; sumLoss: number }>;
}

const SESSION_DEFS: Array<{ name: SessionName; tz: string }> = [
  { name: "ASIA", tz: TOKYO_TIME_ZONE },
  { name: "LONDON", tz: LONDON_TIME_ZONE },
  { name: "NEW_YORK", tz: NEW_YORK_TIME_ZONE },
];
const TPS: TpKind[] = ["reclaim", "pct25", "pct50", "pct75", "pct100"];
const SLS: AmSl[] = [
  "struct_0.10",
  "struct_0.25",
  "struct_0.50",
  "range_25",
  "range_50",
  "range_75",
  "range_100",
  "atr_1",
  "atr_2",
  "atr_3",
  "fixed_10",
  "fixed_20",
  "fixed_30",
  "fixed_45",
];
type AmSl = SlKind;
const HORIZONS: Horizon[] = ["session", "plus4h"];

function mustExist(p: string) {
  if (!fs.existsSync(p)) throw new Error(`Missing cache: ${p}`);
}

const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5_PATH = path.join(PAD, "eurusd-m5-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
mustExist(M15_PATH);
mustExist(M5_PATH);
mustExist(M1_PATH);

console.log("V22 loading M15/M5/M1...");
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
const timesMs = raw.map((c) => Date.parse(c.time));

const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M5_PATH, "utf8"),
);
const M5 = m5raw.length;
const m5ms = new Float64Array(M5);
const mh = new Float64Array(M5),
  ml = new Float64Array(M5),
  mc = new Float64Array(M5),
  mo = new Float64Array(M5);
for (let i = 0; i < M5; i++) {
  const r = m5raw[i]!;
  m5ms[i] = Date.parse(r[0]);
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
  mo[i] = i === 0 ? mc[i]! : mc[i - 1]!;
}
(m5raw as unknown as { length: number }).length = 0;

const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const m1t: string[] = new Array(M1);
const m1ms = new Float64Array(M1);
const bh = new Float64Array(M1),
  bl = new Float64Array(M1),
  ah = new Float64Array(M1),
  al = new Float64Array(M1),
  bc = new Float64Array(M1),
  ac = new Float64Array(M1);
const m1h = new Float64Array(M1),
  m1l = new Float64Array(M1),
  m1c = new Float64Array(M1),
  m1o = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  m1t[i] = r[0];
  m1ms[i] = Date.parse(r[0]);
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
  m1h[i] = (r[1] + r[3]) / 2;
  m1l[i] = (r[2] + r[4]) / 2;
  m1c[i] = (r[5] + r[6]) / 2;
  m1o[i] = i === 0 ? m1c[i]! : m1c[i - 1]!;
}
(m1raw as unknown as { length: number }).length = 0;
console.log(`M15 ${n} | M5 ${M5} | M1 ${M1}`);

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
function localYmd(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}
function inCentreSession(ms: number, tz: string): boolean {
  const mins = localMinutes(new Date(ms), tz);
  return mins >= 8 * 60 && mins < 17 * 60;
}
function periodOf(year: number): Period {
  return year <= 2019 ? "discovery" : "validation";
}
function pctile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! * (1 - (idx - lo)) + s[hi]! * (idx - lo);
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function fmt(x: number, d = 1): string {
  return Number.isFinite(x) ? x.toFixed(d) : "—";
}
function pct(a: number, b: number): number {
  return b > 0 ? (100 * a) / b : NaN;
}
function touchesZone(h: number, l: number, level: number, w: number): boolean {
  return l <= level + w && h >= level - w;
}
function clearInside(h: number, l: number, side: Side, level: number, w: number): boolean {
  if (side === "resistance") return h < level - w;
  return l > level + w;
}
function penMid(h: number, l: number, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (h - level) / PIP);
  return Math.max(0, (level - l) / PIP);
}
function penExec(i: number, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (ah[i]! - level) / PIP);
  return Math.max(0, (level - bl[i]!) / PIP);
}
function hits3p(i: number, side: Side, level: number): boolean {
  return penExec(i, side, level) >= D_PIP;
}
function oppositeOf(snap: SessionSnap, side: Side, type: LevelType, origin: number): number | null {
  const want: Side = side === "resistance" ? "support" : "resistance";
  const same = snap.levels.find((l) => l.side === want && l.type === type);
  if (same && ((side === "resistance" && same.price < origin) || (side === "support" && same.price > origin)))
    return same.price;
  const any = snap.levels.filter((l) => l.side === want);
  if (side === "resistance") {
    const c = any.filter((l) => l.price < origin);
    return c.length ? c.reduce((a, b) => (a.price < b.price ? a : b)).price : null;
  }
  const c = any.filter((l) => l.price > origin);
  return c.length ? c.reduce((a, b) => (a.price > b.price ? a : b)).price : null;
}
function outerSameSide(snap: SessionSnap, side: Side, type: LevelType, origin: number): number | null {
  const same = snap.levels.filter((l) => l.side === side && l.type !== type ? true : l.side === side);
  const all = snap.levels.filter((l) => l.side === side);
  if (side === "resistance") {
    const cands = all.filter((l) => l.price > origin + PIP * 0.5);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (a.price > b.price ? a : b)).price;
  }
  const cands = all.filter((l) => l.price < origin - PIP * 0.5);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.price < b.price ? a : b)).price;
  void same;
}
function penBucket(p: number): string {
  if (p < 4) return "3-4p";
  if (p < 5) return "4-5p";
  if (p < 7.5) return "5-7.5p";
  if (p < 10) return "7.5-10p";
  return "10p+";
}
function widthBucket(p: number): string {
  if (p < 10) return "0-10p";
  if (p < 20) return "10-20p";
  if (p < 30) return "20-30p";
  if (p < 50) return "30-50p";
  if (p < 75) return "50-75p";
  if (p < 100) return "75-100p";
  return "100p+";
}

function buildSnaps(): SessionSnap[] {
  const snaps: SessionSnap[] = [];
  for (const def of SESSION_DEFS) {
    let prevIn = false;
    let prevDay = "";
    for (let i = WINDOW; i < n; i++) {
      const ms = timesMs[i]!;
      const inside = inCentreSession(ms, def.tz);
      const day = inside ? localYmd(ms, def.tz) : "";
      const isOpen = inside && (!prevIn || day !== prevDay);
      if (isOpen) {
        const freezeIdx = i - 1;
        if (freezeIdx < WINDOW - 1) {
          prevIn = inside;
          prevDay = day;
          continue;
        }
        const window = mids.slice(freezeIdx - WINDOW + 1, freezeIdx + 1);
        const levels = computeSupportResistanceLevels(window, INSTRUMENT);
        const atr = atr14Of(window);
        if (!levels || !(atr > 0)) {
          prevIn = inside;
          prevDay = day;
          continue;
        }
        const frozen: FrozenLevel[] = [];
        frozen.push({ side: "resistance", type: "range", price: levels.rangeHigh });
        frozen.push({ side: "support", type: "range", price: levels.rangeLow });
        if (levels.swingHigh !== null && Math.abs(levels.swingHigh - levels.rangeHigh) / PIP >= DUP_PIP) {
          frozen.push({ side: "resistance", type: "swing", price: levels.swingHigh });
        }
        if (levels.swingLow !== null && Math.abs(levels.swingLow - levels.rangeLow) / PIP >= DUP_PIP) {
          frozen.push({ side: "support", type: "swing", price: levels.swingLow });
        }
        let j = i;
        while (j < n && inCentreSession(timesMs[j]!, def.tz) && localYmd(timesMs[j]!, def.tz) === day) j++;
        const openMs = timesMs[i]!;
        const closeMs = j > i ? timesMs[j - 1]! + M15_BAR_MIN * 60_000 : openMs + 9 * 3600_000;
        snaps.push({
          session: def.name,
          openMs,
          closeMs,
          atr,
          levels: frozen,
          year: new Date(openMs).getUTCFullYear(),
        });
      }
      prevIn = inside;
      prevDay = day;
    }
  }
  return snaps;
}

console.log("Building sessions...");
const snaps = buildSnaps();
console.log(`Sessions: ${snaps.length}`);

let lookaheadFail = false;
const auditNotes: string[] = [];
const events: Ev3[] = [];

function collectEvents() {
  for (const snap of snaps) {
    const w = TOUCH_ATR * snap.atr;
    const atr = snap.atr;
    const m5Start = lb(m5ms, M5, snap.openMs);
    let m5End = lb(m5ms, M5, snap.closeMs);
    if (m5End > M5) m5End = M5;
    if (m5End <= m5Start + 2) continue;
    const sessionEndM1 = lb(m1ms, M1, snap.closeMs);

    for (const fl of snap.levels) {
      let armed = true;
      let active = false;
      let touchIdx = -1;
      let reached3 = false;

      for (let i = m5Start; i < m5End; i++) {
        const h = mh[i]!,
          l = ml[i]!,
          c = mc[i]!;
        const touch = touchesZone(h, l, fl.price, w);
        const pen = penMid(h, l, fl.side, fl.price);

        if (armed && touch) {
          armed = false;
          active = true;
          touchIdx = i;
          reached3 = false;
        }
        if (!active) {
          if (!armed && clearInside(h, l, fl.side, fl.price, w)) armed = true;
          continue;
        }

        if (!reached3 && pen >= D_PIP) {
          reached3 = true;
          let returned = false;
          for (let k = i; k < m5End; k++) {
            if (fl.side === "resistance" ? mc[k]! <= fl.price : mc[k]! >= fl.price) {
              returned = true;
              break;
            }
          }
          const m5OpenMs = m5ms[i]!;
          const m5CloseMs = m5OpenMs + M5_BAR_MIN * 60_000;
          const searchFrom = lb(m1ms, M1, m5ms[Math.max(touchIdx, m5Start)]!);
          const searchTo = lb(m1ms, M1, m5CloseMs);
          let t0Idx = -1;
          for (let j = searchFrom; j < searchTo && j < M1; j++) {
            if (hits3p(j, fl.side, fl.price)) {
              t0Idx = j;
              break;
            }
          }
          if (t0Idx < 0) {
            const a = lb(m1ms, M1, m5OpenMs);
            const b = lb(m1ms, M1, m5CloseMs);
            for (let j = a; j < b && j < M1; j++) {
              if (hits3p(j, fl.side, fl.price)) {
                t0Idx = j;
                break;
              }
            }
          }
          if (t0Idx >= 0 && m1ms[t0Idx]! >= m5CloseMs) {
            lookaheadFail = true;
            auditNotes.push("T0 after M5 close");
          }
          const opp = oppositeOf(snap, fl.side, fl.type, fl.price);
          const outer = outerSameSide(snap, fl.side, fl.type, fl.price);
          let rangeValid = false;
          let rw = NaN;
          if (opp !== null) {
            if (fl.side === "resistance" && opp < fl.price) {
              rangeValid = true;
              rw = (fl.price - opp) / PIP;
            } else if (fl.side === "support" && opp > fl.price) {
              rangeValid = true;
              rw = (opp - fl.price) / PIP;
            }
          }
          if (t0Idx >= 0) {
            events.push({
              session: snap.session,
              side: fl.side,
              type: fl.type,
              year: snap.year,
              period: periodOf(snap.year),
              level: fl.price,
              opposite: opp,
              outer,
              rangeWidthPips: rw,
              rangeValid,
              atr,
              m5Idx: i,
              m5CloseMs,
              returned,
              t0Idx,
              sessionEndM1,
              openMs: snap.openMs,
            });
          }
          active = false;
        }

        if (active && clearInside(h, l, fl.side, fl.price, w)) {
          active = false;
          armed = true;
          reached3 = false;
        }
      }
    }
  }
}
collectEvents();
console.log(`V19 3p events with T0: ${events.length}`);

/** Exact V21 T+2 feature snapshot (completed M1 only). */
function featuresAtT2(e: Ev3): {
  cpIdx: number;
  stillOut3: boolean;
  curPen: number;
  momDying: boolean;
  toward2: boolean;
} | null {
  if (e.t0Idx < 0) return null;
  const t0CloseMs = m1ms[e.t0Idx]! + 60_000;
  const cpTime = t0CloseMs + CP * 60_000;
  if (cpTime > e.m5CloseMs + 1) return null;
  let cpIdx = lb(m1ms, M1, cpTime) - 1;
  if (cpIdx < e.t0Idx) cpIdx = e.t0Idx;
  while (cpIdx >= 0 && m1ms[cpIdx]! + 60_000 > e.m5CloseMs) cpIdx--;
  if (cpIdx < e.t0Idx) return null;
  if (m1ms[cpIdx]! + 60_000 > cpTime + 1) {
    lookaheadFail = true;
    auditNotes.push("T+2 used incomplete future bar");
  }
  const curPen = penExec(cpIdx, e.side, e.level);
  const stillOut3 = curPen >= D_PIP;
  const brkSign = e.side === "resistance" ? 1 : -1;
  let sum1 = 0,
    sum3 = 0;
  for (let k = 0; k < 3; k++) {
    const j = cpIdx - k;
    if (j < 0) break;
    const r = ((m1c[j]! - m1o[j]!) / PIP) * brkSign;
    if (k === 0) sum1 = r;
    sum3 += r;
  }
  const momDying = sum3 <= 0 && sum1 <= 0;
  let dirChange = 0;
  for (let k = 0; k < 3; k++) {
    const j = cpIdx - k;
    if (j < e.t0Idx) break;
    const ret = m1c[j]! - m1o[j]!;
    const toward = e.side === "resistance" ? ret < 0 : ret > 0;
    if (toward) dirChange++;
    else break;
  }
  return { cpIdx, stillOut3, curPen, momDying, toward2: dirChange >= 2 };
}

type Cand = {
  e: Ev3;
  cpIdx: number;
  curPen: number;
  momDying: boolean;
  toward2: boolean;
};
const t2Cands: Cand[] = [];
for (const e of events) {
  const f = featuresAtT2(e);
  if (!f || !f.stillOut3) continue;
  t2Cands.push({ e, cpIdx: f.cpIdx, curPen: f.curPen, momDying: f.momDying, toward2: f.toward2 });
}

const parityPrimary = t2Cands.filter((c) => c.momDying);
const parityAlt = t2Cands.filter((c) => c.toward2);
function parityBlock(name: string, list: Cand[]) {
  const val = list.filter((c) => c.e.period === "validation");
  const ret = pct(list.filter((c) => c.e.returned).length, list.length);
  const valRet = pct(val.filter((c) => c.e.returned).length, val.length);
  const medPen = pctile(
    list.map((c) => c.curPen),
    0.5,
  );
  console.log(
    `PARITY ${name}: ALL n=${list.length} RET ${fmt(ret)}% medPen ${fmt(medPen, 2)} | VAL n=${val.length} RET ${fmt(valRet)}%`,
  );
  return { n: list.length, ret, medPen, valN: val.length, valRet };
}
const pPrim = parityBlock("PRIMARY mom_dying", parityPrimary);
const pAlt = parityBlock("ALT toward≥2", parityAlt);

const parityOk =
  Math.abs(pPrim.n - 998) <= 30 &&
  Math.abs(pPrim.valN - 576) <= 30 &&
  Math.abs(pPrim.valRet - 86.8) <= 1.5 &&
  Math.abs(pPrim.medPen - 3.6) <= 0.4 &&
  Math.abs(pAlt.n - 2426) <= 50 &&
  Math.abs(pAlt.valN - 1211) <= 50 &&
  Math.abs(pAlt.valRet - 85.0) <= 1.5 &&
  Math.abs(pAlt.medPen - 4.0) <= 0.4;

if (!parityOk) {
  console.error("V21 PARITY FAIL — stopping before P&L.");
  process.exit(1);
}
if (lookaheadFail) {
  console.error("NO_LOOKAHEAD_AUDIT FAIL", auditNotes.slice(0, 5));
  process.exit(1);
}
console.log("NO_LOOKAHEAD_AUDIT = PASS | V21 parity OK");

function makeSetup(c: Cand, rule: RuleName): Setup {
  const e = c.e;
  const dir: Dir = e.side === "resistance" ? "short" : "long";
  const fillIdx = c.cpIdx;
  const entry = dir === "long" ? ac[fillIdx]! : bc[fillIdx]!;
  const spreadPips = (ac[fillIdx]! - bc[fillIdx]!) / PIP;
  // Executable fill penetration (can be << extreme pen used by V21 stillOut3)
  const entryPen = dir === "short" ? (entry - e.level) / PIP : (e.level - entry) / PIP;
  const extremePen = c.curPen; // V21 checkpoint extreme pen (ah/bl)
  const sessionEndIdx = Math.min(e.sessionEndM1, M1);
  const plus4EndIdx = Math.min(M1, sessionEndIdx + EXTRA_H_M1);
  return {
    rule,
    session: e.session,
    side: e.side,
    type: e.type,
    dir,
    year: e.year,
    period: e.period,
    level: e.level,
    opposite: e.opposite,
    outer: e.outer,
    rangeWidthPips: e.rangeWidthPips,
    rangeValid: e.rangeValid,
    atr: e.atr,
    t0Idx: e.t0Idx,
    fillIdx,
    signalMs: m1ms[fillIdx]! + 60_000,
    fillMs: m1ms[fillIdx]! + 60_000,
    entry,
    spreadPips,
    entryPenPips: entryPen,
    extremePenPips: extremePen,
    penBucket: penBucket(entryPen),
    widthBucket: e.rangeValid ? widthBucket(e.rangeWidthPips) : "no_opp",
    sessionEndIdx,
    plus4EndIdx,
    returned: e.returned,
    momDying: c.momDying,
    toward2: c.toward2,
  };
}

function onePerLevel(cands: Cand[], rule: RuleName): Setup[] {
  const sorted = cands.slice().sort((a, b) => a.cpIdx - b.cpIdx);
  const seen = new Set<string>();
  const out: Setup[] = [];
  for (const c of sorted) {
    const key = `${c.e.openMs}|${c.e.session}|${c.e.side}|${c.e.type}|${c.e.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(makeSetup(c, rule));
  }
  return out;
}

const setupsPrimary = onePerLevel(parityPrimary, "PRIMARY");
const setupsAlt = onePerLevel(parityAlt, "ALT");
const overlapBoth = parityPrimary.filter((c) => c.toward2).length;
console.log(
  `PRIMARY one-trade: ${setupsPrimary.length} | ALT one-trade: ${setupsAlt.length} | overlap both features (pre-dedupe): ${overlapBoth}`,
);

function newAcc(): Acc {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    amb: 0,
    sumPnl: 0,
    sumWin: 0,
    sumLoss: 0,
    winsP: [],
    lossP: [],
    mae: [],
    mfe: [],
    hold: [],
    spreads: [],
    years: new Map(),
  };
}
function addTrade(a: Acc, pnl: number, oc: OC, mae: number, mfe: number, holdMin: number, spread: number, year: number) {
  if (oc === "ambiguous") {
    a.amb++;
    return;
  }
  a.n++;
  a.sumPnl += pnl;
  a.spreads.push(spread);
  a.mae.push(mae);
  a.mfe.push(mfe);
  a.hold.push(holdMin);
  if (oc === "win") {
    a.wins++;
    a.sumWin += pnl;
    a.winsP.push(pnl);
  } else if (oc === "loss") {
    a.losses++;
    a.sumLoss += pnl;
    a.lossP.push(pnl);
  } else {
    a.timeouts++;
    if (pnl >= 0) {
      a.sumWin += pnl;
      a.winsP.push(pnl);
    } else {
      a.sumLoss += pnl;
      a.lossP.push(pnl);
    }
  }
  let y = a.years.get(year);
  if (!y) {
    y = { n: 0, wins: 0, sumPnl: 0, sumWin: 0, sumLoss: 0 };
    a.years.set(year, y);
  }
  y.n++;
  y.sumPnl += pnl;
  if (oc === "win" || (oc === "timeout" && pnl >= 0)) {
    y.wins++;
    y.sumWin += pnl;
  } else y.sumLoss += pnl;
}
function pfOf(a: Acc): number {
  if (a.sumLoss >= 0) return a.sumWin > 0 ? Infinity : NaN;
  return a.sumWin / Math.abs(a.sumLoss);
}
function expOf(a: Acc): number {
  return a.n > 0 ? a.sumPnl / a.n : NaN;
}
function wrOf(a: Acc): number {
  return pct(a.wins, a.n);
}
function avgWin(a: Acc): number {
  return mean(a.winsP);
}
function avgLoss(a: Acc): number {
  return mean(a.lossP);
}
function reportAcc(label: string, a: Acc): string {
  const E = expOf(a);
  const PF = pfOf(a);
  const avgW = avgWin(a);
  const avgL = avgLoss(a);
  const risk = Math.abs(avgL);
  const eR = risk > 0 ? E / risk : NaN;
  return (
    `${label} | N=${a.n} W=${a.wins} L=${a.losses} TO=${a.timeouts} AMB=${a.amb} | ` +
    `WR ${fmt(wrOf(a), 1)}% | PF ${fmt(PF)} | E ${fmt(E)}p | E_R ${fmt(eR)} | tot ${fmt(a.sumPnl)}p | ` +
    `avgW ${fmt(avgW)} avgL ${fmt(avgL)} | medW ${fmt(pctile(a.winsP, 0.5))} medL ${fmt(pctile(a.lossP, 0.5))} | ` +
    `avgSpr ${fmt(mean(a.spreads))} medSpr ${fmt(pctile(a.spreads, 0.5))} | ` +
    `medMAE ${fmt(pctile(a.mae, 0.5))} medMFE ${fmt(pctile(a.mfe, 0.5))} | ` +
    `medHold ${fmt(pctile(a.hold, 0.5), 0)}m | t/yr ${fmt(a.n / YEARS_SPAN)}`
  );
}

function tpPrice(s: Setup, tp: TpKind): number | null {
  if (tp === "reclaim") return s.level;
  if (!s.rangeValid || s.opposite === null) return null;
  const w = s.rangeWidthPips * PIP;
  const frac = tp === "pct25" ? 0.25 : tp === "pct50" ? 0.5 : tp === "pct75" ? 0.75 : 1;
  return s.dir === "short" ? s.level - frac * w : s.level + frac * w;
}
function slPrice(s: Setup, sl: SlKind): number | null {
  if (sl.startsWith("struct_")) {
    if (s.outer === null) return null;
    const buf = sl === "struct_0.10" ? 0.1 : sl === "struct_0.25" ? 0.25 : 0.5;
    return s.dir === "short" ? s.outer + buf * s.atr : s.outer - buf * s.atr;
  }
  if (sl.startsWith("range_")) {
    if (!s.rangeValid) return null;
    const frac = sl === "range_25" ? 0.25 : sl === "range_50" ? 0.5 : sl === "range_75" ? 0.75 : 1;
    const dist = frac * s.rangeWidthPips * PIP;
    return s.dir === "short" ? s.level + dist : s.level - dist;
  }
  if (sl.startsWith("fixed_")) {
    const pips = sl === "fixed_10" ? 10 : sl === "fixed_20" ? 20 : sl === "fixed_30" ? 30 : 45;
    return s.dir === "short" ? s.entry + pips * PIP : s.entry - pips * PIP;
  }
  const mult = sl === "atr_1" ? 1 : sl === "atr_2" ? 2 : 3;
  return s.dir === "short" ? s.entry + mult * s.atr : s.entry - mult * s.atr;
}

function simulate(
  s: Setup,
  tp: number,
  sl: number,
  endIdx: number,
): { oc: OC; pnl: number; mae: number; mfe: number; holdMin: number } {
  let mae = 0,
    mfe = 0;
  let exitBar = endIdx - 1;
  let oc: OC = "timeout";
  let exitPx = s.dir === "long" ? bc[Math.max(s.fillIdx + 1, endIdx - 1)]! : ac[Math.max(s.fillIdx + 1, endIdx - 1)]!;

  for (let k = s.fillIdx + 1; k < endIdx; k++) {
    let fav = 0,
      adv = 0;
    if (s.dir === "long") {
      fav = (bh[k]! - s.entry) / PIP;
      adv = (s.entry - bl[k]!) / PIP;
    } else {
      fav = (s.entry - al[k]!) / PIP;
      adv = (ah[k]! - s.entry) / PIP;
    }
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;

    const tpHit = s.dir === "long" ? bh[k]! >= tp : al[k]! <= tp;
    const slHit = s.dir === "long" ? bl[k]! <= sl : ah[k]! >= sl;
    if (tpHit && slHit) {
      return { oc: "ambiguous", pnl: 0, mae, mfe, holdMin: (k - s.fillIdx) * M1_BAR_MIN };
    }
    if (tpHit) {
      const pnl = s.dir === "long" ? (tp - s.entry) / PIP : (s.entry - tp) / PIP;
      return { oc: "win", pnl, mae, mfe, holdMin: (k - s.fillIdx) * M1_BAR_MIN };
    }
    if (slHit) {
      const pnl = s.dir === "long" ? (sl - s.entry) / PIP : (s.entry - sl) / PIP;
      return { oc: "loss", pnl, mae, mfe, holdMin: (k - s.fillIdx) * M1_BAR_MIN };
    }
    exitBar = k;
    exitPx = s.dir === "long" ? bc[k]! : ac[k]!;
  }
  const pnl = s.dir === "long" ? (exitPx - s.entry) / PIP : (s.entry - exitPx) / PIP;
  return { oc, pnl, mae, mfe, holdMin: (exitBar - s.fillIdx) * M1_BAR_MIN };
}

function pathStats(s: Setup, endIdx: number) {
  const reach: Record<string, boolean> = {
    reclaim: false,
    pct25: false,
    pct50: false,
    pct75: false,
    pct100: false,
  };
  const advKeys = ["10p", "20p", "30p", "45p"] as const;
  const reachBefore: Record<string, Record<string, boolean>> = {};
  for (const tk of Object.keys(reach)) {
    reachBefore[tk] = {};
    for (const ak of advKeys) reachBefore[tk]![ak] = false;
  }
  let mae = 0,
    mfe = 0;
  const hitAdv: Record<string, boolean> = { "10p": false, "20p": false, "30p": false, "45p": false };

  const tpOf = (kind: string): number | null => {
    if (kind === "reclaim") return s.level;
    if (!s.rangeValid || s.opposite === null) return null;
    const w = s.rangeWidthPips * PIP;
    const frac = kind === "pct25" ? 0.25 : kind === "pct50" ? 0.5 : kind === "pct75" ? 0.75 : 1;
    return s.dir === "short" ? s.level - frac * w : s.level + frac * w;
  };

  for (let k = s.fillIdx + 1; k < endIdx; k++) {
    let fav = 0,
      adv = 0;
    if (s.dir === "long") {
      fav = (bh[k]! - s.entry) / PIP;
      adv = (s.entry - bl[k]!) / PIP;
    } else {
      fav = (s.entry - al[k]!) / PIP;
      adv = (ah[k]! - s.entry) / PIP;
    }
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    if (adv >= 10) hitAdv["10p"] = true;
    if (adv >= 20) hitAdv["20p"] = true;
    if (adv >= 30) hitAdv["30p"] = true;
    if (adv >= 45) hitAdv["45p"] = true;

    for (const tk of Object.keys(reach)) {
      const tp = tpOf(tk);
      if (tp === null) continue;
      const hit = s.dir === "long" ? bh[k]! >= tp : al[k]! <= tp;
      if (hit && !reach[tk]) {
        reach[tk] = true;
        for (const ak of advKeys) {
          if (!hitAdv[ak]) reachBefore[tk]![ak] = true;
        }
      }
    }
  }
  return { mae, mfe, reach, reachBefore, hitAdv };
}

const L: string[] = [];
function push(...xs: string[]) {
  for (const x of xs) L.push(x);
}

push("=".repeat(88));
push("EUR/USD V22 — EARLY M1 REVERSAL EXECUTION");
push("=".repeat(88));
push("V18–V21 untouched. Frozen V21 T+2 rules only. BID/ASK. No signal mining.");
push(`NO_LOOKAHEAD_AUDIT = PASS`);
push("");
push("V21 PARITY (still ≥3p at T+2, all encounters)");
push(
  `PRIMARY mom_dying: ALL n=${pPrim.n} (≈998) RET ${fmt(pPrim.ret)}% medPen ${fmt(pPrim.medPen, 2)} | VAL n=${pPrim.valN} (≈576) RET ${fmt(pPrim.valRet)}% (≈86.8)`,
);
push(
  `ALT toward≥2: ALL n=${pAlt.n} (≈2426) RET ${fmt(pAlt.ret)}% medPen ${fmt(pAlt.medPen, 2)} | VAL n=${pAlt.valN} (≈1211) RET ${fmt(pAlt.valRet)}% (≈85.0)`,
);
push(`Feature overlap (mom_dying ∩ toward≥2, pre one-trade): ${overlapBoth}`);
push("");
push("ONE TRADE / LEVEL / SESSION (primary P&L universe)");
push(`PRIMARY setups: ${setupsPrimary.length} | ALT setups: ${setupsAlt.length}`);

type PathSum = {
  n: number;
  mae: number[];
  mfe: number[];
  reach: Record<string, number>;
  before: Record<string, Record<string, number>>;
  rangeN: number;
};
function emptyPath(): PathSum {
  const reach: Record<string, number> = { reclaim: 0, pct25: 0, pct50: 0, pct75: 0, pct100: 0 };
  const before: Record<string, Record<string, number>> = {};
  for (const tk of Object.keys(reach)) {
    before[tk] = { "10p": 0, "20p": 0, "30p": 0, "45p": 0 };
  }
  return { n: 0, mae: [], mfe: [], reach, before, rangeN: 0 };
}
function accumulatePath(ps: PathSum, setups: Setup[]) {
  for (const s of setups) {
    const p = pathStats(s, s.sessionEndIdx);
    ps.n++;
    ps.mae.push(p.mae);
    ps.mfe.push(p.mfe);
    if (p.reach.reclaim) ps.reach.reclaim!++;
    if (s.rangeValid) {
      ps.rangeN++;
      for (const tk of ["pct25", "pct50", "pct75", "pct100"]) {
        if (p.reach[tk]) ps.reach[tk]!++;
        for (const ak of ["10p", "20p", "30p", "45p"]) {
          if (p.reachBefore[tk]![ak]) ps.before[tk]![ak]!++;
        }
      }
    }
    for (const ak of ["10p", "20p", "30p", "45p"]) {
      if (p.reachBefore.reclaim![ak]) ps.before.reclaim![ak]!++;
    }
  }
}
function reportPath(title: string, ps: PathSum, setups: Setup[]) {
  push("");
  push("-".repeat(88));
  push(`PATH FROM BID/ASK ENTRY — ${title}`);
  push(`N=${ps.n} | avgSpr ${fmt(mean(setups.map((s) => s.spreadPips)))} medSpr ${fmt(pctile(setups.map((s) => s.spreadPips), 0.5))} | medFillPen ${fmt(pctile(setups.map((s) => s.entryPenPips), 0.5), 2)} | medExtremePen ${fmt(pctile(setups.map((s) => s.extremePenPips), 0.5), 2)}`);
  push(
    `MAE med/P75/P90/P95: ${fmt(pctile(ps.mae, 0.5))} / ${fmt(pctile(ps.mae, 0.75))} / ${fmt(pctile(ps.mae, 0.9))} / ${fmt(pctile(ps.mae, 0.95))}`,
  );
  push(
    `MFE med/P75/P90/P95: ${fmt(pctile(ps.mfe, 0.5))} / ${fmt(pctile(ps.mfe, 0.75))} / ${fmt(pctile(ps.mfe, 0.9))} / ${fmt(pctile(ps.mfe, 0.95))}`,
  );
  push(
    `Reach reclaim ${fmt(pct(ps.reach.reclaim!, ps.n), 1)}% | 25% ${fmt(pct(ps.reach.pct25!, ps.rangeN), 1)}% | 50% ${fmt(pct(ps.reach.pct50!, ps.rangeN), 1)}% | 75% ${fmt(pct(ps.reach.pct75!, ps.rangeN), 1)}% | 100% ${fmt(pct(ps.reach.pct100!, ps.rangeN), 1)}% (rangeN=${ps.rangeN})`,
  );
  for (const tk of ["reclaim", "pct25", "pct50", "pct75", "pct100"]) {
    const den = tk === "reclaim" ? ps.n : ps.rangeN;
    push(
      `  ${tk} before adverse: 10p ${fmt(pct(ps.before[tk]!["10p"]!, den), 1)}% | 20p ${fmt(pct(ps.before[tk]!["20p"]!, den), 1)}% | 30p ${fmt(pct(ps.before[tk]!["30p"]!, den), 1)}% | 45p ${fmt(pct(ps.before[tk]!["45p"]!, den), 1)}%`,
    );
  }
}

const pathP = emptyPath();
const pathA = emptyPath();
accumulatePath(pathP, setupsPrimary);
accumulatePath(pathA, setupsAlt);
reportPath("PRIMARY", pathP, setupsPrimary);
reportPath("ALT", pathA, setupsAlt);

// Matrix
type Key = string;
function keyOf(rule: RuleName, tp: TpKind, sl: SlKind, hz: Horizon, slice: string): Key {
  return `${rule}|${tp}|${sl}|${hz}|${slice}`;
}
const matrix = new Map<Key, Acc>();
const matrixDisc = new Map<Key, Acc>();
const matrixVal = new Map<Key, Acc>();

function bump(map: Map<Key, Acc>, key: Key, s: Setup, r: ReturnType<typeof simulate>) {
  let a = map.get(key);
  if (!a) {
    a = newAcc();
    map.set(key, a);
  }
  addTrade(a, r.pnl, r.oc, r.mae, r.mfe, r.holdMin, s.spreadPips, s.year);
}

function runMatrix(setups: Setup[], rule: RuleName) {
  for (const s of setups) {
    for (const hz of HORIZONS) {
      const endIdx = hz === "session" ? s.sessionEndIdx : s.plus4EndIdx;
      for (const tp of TPS) {
        const tpPx = tpPrice(s, tp);
        if (tpPx === null) continue;
        for (const sl of SLS) {
          const slPx = slPrice(s, sl);
          if (slPx === null) continue;
          // structural stop must be beyond entry for fade
          if (s.dir === "long" && slPx >= s.entry) continue;
          if (s.dir === "short" && slPx <= s.entry) continue;
          const r = simulate(s, tpPx, slPx, endIdx);
          bump(matrix, keyOf(rule, tp, sl, hz, "ALL"), s, r);
          bump(s.period === "discovery" ? matrixDisc : matrixVal, keyOf(rule, tp, sl, hz, "ALL"), s, r);
          bump(matrix, keyOf(rule, tp, sl, hz, s.session), s, r);
          bump(s.period === "discovery" ? matrixDisc : matrixVal, keyOf(rule, tp, sl, hz, s.session), s, r);
          bump(matrix, keyOf(rule, tp, sl, hz, s.side), s, r);
          bump(matrix, keyOf(rule, tp, sl, hz, s.type), s, r);
          bump(matrix, keyOf(rule, tp, sl, hz, `pen_${s.penBucket}`), s, r);
          if (s.rangeValid) bump(matrix, keyOf(rule, tp, sl, hz, `w_${s.widthBucket}`), s, r);
        }
      }
    }
  }
}
console.log("Simulating PRIMARY + ALT matrices...");
runMatrix(setupsPrimary, "PRIMARY");
runMatrix(setupsAlt, "ALT");

function getA(map: Map<Key, Acc>, rule: RuleName, tp: TpKind, sl: SlKind, hz: Horizon, slice = "ALL"): Acc {
  return map.get(keyOf(rule, tp, sl, hz, slice)) ?? newAcc();
}

for (const rule of ["PRIMARY", "ALT"] as RuleName[]) {
  push("");
  push("=".repeat(88));
  push(`FULL MATRIX — ${rule} | session | ALL`);
  push("=".repeat(88));
  for (const tp of TPS) {
    for (const sl of SLS) {
      const a = getA(matrix, rule, tp, sl, "session");
      if (a.n + a.amb === 0) continue;
      push(reportAcc(`${tp} × ${sl} [session]`, a));
    }
  }
  push("");
  push(`FULL MATRIX — ${rule} | +4h | ALL`);
  for (const tp of TPS) {
    for (const sl of SLS) {
      const a = getA(matrix, rule, tp, sl, "plus4h");
      if (a.n + a.amb === 0) continue;
      push(reportAcc(`${tp} × ${sl} [+4h]`, a));
    }
  }
  push("");
  push(`DISC / VAL — ${rule} | session`);
  for (const tp of TPS) {
    for (const sl of SLS) {
      const d = getA(matrixDisc, rule, tp, sl, "session");
      const v = getA(matrixVal, rule, tp, sl, "session");
      if (d.n + v.n === 0) continue;
      push(
        `${tp}×${sl} DISC N=${d.n} WR ${fmt(wrOf(d), 1)}% PF ${fmt(pfOf(d))} E ${fmt(expOf(d))} | VAL N=${v.n} WR ${fmt(wrOf(v), 1)}% PF ${fmt(pfOf(v))} E ${fmt(expOf(v))}`,
      );
    }
  }
}

interface CandRow {
  rule: RuleName;
  tp: TpKind;
  sl: SlKind;
  hz: Horizon;
  val: Acc;
  disc: Acc;
  all: Acc;
}
const cands: CandRow[] = [];
for (const rule of ["PRIMARY", "ALT"] as RuleName[]) {
  for (const hz of HORIZONS) {
    for (const tp of TPS) {
      for (const sl of SLS) {
        const val = getA(matrixVal, rule, tp, sl, hz);
        const disc = getA(matrixDisc, rule, tp, sl, hz);
        const all = getA(matrix, rule, tp, sl, hz);
        if (val.n < 50) continue;
        cands.push({ rule, tp, sl, hz, val, disc, all });
      }
    }
  }
}

function yearOk(a: Acc): boolean {
  const ys = [...a.years.entries()].filter(([, y]) => y.n >= 10);
  if (ys.length < 3) return false;
  const pos = ys.filter(([, y]) => y.sumPnl > 0).length;
  return pos >= Math.ceil(ys.length * 0.5);
}
function passesEdge(val: Acc, disc: Acc): boolean {
  return (
    val.n >= 200 &&
    pfOf(val) > 1.1 &&
    expOf(val) > 0 &&
    val.amb / Math.max(val.n + val.amb, 1) < 0.15 &&
    expOf(disc) > 0 &&
    yearOk(val)
  );
}
function marginal(val: Acc, disc: Acc): boolean {
  return val.n >= 200 && pfOf(val) > 1.0 && expOf(val) > 0 && expOf(disc) >= 0;
}

const passers = cands.filter((c) => passesEdge(c.val, c.disc)).sort((a, b) => expOf(b.val) - expOf(a.val));
const marginals = cands.filter((c) => !passesEdge(c.val, c.disc) && marginal(c.val, c.disc)).sort((a, b) => expOf(b.val) - expOf(a.val));

push("");
push("=".repeat(88));
push("PASSING / MARGINAL VALIDATION CELLS (ALL session slice)");
push("=".repeat(88));
if (!passers.length) push("No EXECUTABLE_EDGE_FOUND cells.");
for (const c of passers.slice(0, 15)) {
  push(
    `PASS ${c.rule} ${c.tp}×${c.sl}[${c.hz}] VAL N=${c.val.n} WR ${fmt(wrOf(c.val), 1)}% PF ${fmt(pfOf(c.val))} E ${fmt(expOf(c.val))} | DISC E ${fmt(expOf(c.disc))}`,
  );
}
if (!marginals.length) push("No MARGINAL cells.");
for (const c of marginals.slice(0, 10)) {
  push(
    `MARG ${c.rule} ${c.tp}×${c.sl}[${c.hz}] VAL N=${c.val.n} WR ${fmt(wrOf(c.val), 1)}% PF ${fmt(pfOf(c.val))} E ${fmt(expOf(c.val))} | DISC E ${fmt(expOf(c.disc))}`,
  );
}

function bestFor(rule: RuleName): CandRow | undefined {
  const pool = [...passers, ...marginals, ...cands]
    .filter((c) => c.rule === rule && c.hz === "session")
    .sort((a, b) => {
      const sa = (expOf(a.val) > 0 ? 1000 : 0) + pfOf(a.val) * 100 + expOf(a.val);
      const sb = (expOf(b.val) > 0 ? 1000 : 0) + pfOf(b.val) * 100 + expOf(b.val);
      return sb - sa;
    });
  return pool[0];
}
const bestP = bestFor("PRIMARY");
const bestA = bestFor("ALT");
const simplest = passers[0] ?? marginals[0];

// Subgroup analysis for best configs
function subgroupBlock(c: CandRow | undefined, label: string) {
  if (!c) {
    push(`No best ${label}`);
    return;
  }
  push("");
  push(`SUBGROUPS — ${label} ${c.tp}×${c.sl}[${c.hz}]`);
  for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    const a = getA(matrix, c.rule, c.tp, c.sl, c.hz, sess);
    const v = getA(matrixVal, c.rule, c.tp, c.sl, c.hz, sess);
    const d = getA(matrixDisc, c.rule, c.tp, c.sl, c.hz, sess);
    push(
      `  ${sess}: ALL N=${a.n} WR ${fmt(wrOf(a), 1)}% PF ${fmt(pfOf(a))} E ${fmt(expOf(a))} | DISC E ${fmt(expOf(d))} N=${d.n} | VAL E ${fmt(expOf(v))} N=${v.n}`,
    );
  }
  for (const side of ["support", "resistance"] as Side[]) {
    const a = getA(matrix, c.rule, c.tp, c.sl, c.hz, side);
    push(`  ${side}: N=${a.n} WR ${fmt(wrOf(a), 1)}% PF ${fmt(pfOf(a))} E ${fmt(expOf(a))}`);
  }
  for (const t of ["range", "swing"] as LevelType[]) {
    const a = getA(matrix, c.rule, c.tp, c.sl, c.hz, t);
    push(`  ${t}: N=${a.n} WR ${fmt(wrOf(a), 1)}% PF ${fmt(pfOf(a))} E ${fmt(expOf(a))}`);
  }
  for (const pb of ["3-4p", "4-5p", "5-7.5p", "7.5-10p", "10p+"]) {
    const a = getA(matrix, c.rule, c.tp, c.sl, c.hz, `pen_${pb}`);
    if (a.n) push(`  pen ${pb}: N=${a.n} WR ${fmt(wrOf(a), 1)}% PF ${fmt(pfOf(a))} E ${fmt(expOf(a))}`);
  }
  for (const wb of ["0-10p", "10-20p", "20-30p", "30-50p", "50-75p", "75-100p", "100p+"]) {
    const a = getA(matrix, c.rule, c.tp, c.sl, c.hz, `w_${wb}`);
    if (a.n) push(`  width ${wb}: N=${a.n} WR ${fmt(wrOf(a), 1)}% PF ${fmt(pfOf(a))} E ${fmt(expOf(a))}`);
  }
  if (pfOf(c.val) > 1) {
    push("  Year-by-year VAL years in ALL map:");
    const yrs = [...c.val.years.entries()].sort((a, b) => a[0] - b[0]);
    for (const [y, yy] of yrs) {
      const pfY = yy.sumLoss < 0 ? yy.sumWin / Math.abs(yy.sumLoss) : NaN;
      push(`    ${y}: N=${yy.n} WR ${fmt(pct(yy.wins, yy.n), 1)}% PF ${fmt(pfY)} E ${fmt(yy.sumPnl / yy.n)} tot ${fmt(yy.sumPnl)}`);
    }
  }
}
subgroupBlock(bestP, "PRIMARY");
subgroupBlock(bestA, "ALT");

// Break-even
function beBlock(c: CandRow | undefined, label: string) {
  if (!c || c.val.n < 50) return;
  const aw = avgWin(c.val);
  const al = Math.abs(avgLoss(c.val));
  const be = al / (aw + al);
  const act = wrOf(c.val) / 100;
  push("");
  push(`BREAK-EVEN — ${label} ${c.tp}×${c.sl}`);
  push(`  avgWin ${fmt(aw)} avgLoss ${fmt(-al)} | BE_WR ${fmt(be * 100, 1)}% | actual WR ${fmt(act * 100, 1)}% | gap ${fmt((act - be) * 100, 1)}pp`);
  // theoretical extra entry pips to reach E=0 holding exit paths approx: need ΔE = -E, Δentry improves win by ~1:1 for reclaim-ish
  const E = expOf(c.val);
  push(`  Diagnostic: need ~${fmt(E < 0 ? -E : 0)}p expectancy improvement to reach E=0 (current E ${fmt(E)}).`);
}
beBlock(bestP, "PRIMARY");
beBlock(bestA, "ALT");

// V20 comparison
push("");
push("=".repeat(88));
push("V20 DIRECT COMPARISON");
push("=".repeat(88));
push(`V20 med entry ${V20_MED_ENTRY}p | V22 PRIMARY med FILL ${fmt(pctile(setupsPrimary.map((s) => s.entryPenPips), 0.5), 2)}p (extreme ${fmt(pctile(setupsPrimary.map((s) => s.extremePenPips), 0.5), 2)}p) | ALT FILL ${fmt(pctile(setupsAlt.map((s) => s.entryPenPips), 0.5), 2)}p (extreme ${fmt(pctile(setupsAlt.map((s) => s.extremePenPips), 0.5), 2)}p)`);
push(`V20 avg spread ${V20_AVG_SPREAD}p | V22 PRIMARY ${fmt(mean(setupsPrimary.map((s) => s.spreadPips)))} | ALT ${fmt(mean(setupsAlt.map((s) => s.spreadPips)))}`);
push(`V20 med MAE ${V20_MED_MAE}p | V22 PRIMARY ${fmt(pctile(pathP.mae, 0.5))} | ALT ${fmt(pctile(pathA.mae, 0.5))}`);
push(
  `V20 reach reclaim/25/50/75/100: ${V20_REACH.reclaim}/${V20_REACH.pct25}/${V20_REACH.pct50}/${V20_REACH.pct75}/${V20_REACH.pct100}`,
);
push(
  `V22 PRIMARY reach: ${fmt(pct(pathP.reach.reclaim!, pathP.n), 1)}/${fmt(pct(pathP.reach.pct25!, pathP.rangeN), 1)}/${fmt(pct(pathP.reach.pct50!, pathP.rangeN), 1)}/${fmt(pct(pathP.reach.pct75!, pathP.rangeN), 1)}/${fmt(pct(pathP.reach.pct100!, pathP.rangeN), 1)}`,
);
push(
  `V22 ALT reach: ${fmt(pct(pathA.reach.reclaim!, pathA.n), 1)}/${fmt(pct(pathA.reach.pct25!, pathA.rangeN), 1)}/${fmt(pct(pathA.reach.pct50!, pathA.rangeN), 1)}/${fmt(pct(pathA.reach.pct75!, pathA.rangeN), 1)}/${fmt(pct(pathA.reach.pct100!, pathA.rangeN), 1)}`,
);
push("V20 best cells were all PF<1 / E<0. Compare nearest reclaim×atr_2 / pct25×atr_2 etc in matrix above.");

let verdict: "EXECUTABLE_EDGE_FOUND" | "MARGINAL_EXECUTABLE_EDGE" | "EARLY_SIGNAL_NOT_PROFITABLE";
if (passers.length) verdict = "EXECUTABLE_EDGE_FOUND";
else if (marginals.length) verdict = "MARGINAL_EXECUTABLE_EDGE";
else verdict = "EARLY_SIGNAL_NOT_PROFITABLE";

// Answers
const medPenP = pctile(
  setupsPrimary.map((s) => s.entryPenPips),
  0.5,
);
const medPenA = pctile(
  setupsAlt.map((s) => s.entryPenPips),
  0.5,
);
const avgSprP = mean(setupsPrimary.map((s) => s.spreadPips));
const avgSprA = mean(setupsAlt.map((s) => s.spreadPips));
const anyPositive = cands.some((c) => expOf(c.val) > 0 && pfOf(c.val) > 1);

push("");
push("=".repeat(88));
push("ANSWERS");
push("=".repeat(88));
push(`1. PRIMARY reproduce V21? YES — n=${pPrim.n} valN=${pPrim.valN} valRET=${fmt(pPrim.valRet)}% medPen=${fmt(pPrim.medPen, 2)}`);
push(`2. ALT reproduce? YES — n=${pAlt.n} valN=${pAlt.valN} valRET=${fmt(pAlt.valRet)}% medPen=${fmt(pAlt.medPen, 2)}`);
push(`3. Actual med entry pen (FILL / extreme): PRIMARY ${fmt(medPenP, 2)}p / ${fmt(pctile(setupsPrimary.map((s) => s.extremePenPips), 0.5), 2)}p | ALT ${fmt(medPenA, 2)}p / ${fmt(pctile(setupsAlt.map((s) => s.extremePenPips), 0.5), 2)}p`);
push(`4. Avg spread: PRIMARY ${fmt(avgSprP)} | ALT ${fmt(avgSprA)}`);
push(`5. Reclaim reach: PRIMARY ${fmt(pct(pathP.reach.reclaim!, pathP.n), 1)}% | ALT ${fmt(pct(pathA.reach.reclaim!, pathA.n), 1)}%`);
push(`6. 25%: PRIMARY ${fmt(pct(pathP.reach.pct25!, pathP.rangeN), 1)}% | ALT ${fmt(pct(pathA.reach.pct25!, pathA.rangeN), 1)}%`);
push(`7. 50%: PRIMARY ${fmt(pct(pathP.reach.pct50!, pathP.rangeN), 1)}% | ALT ${fmt(pct(pathA.reach.pct50!, pathA.rangeN), 1)}%`);
push(`8. 75%: PRIMARY ${fmt(pct(pathP.reach.pct75!, pathP.rangeN), 1)}% | ALT ${fmt(pct(pathA.reach.pct75!, pathA.rangeN), 1)}%`);
push(`9. 100%: PRIMARY ${fmt(pct(pathP.reach.pct100!, pathP.rangeN), 1)}% | ALT ${fmt(pct(pathA.reach.pct100!, pathA.rangeN), 1)}%`);
push(
  `10. MAE PRIMARY med/P75/P90/P95 ${fmt(pctile(pathP.mae, 0.5))}/${fmt(pctile(pathP.mae, 0.75))}/${fmt(pctile(pathP.mae, 0.9))}/${fmt(pctile(pathP.mae, 0.95))} | ALT ${fmt(pctile(pathA.mae, 0.5))}/${fmt(pctile(pathA.mae, 0.75))}/${fmt(pctile(pathA.mae, 0.9))}/${fmt(pctile(pathA.mae, 0.95))}`,
);
const fillImp = medPenP - V20_MED_ENTRY;
const extremeImp = pctile(
  setupsPrimary.map((s) => s.extremePenPips),
  0.5,
) - V20_MED_ENTRY;
push(
  `11. Earlier entry improve V20? Extreme signal YES (+${fmt(extremeImp, 2)}p vs V20 fill) but FILL only +${fmt(fillImp, 2)}p (PRIMARY med fill ${fmt(medPenP, 2)}p) — executable edge ${anyPositive ? "PARTIAL/see matrix" : "NO — PF/E still fail"}`,
);
if (bestP) {
  push(`12. Best PRIMARY val TP/SL: ${bestP.tp} × ${bestP.sl} [${bestP.hz}]`);
  push(`13. N=${bestP.val.n}`);
  push(`14. WR=${fmt(wrOf(bestP.val), 1)}%`);
  push(`15. PF=${fmt(pfOf(bestP.val))}`);
  push(`16. E=${fmt(expOf(bestP.val))}p`);
} else push("12-16. No PRIMARY cells with usable N");
if (bestA) {
  push(`17. Best ALT: ${bestA.tp} × ${bestA.sl} [${bestA.hz}]`);
  push(`18. PF=${fmt(pfOf(bestA.val))} E=${fmt(expOf(bestA.val))}p N=${bestA.val.n}`);
} else push("17-18. No ALT cells");
const allPass = passers.some((c) => true);
push(`19. ALL-session config pass? ${passers.length ? "YES" : marginals.length ? "MARGINAL only" : "NO"}`);
function sessNote(rule: RuleName, sess: SessionName): string {
  const ref = bestFor(rule);
  if (!ref) return "n/a";
  const v = getA(matrixVal, rule, ref.tp, ref.sl, "session", sess);
  return `VAL N=${v.n} PF ${fmt(pfOf(v))} E ${fmt(expOf(v))}`;
}
push(`20. London P&L (best PRIMARY cell): ${sessNote("PRIMARY", "LONDON")}`);
push(`21. New York: ${sessNote("PRIMARY", "NEW_YORK")}`);
push(`22. Asia: ${sessNote("PRIMARY", "ASIA")}`);
if (bestP) {
  const lng = getA(matrix, bestP.rule, bestP.tp, bestP.sl, bestP.hz, "support");
  const sht = getA(matrix, bestP.rule, bestP.tp, bestP.sl, bestP.hz, "resistance");
  push(`23. LONG(support) E ${fmt(expOf(lng))} PF ${fmt(pfOf(lng))} | SHORT(resistance) E ${fmt(expOf(sht))} PF ${fmt(pfOf(sht))}`);
  const rg = getA(matrix, bestP.rule, bestP.tp, bestP.sl, bestP.hz, "range");
  const sw = getA(matrix, bestP.rule, bestP.tp, bestP.sl, bestP.hz, "swing");
  push(`24. RANGE E ${fmt(expOf(rg))} | SWING E ${fmt(expOf(sw))}`);
} else {
  push("23. n/a");
  push("24. n/a");
}
push("25. Penetration matters? see pen_* subgroup rows (hypothesis only).");
push("26. Range width matters? see w_* subgroup rows (hypothesis only).");
if (bestP && bestP.val.n >= 50) {
  const aw = avgWin(bestP.val);
  const al = Math.abs(avgLoss(bestP.val));
  const be = (100 * al) / (aw + al);
  push(`27. BE_WR best PRIMARY: ${fmt(be, 1)}%`);
  push(`28. Actual WR − BE: ${fmt(wrOf(bestP.val) - be, 1)}pp`);
} else {
  push("27-28. n/a");
}
push(
  `29. +4p earlier entry solve V20 spread/RR? ${verdict === "EARLY_SIGNAL_NOT_PROFITABLE" ? "NO — location improved but payoff still fails after spread/MAE" : verdict === "EXECUTABLE_EDGE_FOUND" ? "YES — validation edge found" : "PARTIAL — marginal only"}`,
);
push(
  `30. Ready as strategy? ${verdict === "EXECUTABLE_EDGE_FOUND" ? "CANDIDATE — freeze setup, do not expand filters yet" : "NO"}`,
);

push("");
push("=".repeat(88));
push(`VERDICT: ${verdict}`);
push("=".repeat(88));
if (simplest && (verdict === "EXECUTABLE_EDGE_FOUND" || verdict === "MARGINAL_EXECUTABLE_EDGE")) {
  const ruleLabel = simplest.rule === "PRIMARY" ? "mom_dying" : "toward≥2";
  push("SIMPLEST FROZEN SETUP:");
  push("Frozen session S/R");
  push("→ 3p breakout");
  push("→ T+2");
  push(`→ ${ruleLabel}`);
  push("→ enter fade using BID/ASK");
  push(`→ SL = ${simplest.sl}`);
  push(`→ TP = ${simplest.tp}`);
  push(`→ horizon = ${simplest.hz}`);
  push(`→ validation N = ${simplest.val.n}`);
  push(`→ WR = ${fmt(wrOf(simplest.val), 1)}%`);
  push(`→ PF = ${fmt(pfOf(simplest.val))}`);
  push(`→ expectancy = ${fmt(expOf(simplest.val))} pips/trade`);
} else {
  push("No frozen V21 early signal clears executable validation after BID/ASK + TP/SL.");
  push("Earlier entry improved location vs V20 but did not create a robust profitable fade.");
  push("Do not create V23 yet.");
}

const reportPathOut = path.join(OUT_DIR, "eurusd-early-m1-reversal-exec-v22-report.txt");
fs.writeFileSync(reportPathOut, L.join("\n"));
try {
  fs.mkdirSync(path.join(process.cwd(), "research-output"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "research-output", "eurusd-early-m1-reversal-exec-v22-report.txt"),
    L.join("\n"),
  );
} catch {
  /* ignore */
}
console.log(`Wrote ${reportPathOut}`);
console.log(`VERDICT: ${verdict}`);
void M5_BAR_MIN;
void allPass;
