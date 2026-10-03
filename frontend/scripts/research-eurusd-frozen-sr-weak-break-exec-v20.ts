/**
 * EUR/USD V20 — FROZEN S/R WEAK-BREAK EXECUTION TEST (research-only).
 *
 * V18/V19 FROZEN — this script does not modify them.
 *
 * Signal (EXACT V19): first M5 bar that reaches 3p beyond frozen session S/R
 * AND body_weak per V19:
 *   bodyAtr <= 0.15 || bodyRange <= 0.35 || closeOut <= 0.5
 * Fade: resistance→SHORT, support→LONG. BID/ASK P&L. No MID.
 *
 * TP: reclaim / 25% / 50% / 75% / 100% of frozen range (known at session open).
 * SL families: outer structural (±0.10/0.25/0.50 ATR), range-width %, ATR control.
 * Horizon: session end + secondary +4h (same frozen levels).
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
const EXTRA_H_BARS = (4 * 60) / M5_BAR_MIN; // +4h

type SessionName = "ASIA" | "LONDON" | "NEW_YORK";
type Side = "support" | "resistance";
type LevelType = "range" | "swing";
type Dir = "long" | "short";
type Period = "discovery" | "validation";
type OC = "win" | "loss" | "timeout" | "ambiguous";
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
  | "atr_3";
type Horizon = "session" | "plus4h";

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

interface FrozenLevel {
  side: Side;
  type: LevelType;
  price: number;
  openDistPips: number;
}

interface SessionSnap {
  session: SessionName;
  openMs: number;
  closeMs: number;
  atr: number;
  levels: FrozenLevel[];
  year: number;
}

interface Setup {
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
  sigIdx: number;
  entry: number;
  spreadPips: number;
  entryPenPips: number;
  penBucket: string;
  widthBucket: string;
  sessionEndIdx: number;
  plus4EndIdx: number;
  // behavioral: mid close back inside after entry (V19-style reclaim after fill)
  midReclaimAfterEntry: boolean;
}

interface Acc {
  n: number;
  wins: number;
  losses: number;
  timeouts: number;
  amb: number;
  sumPnl: number;
  sumWin: number;
  sumLoss: number; // negative sum
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
const SLS: SlKind[] = [
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
];
const HORIZONS: Horizon[] = ["session", "plus4h"];

console.log("V20 loading M15 + M5 BID/ASK...");
const raw: RC[] = JSON.parse(fs.readFileSync(path.join(PAD, "eurusd-m15-mba-cache.json"), "utf8"));
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
  fs.readFileSync(path.join(PAD, "eurusd-m5-mba-cache.json"), "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const bh = new Float64Array(M),
  bl = new Float64Array(M),
  ah = new Float64Array(M),
  al = new Float64Array(M),
  bc = new Float64Array(M),
  ac = new Float64Array(M);
const mh = new Float64Array(M),
  ml = new Float64Array(M),
  mc = new Float64Array(M),
  mo = new Float64Array(M);
const m5ms = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  m5ms[i] = Date.parse(r[0]);
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
  mo[i] = i === 0 ? mc[i]! : mc[i - 1]!;
}
(m5raw as unknown as { length: number }).length = 0;

console.log(`M15 ${n} | M5 ${M}`);

function lbMs(target: number): number {
  let lo = 0,
    hi = M;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m5ms[mid]! < target) lo = mid + 1;
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

function fmt(x: number, d = 2): string {
  return Number.isFinite(x) ? x.toFixed(d) : "—";
}

function pct(a: number, b: number): number {
  return b > 0 ? (100 * a) / b : NaN;
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

/** EXACT V19 body_weak definition — DO NOT CHANGE. */
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
        const openPrice = levels.current;
        const frozen: FrozenLevel[] = [];
        frozen.push({
          side: "resistance",
          type: "range",
          price: levels.rangeHigh,
          openDistPips: (levels.rangeHigh - openPrice) / PIP,
        });
        frozen.push({
          side: "support",
          type: "range",
          price: levels.rangeLow,
          openDistPips: (openPrice - levels.rangeLow) / PIP,
        });
        if (
          levels.swingHigh !== null &&
          Math.abs(levels.swingHigh - levels.rangeHigh) / PIP >= DUP_PIP
        ) {
          frozen.push({
            side: "resistance",
            type: "swing",
            price: levels.swingHigh,
            openDistPips: (levels.swingHigh - openPrice) / PIP,
          });
        }
        if (
          levels.swingLow !== null &&
          Math.abs(levels.swingLow - levels.rangeLow) / PIP >= DUP_PIP
        ) {
          frozen.push({
            side: "support",
            type: "swing",
            price: levels.swingLow,
            openDistPips: (openPrice - levels.swingLow) / PIP,
          });
        }
        let j = i;
        while (j < n && inCentreSession(timesMs[j]!, def.tz) && localYmd(timesMs[j]!, def.tz) === day) {
          j += 1;
        }
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

function penBeyond(h: number, l: number, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (h - level) / PIP);
  return Math.max(0, (level - l) / PIP);
}

function closeOutsidePips(c: number, side: Side, level: number): number {
  if (side === "resistance") return (c - level) / PIP;
  return (level - c) / PIP;
}

function oppositeOf(snap: SessionSnap, side: Side, type: LevelType): number | null {
  const want: Side = side === "resistance" ? "support" : "resistance";
  const same = snap.levels.find((l) => l.side === want && l.type === type);
  if (same) {
    if (side === "resistance" && same.price < snap.levels.find((l) => l.side === side && l.type === type)!.price)
      return same.price;
    if (side === "support" && same.price > snap.levels.find((l) => l.side === side && l.type === type)!.price)
      return same.price;
  }
  const any = snap.levels.filter((l) => l.side === want);
  if (!any.length) return null;
  // pick farthest opposite that makes geometric sense
  const origin = snap.levels.find((l) => l.side === side && l.type === type)!.price;
  if (side === "resistance") {
    const cands = any.filter((l) => l.price < origin);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (a.price < b.price ? a : b)).price; // lowest support
  }
  const cands = any.filter((l) => l.price > origin);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.price > b.price ? a : b)).price;
}

function outerSameSide(snap: SessionSnap, side: Side, type: LevelType, origin: number): number | null {
  const same = snap.levels.filter((l) => l.side === side && !(l.type === type && l.price === origin));
  if (side === "resistance") {
    const cands = same.filter((l) => l.price > origin + PIP * 0.5);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (a.price > b.price ? a : b)).price; // farthest out
  }
  const cands = same.filter((l) => l.price < origin - PIP * 0.5);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.price < b.price ? a : b)).price;
}

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
  if (oc === "win") {
    y.wins++;
    y.sumWin += pnl;
  } else if (oc === "loss") y.sumLoss += pnl;
  else if (pnl >= 0) {
    y.wins++;
    y.sumWin += pnl;
  } else y.sumLoss += pnl;
}

function pfOf(a: Acc): number {
  if (a.sumLoss >= 0) return a.sumWin > 0 ? Infinity : NaN;
  return a.sumWin / Math.abs(a.sumLoss);
}

function reportAcc(label: string, a: Acc, yearsSpan: number): string {
  const wr = pct(a.wins, a.n);
  const exp = a.n > 0 ? a.sumPnl / a.n : NaN;
  // R = |avg loss| when available
  const avgL = a.lossP.length ? Math.abs(mean(a.lossP)) : NaN;
  const expR = avgL > 0 ? exp / avgL : NaN;
  const tpy = yearsSpan > 0 ? a.n / yearsSpan : NaN;
  return [
    label,
    `N=${a.n} W=${a.wins} L=${a.losses} TO=${a.timeouts} AMB=${a.amb}`,
    `WR ${fmt(wr, 1)}%`,
    `PF ${fmt(pfOf(a))}`,
    `E ${fmt(exp)}p`,
    `E_R ${fmt(expR)}`,
    `tot ${fmt(a.sumPnl, 1)}p`,
    `avgW ${fmt(mean(a.winsP))} avgL ${fmt(mean(a.lossP))}`,
    `medW ${fmt(pctile(a.winsP, 0.5))} medL ${fmt(pctile(a.lossP, 0.5))}`,
    `avgSpr ${fmt(mean(a.spreads))} medSpr ${fmt(pctile(a.spreads, 0.5))}`,
    `medMAE ${fmt(pctile(a.mae, 0.5))} P75 ${fmt(pctile(a.mae, 0.75))} P90 ${fmt(pctile(a.mae, 0.9))}`,
    `medMFE ${fmt(pctile(a.mfe, 0.5))} P75 ${fmt(pctile(a.mfe, 0.75))} P90 ${fmt(pctile(a.mfe, 0.9))}`,
    `medHold ${fmt(pctile(a.hold, 0.5), 0)}m`,
    `t/yr ${fmt(tpy, 1)}`,
  ].join(" | ");
}

console.log("Building session snapshots...");
const snaps = buildSnaps();
console.log(`Sessions: ${snaps.length}`);

const setups: Setup[] = [];
let signalsSeen = 0;
let excludedNoOpp = 0;
let structAvail = 0;

function collectSetups() {
  for (const snap of snaps) {
    const w = TOUCH_ATR * snap.atr;
    const atr = snap.atr;
    const m5Start = lbMs(snap.openMs);
    let m5End = lbMs(snap.closeMs);
    if (m5End > M) m5End = M;
    if (m5End <= m5Start + 2) continue;
    const plus4 = Math.min(M, m5End + EXTRA_H_BARS);

    for (const fl of snap.levels) {
      let armed = true;
      let active = false;
      let traded = false;
      let reached3 = false; // within current encounter

      for (let i = m5Start; i < m5End && !traded; i++) {
        const o = mo[i]!,
          h = mh[i]!,
          l = ml[i]!,
          c = mc[i]!;
        const touch = touchesZone(h, l, fl.price, w);
        const pen = penBeyond(h, l, fl.side, fl.price);

        if (armed && touch) {
          armed = false;
          active = true;
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
          const closeOut = closeOutsidePips(c, fl.side, fl.price);
          const weak = isWeakBody(bodyAtr, bodyRange, closeOut);

          if (!weak) {
            // V19: this encounter's at_D is not weak_body — end encounter, re-arm after clear
            active = false;
            continue;
          }

          signalsSeen++;
          const dir: Dir = fl.side === "resistance" ? "short" : "long";
          const entry = dir === "long" ? ac[i]! : bc[i]!;
          const spreadPips = (ac[i]! - bc[i]!) / PIP;
          const entryPen =
            dir === "short" ? (entry - fl.price) / PIP : (fl.price - entry) / PIP;

          const opposite = oppositeOf(snap, fl.side, fl.type);
          const outer = outerSameSide(snap, fl.side, fl.type, fl.price);
          let rangeValid = false;
          let rangeWidthPips = NaN;
          if (opposite !== null) {
            if (fl.side === "resistance" && opposite < fl.price) {
              rangeValid = true;
              rangeWidthPips = (fl.price - opposite) / PIP;
            } else if (fl.side === "support" && opposite > fl.price) {
              rangeValid = true;
              rangeWidthPips = (opposite - fl.price) / PIP;
            }
          }
          if (!rangeValid) excludedNoOpp++;
          if (outer !== null) structAvail++;

          let midReclaim = false;
          for (let k = i; k < m5End; k++) {
            if (fl.side === "resistance" ? mc[k]! <= fl.price : mc[k]! >= fl.price) {
              midReclaim = true;
              break;
            }
          }

          setups.push({
            session: snap.session,
            side: fl.side,
            type: fl.type,
            dir,
            year: snap.year,
            period: periodOf(snap.year),
            level: fl.price,
            opposite,
            outer,
            rangeWidthPips,
            rangeValid,
            atr,
            sigIdx: i,
            entry,
            spreadPips,
            entryPenPips: entryPen,
            penBucket: penBucket(entryPen),
            widthBucket: rangeValid ? widthBucket(rangeWidthPips) : "no_opp",
            sessionEndIdx: m5End,
            plus4EndIdx: plus4,
            midReclaimAfterEntry: midReclaim,
          });
          traded = true; // one trade per level per session
          break;
        }

        if (clearInside(h, l, fl.side, fl.price, w)) {
          active = false;
          armed = true;
          reached3 = false;
        }
      }
    }
  }
}

collectSetups();
console.log(`V19 weak-body executable setups: ${setups.length} (signals ${signalsSeen})`);
console.log(`No opposite (excl from % TP): ${excludedNoOpp} | structural outer available: ${structAvail}`);

// ---------- path MAE/MFE study (session horizon, executable side) ----------
function pathStats(s: Setup, endIdx: number): {
  mae: number;
  mfe: number;
  reach: Record<string, boolean>;
  hitAdv: Record<string, boolean>;
  reachBefore: Record<string, Record<string, boolean>>;
} {
  const reach: Record<string, boolean> = {
    reclaim: false,
    pct25: false,
    pct50: false,
    pct75: false,
    pct100: false,
  };
  const advKeys = ["10p", "20p", "0.5atr", "1atr", "2atr", "outer"] as const;
  const hitAdv: Record<string, boolean> = {};
  const reachBefore: Record<string, Record<string, boolean>> = {};
  for (const tk of ["reclaim", "pct25", "pct50", "pct75", "pct100"]) {
    reachBefore[tk] = {};
    for (const ak of advKeys) reachBefore[tk]![ak] = false;
  }
  for (const ak of advKeys) hitAdv[ak] = false;

  let mae = 0,
    mfe = 0;
  let hit10 = false,
    hit20 = false,
    hit05 = false,
    hit1 = false,
    hit2 = false,
    hitOuter = false;

  const tpPrice = (kind: string): number | null => {
    if (kind === "reclaim") return s.level;
    if (!s.rangeValid || s.opposite === null) return null;
    const w = s.rangeWidthPips * PIP;
    const frac = kind === "pct25" ? 0.25 : kind === "pct50" ? 0.5 : kind === "pct75" ? 0.75 : 1;
    return s.dir === "short" ? s.level - frac * w : s.level + frac * w;
  };

  for (let k = s.sigIdx + 1; k < endIdx; k++) {
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

    if (adv >= 10) hit10 = true;
    if (adv >= 20) hit20 = true;
    if (adv >= (0.5 * s.atr) / PIP) hit05 = true;
    if (adv >= s.atr / PIP) hit1 = true;
    if (adv >= (2 * s.atr) / PIP) hit2 = true;
    if (s.outer !== null) {
      const outerDist =
        s.dir === "long" ? (s.entry - s.outer) / PIP : (s.outer - s.entry) / PIP;
      // hit outer region if adverse reaches beyond outer
      if (s.dir === "long" && bl[k]! <= s.outer) hitOuter = true;
      if (s.dir === "short" && ah[k]! >= s.outer) hitOuter = true;
      void outerDist;
    }

    for (const tk of Object.keys(reach)) {
      const tp = tpPrice(tk);
      if (tp === null) continue;
      let hit = false;
      if (s.dir === "long") hit = bh[k]! >= tp;
      else hit = al[k]! <= tp;
      if (hit && !reach[tk]) {
        reach[tk] = true;
        if (!hit10) reachBefore[tk]!["10p"] = true;
        if (!hit20) reachBefore[tk]!["20p"] = true;
        if (!hit05) reachBefore[tk]!["0.5atr"] = true;
        if (!hit1) reachBefore[tk]!["1atr"] = true;
        if (!hit2) reachBefore[tk]!["2atr"] = true;
        if (!hitOuter) reachBefore[tk]!["outer"] = true;
      }
    }
  }
  hitAdv["10p"] = hit10;
  hitAdv["20p"] = hit20;
  hitAdv["0.5atr"] = hit05;
  hitAdv["1atr"] = hit1;
  hitAdv["2atr"] = hit2;
  hitAdv["outer"] = hitOuter;
  return { mae, mfe, reach, hitAdv, reachBefore };
}

const pathMae: number[] = [];
const pathMfe: number[] = [];
const reachCounts: Record<string, number> = {
  reclaim: 0,
  pct25: 0,
  pct50: 0,
  pct75: 0,
  pct100: 0,
};
const reachBeforeAdv: Record<string, Record<string, number>> = {};
for (const tk of ["reclaim", "pct25", "pct50", "pct75", "pct100"]) {
  reachBeforeAdv[tk] = { "10p": 0, "20p": 0, "0.5atr": 0, "1atr": 0, "2atr": 0, outer: 0 };
}
let pathN = 0;
let pathRangeN = 0;
let reclaimN = 0;

for (const s of setups) {
  const ps = pathStats(s, s.sessionEndIdx);
  pathMae.push(ps.mae);
  pathMfe.push(ps.mfe);
  pathN++;
  if (s.midReclaimAfterEntry) reclaimN++;
  if (s.rangeValid) {
    pathRangeN++;
    for (const tk of Object.keys(reachCounts)) {
      if (tk === "reclaim" || s.rangeValid) {
        if (ps.reach[tk]) reachCounts[tk]!++;
        for (const ak of Object.keys(reachBeforeAdv[tk]!)) {
          if (ps.reachBefore[tk]![ak]) reachBeforeAdv[tk]![ak]!++;
        }
      }
    }
  } else if (ps.reach.reclaim) {
    reachCounts.reclaim!++;
    for (const ak of Object.keys(reachBeforeAdv.reclaim!)) {
      if (ps.reachBefore.reclaim![ak]) reachBeforeAdv.reclaim![ak]!++;
    }
  }
}

// ---------- simulate matrix ----------
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
  let exitPx = s.dir === "long" ? bc[Math.max(s.sigIdx + 1, endIdx - 1)]! : ac[Math.max(s.sigIdx + 1, endIdx - 1)]!;

  for (let k = s.sigIdx + 1; k < endIdx; k++) {
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
      return { oc: "ambiguous", pnl: 0, mae, mfe, holdMin: (k - s.sigIdx) * M5_BAR_MIN };
    }
    if (tpHit) {
      const pnl = s.dir === "long" ? (tp - s.entry) / PIP : (s.entry - tp) / PIP;
      return { oc: "win", pnl, mae, mfe, holdMin: (k - s.sigIdx) * M5_BAR_MIN };
    }
    if (slHit) {
      const pnl = s.dir === "long" ? (sl - s.entry) / PIP : (s.entry - sl) / PIP;
      return { oc: "loss", pnl, mae, mfe, holdMin: (k - s.sigIdx) * M5_BAR_MIN };
    }
    exitBar = k;
    exitPx = s.dir === "long" ? bc[k]! : ac[k]!;
  }
  const pnl = s.dir === "long" ? (exitPx - s.entry) / PIP : (s.entry - exitPx) / PIP;
  return { oc, pnl, mae, mfe, holdMin: (exitBar - s.sigIdx) * M5_BAR_MIN };
}

type Key = string;
const matrix = new Map<Key, Acc>();
const matrixDisc = new Map<Key, Acc>();
const matrixVal = new Map<Key, Acc>();

function keyOf(tp: TpKind, sl: SlKind, hz: Horizon, slice: string): Key {
  return `${tp}|${sl}|${hz}|${slice}`;
}

function bump(map: Map<Key, Acc>, key: Key, s: Setup, r: ReturnType<typeof simulate>) {
  let a = map.get(key);
  if (!a) {
    a = newAcc();
    map.set(key, a);
  }
  addTrade(a, r.pnl, r.oc, r.mae, r.mfe, r.holdMin, s.spreadPips, s.year);
}

console.log("Simulating TP×SL matrix...");
matrix.clear();
matrixDisc.clear();
matrixVal.clear();

for (const s of setups) {
  for (const hz of HORIZONS) {
    const endIdx = hz === "session" ? s.sessionEndIdx : s.plus4EndIdx;
    for (const tp of TPS) {
      const tpPx = tpPrice(s, tp);
      if (tpPx === null) continue;
      for (const sl of SLS) {
        const slPx = slPrice(s, sl);
        if (slPx === null) continue;
        if (s.dir === "long" && !(slPx < s.entry && tpPx > s.entry)) continue;
        if (s.dir === "short" && !(slPx > s.entry && tpPx < s.entry)) continue;

        const r = simulate(s, tpPx, slPx, endIdx);
        const slices = [
          "ALL",
          s.period,
          `sess_${s.session}`,
          `side_${s.side}`,
          `type_${s.type}`,
          `pen_${s.penBucket}`,
          `width_${s.widthBucket}`,
        ];
        for (const slice of slices) {
          bump(matrix, keyOf(tp, sl, hz, slice), s, r);
        }
        if (s.period === "discovery") bump(matrixDisc, keyOf(tp, sl, hz, "ALL"), s, r);
        else bump(matrixVal, keyOf(tp, sl, hz, "ALL"), s, r);
      }
    }
  }
}

console.log(`Matrix cells: ${matrix.size}`);

// ---------- report ----------
const L: string[] = [];
const yearsAll = 2026 - 2013 + 1;
const yearsDisc = 2019 - 2013 + 1;
const yearsVal = 2026 - 2020 + 1;

L.push("=".repeat(88));
L.push("EUR/USD V20 — FROZEN S/R WEAK-BREAK EXECUTION TEST");
L.push("=".repeat(88));
L.push("Signal: EXACT V19 — first M5 ≥3p beyond frozen S/R + weak_body");
L.push("  weak_body := bodyAtr≤0.15 OR bodyRange≤0.35 OR closeOut≤0.5");
L.push("Entry: fade at completed M5 BID/ASK close. One trade / level / session.");
L.push(`Executable setups: ${setups.length}`);
L.push(`V19-style mid reclaim after entry: ${reclaimN}/${setups.length} = ${fmt(pct(reclaimN, setups.length), 1)}%`);
L.push(`Avg entry penetration: ${fmt(mean(setups.map((s) => s.entryPenPips)))}p | med ${fmt(pctile(setups.map((s) => s.entryPenPips), 0.5))}p`);
L.push(`Avg spread: ${fmt(mean(setups.map((s) => s.spreadPips)))}p | med ${fmt(pctile(setups.map((s) => s.spreadPips), 0.5))}p`);
L.push(`Range-valid (opp exists): ${setups.filter((s) => s.rangeValid).length} | excluded from %TP: ${setups.filter((s) => !s.rangeValid).length}`);
L.push(`Structural outer available: ${setups.filter((s) => s.outer !== null).length} / ${setups.length}`);
L.push("");

L.push("-".repeat(88));
L.push("MAE / MFE PATH STUDY (session horizon, before TP/SL choice)");
L.push(`N=${pathN}`);
L.push(
  `MAE pips: P25 ${fmt(pctile(pathMae, 0.25))} P50 ${fmt(pctile(pathMae, 0.5))} P75 ${fmt(pctile(pathMae, 0.75))} P80 ${fmt(pctile(pathMae, 0.8))} P90 ${fmt(pctile(pathMae, 0.9))} P95 ${fmt(pctile(pathMae, 0.95))} P99 ${fmt(pctile(pathMae, 0.99))}`,
);
L.push(
  `MFE pips: P25 ${fmt(pctile(pathMfe, 0.25))} P50 ${fmt(pctile(pathMfe, 0.5))} P75 ${fmt(pctile(pathMfe, 0.75))} P80 ${fmt(pctile(pathMfe, 0.8))} P90 ${fmt(pctile(pathMfe, 0.9))} P95 ${fmt(pctile(pathMfe, 0.95))} P99 ${fmt(pctile(pathMfe, 0.99))}`,
);
L.push(`P(MFE reclaim)=${fmt(pct(reachCounts.reclaim!, pathN), 1)}%`);
L.push(`P(MFE 25%)=${fmt(pct(reachCounts.pct25!, pathRangeN), 1)}% of range-valid n=${pathRangeN}`);
L.push(`P(MFE 50%)=${fmt(pct(reachCounts.pct50!, pathRangeN), 1)}%`);
L.push(`P(MFE 75%)=${fmt(pct(reachCounts.pct75!, pathRangeN), 1)}%`);
L.push(`P(MFE 100%)=${fmt(pct(reachCounts.pct100!, pathRangeN), 1)}%`);
L.push("Reach target BEFORE adverse threshold (count / range-valid or all for reclaim):");
for (const tk of ["reclaim", "pct25", "pct50", "pct75", "pct100"]) {
  const den = tk === "reclaim" ? pathN : pathRangeN;
  const parts = Object.entries(reachBeforeAdv[tk]!)
    .map(([ak, c]) => `${ak}:${fmt(pct(c, den), 1)}%`)
    .join(" ");
  L.push(`  ${tk}: ${parts}`);
}
L.push("");

L.push("-".repeat(88));
L.push("FULL MATRIX — session horizon | slice=ALL");
L.push("(amb excluded from N/WR/PF; listed separately)");
for (const tp of TPS) {
  for (const sl of SLS) {
    const a = matrix.get(keyOf(tp, sl, "session", "ALL"));
    if (!a || a.n + a.amb === 0) {
      L.push(`${tp} × ${sl} | UNAVAILABLE or N=0`);
      continue;
    }
    L.push(reportAcc(`${tp} × ${sl} [session]`, a, yearsAll));
  }
}
L.push("");
L.push("FULL MATRIX — +4h horizon | slice=ALL");
for (const tp of TPS) {
  for (const sl of SLS) {
    const a = matrix.get(keyOf(tp, sl, "plus4h", "ALL"));
    if (!a || a.n + a.amb === 0) continue;
    L.push(reportAcc(`${tp} × ${sl} [+4h]`, a, yearsAll));
  }
}

// Discovery vs Validation for every cell
L.push("\n" + "-".repeat(88));
L.push("DISCOVERY vs VALIDATION (session horizon)");
type Cand = {
  tp: TpKind;
  sl: SlKind;
  hz: Horizon;
  disc: Acc;
  val: Acc;
  all: Acc;
};
const cands: Cand[] = [];
for (const tp of TPS) {
  for (const sl of SLS) {
    for (const hz of HORIZONS) {
      const disc = matrixDisc.get(keyOf(tp, sl, hz, "ALL"));
      const val = matrixVal.get(keyOf(tp, sl, hz, "ALL"));
      const all = matrix.get(keyOf(tp, sl, hz, "ALL"));
      if (!disc || !val || !all) continue;
      if (disc.n < 50 || val.n < 50) continue;
      L.push(
        `${tp}×${sl}[${hz}] DISC ${reportAcc("", disc, yearsDisc).replace(/^ \| /, "")}`,
      );
      L.push(
        `  → VAL  ${reportAcc("", val, yearsVal).replace(/^ \| /, "")}`,
      );
      cands.push({ tp, sl, hz, disc, val, all });
    }
  }
}

function passesEdge(val: Acc, disc: Acc): boolean {
  if (val.n < 200) return false;
  if (!(pfOf(val) > 1.1)) return false;
  const eV = val.sumPnl / val.n;
  const eD = disc.sumPnl / disc.n;
  if (!(eV > 0)) return false;
  if (!(eD > 0)) return false; // same direction
  // not dependent on ambiguous: amb rate low
  if (val.amb > val.n * 0.15) return false;
  // year stability: majority of years with n>=20 have positive pnl
  let posY = 0,
    negY = 0;
  for (const [, y] of val.years) {
    if (y.n < 20) continue;
    if (y.sumPnl > 0) posY++;
    else negY++;
  }
  if (posY + negY >= 3 && posY <= negY) return false;
  return true;
}

function marginal(val: Acc, disc: Acc): boolean {
  if (val.n < 200) return false;
  const eV = val.sumPnl / val.n;
  const eD = disc.sumPnl / disc.n;
  if (eV > 0 && eD > 0 && pfOf(val) > 1.0) return true;
  return false;
}

const passing = cands.filter((c) => passesEdge(c.val, c.disc));
const marginals = cands.filter((c) => !passesEdge(c.val, c.disc) && marginal(c.val, c.disc));

passing.sort((a, b) => b.val.sumPnl / b.val.n - a.val.sumPnl / a.val.n);
marginals.sort((a, b) => pfOf(b.val) - pfOf(a.val));

L.push("\n" + "-".repeat(88));
L.push(`PASSING VALIDATION EDGE (PF>1.10, E>0, n≥200, disc E>0): ${passing.length}`);
for (const c of passing.slice(0, 20)) {
  L.push(
    `PASS ${c.tp}×${c.sl}[${c.hz}] VAL N=${c.val.n} WR=${fmt(pct(c.val.wins, c.val.n), 1)}% PF=${fmt(pfOf(c.val))} E=${fmt(c.val.sumPnl / c.val.n)} | DISC E=${fmt(c.disc.sumPnl / c.disc.n)} PF=${fmt(pfOf(c.disc))}`,
  );
}
L.push(`MARGINAL (E>0 both, PF>1, n≥200): ${marginals.length}`);
for (const c of marginals.slice(0, 15)) {
  L.push(
    `MARG ${c.tp}×${c.sl}[${c.hz}] VAL N=${c.val.n} WR=${fmt(pct(c.val.wins, c.val.n), 1)}% PF=${fmt(pfOf(c.val))} E=${fmt(c.val.sumPnl / c.val.n)}`,
  );
}

// Best by validation expectancy among session horizon
const sessionCands = cands.filter((c) => c.hz === "session");
const bestVal = [...sessionCands].sort((a, b) => b.val.sumPnl / b.val.n - a.val.sumPnl / a.val.n)[0];
const bestPF = [...sessionCands].filter((c) => c.val.n >= 200).sort((a, b) => pfOf(b.val) - pfOf(a.val))[0];

// Breakdowns for best / or reclaim×range_50 as default reference
function pickRef(): Cand | undefined {
  if (passing.length) return passing.find((c) => c.hz === "session") ?? passing[0];
  if (bestPF) return bestPF;
  return bestVal;
}
const ref = pickRef();

if (ref) {
  L.push("\n" + "-".repeat(88));
  L.push(`REFERENCE SETUP: ${ref.tp} × ${ref.sl} [${ref.hz}]`);
  L.push(reportAcc("ALL", ref.all, yearsAll));
  L.push(reportAcc("DISC", ref.disc, yearsDisc));
  L.push(reportAcc("VAL", ref.val, yearsVal));

  L.push("\nYear-by-year (reference):");
  for (let y = 2013; y <= 2026; y++) {
    const yd = ref.all.years.get(y);
    if (!yd || !yd.n) continue;
    const wr = pct(yd.wins, yd.n);
    const pf = yd.sumLoss < 0 ? yd.sumWin / Math.abs(yd.sumLoss) : NaN;
    L.push(`  ${y}: N=${yd.n} WR=${fmt(wr, 1)}% PF=${fmt(pf)} E=${fmt(yd.sumPnl / yd.n)} tot=${fmt(yd.sumPnl, 1)}`);
  }

  // session / side / type / pen / width using matrix keys
  L.push("\nSession breakdown (reference):");
  for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    const a = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, `sess_${sess}`));
    if (a) L.push(reportAcc(sess, a, yearsAll));
  }
  L.push("\nSide breakdown:");
  for (const side of ["support", "resistance"] as Side[]) {
    const a = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, `side_${side}`));
    if (a) L.push(reportAcc(side, a, yearsAll));
  }
  L.push("\nType breakdown:");
  for (const t of ["range", "swing"] as LevelType[]) {
    const a = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, `type_${t}`));
    if (a) L.push(reportAcc(t, a, yearsAll));
  }
  L.push("\nEntry penetration:");
  for (const b of ["3-4p", "4-5p", "5-7.5p", "7.5-10p", "10p+"]) {
    const a = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, `pen_${b}`));
    if (a && a.n) L.push(reportAcc(b, a, yearsAll));
  }
  L.push("\nRange width:");
  for (const b of ["0-10p", "10-20p", "20-30p", "30-50p", "50-75p", "75-100p", "100p+", "no_opp"]) {
    const a = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, `width_${b}`));
    if (a && a.n) L.push(reportAcc(b, a, yearsAll));
  }
}

// Which TP / SL family best in validation
L.push("\n" + "-".repeat(88));
L.push("VALIDATION expectancy by TP (best SL per TP, session, n≥200):");
for (const tp of TPS) {
  const opts = sessionCands.filter((c) => c.tp === tp && c.val.n >= 200);
  opts.sort((a, b) => b.val.sumPnl / b.val.n - a.val.sumPnl / a.val.n);
  const b = opts[0];
  if (!b) {
    L.push(`  ${tp}: none`);
    continue;
  }
  L.push(
    `  ${tp} best SL=${b.sl} VAL E=${fmt(b.val.sumPnl / b.val.n)} PF=${fmt(pfOf(b.val))} WR=${fmt(pct(b.val.wins, b.val.n), 1)}% N=${b.val.n}`,
  );
}
L.push("VALIDATION expectancy by SL family (best TP, session, n≥200):");
for (const sl of SLS) {
  const opts = sessionCands.filter((c) => c.sl === sl && c.val.n >= 200);
  opts.sort((a, b) => b.val.sumPnl / b.val.n - a.val.sumPnl / a.val.n);
  const b = opts[0];
  if (!b) {
    L.push(`  ${sl}: none`);
    continue;
  }
  L.push(
    `  ${sl} best TP=${b.tp} VAL E=${fmt(b.val.sumPnl / b.val.n)} PF=${fmt(pfOf(b.val))} WR=${fmt(pct(b.val.wins, b.val.n), 1)}% N=${b.val.n}`,
  );
}

// Any PF>1?
const anyPF = sessionCands.filter((c) => c.val.n >= 200 && pfOf(c.val) > 1);
const anyE = sessionCands.filter((c) => c.val.n >= 200 && c.val.sumPnl / c.val.n > 0);
L.push(`\nSession cells with VAL n≥200 & PF>1: ${anyPF.length}`);
L.push(`Session cells with VAL n≥200 & E>0: ${anyE.length}`);

let verdict: "EXECUTABLE_EDGE_FOUND" | "MARGINAL_EXECUTABLE_EDGE" | "RETURN_BEHAVIOR_NOT_PROFITABLE";
if (passing.length > 0) verdict = "EXECUTABLE_EDGE_FOUND";
else if (marginals.length > 0) verdict = "MARGINAL_EXECUTABLE_EDGE";
else verdict = "RETURN_BEHAVIOR_NOT_PROFITABLE";

const simplest = passing.find((c) => c.hz === "session") ?? passing[0] ?? marginals.find((c) => c.hz === "session") ?? marginals[0];

// London vs others P&L for reclaim×atr_2 as common ref, and for simplest
function sessE(tp: TpKind, sl: SlKind, hz: Horizon, sess: SessionName): string {
  const a = matrix.get(keyOf(tp, sl, hz, `sess_${sess}`));
  if (!a || !a.n) return `${sess}: n=0`;
  return `${sess}: N=${a.n} WR=${fmt(pct(a.wins, a.n), 1)}% PF=${fmt(pfOf(a))} E=${fmt(a.sumPnl / a.n)}`;
}

L.push("\n" + "=".repeat(88));
L.push("ANSWERS");
L.push("=".repeat(88));
L.push(`1. Executable V19 weak-body trades: ${setups.length}`);
L.push(`2. Avg actual entry penetration: ${fmt(mean(setups.map((s) => s.entryPenPips)))}p (med ${fmt(pctile(setups.map((s) => s.entryPenPips), 0.5))}p)`);
L.push(`3. Avg spread: ${fmt(mean(setups.map((s) => s.spreadPips)))}p`);
L.push(`4. % mid-reclaim S/R after entry: ${fmt(pct(reclaimN, setups.length), 1)}% (behavioral; not TP win)`);
L.push(`5. % MFE≥25% range: ${fmt(pct(reachCounts.pct25!, pathRangeN), 1)}% (nValid=${pathRangeN})`);
L.push(`6. % MFE≥50%: ${fmt(pct(reachCounts.pct50!, pathRangeN), 1)}%`);
L.push(`7. % MFE≥75%: ${fmt(pct(reachCounts.pct75!, pathRangeN), 1)}%`);
L.push(`8. % MFE≥100%: ${fmt(pct(reachCounts.pct100!, pathRangeN), 1)}%`);
L.push(`9. MAE before reversal (path): med ${fmt(pctile(pathMae, 0.5))}p | P75 ${fmt(pctile(pathMae, 0.75))} | P90 ${fmt(pctile(pathMae, 0.9))}`);
L.push(`10. Large structural SL sensible? Outer available ${setups.filter((s) => s.outer !== null).length}/${setups.length}; see struct_* matrix rows.`);
L.push(`11. Best validation TP: see VALIDATION-by-TP section above.`);
L.push(`12. Best validation stop family: see VALIDATION-by-SL section above.`);
L.push(`13. Any combo PF>1 (val n≥200)? ${anyPF.length > 0 ? "YES" : "NO"} (${anyPF.length} cells)`);
L.push(`14. Any combo E>0 after spread? ${anyE.length > 0 ? "YES" : "NO"} (${anyE.length} cells)`);
L.push(`15. Remains positive 2020–2026? ${passing.length || marginals.filter((c) => c.val.sumPnl / c.val.n > 0).length ? "see PASS/MARG list" : "NO clear positive validation"}`);
if (simplest) {
  L.push(`16. London P&L vs others (${simplest.tp}×${simplest.sl}):`);
  for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    L.push(`    ${sessE(simplest.tp, simplest.sl, simplest.hz, sess)}`);
  }
} else {
  L.push(`16. London vs others: no ref setup`);
}
if (ref) {
  const sup = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, "side_support"));
  const res = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, "side_resistance"));
  L.push(
    `17. LONG vs SHORT: SUP E=${sup ? fmt(sup.sumPnl / Math.max(sup.n, 1)) : "—"} | RES E=${res ? fmt(res.sumPnl / Math.max(res.n, 1)) : "—"}`,
  );
  const rg = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, "type_range"));
  const sw = matrix.get(keyOf(ref.tp, ref.sl, ref.hz, "type_swing"));
  L.push(
    `18. RANGE vs SWING: range E=${rg ? fmt(rg.sumPnl / Math.max(rg.n, 1)) : "—"} PF=${rg ? fmt(pfOf(rg)) : "—"} | swing E=${sw ? fmt(sw.sumPnl / Math.max(sw.n, 1)) : "—"} PF=${sw ? fmt(pfOf(sw)) : "—"}`,
  );
  L.push(`19. Entry penetration: see penetration buckets for reference setup.`);
}
L.push(
  `20. Does 91% behavioral return produce tradable edge? ${verdict === "RETURN_BEHAVIOR_NOT_PROFITABLE" ? "NO — return≠win after spread/SL/TP" : verdict === "EXECUTABLE_EDGE_FOUND" ? "YES — validation edge found" : "MARGINAL — weak/unstable after costs"}`,
);

L.push("\n" + "=".repeat(88));
L.push(`VERDICT: ${verdict}`);
L.push("=".repeat(88));
if (simplest) {
  L.push("SIMPLEST PASSING / BEST MARGINAL SETUP:");
  L.push(`Frozen S/R → break ≥3p → V19 weak body → fade`);
  L.push(`SL = ${simplest.sl} | TP = ${simplest.tp} | horizon = ${simplest.hz}`);
  L.push(
    `validation N=${simplest.val.n} WR=${fmt(pct(simplest.val.wins, simplest.val.n), 1)}% PF=${fmt(pfOf(simplest.val))} E=${fmt(simplest.val.sumPnl / simplest.val.n)} pips/trade`,
  );
  L.push(
    `discovery N=${simplest.disc.n} WR=${fmt(pct(simplest.disc.wins, simplest.disc.n), 1)}% PF=${fmt(pfOf(simplest.disc))} E=${fmt(simplest.disc.sumPnl / simplest.disc.n)} pips/trade`,
  );
} else {
  L.push("No setup met even marginal validation gates.");
  L.push("V19's ~91% return-inside rate does not survive BID/ASK + realistic TP/SL as a profitable fade.");
}

const reportPath = path.join(OUT_DIR, "eurusd-frozen-sr-weak-break-exec-v20-report.txt");
fs.writeFileSync(reportPath, L.join("\n"));
try {
  fs.mkdirSync(path.join(process.cwd(), "research-output"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "research-output", "eurusd-frozen-sr-weak-break-exec-v20-report.txt"),
    L.join("\n"),
  );
} catch {
  /* ignore */
}
console.log(L.join("\n"));
console.log(`\nWrote ${reportPath}`);
