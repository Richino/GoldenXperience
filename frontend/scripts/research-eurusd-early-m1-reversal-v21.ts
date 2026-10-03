/**
 * EUR/USD V21 — EARLY M1 REVERSAL DETECTION (research-only).
 *
 * V18/V19/V20 FROZEN. No P&L / no TP/SL.
 *
 * Question: at the first moment price reaches 3p outside frozen session S/R,
 * can M1 information identify future V19 weak_body / RETURN_INSIDE BEFORE the
 * M5 breakout candle closes — while price is preferably STILL outside?
 *
 * Exact V19 weak_body (DO NOT CHANGE):
 *   bodyAtr <= 0.15 || bodyRange <= 0.35 || closeOut <= 0.5
 *
 * T0 = first M1 bar whose executable extreme reaches 3p beyond frozen S/R
 *   resistance: ask.high >= R+3p
 *   support:    bid.low  <= S-3p
 * Checkpoints: T0..T+4m, stop at M5 breakout candle close.
 * Features use only completed M1 information available at the checkpoint.
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
const D_PIP = 3;
const V20_MED_ENTRY = -0.6;
const CHECKPOINTS = [0, 1, 2, 3, 4] as const;

type SessionName = "ASIA" | "LONDON" | "NEW_YORK";
type Side = "support" | "resistance";
type LevelType = "range" | "swing";
type Period = "discovery" | "validation";
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

/** One V19-parity 3p M5 event. */
interface Ev3 {
  session: SessionName;
  side: Side;
  type: LevelType;
  year: number;
  period: Period;
  level: number;
  opposite: number | null;
  rangeWidthPips: number;
  atr: number; // M15 ATR at freeze
  m5Idx: number;
  m5OpenMs: number;
  m5CloseMs: number;
  touchM5Idx: number;
  weakBody: boolean; // LABEL A
  returned: boolean; // LABEL B
  t0Idx: number; // M1 index of first 3p touch bar (completed)
  sessionEndM1: number;
}

interface CpSnap {
  ev: Ev3;
  cp: number; // 0..4
  cpIdx: number; // M1 index at checkpoint (last completed bar)
  stillOut3: boolean;
  penBucket: string;
  curPen: number;
  maxPen: number;
  giveback: number;
  // features
  bodyStrength: "weak" | "normal" | "strong";
  wickBucket: string;
  givebackBucket: string;
  velocityState: "accelerating" | "stable" | "decelerating";
  dirChange: number; // 0..3 consecutive toward S/R
  microFail: boolean;
  closeLoc: string;
  momBucket: string;
  largeWick: boolean;
  giveback1: boolean;
  giveback2: boolean;
  weakBodyM1: boolean;
  decel: boolean;
  toward1: boolean;
  toward2: boolean;
}

const SESSION_DEFS: Array<{ name: SessionName; tz: string }> = [
  { name: "ASIA", tz: TOKYO_TIME_ZONE },
  { name: "LONDON", tz: LONDON_TIME_ZONE },
  { name: "NEW_YORK", tz: NEW_YORK_TIME_ZONE },
];

function mustExist(p: string) {
  if (!fs.existsSync(p)) throw new Error(`Missing cache: ${p}`);
}

const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5_PATH = path.join(PAD, "eurusd-m5-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
mustExist(M15_PATH);
mustExist(M5_PATH);
mustExist(M1_PATH);

console.log("V21 loading M15/M5/M1...");
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
const m5t: string[] = new Array(M5);
const m5ms = new Float64Array(M5);
const mh = new Float64Array(M5),
  ml = new Float64Array(M5),
  mc = new Float64Array(M5),
  mo = new Float64Array(M5);
for (let i = 0; i < M5; i++) {
  const r = m5raw[i]!;
  m5t[i] = r[0];
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
// mid for some path metrics
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
console.log(`M1 range ${m1t[0]} → ${m1t[M1 - 1]}`);

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

/** EXACT V19 — DO NOT CHANGE */
function isWeakBody(bodyAtr: number, bodyRange: number, closeOut: number): boolean {
  return bodyAtr <= 0.15 || bodyRange <= 0.35 || closeOut <= 0.5;
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
function closeOutMid(c: number, side: Side, level: number): number {
  if (side === "resistance") return (c - level) / PIP;
  return (level - c) / PIP;
}

/** Executable penetration for fade path. */
function penExec(i: number, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (ah[i]! - level) / PIP);
  return Math.max(0, (level - bl[i]!) / PIP);
}
function closeOutExec(i: number, side: Side, level: number): number {
  if (side === "resistance") return (ac[i]! - level) / PIP;
  return (level - bc[i]!) / PIP;
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

function penBucketOf(p: number): string {
  if (p >= 3) return ">=3p_out";
  if (p >= 2) return "2-3p_out";
  if (p >= 1) return "1-2p_out";
  if (p > 0) return "0-1p_out";
  return "inside";
}

function closeLocOf(p: number): string {
  if (p >= 5) return ">=5p_out";
  if (p >= 3) return "3-5p_out";
  if (p >= 2) return "2-3p_out";
  if (p >= 1) return "1-2p_out";
  if (p > 0) return "0-1p_out";
  return "inside";
}

function givebackBucketOf(g: number): string {
  if (g < 0.5) return "gb_0-0.5";
  if (g < 1) return "gb_0.5-1";
  if (g < 2) return "gb_1-2";
  if (g < 3) return "gb_2-3";
  return "gb_3+";
}

function wickBucketOf(wr: number): string {
  if (wr < 0.2) return "wr_<20%";
  if (wr < 0.35) return "wr_20-35%";
  if (wr < 0.5) return "wr_35-50%";
  if (wr < 0.65) return "wr_50-65%";
  return "wr_65%+";
}

// ---------- collect V19 3p events + M1 T0 ----------
console.log("Building session snapshots...");
const snaps = buildSnaps();
console.log(`Sessions: ${snaps.length}`);

const events: Ev3[] = [];
let lookaheadFail = false;
const auditNotes: string[] = [];

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
          c = mc[i]!,
          o = mo[i]!;
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
          const range = Math.max(h - l, PIP * 0.1);
          const body = Math.abs(c - o);
          const bodyRange = body / range;
          const bodyAtr = body / atr;
          const closeOut = closeOutMid(c, fl.side, fl.price);
          const weakBody = isWeakBody(bodyAtr, bodyRange, closeOut);

          // LABEL B: return inside before session end (mid close, V19-style)
          let returned = false;
          for (let k = i; k < m5End; k++) {
            if (fl.side === "resistance" ? mc[k]! <= fl.price : mc[k]! >= fl.price) {
              returned = true;
              break;
            }
          }

          const m5OpenMs = m5ms[i]!;
          const m5CloseMs = m5OpenMs + M5_BAR_MIN * 60_000;

          // T0: first M1 bar in this encounter that hits 3p executable
          // Search from touch start (or session) through this M5 candle close
          const searchFrom = lb(m1ms, M1, m5ms[Math.max(touchIdx, m5Start)]!);
          const searchTo = lb(m1ms, M1, m5CloseMs);
          let t0Idx = -1;
          for (let j = searchFrom; j < searchTo && j < M1; j++) {
            if (hits3p(j, fl.side, fl.price)) {
              t0Idx = j;
              break;
            }
          }
          // Fallback: search within the signal M5 bar only
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

          if (t0Idx < 0) {
            // M5 mid hit 3p but executable M1 never did — skip M1 path, still count for parity
            const opp = oppositeOf(snap, fl.side, fl.type, fl.price);
            let rw = NaN;
            if (opp !== null) {
              rw =
                fl.side === "resistance"
                  ? (fl.price - opp) / PIP
                  : (opp - fl.price) / PIP;
            }
            events.push({
              session: snap.session,
              side: fl.side,
              type: fl.type,
              year: snap.year,
              period: periodOf(snap.year),
              level: fl.price,
              opposite: opp,
              rangeWidthPips: rw,
              atr,
              m5Idx: i,
              m5OpenMs,
              m5CloseMs,
              touchM5Idx: touchIdx,
              weakBody,
              returned,
              t0Idx: -1,
              sessionEndM1,
            });
          } else {
            // Audit: T0 must be before M5 close
            if (m1ms[t0Idx]! >= m5CloseMs) {
              lookaheadFail = true;
              auditNotes.push(`T0 after M5 close at ${m5t[i]}`);
            }
            const opp = oppositeOf(snap, fl.side, fl.type, fl.price);
            let rw = NaN;
            if (opp !== null) {
              rw =
                fl.side === "resistance"
                  ? (fl.price - opp) / PIP
                  : (opp - fl.price) / PIP;
            }
            events.push({
              session: snap.session,
              side: fl.side,
              type: fl.type,
              year: snap.year,
              period: periodOf(snap.year),
              level: fl.price,
              opposite: opp,
              rangeWidthPips: rw,
              atr,
              m5Idx: i,
              m5OpenMs,
              m5CloseMs,
              touchM5Idx: touchIdx,
              weakBody,
              returned,
              t0Idx,
              sessionEndM1,
            });
          }

          // end encounter after first 3p (V19 at_D once)
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
const withT0 = events.filter((e) => e.t0Idx >= 0);
console.log(`V19 3p events: ${events.length} | with M1 T0: ${withT0.length}`);
console.log(
  `Return baseline: ${fmt(pct(events.filter((e) => e.returned).length, events.length))}% | weak_body ${fmt(pct(events.filter((e) => e.weakBody).length, events.length))}%`,
);

// ---------- discovery thresholds for M1 body ----------
function m1BodyAtr(i: number, atrM1: number): { bodyAtr: number; bodyRange: number; wickRange: number; rejWick: number; closeOut: number } {
  // placeholder — filled in feature builder
  return { bodyAtr: 0, bodyRange: 0, wickRange: 0, rejWick: 0, closeOut: 0 };
}
void m1BodyAtr;

function atr1At(i: number): number {
  // simple mean range of prior 14 completed M1
  let sum = 0,
    n = 0;
  for (let k = i - 14; k < i; k++) {
    if (k < 0) continue;
    sum += m1h[k]! - m1l[k]!;
    n++;
  }
  return n > 0 ? sum / n : PIP;
}

// Collect discovery bodyAtr / bodyRange distributions at T0 for thresholds
const discBodyAtr: number[] = [];
const discBodyRange: number[] = [];
for (const e of withT0) {
  if (e.period !== "discovery") continue;
  const i = e.t0Idx;
  const atr1 = atr1At(i);
  const o = m1o[i]!,
    h = m1h[i]!,
    l = m1l[i]!,
    c = m1c[i]!;
  const range = Math.max(h - l, PIP * 0.05);
  const body = Math.abs(c - o);
  discBodyAtr.push(body / atr1);
  discBodyRange.push(body / range);
}
const bodyAtrP33 = pctile(discBodyAtr, 0.33);
const bodyAtrP66 = pctile(discBodyAtr, 0.66);
const bodyRangeP33 = pctile(discBodyRange, 0.33);
const bodyRangeP66 = pctile(discBodyRange, 0.66);
console.log(
  `Discovery M1 body thresholds (frozen): bodyAtr P33/P66=${fmt(bodyAtrP33, 3)}/${fmt(bodyAtrP66, 3)} bodyRange P33/P66=${fmt(bodyRangeP33, 3)}/${fmt(bodyRangeP66, 3)}`,
);

function bodyStrengthOf(bodyAtr: number, bodyRange: number): "weak" | "normal" | "strong" {
  if (bodyAtr <= bodyAtrP33 || bodyRange <= bodyRangeP33) return "weak";
  if (bodyAtr >= bodyAtrP66 && bodyRange >= bodyRangeP66) return "strong";
  return "normal";
}

function buildCp(e: Ev3, cp: number): CpSnap | null {
  if (e.t0Idx < 0) return null;
  // Checkpoint time = T0 bar open + cp minutes; use last COMPLETED M1 at or before that
  // T0 itself = completion of first touch bar (causal OHLC).
  const t0CloseMs = m1ms[e.t0Idx]! + 60_000;
  const cpTime = t0CloseMs + cp * 60_000;
  // Stop if past M5 breakout close
  if (cpTime > e.m5CloseMs + 1) return null;
  // last completed M1 with open+1m <= cpTime
  let cpIdx = lb(m1ms, M1, cpTime) - 1;
  if (cpIdx < e.t0Idx) cpIdx = e.t0Idx;
  // must not use bars at/after M5 close
  while (cpIdx >= 0 && m1ms[cpIdx]! + 60_000 > e.m5CloseMs) cpIdx--;
  if (cpIdx < e.t0Idx) return null;

  // Audit: no future bars
  if (m1ms[cpIdx]! + 60_000 > cpTime + 1) {
    lookaheadFail = true;
    auditNotes.push(`cp ${cp} used incomplete future bar`);
  }

  // max pen from t0..cpIdx
  let maxPen = 0;
  for (let j = e.t0Idx; j <= cpIdx; j++) {
    maxPen = Math.max(maxPen, penExec(j, e.side, e.level));
  }
  const curPen = penExec(cpIdx, e.side, e.level);
  const giveback = Math.max(0, maxPen - curPen);
  const stillOut3 = curPen >= D_PIP;

  const atr1 = atr1At(cpIdx);
  const o = m1o[cpIdx]!,
    h = m1h[cpIdx]!,
    l = m1l[cpIdx]!,
    c = m1c[cpIdx]!;
  const range = Math.max(h - l, PIP * 0.05);
  const body = Math.abs(c - o);
  const bodyAtr = body / atr1;
  const bodyRange = body / range;
  let rejWick = 0;
  if (e.side === "resistance") rejWick = h - Math.max(o, c);
  else rejWick = Math.min(o, c) - l;
  const wickRange = rejWick / range;
  const closeOut = closeOutExec(cpIdx, e.side, e.level);

  // velocity: pips/min before 3p (from S/R cross approx = touch) vs since T0
  const preBars = Math.max(1, e.t0Idx - Math.max(0, e.t0Idx - 5));
  let preMove = 0;
  for (let j = e.t0Idx - preBars; j < e.t0Idx; j++) {
    if (j < 0) continue;
    preMove += penExec(j, e.side, e.level);
  }
  const preVel = preMove / preBars; // rough
  const postBars = Math.max(1, cpIdx - e.t0Idx + 1);
  const postVel = maxPen / postBars;

  // deceleration: last 1m move vs previous 1m
  let last1 = 0,
    prev1 = 0;
  if (cpIdx >= 1) {
    last1 = e.side === "resistance" ? (m1c[cpIdx]! - m1c[cpIdx - 1]!) / PIP : (m1c[cpIdx - 1]! - m1c[cpIdx]!) / PIP;
    // breakout direction positive
    const brkSign = e.side === "resistance" ? 1 : -1;
    last1 = ((m1c[cpIdx]! - m1c[cpIdx - 1]!) / PIP) * brkSign;
  }
  if (cpIdx >= 2) {
    const brkSign = e.side === "resistance" ? 1 : -1;
    prev1 = ((m1c[cpIdx - 1]! - m1c[cpIdx - 2]!) / PIP) * brkSign;
  }
  let velocityState: "accelerating" | "stable" | "decelerating" = "stable";
  if (postVel < preVel * 0.7 || last1 < prev1 - 0.3) velocityState = "decelerating";
  else if (postVel > preVel * 1.3 || last1 > prev1 + 0.3) velocityState = "accelerating";

  // consecutive M1 toward S/R (completed bars ending at cpIdx)
  let dirChange = 0;
  for (let k = 0; k < 3; k++) {
    const j = cpIdx - k;
    if (j < e.t0Idx) break;
    const ret = m1c[j]! - m1o[j]!;
    const toward = e.side === "resistance" ? ret < 0 : ret > 0;
    if (toward) dirChange++;
    else break;
  }

  // micro high/low failure after T0
  let microFail = false;
  if (cpIdx > e.t0Idx) {
    if (e.side === "resistance") {
      // new high then close below prior close
      for (let j = e.t0Idx + 1; j <= cpIdx; j++) {
        if (ah[j]! > ah[j - 1]! && ac[j]! < ac[j - 1]!) {
          microFail = true;
          break;
        }
      }
    } else {
      for (let j = e.t0Idx + 1; j <= cpIdx; j++) {
        if (bl[j]! < bl[j - 1]! && bc[j]! > bc[j - 1]!) {
          microFail = true;
          break;
        }
      }
    }
  }

  // micro momentum last 1/2/3m toward breakout (positive = still breaking out)
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
  let momBucket = "mom_normal";
  if (sum3 <= 0 && sum1 <= 0) momBucket = "mom_dying";
  else if (sum3 > 1.5) momBucket = "mom_strong";

  const bodyStrength = bodyStrengthOf(bodyAtr, bodyRange);
  const largeWick = wickRange >= 0.5 || (body > PIP * 0.05 && rejWick / body >= 1);
  const weakBodyM1 = bodyStrength === "weak";

  return {
    ev: e,
    cp,
    cpIdx,
    stillOut3,
    penBucket: penBucketOf(curPen),
    curPen,
    maxPen,
    giveback,
    bodyStrength,
    wickBucket: wickBucketOf(wickRange),
    givebackBucket: givebackBucketOf(giveback),
    velocityState,
    dirChange,
    microFail,
    closeLoc: closeLocOf(closeOut),
    momBucket,
    largeWick,
    giveback1: giveback >= 1,
    giveback2: giveback >= 2,
    weakBodyM1,
    decel: velocityState === "decelerating",
    toward1: dirChange >= 1,
    toward2: dirChange >= 2,
  };
}

console.log("Building checkpoint snapshots...");
const snapsCp: CpSnap[] = [];
for (const e of withT0) {
  for (const cp of CHECKPOINTS) {
    const s = buildCp(e, cp);
    if (s) snapsCp.push(s);
  }
}
console.log(`Checkpoint snaps: ${snapsCp.length}`);

// Path metrics from checkpoint (cached)
const pathCache = new Map<string, ReturnType<typeof pathFromRaw>>();

function pathFromRaw(s: CpSnap): {
  mae: number;
  mfe: number;
  reach: Record<string, boolean>;
  advExtra: Record<string, boolean>;
} {
  const e = s.ev;
  const reach = { reclaim: false, pct25: false, pct50: false, pct75: false, pct100: false };
  const advExtra = { "5p": false, "10p": false, "20p": false, "30p": false, "50p": false };
  let mae = 0,
    mfe = 0;
  const startPen = s.curPen;
  const end = Math.min(e.sessionEndM1, M1);
  for (let j = s.cpIdx + 1; j < end; j++) {
    const pen = penExec(j, e.side, e.level);
    const extra = pen - startPen;
    if (extra > mae) mae = extra;
    let fav = 0;
    if (e.side === "resistance") {
      fav = Math.max(0, (e.level + startPen * PIP - bl[j]!) / PIP);
    } else {
      fav = Math.max(0, (bh[j]! - (e.level - startPen * PIP)) / PIP);
    }
    if (fav > mfe) mfe = fav;

    const reclaimHit = e.side === "resistance" ? bl[j]! <= e.level : bh[j]! >= e.level;
    if (reclaimHit) reach.reclaim = true;

    if (e.opposite !== null && e.rangeWidthPips > 0) {
      const w = e.rangeWidthPips * PIP;
      if (!reach.pct25) {
        const tp = e.side === "resistance" ? e.level - 0.25 * w : e.level + 0.25 * w;
        if (e.side === "resistance" ? bl[j]! <= tp : bh[j]! >= tp) reach.pct25 = true;
      }
      if (!reach.pct50) {
        const tp = e.side === "resistance" ? e.level - 0.5 * w : e.level + 0.5 * w;
        if (e.side === "resistance" ? bl[j]! <= tp : bh[j]! >= tp) reach.pct50 = true;
      }
      if (!reach.pct75) {
        const tp = e.side === "resistance" ? e.level - 0.75 * w : e.level + 0.75 * w;
        if (e.side === "resistance" ? bl[j]! <= tp : bh[j]! >= tp) reach.pct75 = true;
      }
      if (!reach.pct100) {
        const tp = e.opposite;
        if (e.side === "resistance" ? bl[j]! <= tp : bh[j]! >= tp) reach.pct100 = true;
      }
    }
    if (extra >= 5) advExtra["5p"] = true;
    if (extra >= 10) advExtra["10p"] = true;
    if (extra >= 20) advExtra["20p"] = true;
    if (extra >= 30) advExtra["30p"] = true;
    if (extra >= 50) advExtra["50p"] = true;
  }
  return { mae, mfe, reach, advExtra };
}

function pathFrom(s: CpSnap) {
  const key = `${s.ev.m5Idx}|${s.ev.side}|${s.ev.type}|${s.cp}|${s.cpIdx}`;
  let p = pathCache.get(key);
  if (!p) {
    p = pathFromRaw(s);
    pathCache.set(key, p);
  }
  return p;
}

type Pred = (s: CpSnap) => boolean;

interface Row {
  name: string;
  n: number;
  ret: number;
  weak: number;
  lift: number;
  medPen: number;
  entryImp: number;
  medMae: number;
  p75Mae: number;
  p90Mae: number;
  discN: number;
  discRet: number;
  valN: number;
  valRet: number;
  reach: Record<string, number>;
  adv: Record<string, number>;
}

function summarize(list: CpSnap[], name: string, baselineRet: number, withPath = false): Row {
  const nE = list.length;
  const retN = list.filter((s) => s.ev.returned).length;
  const weakN = list.filter((s) => s.ev.weakBody).length;
  const ret = pct(retN, nE);
  const pens = list.map((s) => s.curPen);
  const disc = list.filter((s) => s.ev.period === "discovery");
  const val = list.filter((s) => s.ev.period === "validation");
  const reach: Record<string, number> = {
    reclaim: NaN,
    pct25: NaN,
    pct50: NaN,
    pct75: NaN,
    pct100: NaN,
  };
  const adv: Record<string, number> = {
    "5p": NaN,
    "10p": NaN,
    "20p": NaN,
    "30p": NaN,
    "50p": NaN,
  };
  let medMae = NaN,
    p75Mae = NaN,
    p90Mae = NaN;
  if (withPath && nE > 0) {
    const paths = list.map((s) => pathFrom(s));
    const maes = paths.map((p) => p.mae);
    medMae = pctile(maes, 0.5);
    p75Mae = pctile(maes, 0.75);
    p90Mae = pctile(maes, 0.9);
    for (const k of Object.keys(reach)) {
      reach[k] = pct(paths.filter((p) => p.reach[k as keyof typeof p.reach]).length, nE);
    }
    for (const k of Object.keys(adv)) {
      adv[k] = pct(paths.filter((p) => p.advExtra[k as keyof typeof p.advExtra]).length, nE);
    }
  }
  const medPen = pctile(pens, 0.5);
  return {
    name,
    n: nE,
    ret,
    weak: pct(weakN, nE),
    lift: ret - baselineRet,
    medPen,
    entryImp: medPen - V20_MED_ENTRY,
    medMae,
    p75Mae,
    p90Mae,
    discN: disc.length,
    discRet: pct(disc.filter((s) => s.ev.returned).length, disc.length),
    valN: val.length,
    valRet: pct(val.filter((s) => s.ev.returned).length, val.length),
    reach,
    adv,
  };
}

function pushRow(L: string[], r: Row) {
  L.push(
    `${r.name} | n=${r.n} RET ${fmt(r.ret)}% (lift ${fmt(r.lift, 1)}) weak ${fmt(r.weak)}% | medPen ${fmt(r.medPen, 2)} (ΔvsV20 ${fmt(r.entryImp, 2)}) | MAE med/P75/P90 ${fmt(r.medMae)}/${fmt(r.p75Mae)}/${fmt(r.p90Mae)} | disc ${r.discN}/${fmt(r.discRet)}% val ${r.valN}/${fmt(r.valRet)}%`,
  );
}

const L: string[] = [];
L.push("=".repeat(88));
L.push("EUR/USD V21 — EARLY M1 REVERSAL DETECTION");
L.push("=".repeat(88));
L.push("V18/V19/V20 untouched. No P&L.");
L.push(`M1 ${M1} candles ${m1t[0]} → ${m1t[M1 - 1]}`);
L.push("");
L.push("V19 PARITY");
L.push(`  3p M5 events: ${events.length} (V19≈36986)`);
L.push(`  RETURN baseline: ${fmt(pct(events.filter((e) => e.returned).length, events.length))}% (V19≈79.7%)`);
L.push(`  weak_body rate: ${fmt(pct(events.filter((e) => e.weakBody).length, events.length))}%`);
L.push(`  with M1 T0: ${withT0.length}`);
L.push(`  Discovery body thresholds frozen: bodyAtr P33=${fmt(bodyAtrP33, 3)} P66=${fmt(bodyAtrP66, 3)}`);
L.push("");

// NO_LOOKAHEAD_AUDIT
const auditPass = !lookaheadFail;
L.push(`NO_LOOKAHEAD_AUDIT = ${auditPass ? "PASS" : "FAIL"}`);
if (!auditPass) {
  L.push(...auditNotes.slice(0, 20));
  fs.writeFileSync(path.join(OUT_DIR, "eurusd-early-m1-reversal-v21-report.txt"), L.join("\n"));
  console.log(L.join("\n"));
  process.exit(1);
}
L.push("  Rules: T0=first completed M1 with executable extreme ≥3p; checkpoints use only");
L.push("  completed M1 with close≤checkpoint time and ≤M5 breakout close; no M5 OHLC");
L.push("  features before M5 close; labels computed after the fact only.");
L.push("");

type Combo = { name: string; pred: Pred };

for (const cp of CHECKPOINTS) {
  const allCp = snapsCp.filter((s) => s.cp === cp);
  const out3 = allCp.filter((s) => s.stillOut3);
  const baseline = pct(out3.filter((s) => s.ev.returned).length, out3.length);
  L.push("-".repeat(88));
  L.push(`CHECKPOINT T+${cp}m | all=${allCp.length} | STILL≥3p OUT=${out3.length} | base RET ${fmt(baseline)}%`);
  L.push(`  pen buckets (all):`);
  for (const b of [">=3p_out", "2-3p_out", "1-2p_out", "0-1p_out", "inside"]) {
    const sub = allCp.filter((s) => s.penBucket === b);
    if (!sub.length) continue;
    L.push(
      `    ${b}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.ev.returned).length, sub.length))}% weak ${fmt(pct(sub.filter((s) => s.ev.weakBody).length, sub.length))}% medPen ${fmt(pctile(sub.map((x) => x.curPen), 0.5), 2)}`,
    );
  }

  L.push(`  Features among STILL≥3p OUT:`);
  const feats: Combo[] = [
    { name: "weak M1 body", pred: (s) => s.weakBodyM1 },
    { name: "large rejection wick", pred: (s) => s.largeWick },
    { name: "giveback≥1p", pred: (s) => s.giveback1 },
    { name: "giveback≥2p", pred: (s) => s.giveback2 },
    { name: "decelerating", pred: (s) => s.decel },
    { name: "toward S/R ≥1 M1", pred: (s) => s.toward1 },
    { name: "toward S/R ≥2 M1", pred: (s) => s.toward2 },
    { name: "micro fail", pred: (s) => s.microFail },
    { name: "mom_dying", pred: (s) => s.momBucket === "mom_dying" },
  ];
  for (const f of feats) {
    const sub = out3.filter(f.pred);
    if (sub.length < 50) continue;
    pushRow(L, summarize(sub, `T+${cp}|${f.name}`, baseline));
  }

  // combinations (max 2)
  const combos: Combo[] = [
    { name: "decel+wick", pred: (s) => s.decel && s.largeWick },
    { name: "decel+gb≥1", pred: (s) => s.decel && s.giveback1 },
    { name: "weak+wick", pred: (s) => s.weakBodyM1 && s.largeWick },
    { name: "wick+toward1", pred: (s) => s.largeWick && s.toward1 },
    { name: "gb≥1+toward1", pred: (s) => s.giveback1 && s.toward1 },
    { name: "microFail+decel", pred: (s) => s.microFail && s.decel },
    { name: "gb≥1+decel", pred: (s) => s.giveback1 && s.decel },
    { name: "weak+decel", pred: (s) => s.weakBodyM1 && s.decel },
  ];
  L.push(`  Combinations (STILL≥3p):`);
  for (const c of combos) {
    const sub = out3.filter(c.pred);
    if (sub.length < 50) continue;
    pushRow(L, summarize(sub, `T+${cp}|${c.name}`, baseline));
  }
}

// Rank best validated early signals (still outside, discovery select)
L.push("\n" + "=".repeat(88));
L.push("BEST EARLY SIGNALS — discovery select, validation score (STILL≥3p only)");
L.push("=".repeat(88));

interface Cand {
  cp: number;
  name: string;
  pred: Pred;
  disc: Row;
  val: Row;
  all: Row;
  score: number;
}

const allCombos: Array<{ name: string; pred: Pred }> = [
  { name: "weak M1 body", pred: (s) => s.weakBodyM1 },
  { name: "large rejection wick", pred: (s) => s.largeWick },
  { name: "giveback≥1p", pred: (s) => s.giveback1 },
  { name: "giveback≥2p", pred: (s) => s.giveback2 },
  { name: "decelerating", pred: (s) => s.decel },
  { name: "toward≥1", pred: (s) => s.toward1 },
  { name: "toward≥2", pred: (s) => s.toward2 },
  { name: "microFail", pred: (s) => s.microFail },
  { name: "mom_dying", pred: (s) => s.momBucket === "mom_dying" },
  { name: "decel+wick", pred: (s) => s.decel && s.largeWick },
  { name: "decel+gb≥1", pred: (s) => s.decel && s.giveback1 },
  { name: "weak+wick", pred: (s) => s.weakBodyM1 && s.largeWick },
  { name: "wick+toward1", pred: (s) => s.largeWick && s.toward1 },
  { name: "gb≥1+toward1", pred: (s) => s.giveback1 && s.toward1 },
  { name: "microFail+decel", pred: (s) => s.microFail && s.decel },
  { name: "weak+decel", pred: (s) => s.weakBodyM1 && s.decel },
];

const cands: Cand[] = [];
for (const cp of CHECKPOINTS) {
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3);
  const baseAll = pct(out3.filter((s) => s.ev.returned).length, out3.length);
  for (const c of allCombos) {
    const sub = out3.filter(c.pred);
    const disc = sub.filter((s) => s.ev.period === "discovery");
    const val = sub.filter((s) => s.ev.period === "validation");
    if (disc.length < 200) continue;
    const discRow = summarize(disc, c.name, baseAll, false);
    if (discRow.lift < 2) continue; // material discovery lift
    if (pctile(disc.map((s) => s.curPen), 0.5) < 3) continue; // must be outside
    const valRow = summarize(val, c.name, baseAll, false);
    const allRow = summarize(sub, c.name, baseAll, true);
    const valLift = valRow.ret - baseAll;
    const stable = val.length >= 200 && valLift >= 1.5 && valRow.ret > baseAll && discRow.ret > baseAll;
    const score =
      (stable ? 1000 : 0) +
      Math.min(valLift, 20) * 20 +
      Math.min(discRow.lift, 20) * 8 +
      Math.min(allRow.medPen, 8) * 15 + // prefer still deep outside
      Math.log10(Math.max(val.length, 1)) * 25 -
      Math.abs(discRow.lift - valLift) * 3;
    cands.push({ cp, name: c.name, pred: c.pred, disc: discRow, val: valRow, all: allRow, score });
  }
}
cands.sort((a, b) => b.score - a.score);

L.push("TOP candidates:");
for (const c of cands.slice(0, 20)) {
  L.push(
    `T+${c.cp}|${c.name} score=${fmt(c.score, 0)} | ALL n=${c.all.n} RET ${fmt(c.all.ret)}% lift ${fmt(c.all.lift, 1)} medPen ${fmt(c.all.medPen, 2)} | VAL n=${c.val.n} RET ${fmt(c.val.ret)}% | DISC ${fmt(c.disc.ret)}%`,
  );
}

function checkpointBase(cp: number): number {
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3);
  return pct(out3.filter((s) => s.ev.returned).length, out3.length);
}

const bestValidated = cands
  .filter((c) => {
    const base = checkpointBase(c.cp);
    return (
      c.val.n >= 200 &&
      c.disc.n >= 200 &&
      c.all.medPen >= 3 &&
      c.val.ret - base >= 2 &&
      c.disc.ret - base >= 2
    );
  })
  .sort((a, b) => {
    const ba = checkpointBase(a.cp);
    const bb = checkpointBase(b.cp);
    const la = Math.min(a.val.ret - ba, a.disc.ret - ba);
    const lb_ = Math.min(b.val.ret - bb, b.disc.ret - bb);
    if (Math.abs(lb_ - la) <= 1) {
      if (Math.abs(b.all.medPen - a.all.medPen) > 0.3) return b.all.medPen - a.all.medPen;
      return b.val.n - a.val.n;
    }
    return lb_ - la;
  })[0];

// Checkpoint summary table
L.push("\nCHECKPOINT COMPARISON TABLE");
L.push("CP | N_OUT | BASE_RET | BEST_SIGNAL | SIG_N | RET | LIFT | MED_PEN | MED_MAE | P90_MAE");
for (const cp of CHECKPOINTS) {
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3);
  const base = pct(out3.filter((s) => s.ev.returned).length, out3.length);
  const local = cands.filter((c) => c.cp === cp && c.val.n >= 200);
  const bestL = local.sort((a, b) => b.val.ret - checkpointBase(b.cp) - (a.val.ret - checkpointBase(a.cp)))[0];
  if (!bestL) {
    L.push(`T+${cp} | ${out3.length} | ${fmt(base)}% | — | — | — | — | — | — | —`);
    continue;
  }
  L.push(
    `T+${cp} | ${out3.length} | ${fmt(base)}% | ${bestL.name} | ${bestL.all.n} | ${fmt(bestL.all.ret)}% | ${fmt(bestL.all.lift, 1)} | ${fmt(bestL.all.medPen, 2)} | ${fmt(bestL.all.medMae)} | ${fmt(bestL.all.p90Mae)}`,
  );
}

// Predict weak_body
L.push("\nPREDICT V19 WEAK_BODY (STILL≥3p, by checkpoint)");
for (const cp of CHECKPOINTS) {
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3);
  const baseW = pct(out3.filter((s) => s.ev.weakBody).length, out3.length);
  L.push(`T+${cp} base weak_body ${fmt(baseW)}% n=${out3.length}`);
  for (const c of allCombos.slice(0, 12)) {
    const sub = out3.filter(c.pred);
    if (sub.length < 100) continue;
    const prec = pct(sub.filter((s) => s.ev.weakBody).length, sub.length);
    const recall = pct(
      out3.filter((s) => s.ev.weakBody && c.pred(s)).length,
      out3.filter((s) => s.ev.weakBody).length,
    );
    const ret = pct(sub.filter((s) => s.ev.returned).length, sub.length);
    L.push(
      `  ${c.name}: n=${sub.length} P(weak)=${fmt(prec)}% liftW ${fmt(prec - baseW, 1)} recall ${fmt(recall)}% | RET ${fmt(ret)}% medPen ${fmt(pctile(sub.map((s) => s.curPen), 0.5), 2)}`,
    );
  }
}

// Session / side / type for best
if (bestValidated) {
  const cp = bestValidated.cp;
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3 && bestValidated.pred(s));
  L.push(`\nBREAKDOWNS for best: T+${cp}|${bestValidated.name}`);
  for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    const sub = out3.filter((s) => s.ev.session === sess);
    if (sub.length)
      L.push(
        `  ${sess}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.ev.returned).length, sub.length))}% medPen ${fmt(pctile(sub.map((s) => s.curPen), 0.5), 2)}`,
      );
  }
  for (const side of ["support", "resistance"] as Side[]) {
    const sub = out3.filter((s) => s.ev.side === side);
    if (sub.length)
      L.push(
        `  ${side}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.ev.returned).length, sub.length))}%`,
      );
  }
  for (const t of ["range", "swing"] as LevelType[]) {
    const sub = out3.filter((s) => s.ev.type === t);
    if (sub.length)
      L.push(
        `  ${t}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.ev.returned).length, sub.length))}%`,
      );
  }
  const full = summarize(out3, "best", checkpointBase(cp), true);
  // refresh bestValidated path metrics from full path scan
  bestValidated.all.medMae = full.medMae;
  bestValidated.all.p75Mae = full.p75Mae;
  bestValidated.all.p90Mae = full.p90Mae;
  bestValidated.all.reach = full.reach;
  bestValidated.all.adv = full.adv;
  L.push(
    `  Path reach: reclaim ${fmt(full.reach.reclaim!)}% 25% ${fmt(full.reach.pct25!)}% 50% ${fmt(full.reach.pct50!)}% 75% ${fmt(full.reach.pct75!)}% 100% ${fmt(full.reach.pct100!)}%`,
  );
  L.push(
    `  Extra adverse after signal: +5p ${fmt(full.adv["5p"]!)}% +10p ${fmt(full.adv["10p"]!)}% +20p ${fmt(full.adv["20p"]!)}% +30p ${fmt(full.adv["30p"]!)}% +50p ${fmt(full.adv["50p"]!)}%`,
  );
  L.push(
    `  MAE med/P75/P90: ${fmt(full.medMae)} / ${fmt(full.p75Mae)} / ${fmt(full.p90Mae)}`,
  );
}

// Answers
const baseT0 = checkpointBase(0);
const baseT1 = checkpointBase(1);
const baseT2 = checkpointBase(2);
const baseT3 = checkpointBase(3);

L.push("\n" + "=".repeat(88));
L.push("ANSWERS");
L.push("=".repeat(88));

const canPredictWeak = cands.some((c) => {
  const out3 = snapsCp.filter((s) => s.cp === c.cp && s.stillOut3);
  const baseW = pct(out3.filter((s) => s.ev.weakBody).length, out3.length);
  const sub = out3.filter(c.pred);
  return sub.length >= 200 && pct(sub.filter((s) => s.ev.weakBody).length, sub.length) >= baseW + 5;
});

L.push(`1. Can V19 weak_body be predicted before M5 close? ${canPredictWeak ? "YES — some M1 features lift P(weak)" : "WEAK/NO — limited lift"}`);
L.push(`2. T0 return (still≥3p): ${fmt(baseT0)}%`);
L.push(`3. T+1: ${fmt(baseT1)}%`);
L.push(`4. T+2: ${fmt(baseT2)}%`);
L.push(`5. T+3: ${fmt(baseT3)}%`);

// best balance checkpoint
let bestBalCp = 0;
let bestBalScore = -Infinity;
for (const cp of CHECKPOINTS) {
  const local = cands.filter((c) => c.cp === cp && c.val.n >= 200);
  if (!local.length) continue;
  const b = local[0]!;
  const score = b.all.lift * 2 + b.all.medPen - cp * 0.5;
  if (score > bestBalScore) {
    bestBalScore = score;
    bestBalCp = cp;
  }
}
L.push(`6. Best balance checkpoint: T+${bestBalCp}m`);

if (bestValidated) {
  const base = checkpointBase(bestValidated.cp);
  L.push(`7. Strongest validated early RETURN (still≥3p): T+${bestValidated.cp}|${bestValidated.name}`);
  L.push(`8. Validation N: ${bestValidated.val.n}`);
  L.push(`9. Validation return: ${fmt(bestValidated.val.ret)}%`);
  L.push(`10. Lift vs checkpoint baseline: ${fmt(bestValidated.val.ret - base, 1)}pp (base ${fmt(base)}%)`);
  L.push(`11. Median penetration at signal: ${fmt(bestValidated.all.medPen, 2)}p`);
  L.push(`12. Improvement vs V20 (−0.60p): ${fmt(bestValidated.all.entryImp, 2)}p`);
  L.push(`13. MAE med/P75/P90: ${fmt(bestValidated.all.medMae)} / ${fmt(bestValidated.all.p75Mae)} / ${fmt(bestValidated.all.p90Mae)}`);
  L.push(`14. Reach reclaim: ${fmt(bestValidated.all.reach.reclaim!)}%`);
  L.push(`15. 25%: ${fmt(bestValidated.all.reach.pct25!)}%`);
  L.push(`16. 50%: ${fmt(bestValidated.all.reach.pct50!)}%`);
  L.push(`17. 75%: ${fmt(bestValidated.all.reach.pct75!)}%`);
  L.push(`18. 100%: ${fmt(bestValidated.all.reach.pct100!)}%`);
} else {
  L.push(`7–18. No signal met validation gates (n≥200, lift≥2pp, still≥3p outside).`);
}

// feature usefulness from T+2 out3
{
  const cp = 2;
  const out3 = snapsCp.filter((s) => s.cp === cp && s.stillOut3);
  const base = pct(out3.filter((s) => s.ev.returned).length, out3.length);
  const scores = allCombos.map((c) => {
    const sub = out3.filter(c.pred);
    return { name: c.name, lift: pct(sub.filter((s) => s.ev.returned).length, sub.length) - base, n: sub.length };
  });
  scores.sort((a, b) => b.lift - a.lift);
  L.push(`19. Most useful M1 feature (T+2 lift): ${scores[0]?.name ?? "—"} (lift ${fmt(scores[0]?.lift ?? NaN, 1)} n=${scores[0]?.n ?? 0})`);
  const wick = scores.find((s) => s.name.includes("wick") && !s.name.includes("+"));
  const decel = scores.find((s) => s.name === "decelerating");
  const gb = scores.find((s) => s.name === "giveback≥1p");
  const toward = scores.find((s) => s.name === "toward≥2");
  L.push(`20. Rejection wick useful early? ${wick && wick.lift >= 1.5 ? "YES" : "MILD/NO"} (lift ${fmt(wick?.lift ?? NaN, 1)})`);
  L.push(`21. Deceleration useful? ${decel && decel.lift >= 1.5 ? "YES" : "MILD/NO"} (lift ${fmt(decel?.lift ?? NaN, 1)})`);
  L.push(`22. Giveback from extreme useful? ${gb && gb.lift >= 1.5 ? "YES" : "MILD/NO"} (lift ${fmt(gb?.lift ?? NaN, 1)})`);
  L.push(`23. Consecutive M1 reversal useful? ${toward && toward.lift >= 1.5 ? "YES" : "MILD/NO"} (lift ${fmt(toward?.lift ?? NaN, 1)})`);
}
L.push(
  `24. Waiting +1–2m improve prediction? base T0 ${fmt(baseT0)}% → T+2 ${fmt(baseT2)}% (Δ ${fmt(baseT2 - baseT0, 1)}pp); signal lifts also tend to rise with cp — see table.`,
);
const entryEnough =
  bestValidated && bestValidated.all.entryImp >= 3 && bestValidated.val.ret - checkpointBase(bestValidated.cp) >= 3;
L.push(
  `25. Entry improvement justify V22 execution test? ${entryEnough ? "YES — material outside entry + validated lift" : bestValidated && bestValidated.all.entryImp >= 2 ? "MAYBE — modest improvement" : "NO — insufficient early edge"}`,
);

let verdict: "EARLY_REVERSAL_SIGNAL_FOUND" | "EARLY_SIGNAL_TOO_LATE" | "NO_EARLY_SIGNAL";
if (
  bestValidated &&
  bestValidated.val.n >= 200 &&
  bestValidated.all.medPen >= 3 &&
  bestValidated.all.entryImp >= 2.5 &&
  bestValidated.val.ret - checkpointBase(bestValidated.cp) >= 3 &&
  bestValidated.disc.ret - checkpointBase(bestValidated.cp) >= 2
) {
  verdict =
    bestValidated.val.n >= 500 && bestValidated.all.entryImp >= 3.5
      ? "EARLY_REVERSAL_SIGNAL_FOUND"
      : "EARLY_REVERSAL_SIGNAL_FOUND";
} else if (bestValidated && bestValidated.all.medPen < 3) {
  verdict = "EARLY_SIGNAL_TOO_LATE";
} else if (cands.some((c) => c.all.medPen >= 3 && c.all.lift >= 2)) {
  verdict = "EARLY_SIGNAL_TOO_LATE"; // lifts exist but don't clear validation/entry bar
} else {
  verdict = "NO_EARLY_SIGNAL";
}

// refine too_late: if best signals have medPen high but lift weak in val
if (verdict === "EARLY_REVERSAL_SIGNAL_FOUND" && bestValidated && bestValidated.val.n < 200) {
  verdict = "NO_EARLY_SIGNAL";
}

L.push("\n" + "=".repeat(88));
L.push(`VERDICT: ${verdict}`);
L.push("=".repeat(88));
if (bestValidated && verdict === "EARLY_REVERSAL_SIGNAL_FOUND") {
  const base = checkpointBase(bestValidated.cp);
  const ruleExplain =
    bestValidated.name === "mom_dying"
      ? "last 1m AND last 3m completed M1 returns ≤0 in breakout direction (mom_dying)"
      : bestValidated.name;
  L.push("SIMPLEST RULE:");
  L.push(`Frozen S/R → price reaches 3p outside`);
  L.push(`→ within ${bestValidated.cp} minute(s): ${ruleExplain}`);
  L.push(`→ still ≥3p outside`);
  L.push(`→ validation return = ${fmt(bestValidated.val.ret)}% (base ${fmt(base)}%, lift ${fmt(bestValidated.val.ret - base, 1)}pp)`);
  L.push(`→ validation N = ${bestValidated.val.n}`);
  L.push(`→ median signal location = +${fmt(bestValidated.all.medPen, 2)}p outside`);
  L.push(`→ improvement vs V20 (−0.60p) = ${fmt(bestValidated.all.entryImp, 2)}p`);
  const alt = cands.find((c) => c.cp === 2 && c.name === "toward≥2" && c.val.n >= 200);
  if (alt && bestValidated.name !== "toward≥2") {
    L.push("");
    L.push(
      `ALT (simpler / larger N): T+2 toward≥2 consecutive completed M1 toward S/R | ALL n=${alt.all.n} RET ${fmt(alt.all.ret)}% | VAL n=${alt.val.n} RET ${fmt(alt.val.ret)}% | medPen +${fmt(alt.all.medPen, 2)}p`,
    );
  }
} else {
  L.push("No frozen early rule cleared validation while remaining ≥3p outside with material lift.");
  L.push("Do not proceed to V22 until an EARLY_REVERSAL_SIGNAL_FOUND rule exists.");
}

const reportPath = path.join(OUT_DIR, "eurusd-early-m1-reversal-v21-report.txt");
fs.writeFileSync(reportPath, L.join("\n"));
try {
  fs.mkdirSync(path.join(process.cwd(), "research-output"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "research-output", "eurusd-early-m1-reversal-v21-report.txt"),
    L.join("\n"),
  );
} catch {
  /* ignore */
}
console.log(L.join("\n"));
console.log(`\nWrote ${reportPath}`);
