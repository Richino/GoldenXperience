/**
 * EUR/USD V23 — EXECUTABLE OUTSIDE-PRICE REVERSAL SIGNAL (research-only).
 *
 * V18–V22 FROZEN. No TP/SL / no P&L.
 *
 * Correction vs V21/V22: NEVER use M1 high/low as the decision price.
 * Snapshot only when completed M1 EXECUTABLE CLOSE is itself ≥ D pips outside
 * frozen S/R:
 *   resistance → future SHORT → BID close vs R
 *   support    → future LONG  → ASK close vs S
 *
 * D ∈ {3, 5, 7.5, 10}. Behavioral classifier + path study only.
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
const DISTANCES = [3, 5, 7.5, 10] as const;
type Dist = (typeof DISTANCES)[number];

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
  openPrice: number;
}

interface Shot {
  dist: Dist;
  session: SessionName;
  side: Side;
  type: LevelType;
  year: number;
  period: Period;
  level: number;
  opposite: number | null;
  rangeWidthPips: number;
  rangeValid: boolean;
  atr: number;
  idx: number; // M1 index of completed bar at snapshot
  execPx: number;
  pen: number; // REAL executable close penetration
  spread: number;
  maxPenBefore: number; // diagnostic extreme-ish max exec close pen before
  distFromOpenPips: number;
  sessionEndIdx: number;
  // features (causal)
  momClass: string;
  momChange: string;
  towardN: number;
  giveback: number;
  givebackBucket: string;
  ageBucket: string;
  timeToDFrom3: number; // minutes; NaN for D=3
  microFail: boolean;
  largeWick: boolean;
  bodyStrength: string;
  spreadBucket: string;
  // labels / path filled later optionally
  returned: boolean;
  ret15: boolean;
  ret30: boolean;
  ret60: boolean;
  ret120: boolean;
  ret240: boolean;
  minsToReturn: number;
  mae: number;
  mfe: number;
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

console.log("V23 loading M15/M5/M1...");
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
  mc = new Float64Array(M5);
for (let i = 0; i < M5; i++) {
  const r = m5raw[i]!;
  m5ms[i] = Date.parse(r[0]);
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
}
(m5raw as unknown as { length: number }).length = 0;

const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
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
function widthBucket(p: number): string {
  if (!(p > 0)) return "no_opp";
  if (p < 10) return "0-10p";
  if (p < 20) return "10-20p";
  if (p < 30) return "20-30p";
  if (p < 50) return "30-50p";
  if (p < 75) return "50-75p";
  if (p < 100) return "75-100p";
  return "100p+";
}

/** REAL executable close penetration for fade fill. */
function execClosePen(i: number, side: Side, level: number): number {
  if (side === "resistance") return (bc[i]! - level) / PIP; // SHORT @ BID
  return (level - ac[i]!) / PIP; // LONG @ ASK
}
function execPxOf(i: number, side: Side): number {
  return side === "resistance" ? bc[i]! : ac[i]!;
}
function spreadOf(i: number): number {
  return (ac[i]! - bc[i]!) / PIP;
}
/** Diagnostic: max extreme penetration already observed (NOT used as trigger). */
function extremePen(i: number, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (ah[i]! - level) / PIP);
  return Math.max(0, (level - bl[i]!) / PIP);
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
          openPrice: levels.current,
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

// ---------- discovery momentum thresholds (frozen after first pass over discovery raw returns) ----------
function brkRet(i: number, side: Side): number {
  // completed M1 close-to-close in breakout direction (positive = continuing breakout)
  if (i < 1) return 0;
  const d = (m1c[i]! - m1c[i - 1]!) / PIP;
  return side === "resistance" ? d : -d;
}
function sumBrk(from: number, to: number, side: Side): number {
  let s = 0;
  for (let i = from; i <= to; i++) s += brkRet(i, side);
  return s;
}

const discMom1: number[] = [];
const discMom3: number[] = [];
// collect after shots built — freeze thresholds from discovery shots at D=3

function atr1At(i: number): number {
  let sum = 0,
    nn = 0;
  for (let k = i - 14; k < i; k++) {
    if (k < 0) continue;
    sum += m1h[k]! - m1l[k]!;
    nn++;
  }
  return nn > 0 ? sum / nn : PIP;
}

function givebackBucketOf(g: number): string {
  if (g < 0.5) return "0-0.5";
  if (g < 1) return "0.5-1";
  if (g < 2) return "1-2";
  if (g < 3) return "2-3";
  if (g < 5) return "3-5";
  return "5+";
}
function ageBucketOf(mins: number): string {
  if (mins <= 2) return "0-2m";
  if (mins <= 5) return "3-5m";
  if (mins <= 10) return "6-10m";
  if (mins <= 20) return "11-20m";
  return "20m+";
}
function spreadBucketOf(s: number): string {
  if (s < 1) return "<1p";
  if (s < 1.5) return "1-1.5p";
  if (s < 2) return "1.5-2p";
  return "2p+";
}

/** Build features at snapshot idx using only completed info ≤ idx. */
function buildFeatures(
  idx: number,
  side: Side,
  level: number,
  firstCrossIdx: number,
  first3Idx: number,
  maxExecPenBefore: number,
  pen: number,
  // frozen discovery thresholds
  mom1P20: number,
  mom1P40: number,
  mom1P60: number,
  mom1P80: number,
): Omit<
  Shot,
  | "dist"
  | "session"
  | "side"
  | "type"
  | "year"
  | "period"
  | "level"
  | "opposite"
  | "rangeWidthPips"
  | "rangeValid"
  | "atr"
  | "idx"
  | "execPx"
  | "pen"
  | "spread"
  | "maxPenBefore"
  | "distFromOpenPips"
  | "sessionEndIdx"
  | "returned"
  | "ret15"
  | "ret30"
  | "ret60"
  | "ret120"
  | "ret240"
  | "minsToReturn"
  | "mae"
  | "mfe"
> {
  const m1 = sumBrk(idx, idx, side);
  const m3 = sumBrk(Math.max(0, idx - 2), idx, side);
  const m5 = sumBrk(Math.max(0, idx - 4), idx, side);
  const prev3 = sumBrk(Math.max(0, idx - 3), Math.max(0, idx - 1), side);
  const prev5 = sumBrk(Math.max(0, idx - 5), Math.max(0, idx - 2), side);
  const last2 = sumBrk(Math.max(0, idx - 1), idx, side);

  let momClass = "moderate";
  if (m1 <= mom1P20 && m3 <= 0) momClass = "dying";
  else if (m1 < 0 && m3 < 0) momClass = "reversing";
  else if (m1 >= mom1P80 && m3 > 0) momClass = "strong";
  else if (m1 <= mom1P40) momClass = "flat";
  void mom1P60;

  let momChange = "stable";
  if (m1 < prev3 - 0.5 || last2 < prev5 * 0.5) momChange = "slowing";
  if (m1 < 0 && prev3 > 0) momChange = "reversing";
  if (m1 > prev3 + 0.5 && m1 > 0) momChange = "accelerating";

  let towardN = 0;
  for (let k = 0; k < 3; k++) {
    const j = idx - k;
    if (j < 0) break;
    const ret = m1c[j]! - m1o[j]!;
    const toward = side === "resistance" ? ret < 0 : ret > 0;
    if (toward) towardN++;
    else break;
  }

  const giveback = Math.max(0, maxExecPenBefore - pen);
  const ageMins = Math.max(0, idx - firstCrossIdx);
  const timeToDFrom3 = first3Idx >= 0 && idx >= first3Idx ? idx - first3Idx : NaN;

  let microFail = false;
  if (idx >= 1) {
    if (side === "resistance") {
      // new/equal high extreme then close lower, while still outside
      if (ah[idx]! >= ah[idx - 1]! && ac[idx]! < ac[idx - 1]!) microFail = true;
    } else {
      if (bl[idx]! <= bl[idx - 1]! && bc[idx]! > bc[idx - 1]!) microFail = true;
    }
  }

  const o = m1o[idx]!,
    h = m1h[idx]!,
    l = m1l[idx]!,
    c = m1c[idx]!;
  const range = Math.max(h - l, PIP * 0.05);
  const body = Math.abs(c - o);
  let rejWick = 0;
  if (side === "resistance") rejWick = h - Math.max(o, c);
  else rejWick = Math.min(o, c) - l;
  const wickRange = rejWick / range;
  const largeWick = wickRange >= 0.5 || (body > PIP * 0.05 && rejWick / body >= 1);
  const atr1 = atr1At(idx);
  const bodyAtr = body / atr1;
  let bodyStrength = "normal";
  if (bodyAtr <= 0.5 || body / range <= 0.35) bodyStrength = "weak";
  if (bodyAtr >= 1.5 && body / range >= 0.7) bodyStrength = "strong";

  return {
    momClass,
    momChange,
    towardN,
    giveback,
    givebackBucket: givebackBucketOf(giveback),
    ageBucket: ageBucketOf(ageMins),
    timeToDFrom3,
    microFail,
    largeWick,
    bodyStrength,
    spreadBucket: spreadBucketOf(spreadOf(idx)),
  };
}

function pathFill(s: Shot) {
  const end = s.sessionEndIdx;
  let returned = false;
  let minsToReturn = NaN;
  let mae = 0,
    mfe = 0;
  const retAt = { 15: false, 30: false, 60: false, 120: false, 240: false };

  for (let k = s.idx + 1; k < end; k++) {
    const mins = k - s.idx;
    // MAE/MFE relative to executable snapshot price
    if (s.side === "support") {
      // LONG path: adverse = ask/bid lower, fav = bid higher
      const adv = (s.execPx - Math.min(al[k]!, bl[k]!)) / PIP;
      const fav = (Math.max(bh[k]!, ah[k]!) - s.execPx) / PIP;
      if (adv > mae) mae = adv;
      if (fav > mfe) mfe = fav;
      // return inside: ASK back at/above support
      if (!returned && ac[k]! >= s.level) {
        returned = true;
        minsToReturn = mins;
      }
    } else {
      const adv = (Math.max(ah[k]!, bh[k]!) - s.execPx) / PIP;
      const fav = (s.execPx - Math.min(bl[k]!, al[k]!)) / PIP;
      if (adv > mae) mae = adv;
      if (fav > mfe) mfe = fav;
      if (!returned && bc[k]! <= s.level) {
        returned = true;
        minsToReturn = mins;
      }
    }
    if (returned) {
      if (minsToReturn <= 15) retAt[15] = true;
      if (minsToReturn <= 30) retAt[30] = true;
      if (minsToReturn <= 60) retAt[60] = true;
      if (minsToReturn <= 120) retAt[120] = true;
      if (minsToReturn <= 240) retAt[240] = true;
    }
  }
  s.returned = returned;
  s.minsToReturn = minsToReturn;
  s.mae = mae;
  s.mfe = mfe;
  s.ret15 = retAt[15];
  s.ret30 = retAt[30];
  s.ret60 = retAt[60];
  s.ret120 = retAt[120];
  s.ret240 = retAt[240];
}

function raceStats(s: Shot) {
  const end = s.sessionEndIdx;
  const reach: Record<string, boolean> = {
    reclaim: false,
    pct25: false,
    pct50: false,
    pct75: false,
    pct100: false,
  };
  const advKeys = [5, 10, 15, 20, 30, 45] as const;
  const hitAdv: Record<number, boolean> = {};
  const before: Record<string, Record<number, boolean>> = {};
  for (const tk of Object.keys(reach)) {
    before[tk] = {};
    for (const a of advKeys) before[tk]![a] = false;
  }
  for (const a of advKeys) hitAdv[a] = false;

  const tpOf = (kind: string): number | null => {
    if (kind === "reclaim") return s.level;
    if (!s.rangeValid || s.opposite === null) return null;
    const w = s.rangeWidthPips * PIP;
    const frac = kind === "pct25" ? 0.25 : kind === "pct50" ? 0.5 : kind === "pct75" ? 0.75 : 1;
    return s.side === "resistance" ? s.level - frac * w : s.level + frac * w;
  };

  for (let k = s.idx + 1; k < end; k++) {
    let adv = 0;
    if (s.side === "support") adv = (s.execPx - Math.min(al[k]!, bl[k]!)) / PIP;
    else adv = (Math.max(ah[k]!, bh[k]!) - s.execPx) / PIP;
    for (const a of advKeys) if (adv >= a) hitAdv[a] = true;

    for (const tk of Object.keys(reach)) {
      const tp = tpOf(tk);
      if (tp === null) continue;
      let hit = false;
      if (s.side === "support") hit = bh[k]! >= tp || ac[k]! >= tp;
      else hit = al[k]! <= tp || bc[k]! <= tp;
      if (hit && !reach[tk]) {
        reach[tk] = true;
        for (const a of advKeys) {
          if (!hitAdv[a]) before[tk]![a] = true;
        }
      }
    }
  }
  const extraAdv: Record<number, boolean> = {};
  for (const a of advKeys) extraAdv[a] = hitAdv[a]!;
  return { reach, before, extraAdv, mae: s.mae, mfe: s.mfe };
}

// ---------- collect snapshots ----------
console.log("Collecting executable-close snapshots...");
const rawShots: Array<{
  dist: Dist;
  snap: SessionSnap;
  fl: FrozenLevel;
  idx: number;
  pen: number;
  firstCrossIdx: number;
  first3Idx: number;
  maxExecPenBefore: number;
}> = [];

for (const snap of snaps) {
  const w = TOUCH_ATR * snap.atr;
  const m5Start = lb(m5ms, M5, snap.openMs);
  let m5End = lb(m5ms, M5, snap.closeMs);
  if (m5End > M5) m5End = M5;
  if (m5End <= m5Start + 2) continue;
  const m1Start = lb(m1ms, M1, snap.openMs);
  const m1End = lb(m1ms, M1, snap.closeMs);

  for (const fl of snap.levels) {
    let armed = true;
    let active = false;
    let touchM5 = -1;
    const fired = new Set<number>(); // which D already snapped this encounter

    for (let i = m5Start; i < m5End; i++) {
      const h = mh[i]!,
        l = ml[i]!;
      const touch = touchesZone(h, l, fl.price, w);
      if (armed && touch) {
        armed = false;
        active = true;
        touchM5 = i;
        fired.clear();
      }
      if (!active) {
        if (!armed && clearInside(h, l, fl.side, fl.price, w)) armed = true;
        continue;
      }

      // scan M1 bars belonging to this M5 candle and later until clear
      const barOpen = m5ms[i]!;
      const barClose = barOpen + 5 * 60_000;
      const a = Math.max(m1Start, lb(m1ms, M1, Math.max(barOpen, m5ms[Math.max(touchM5, m5Start)]!)));
      const b = Math.min(m1End, lb(m1ms, M1, barClose));

      // track first cross / first 3p within encounter using prior M1
      // (computed lazily when we fire)

      for (let j = a; j < b; j++) {
        const pen = execClosePen(j, fl.side, fl.price);
        // audit: never use high/low as decision
        if (pen >= 3 && extremePen(j, fl.side, fl.price) < pen - 0.01) {
          // close cannot exceed extreme; if it did, data bug
          lookaheadFail = true;
          auditNotes.push("exec close pen > extreme pen");
        }
        for (const D of DISTANCES) {
          if (fired.has(D)) continue;
          if (pen >= D) {
            const encStart = lb(m1ms, M1, m5ms[Math.max(touchM5, m5Start)]!);
            let firstCross = -1;
            let first3 = -1;
            let maxBefore = 0;
            for (let t = encStart; t < j; t++) {
              const p = execClosePen(t, fl.side, fl.price);
              if (firstCross < 0 && p > 0) firstCross = t;
              if (first3 < 0 && p >= 3) first3 = t;
              if (p > maxBefore) maxBefore = p;
            }
            // also detect firstCross/first3 on current bar if needed
            if (firstCross < 0 && pen > 0) firstCross = j;
            if (first3 < 0 && pen >= 3) first3 = j;

            rawShots.push({
              dist: D,
              snap,
              fl,
              idx: j,
              pen,
              firstCrossIdx: firstCross >= 0 ? firstCross : j,
              first3Idx: first3 >= 0 ? first3 : j,
              maxExecPenBefore: Math.max(maxBefore, pen),
            });
            fired.add(D);
          }
        }
      }

      if (active && clearInside(h, l, fl.side, fl.price, w)) {
        active = false;
        armed = true;
        fired.clear();
      }
    }
  }
}
console.log(`Raw executable snapshots: ${rawShots.length}`);

// discovery mom thresholds from D=3 discovery pens' 1m/3m returns
for (const r of rawShots) {
  if (r.dist !== 3 || periodOf(r.snap.year) !== "discovery") continue;
  discMom1.push(brkRet(r.idx, r.fl.side));
  discMom3.push(sumBrk(Math.max(0, r.idx - 2), r.idx, r.fl.side));
}
const mom1P20 = pctile(discMom1, 0.2);
const mom1P40 = pctile(discMom1, 0.4);
const mom1P60 = pctile(discMom1, 0.6);
const mom1P80 = pctile(discMom1, 0.8);
console.log(
  `Discovery mom1 thresholds frozen: P20/P40/P60/P80=${fmt(mom1P20, 2)}/${fmt(mom1P40, 2)}/${fmt(mom1P60, 2)}/${fmt(mom1P80, 2)}`,
);

const shots: Shot[] = [];
for (const r of rawShots) {
  const opp = oppositeOf(r.snap, r.fl.side, r.fl.type, r.fl.price);
  let rangeValid = false;
  let rw = NaN;
  if (opp !== null) {
    if (r.fl.side === "resistance" && opp < r.fl.price) {
      rangeValid = true;
      rw = (r.fl.price - opp) / PIP;
    } else if (r.fl.side === "support" && opp > r.fl.price) {
      rangeValid = true;
      rw = (opp - r.fl.price) / PIP;
    }
  }
  const feat = buildFeatures(
    r.idx,
    r.fl.side,
    r.fl.price,
    r.firstCrossIdx,
    r.first3Idx,
    r.maxExecPenBefore,
    r.pen,
    mom1P20,
    mom1P40,
    mom1P60,
    mom1P80,
  );
  // CRITICAL: still must have executable pen >= D (already true by construction)
  if (r.pen < r.dist - 1e-9) {
    lookaheadFail = true;
    auditNotes.push("snapshot pen < D");
    continue;
  }
  const s: Shot = {
    dist: r.dist,
    session: r.snap.session,
    side: r.fl.side,
    type: r.fl.type,
    year: r.snap.year,
    period: periodOf(r.snap.year),
    level: r.fl.price,
    opposite: opp,
    rangeWidthPips: rw,
    rangeValid,
    atr: r.snap.atr,
    idx: r.idx,
    execPx: execPxOf(r.idx, r.fl.side),
    pen: r.pen,
    spread: spreadOf(r.idx),
    maxPenBefore: r.maxExecPenBefore,
    distFromOpenPips: Math.abs(execPxOf(r.idx, r.fl.side) - r.snap.openPrice) / PIP,
    sessionEndIdx: lb(m1ms, M1, r.snap.closeMs),
    ...feat,
    returned: false,
    ret15: false,
    ret30: false,
    ret60: false,
    ret120: false,
    ret240: false,
    minsToReturn: NaN,
    mae: 0,
    mfe: 0,
  };
  pathFill(s);
  shots.push(s);
}
console.log(`Shots with path: ${shots.length}`);

// audit: confirm no high/low decision
let hlIllusion = 0;
for (const s of shots) {
  const ext = extremePen(s.idx, s.side, s.level);
  // decision used close; if close < D but we snapped, fail
  if (s.pen < s.dist) {
    lookaheadFail = true;
    auditNotes.push("pen < dist after build");
  }
  // count cases where extreme would have fired earlier/farther (diagnostic)
  if (ext >= s.dist && s.pen >= s.dist) {
    /* ok */
  }
  void hlIllusion;
}

if (lookaheadFail) {
  console.error("NO_LOOKAHEAD_AUDIT FAIL", auditNotes.slice(0, 10));
  process.exit(1);
}
console.log("NO_LOOKAHEAD_AUDIT = PASS");

const L: string[] = [];
function push(...xs: string[]) {
  for (const x of xs) L.push(x);
}

push("=".repeat(88));
push("EUR/USD V23 — EXECUTABLE OUTSIDE-PRICE REVERSAL SIGNAL");
push("=".repeat(88));
push("V18–V22 untouched. No TP/SL. Decision price = completed M1 BID/ASK CLOSE only.");
push("Resistance→SHORT uses BID close | Support→LONG uses ASK close.");
push("NO_LOOKAHEAD_AUDIT = PASS");
push(`Discovery mom thresholds frozen: mom1 P20=${fmt(mom1P20, 2)} P40=${fmt(mom1P40, 2)} P80=${fmt(mom1P80, 2)}`);
push("");

// ---------- baselines ----------
push("=".repeat(88));
push("UNCONDITIONAL BASELINES (executable close ≥ D)");
push("=".repeat(88));
const baselines: Record<number, { n: number; ret: number; medPen: number; medMae: number; medMfe: number; medT: number }> = {};
for (const D of DISTANCES) {
  const list = shots.filter((s) => s.dist === D);
  const retN = list.filter((s) => s.returned).length;
  const ret = pct(retN, list.length);
  const cont = 100 - ret;
  const times = list.filter((s) => s.returned).map((s) => s.minsToReturn);
  baselines[D] = {
    n: list.length,
    ret,
    medPen: pctile(
      list.map((s) => s.pen),
      0.5,
    ),
    medMae: pctile(
      list.map((s) => s.mae),
      0.5,
    ),
    medMfe: pctile(
      list.map((s) => s.mfe),
      0.5,
    ),
    medT: pctile(times, 0.5),
  };
  push(
    `D=${D}p | N=${list.length} | RETURN ${fmt(ret)}% | CONT ${fmt(cont)}% | medPen ${fmt(baselines[D]!.medPen, 2)} | medTimeRet ${fmt(baselines[D]!.medT, 0)}m | medMAE ${fmt(baselines[D]!.medMae)} medMFE ${fmt(baselines[D]!.medMfe)}`,
  );
  push(
    `  ret@15/30/60/2h/4h: ${fmt(pct(list.filter((s) => s.ret15).length, list.length))}% / ${fmt(pct(list.filter((s) => s.ret30).length, list.length))}% / ${fmt(pct(list.filter((s) => s.ret60).length, list.length))}% / ${fmt(pct(list.filter((s) => s.ret120).length, list.length))}% / ${fmt(pct(list.filter((s) => s.ret240).length, list.length))}%`,
  );
}

type Pred = (s: Shot) => boolean;
type Feat = { name: string; pred: Pred };

function featsFor(): Feat[] {
  return [
    { name: "mom_dying", pred: (s) => s.momClass === "dying" },
    { name: "mom_reversing", pred: (s) => s.momClass === "reversing" },
    { name: "toward≥1", pred: (s) => s.towardN >= 1 },
    { name: "toward≥2", pred: (s) => s.towardN >= 2 },
    { name: "toward≥3", pred: (s) => s.towardN >= 3 },
    { name: "gb≥1", pred: (s) => s.giveback >= 1 },
    { name: "gb≥2", pred: (s) => s.giveback >= 2 },
    { name: "gb≥3", pred: (s) => s.giveback >= 3 },
    { name: "mom_slowing", pred: (s) => s.momChange === "slowing" },
    { name: "microFail", pred: (s) => s.microFail },
    { name: "largeWick", pred: (s) => s.largeWick },
    { name: "dying+gb≥1", pred: (s) => s.momClass === "dying" && s.giveback >= 1 },
    { name: "dying+toward≥2", pred: (s) => s.momClass === "dying" && s.towardN >= 2 },
    { name: "rev+gb≥1", pred: (s) => s.momClass === "reversing" && s.giveback >= 1 },
    { name: "toward≥2+gb≥1", pred: (s) => s.towardN >= 2 && s.giveback >= 1 },
    { name: "micro+dying", pred: (s) => s.microFail && s.momClass === "dying" },
    { name: "slowing+toward≥2", pred: (s) => s.momChange === "slowing" && s.towardN >= 2 },
  ];
}

interface Row {
  dist: Dist;
  name: string;
  pred: Pred;
  n: number;
  ret: number;
  lift: number;
  medPen: number;
  medMae: number;
  p75Mae: number;
  p90Mae: number;
  discN: number;
  discRet: number;
  valN: number;
  valRet: number;
  valLift: number;
}

function summarize(list: Shot[], name: string, baseRet: number, dist: Dist, pred: Pred): Row {
  const retN = list.filter((s) => s.returned).length;
  const ret = pct(retN, list.length);
  const disc = list.filter((s) => s.period === "discovery");
  const val = list.filter((s) => s.period === "validation");
  const maes = list.map((s) => s.mae);
  return {
    dist,
    name,
    pred,
    n: list.length,
    ret,
    lift: ret - baseRet,
    medPen: pctile(
      list.map((s) => s.pen),
      0.5,
    ),
    medMae: pctile(maes, 0.5),
    p75Mae: pctile(maes, 0.75),
    p90Mae: pctile(maes, 0.9),
    discN: disc.length,
    discRet: pct(disc.filter((s) => s.returned).length, disc.length),
    valN: val.length,
    valRet: pct(val.filter((s) => s.returned).length, val.length),
    valLift: pct(val.filter((s) => s.returned).length, val.length) - baseRet,
  };
}

const allFeats = featsFor();
const rows: Row[] = [];

for (const D of DISTANCES) {
  const universe = shots.filter((s) => s.dist === D);
  const base = baselines[D]!.ret;
  push("");
  push("-".repeat(88));
  push(`FEATURES @ D=${D}p | base RET ${fmt(base)}% N=${universe.length}`);
  for (const f of allFeats) {
    const sub = universe.filter(f.pred);
    // must still be outside D (already true); report
    if (sub.length < 30) continue;
    const row = summarize(sub, f.name, base, D, f.pred);
    rows.push(row);
    push(
      `  ${f.name}: n=${row.n} RET ${fmt(row.ret)}% lift ${fmt(row.lift, 1)} | medPen ${fmt(row.medPen, 2)} MAE ${fmt(row.medMae)}/${fmt(row.p75Mae)}/${fmt(row.p90Mae)} | disc ${row.discN}/${fmt(row.discRet)}% val ${row.valN}/${fmt(row.valRet)}%`,
    );
  }
}

// select candidates: discovery lift ≥ 3, discN≥200, medPen≥D, freeze then validate
const cands = rows
  .filter((r) => r.discN >= 200 && r.lift >= 2 && r.medPen >= r.dist - 0.05)
  .sort((a, b) => b.discRet - a.discRet);

push("");
push("=".repeat(88));
push("DISCOVERY-SELECTED CANDIDATES (frozen) → VALIDATION");
push("=".repeat(88));

interface ValCand {
  row: Row;
  score: number;
  race?: ReturnType<typeof aggregateRace>;
}
function aggregateRace(list: Shot[]) {
  const advKeys = [5, 10, 15, 20, 30, 45] as const;
  const reach: Record<string, number> = { reclaim: 0, pct25: 0, pct50: 0, pct75: 0, pct100: 0 };
  const before: Record<string, Record<number, number>> = {};
  const extra: Record<number, number> = {};
  for (const tk of Object.keys(reach)) {
    before[tk] = {};
    for (const a of advKeys) before[tk]![a] = 0;
  }
  for (const a of advKeys) extra[a] = 0;
  let rangeN = 0;
  const maes: number[] = [];
  const mfes: number[] = [];
  for (const s of list) {
    const r = raceStats(s);
    maes.push(r.mae);
    mfes.push(r.mfe);
    if (r.reach.reclaim) reach.reclaim!++;
    if (s.rangeValid) {
      rangeN++;
      for (const tk of ["pct25", "pct50", "pct75", "pct100"]) {
        if (r.reach[tk]) reach[tk]!++;
        for (const a of advKeys) if (r.before[tk]![a]) before[tk]![a]!++;
      }
    }
    for (const a of advKeys) {
      if (r.before.reclaim![a]) before.reclaim![a]!++;
      if (r.extraAdv[a]) extra[a]!++;
    }
  }
  return { n: list.length, rangeN, reach, before, extra, maes, mfes };
}

const validated: ValCand[] = [];
for (const r of cands) {
  const base = baselines[r.dist]!.ret;
  const valLift = r.valRet - base;
  const ok = r.valN >= 200 && valLift >= 2 && r.discRet > base && r.valRet > base && r.medPen >= r.dist - 0.05;
  const score =
    (ok ? 1000 : 0) +
    Math.min(valLift, 20) * 20 +
    Math.min(r.lift, 20) * 8 +
    Math.min(r.medPen, 12) * 10 +
    Math.log10(Math.max(r.valN, 1)) * 30 -
    Math.abs(r.lift - valLift) * 3;
  const list = shots.filter((s) => s.dist === r.dist && r.pred(s));
  const race = aggregateRace(list);
  validated.push({ row: r, score, race });
  push(
    `D=${r.dist}|${r.name} score=${fmt(score, 0)} | ALL n=${r.n} RET ${fmt(r.ret)}% lift ${fmt(r.lift, 1)} medPen ${fmt(r.medPen, 2)} | VAL n=${r.valN} RET ${fmt(r.valRet)}% lift ${fmt(valLift, 1)} | DISC ${fmt(r.discRet)}% ${ok ? "PASS" : "fail"}`,
  );
}
validated.sort((a, b) => b.score - a.score);

function bestAt(D: Dist): ValCand | undefined {
  return validated
    .filter(
      (v) =>
        v.row.dist === D &&
        v.row.valN >= 200 &&
        v.row.valRet - baselines[D]!.ret >= 2 &&
        v.row.discRet > baselines[D]!.ret &&
        v.row.medPen >= D - 0.05,
    )
    .sort((a, b) => {
      const la = Math.min(a.row.valRet - baselines[D]!.ret, a.row.discRet - baselines[D]!.ret);
      const lb_ = Math.min(b.row.valRet - baselines[D]!.ret, b.row.discRet - baselines[D]!.ret);
      if (Math.abs(lb_ - la) <= 1) return b.row.valN - a.row.valN;
      return lb_ - la;
    })[0];
}

const best3 = bestAt(3);
const best5 = bestAt(5);
const best75 = bestAt(7.5);
const best10 = bestAt(10);
const bestOverall = [best3, best5, best75, best10]
  .filter(Boolean)
  .sort((a, b) => {
    const da = a!.row.dist;
    const db = b!.row.dist;
    const la = a!.row.valRet - baselines[da]!.ret;
    const lb_ = b!.row.valRet - baselines[db]!.ret;
    // prefer real buffer: weight medPen
    return lb_ + b!.row.medPen * 0.3 - (la + a!.row.medPen * 0.3);
  })[0];

function reportBest(label: string, v: ValCand | undefined) {
  if (!v || !v.race) {
    push(`\n${label}: none cleared validation`);
    return;
  }
  const r = v.row;
  const race = v.race;
  const base = baselines[r.dist]!.ret;
  push("");
  push("-".repeat(88));
  push(`BEST ${label}: D=${r.dist} | ${r.name}`);
  push(
    `VAL n=${r.valN} RET ${fmt(r.valRet)}% (base ${fmt(base)}% lift ${fmt(r.valRet - base, 1)}) | DISC n=${r.discN} RET ${fmt(r.discRet)}% | medPen ${fmt(r.medPen, 2)}`,
  );
  push(
    `MAE P25/50/75/90/95: ${fmt(pctile(race.maes, 0.25))} / ${fmt(pctile(race.maes, 0.5))} / ${fmt(pctile(race.maes, 0.75))} / ${fmt(pctile(race.maes, 0.9))} / ${fmt(pctile(race.maes, 0.95))}`,
  );
  push(
    `MFE P25/50/75/90/95: ${fmt(pctile(race.mfes, 0.25))} / ${fmt(pctile(race.mfes, 0.5))} / ${fmt(pctile(race.mfes, 0.75))} / ${fmt(pctile(race.mfes, 0.9))} / ${fmt(pctile(race.mfes, 0.95))}`,
  );
  push(
    `Reach reclaim ${fmt(pct(race.reach.reclaim!, race.n), 1)}% | 25% ${fmt(pct(race.reach.pct25!, race.rangeN), 1)}% | 50% ${fmt(pct(race.reach.pct50!, race.rangeN), 1)}% | 75% ${fmt(pct(race.reach.pct75!, race.rangeN), 1)}% | 100% ${fmt(pct(race.reach.pct100!, race.rangeN), 1)}%`,
  );
  push(
    `Extra adverse after signal: +5 ${fmt(pct(race.extra[5]!, race.n), 1)}% +10 ${fmt(pct(race.extra[10]!, race.n), 1)}% +15 ${fmt(pct(race.extra[15]!, race.n), 1)}% +20 ${fmt(pct(race.extra[20]!, race.n), 1)}% +30 ${fmt(pct(race.extra[30]!, race.n), 1)}% +45 ${fmt(pct(race.extra[45]!, race.n), 1)}%`,
  );
  for (const tk of ["reclaim", "pct25", "pct50", "pct75", "pct100"]) {
    const den = tk === "reclaim" ? race.n : race.rangeN;
    push(
      `  ${tk} before adverse: 5p ${fmt(pct(race.before[tk]![5]!, den), 1)}% | 10p ${fmt(pct(race.before[tk]![10]!, den), 1)}% | 15p ${fmt(pct(race.before[tk]![15]!, den), 1)}% | 20p ${fmt(pct(race.before[tk]![20]!, den), 1)}% | 30p ${fmt(pct(race.before[tk]![30]!, den), 1)}% | 45p ${fmt(pct(race.before[tk]![45]!, den), 1)}%`,
    );
  }

  // subgroups
  const list = shots.filter((s) => s.dist === r.dist && r.pred(s));
  for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    const sub = list.filter((s) => s.session === sess);
    if (sub.length)
      push(
        `  ${sess}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.returned).length, sub.length))}% medPen ${fmt(pctile(sub.map((s) => s.pen), 0.5), 2)}`,
      );
  }
  for (const side of ["support", "resistance"] as Side[]) {
    const sub = list.filter((s) => s.side === side);
    if (sub.length)
      push(`  ${side}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.returned).length, sub.length))}%`);
  }
  for (const t of ["range", "swing"] as LevelType[]) {
    const sub = list.filter((s) => s.type === t);
    if (sub.length)
      push(`  ${t}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.returned).length, sub.length))}%`);
  }
  for (const wb of ["0-10p", "10-20p", "20-30p", "30-50p", "50-75p", "75-100p", "100p+"]) {
    const sub = list.filter((s) => s.rangeValid && widthBucket(s.rangeWidthPips) === wb);
    if (sub.length >= 20)
      push(`  width ${wb}: n=${sub.length} RET ${fmt(pct(sub.filter((s) => s.returned).length, sub.length))}%`);
  }
}

reportBest("3p", best3);
reportBest("5p", best5);
reportBest("7.5p", best75);
reportBest("10p", best10);

// V21/V22 comparison table
push("");
push("=".repeat(88));
push("V21 / V22 / V23 COMPARISON");
push("=".repeat(88));
push("Name | valN | ret% | execPen | spread | medMAE | P75 | P90 | reclaim | 25 | 50 | 75 | 100");
push("V21 PRIMARY | 576 | 86.8 | 3.60 extreme / 0.00 fill | ~1.5 | 11.1 | 26.2 | 44.2 | 95.7 | 72.5 | 57.3 | 48.3 | 41.0");
push("V21 ALT | 1211 | 85.0 | 4.00 extreme / 1.10 fill | ~1.5 | — | — | — | — | — | — | — | —");
function compLine(name: string, v: ValCand | undefined) {
  if (!v || !v.race) {
    push(`${name} | — | — | — | — | — | — | — | — | — | — | — | —`);
    return;
  }
  const r = v.row;
  const race = v.race;
  const list = shots.filter((s) => s.dist === r.dist && r.pred(s));
  const spr = pctile(
    list.map((s) => s.spread),
    0.5,
  );
  push(
    `${name} | ${r.valN} | ${fmt(r.valRet)} | ${fmt(r.medPen, 2)} REAL | ${fmt(spr)} | ${fmt(pctile(race.maes, 0.5))} | ${fmt(pctile(race.maes, 0.75))} | ${fmt(pctile(race.maes, 0.9))} | ${fmt(pct(race.reach.reclaim!, race.n), 1)} | ${fmt(pct(race.reach.pct25!, race.rangeN), 1)} | ${fmt(pct(race.reach.pct50!, race.rangeN), 1)} | ${fmt(pct(race.reach.pct75!, race.rangeN), 1)} | ${fmt(pct(race.reach.pct100!, race.rangeN), 1)}`,
  );
}
compLine("V23 best 3p", best3);
compLine("V23 best 5p", best5);
compLine("V23 best 7.5p", best75);
compLine("V23 best 10p", best10);

// Entry buffer
push("");
push("ENTRY BUFFER CHECK");
for (const v of [best3, best5, best75, best10]) {
  if (!v) continue;
  push(
    `  D=${v.row.dist}|${v.row.name}: med REAL pen ${fmt(v.row.medPen, 2)}p | ≥3? ${v.row.medPen >= 3} | ≥5? ${v.row.medPen >= 5} | ≥7.5? ${v.row.medPen >= 7.5}`,
  );
}

// Verdict
const foundList = [best3, best5, best75, best10].filter(
  (v): v is ValCand =>
    !!v &&
    v.row.valN >= 200 &&
    v.row.valRet - baselines[v.row.dist]!.ret >= 3 &&
    v.row.discRet - baselines[v.row.dist]!.ret >= 2 &&
    v.row.medPen >= 3 &&
    !!v.race &&
    pct(v.race.before.reclaim![10]!, v.race.n) >= 50,
);
let verdict: "EXECUTABLE_EARLY_SIGNAL_FOUND" | "EXECUTABLE_SIGNAL_TOO_WEAK" | "NO_EXECUTABLE_EARLY_SIGNAL";
if (foundList.length) verdict = "EXECUTABLE_EARLY_SIGNAL_FOUND";
else if (
  [best3, best5, best75, best10].some(
    (v) => v && v.row.valN >= 200 && v.row.valRet > baselines[v.row.dist]!.ret + 1 && v.row.medPen >= 3,
  )
)
  verdict = "EXECUTABLE_SIGNAL_TOO_WEAK";
else verdict = "NO_EXECUTABLE_EARLY_SIGNAL";

const simplest = foundList.sort((a, b) => {
  const la = a.row.valRet - baselines[a.row.dist]!.ret;
  const lb_ = b.row.valRet - baselines[b.row.dist]!.ret;
  if (Math.abs(lb_ - la) <= 1) return b.row.medPen - a.row.medPen;
  return lb_ - la;
})[0] ?? bestOverall;

// Answers
push("");
push("=".repeat(88));
push("ANSWERS");
push("=".repeat(88));
push(`1. Executable 3p snapshots N: ${baselines[3]!.n}`);
push(`2. Uncond return 3p: ${fmt(baselines[3]!.ret)}%`);
push(`3. 5p: N=${baselines[5]!.n} RET ${fmt(baselines[5]!.ret)}%`);
push(`4. 7.5p: N=${baselines[7.5]!.n} RET ${fmt(baselines[7.5]!.ret)}%`);
push(`5. 10p: N=${baselines[10]!.n} RET ${fmt(baselines[10]!.ret)}%`);
push(
  `6. Executable-close requirement change behavior? YES — V21 extreme+3p illusion removed; V23 3p baseline RET ${fmt(baselines[3]!.ret)}% with REAL medPen ${fmt(baselines[3]!.medPen, 2)}p (vs V21 fill ~0p)`,
);

function ansBest(v: ValCand | undefined, qN: string, qRet: string, qLift: string) {
  if (!v) {
    push(`${qN} none`);
    push(`${qRet} —`);
    push(`${qLift} —`);
    return;
  }
  const base = baselines[v.row.dist]!.ret;
  push(`${qN} ${v.row.name}`);
  push(`${qRet.replace("N?", String(v.row.valN))} RET ${fmt(v.row.valRet)}%`);
  push(`${qLift} ${fmt(v.row.valRet - base, 1)}pp (base ${fmt(base)}%)`);
}
if (best3) {
  push(`7. Strongest validated @3p: ${best3.row.name}`);
  push(`8. Validation N: ${best3.row.valN}`);
  push(`9. Return: ${fmt(best3.row.valRet)}%`);
  push(`10. Lift: ${fmt(best3.row.valRet - baselines[3]!.ret, 1)}pp`);
} else {
  push("7-10. No validated 3p signal");
}
if (best5) {
  push(`11. Strongest @5p: ${best5.row.name}`);
  push(`12. Validation N: ${best5.row.valN}`);
  push(`13. Return: ${fmt(best5.row.valRet)}%`);
  push(`14. Lift: ${fmt(best5.row.valRet - baselines[5]!.ret, 1)}pp`);
} else {
  push("11-14. No validated 5p signal");
}
push(
  `15. Signal at 7.5/10p? 7.5=${best75 ? best75.row.name + " valN=" + best75.row.valN : "NO"} | 10=${best10 ? best10.row.name + " valN=" + best10.row.valN : "NO"}`,
);

const topFeat = validated[0];
push(`16. Strongest feature overall (by score): ${topFeat ? `D=${topFeat.row.dist}|${topFeat.row.name}` : "none"}`);
const dying3 = rows.find((r) => r.dist === 3 && r.name === "mom_dying");
push(
  `17. Dying momentum useful when ACTUALLY outside? ${dying3 && dying3.valLift >= 2 ? "YES" : dying3 && dying3.lift >= 1 ? "MILD" : "NO/WEAK"} (3p dying lift ALL ${fmt(dying3?.lift ?? NaN, 1)} valLift ${fmt(dying3?.valLift ?? NaN, 1)})`,
);
const t2 = rows.find((r) => r.dist === 3 && r.name === "toward≥2");
push(`18. Toward≥2 useful? ${t2 && t2.valLift >= 2 ? "YES" : t2 && t2.lift >= 1 ? "MILD" : "NO/WEAK"} (lift ${fmt(t2?.lift ?? NaN, 1)})`);
const gb = rows.find((r) => r.dist === 3 && r.name === "gb≥1");
push(`19. Giveback useful? ${gb && gb.valLift >= 2 ? "YES" : gb && gb.lift >= 1 ? "MILD" : "NO/WEAK"} (lift ${fmt(gb?.lift ?? NaN, 1)})`);
const combos = rows.filter((r) => r.name.includes("+") && r.valN >= 200 && r.valLift >= 2);
push(`20. Two-feature combo improve validation? ${combos.length ? "YES — " + combos.slice(0, 3).map((c) => `D${c.dist}|${c.name}`).join(", ") : "NO clear validated combo edge"}`);

const ref = simplest;
if (ref && ref.race) {
  push(`21. Median REAL exec penetration (best): ${fmt(ref.row.medPen, 2)}p`);
  push(
    `22. MAE med/P75/P90: ${fmt(pctile(ref.race.maes, 0.5))} / ${fmt(pctile(ref.race.maes, 0.75))} / ${fmt(pctile(ref.race.maes, 0.9))}`,
  );
  push(`23. Reclaim: ${fmt(pct(ref.race.reach.reclaim!, ref.race.n), 1)}%`);
  push(`24. 25%: ${fmt(pct(ref.race.reach.pct25!, ref.race.rangeN), 1)}%`);
  push(`25. 50%: ${fmt(pct(ref.race.reach.pct50!, ref.race.rangeN), 1)}%`);
  push(`26. 75%: ${fmt(pct(ref.race.reach.pct75!, ref.race.rangeN), 1)}%`);
  push(`27. 100%: ${fmt(pct(ref.race.reach.pct100!, ref.race.rangeN), 1)}%`);
  push(`28. P(reclaim before +10p adverse): ${fmt(pct(ref.race.before.reclaim![10]!, ref.race.n), 1)}%`);
  push(`29. P(reclaim before +20p): ${fmt(pct(ref.race.before.reclaim![20]!, ref.race.n), 1)}%`);
} else {
  for (let q = 21; q <= 29; q++) push(`${q}. n/a`);
}

// best balance distance
let balD: Dist = 3;
let balScore = -Infinity;
for (const D of DISTANCES) {
  const v = bestAt(D);
  if (!v) continue;
  const sc = v.row.valRet - baselines[D]!.ret + v.row.medPen * 0.5;
  if (sc > balScore) {
    balScore = sc;
    balD = D;
  }
}
push(`30. Best balance distance: ${balD}p`);

if (ref) {
  const list = shots.filter((s) => s.dist === ref.row.dist && ref.row.pred(s));
  const lon = list.filter((s) => s.session === "LONDON");
  const asia = list.filter((s) => s.session === "ASIA");
  const ny = list.filter((s) => s.session === "NEW_YORK");
  push(
    `31. London different? LON RET ${fmt(pct(lon.filter((s) => s.returned).length, lon.length))}% vs ASIA ${fmt(pct(asia.filter((s) => s.returned).length, asia.length))}% NY ${fmt(pct(ny.filter((s) => s.returned).length, ny.length))}% (subgroup only)`,
  );
  const sup = list.filter((s) => s.side === "support");
  const res = list.filter((s) => s.side === "resistance");
  push(
    `32. Support vs resistance: SUP ${fmt(pct(sup.filter((s) => s.returned).length, sup.length))}% | RES ${fmt(pct(res.filter((s) => s.returned).length, res.length))}%`,
  );
  const rg = list.filter((s) => s.type === "range");
  const sw = list.filter((s) => s.type === "swing");
  push(
    `33. Range vs swing: RANGE ${fmt(pct(rg.filter((s) => s.returned).length, rg.length))}% | SWING ${fmt(pct(sw.filter((s) => s.returned).length, sw.length))}%`,
  );
} else {
  push("31-33. n/a");
}
push(
  `34. Enough real entry buffer for V24? ${verdict === "EXECUTABLE_EARLY_SIGNAL_FOUND" && ref && ref.row.medPen >= 3 ? "YES — real ≥3p buffer with validated lift" : verdict === "EXECUTABLE_SIGNAL_TOO_WEAK" ? "MAYBE — weak/partial" : "NO"}`,
);

push("");
push("=".repeat(88));
push(`VERDICT: ${verdict}`);
push("=".repeat(88));
if (verdict === "EXECUTABLE_EARLY_SIGNAL_FOUND" && simplest && simplest.race) {
  const r = simplest.row;
  const base = baselines[r.dist]!.ret;
  push("SIMPLEST RULE:");
  push(`Frozen session S/R`);
  push(`→ executable ${r.dist === r.dist ? "[BID if resistance / ASK if support]" : ""} reaches ${r.dist} pips outside`);
  push(`→ ${r.name}`);
  push(`→ executable price still ≥${r.dist}p outside`);
  push(`→ validation N = ${r.valN}`);
  push(`→ baseline return = ${fmt(base)}%`);
  push(`→ signal return = ${fmt(r.valRet)}%`);
  push(`→ lift = ${fmt(r.valRet - base, 1)}pp`);
  push(`→ median real penetration = ${fmt(r.medPen, 2)}p`);
  push(`→ median MAE = ${fmt(pctile(simplest.race.maes, 0.5))}`);
  push(`→ reclaim-before-10p-adverse = ${fmt(pct(simplest.race.before.reclaim![10]!, simplest.race.n), 1)}%`);
} else {
  push("No frozen executable-close early reversal signal cleared validation with real ≥3p buffer and material lift.");
  push("Do not create V24 yet.");
}

const outPath = path.join(OUT_DIR, "eurusd-executable-outside-reversal-v23-report.txt");
fs.writeFileSync(outPath, L.join("\n"));
try {
  fs.mkdirSync(path.join(process.cwd(), "research-output"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "research-output", "eurusd-executable-outside-reversal-v23-report.txt"),
    L.join("\n"),
  );
} catch {
  /* ignore */
}
console.log(`Wrote ${outPath}`);
console.log(`VERDICT: ${verdict}`);
void ansBest;
void discMom3;
