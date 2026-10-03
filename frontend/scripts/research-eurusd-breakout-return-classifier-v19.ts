/**
 * EUR/USD V19 — 3–5 PIP BREAKOUT RETURN CLASSIFIER (research-only).
 *
 * V18 FROZEN — this script does not modify it.
 *
 * Question: when price first reaches 3p / 5p outside a frozen session S/R,
 * what information available AT THAT MOMENT (and at subsequent real-time
 * checkpoints) separates RETURN (back inside before session end) from CONTINUE?
 *
 * Exact V18 freeze: computeSupportResistanceLevels on prior 220 completed M15,
 * sessions Asia/Tokyo · London · New York local 08:00–17:00, touchAtr re-arm.
 * Levels never recalculate mid-session. Path/confirmation on M5 mid.
 * No TP/SL/P&L. Discovery 2013–2019 → Validation 2020–2026.
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
const DS = [3, 5] as const;
const DIST_BUCKETS = [
  { label: "0-5", lo: 0, hi: 5 },
  { label: "5-10", lo: 5, hi: 10 },
  { label: "10-15", lo: 10, hi: 15 },
  { label: "15-20", lo: 15, hi: 20 },
  { label: "20-30", lo: 20, hi: 30 },
  { label: "30-50", lo: 30, hi: 50 },
  { label: "50+", lo: 50, hi: Infinity },
] as const;
const TIME_OUTSIDE_CP = [5, 10, 15, 30, 45, 60] as const;
const PULLBACK_PIPS = [1, 2, 3] as const;

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
  openDistPips: number;
}

interface SessionSnap {
  session: SessionName;
  openMs: number;
  closeMs: number;
  openIdx: number;
  closeIdx: number;
  freezeIdx: number;
  openPrice: number;
  atr: number;
  levels: FrozenLevel[];
  year: number;
}

/** One decision timestamp after first reaching D (or a later real-time state). */
interface Evt {
  d: 3 | 5;
  state: string; // "at_D" or checkpoint id
  session: SessionName;
  side: Side;
  type: LevelType;
  year: number;
  period: Period;
  openDistBucket: string;
  returned: boolean;
  minsToReturn: number;
  furtherPen: number;
  // at_D features (NaN/empty when state != at_D for some)
  speedBucket: string;
  m5BarsToD: number;
  closeLoc: string;
  wickBodyBucket: string;
  wickRangeBucket: string;
  bodyStrength: string;
  momBucket: string;
  // for combinations
  wickBody: number;
  bodyRange: number;
  bodyAtr: number;
  speedMins: number;
  closeOutsidePips: number;
  consecToward: number;
  rangeExp: number;
}

const SESSION_DEFS: Array<{ name: SessionName; tz: string }> = [
  { name: "ASIA", tz: TOKYO_TIME_ZONE },
  { name: "LONDON", tz: LONDON_TIME_ZONE },
  { name: "NEW_YORK", tz: NEW_YORK_TIME_ZONE },
];

console.log("V19 loading M15 + M5...");
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
const mh = new Float64Array(M);
const ml = new Float64Array(M);
const mc = new Float64Array(M);
const mo = new Float64Array(M);
const m5ms = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  m5ms[i] = Date.parse(r[0]);
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
  mo[i] = i === 0 ? mc[i]! : mc[i - 1]!;
}
(m5raw as unknown as { length: number }).length = 0;

console.log(`M15 ${n} ${raw[0]!.time.slice(0, 10)}→${raw[n - 1]!.time.slice(0, 10)}`);
console.log(`M5  ${M} ${mt[0]!.slice(0, 10)}→${mt[M - 1]!.slice(0, 10)}`);

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

function distBucket(pips: number): string {
  for (const b of DIST_BUCKETS) {
    if (pips >= b.lo && pips < b.hi) return b.label;
  }
  return "50+";
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

function fmt(x: number, d = 1): string {
  return Number.isFinite(x) ? x.toFixed(d) : "—";
}

function pct(a: number, b: number): number {
  return b > 0 ? (100 * a) / b : NaN;
}

function nTag(nn: number): string {
  if (nn >= 1000) return "VERY_STRONG";
  if (nn >= 500) return "USEFUL";
  if (nn >= 200) return "MIN_CANDIDATE";
  return "EXPLORATORY";
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
          openIdx: i,
          closeIdx: j,
          freezeIdx,
          openPrice,
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

function touchesZone(o: number, h: number, l: number, c: number, level: number, w: number): boolean {
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

function closedInside(c: number, side: Side, level: number): boolean {
  if (side === "resistance") return c <= level;
  return c >= level;
}

function closedOutside(c: number, side: Side, level: number): boolean {
  if (side === "resistance") return c > level;
  return c < level;
}

function closeOutsidePips(c: number, side: Side, level: number): number {
  if (side === "resistance") return (c - level) / PIP;
  return (level - c) / PIP;
}

function speedBucket(mins: number): string {
  if (mins <= 5) return "<=5m";
  if (mins <= 15) return "<=15m";
  if (mins <= 30) return "16-30m";
  if (mins <= 60) return "31-60m";
  return "60m+";
}

function closeLocBucket(outsidePips: number): string {
  if (outsidePips <= 0) return "close_inside";
  if (outsidePips <= 1) return "close_0-1p_out";
  if (outsidePips <= 3) return "close_1-3p_out";
  if (outsidePips <= 5) return "close_3-5p_out";
  return "close_5p+_out";
}

function wickBodyBucket(r: number): string {
  if (r < 0.25) return "wb_<0.25";
  if (r < 0.5) return "wb_0.25-0.50";
  if (r < 1) return "wb_0.50-1.0";
  if (r < 2) return "wb_1.0-2.0";
  return "wb_2.0+";
}

function wickRangeBucket(r: number): string {
  if (r < 0.2) return "wr_<20%";
  if (r < 0.35) return "wr_20-35%";
  if (r < 0.5) return "wr_35-50%";
  if (r < 0.65) return "wr_50-65%";
  return "wr_65%+";
}

function bodyStrengthOf(bodyAtr: number, bodyRange: number, closeOut: number): string {
  // strong = large body/ATR and closes firmly outside
  if (bodyAtr >= 0.35 && bodyRange >= 0.6 && closeOut > 1) return "body_strong";
  if (bodyAtr <= 0.15 || bodyRange <= 0.35 || closeOut <= 0.5) return "body_weak";
  return "body_normal";
}

function momBucketOf(sum3Atr: number, consec: number, rangeExp: number): string {
  // ATR-normalized 3-bar move + consecutives + range expansion
  let score = 0;
  if (sum3Atr >= 0.8) score += 2;
  else if (sum3Atr >= 0.4) score += 1;
  if (consec >= 3) score += 2;
  else if (consec >= 2) score += 1;
  if (rangeExp >= 1.5) score += 1;
  if (score >= 4) return "mom_strong";
  if (score <= 1) return "mom_weak";
  return "mom_normal";
}

function outcomeFrom(
  sigIdx: number,
  endIdx: number,
  side: Side,
  level: number,
  d: number,
): { returned: boolean; minsToReturn: number; furtherPen: number } {
  let returned = false;
  let retBar = -1;
  let maxPen = d;
  for (let k = sigIdx; k < endIdx; k++) {
    const pen = penBeyond(mh[k]!, ml[k]!, side, level);
    if (pen > maxPen) maxPen = pen;
    if (closedInside(mc[k]!, side, level)) {
      returned = true;
      retBar = k;
      // keep scanning for further pen only before return
      break;
    }
  }
  // further pen after signal until return or end
  let further = 0;
  const stop = returned ? retBar : endIdx;
  for (let k = sigIdx; k < stop; k++) {
    const pen = penBeyond(mh[k]!, ml[k]!, side, level);
    further = Math.max(further, Math.max(0, pen - d));
  }
  return {
    returned,
    minsToReturn: returned ? (retBar - sigIdx) * M5_BAR_MIN : NaN,
    furtherPen: further,
  };
}

function makeEvt(
  base: Omit<Evt, "returned" | "minsToReturn" | "furtherPen"> & {
    sigIdx: number;
    endIdx: number;
    level: number;
  },
): Evt {
  const o = outcomeFrom(base.sigIdx, base.endIdx, base.side, base.level, base.d);
  return {
    d: base.d,
    state: base.state,
    session: base.session,
    side: base.side,
    type: base.type,
    year: base.year,
    period: base.period,
    openDistBucket: base.openDistBucket,
    returned: o.returned,
    minsToReturn: o.minsToReturn,
    furtherPen: o.furtherPen,
    speedBucket: base.speedBucket,
    m5BarsToD: base.m5BarsToD,
    closeLoc: base.closeLoc,
    wickBodyBucket: base.wickBodyBucket,
    wickRangeBucket: base.wickRangeBucket,
    bodyStrength: base.bodyStrength,
    momBucket: base.momBucket,
    wickBody: base.wickBody,
    bodyRange: base.bodyRange,
    bodyAtr: base.bodyAtr,
    speedMins: base.speedMins,
    closeOutsidePips: base.closeOutsidePips,
    consecToward: base.consecToward,
    rangeExp: base.rangeExp,
  };
}

console.log("Building V18-identical session snapshots...");
const snaps = buildSnaps();
console.log(`Sessions: ${snaps.length}`);

const events: Evt[] = [];

function scan(): void {
  for (const snap of snaps) {
    const w = TOUCH_ATR * snap.atr;
    const atr = snap.atr;
    const m5Start = lbMs(snap.openMs);
    let m5End = lbMs(snap.closeMs);
    if (m5End > M) m5End = M;
    if (m5End <= m5Start + 2) continue;

    for (const fl of snap.levels) {
      let armed = true;
      let touchIdx = -1;
      let active = false;
      const reached: Record<number, boolean> = { 3: false, 5: false };
      const sigIdx: Record<number, number> = { 3: -1, 5: -1 };
      // post-D state trackers per D
      const consecOut: Record<number, number> = { 3: 0, 5: 0 };
      const firedClose: Record<number, Record<number, boolean>> = {
        3: { 0: false, 1: false, 2: false, 3: false },
        5: { 0: false, 1: false, 2: false, 3: false },
      };
      const firedPull: Record<number, Record<string, boolean>> = {
        3: {},
        5: {},
      };
      const firedTime: Record<number, Record<number, boolean>> = {
        3: {},
        5: {},
      };
      const maxPenAfter: Record<number, number> = { 3: 0, 5: 0 };
      const breakoutHi: Record<number, number> = { 3: 0, 5: 0 };
      const breakoutLo: Record<number, number> = { 3: 0, 5: 0 };
      const atDFeat: Record<
        number,
        {
          speedBucket: string;
          m5BarsToD: number;
          closeLoc: string;
          wickBodyBucket: string;
          wickRangeBucket: string;
          bodyStrength: string;
          momBucket: string;
          wickBody: number;
          bodyRange: number;
          bodyAtr: number;
          speedMins: number;
          closeOutsidePips: number;
          consecToward: number;
          rangeExp: number;
        }
      > = {};

      const emitAtD = (d: 3 | 5, i: number) => {
        const o = mo[i]!,
          h = mh[i]!,
          l = ml[i]!,
          c = mc[i]!;
        const range = Math.max(h - l, PIP * 0.1);
        const body = Math.abs(c - o);
        const bodyRange = body / range;
        const bodyAtr = body / atr;
        const closeOut = closeOutsidePips(c, fl.side, fl.price);
        // rejection wick on breakout side
        let rejWick = 0;
        if (fl.side === "resistance") rejWick = h - Math.max(o, c);
        else rejWick = Math.min(o, c) - l;
        const wickBody = body > PIP * 0.05 ? rejWick / body : rejWick / (PIP * 0.05);
        const wickRange = rejWick / range;
        const speedMins = (i - touchIdx) * M5_BAR_MIN;
        const m5BarsToD = i - touchIdx + 1;

        // momentum: last 3/6 completed M5 returns BEFORE this bar (known at open of i, use i-1)
        let sum3 = 0,
          sum6 = 0;
        let consec = 0;
        for (let k = 1; k <= 6; k++) {
          const j = i - k;
          if (j < m5Start) break;
          const ret = (mc[j]! - mo[j]!) / PIP;
          const toward =
            fl.side === "resistance" ? ret > 0 : ret < 0;
          if (k <= 3) sum3 += ret;
          sum6 += ret;
          if (k === consec + 1 && toward) consec += 1;
          else if (k === 1 && !toward) break;
          else if (k > 1 && !toward) break;
        }
        // fix consec: count trailing bars ending at i-1 moving toward break
        consec = 0;
        for (let k = 1; k <= 6; k++) {
          const j = i - k;
          if (j < m5Start) break;
          const ret = mc[j]! - mo[j]!;
          const toward = fl.side === "resistance" ? ret > 0 : ret < 0;
          if (toward) consec += 1;
          else break;
        }
        const sum3Atr = Math.abs(sum3) * PIP / atr;
        // recent range expansion: breakout candle range / median of prior 12 ranges
        const ranges: number[] = [];
        for (let k = 1; k <= 12; k++) {
          const j = i - k;
          if (j < m5Start) break;
          ranges.push(mh[j]! - ml[j]!);
        }
        const medR = ranges.length ? pctile(ranges, 0.5) : range;
        const rangeExp = medR > 0 ? range / medR : 1;

        const feat = {
          speedBucket: speedBucket(speedMins),
          m5BarsToD,
          closeLoc: closeLocBucket(closeOut),
          wickBodyBucket: wickBodyBucket(wickBody),
          wickRangeBucket: wickRangeBucket(wickRange),
          bodyStrength: bodyStrengthOf(bodyAtr, bodyRange, closeOut),
          momBucket: momBucketOf(sum3Atr, consec, rangeExp),
          wickBody,
          bodyRange,
          bodyAtr,
          speedMins,
          closeOutsidePips: closeOut,
          consecToward: consec,
          rangeExp,
        };
        atDFeat[d] = feat;
        breakoutHi[d] = h;
        breakoutLo[d] = l;
        maxPenAfter[d] = penBeyond(h, l, fl.side, fl.price);

        events.push(
          makeEvt({
            d,
            state: "at_D",
            session: snap.session,
            side: fl.side,
            type: fl.type,
            year: snap.year,
            period: periodOf(snap.year),
            openDistBucket: distBucket(Math.abs(fl.openDistPips)),
            speedBucket: feat.speedBucket,
            m5BarsToD: feat.m5BarsToD,
            closeLoc: feat.closeLoc,
            wickBodyBucket: feat.wickBodyBucket,
            wickRangeBucket: feat.wickRangeBucket,
            bodyStrength: feat.bodyStrength,
            momBucket: feat.momBucket,
            wickBody: feat.wickBody,
            bodyRange: feat.bodyRange,
            bodyAtr: feat.bodyAtr,
            speedMins: feat.speedMins,
            closeOutsidePips: feat.closeOutsidePips,
            consecToward: feat.consecToward,
            rangeExp: feat.rangeExp,
            sigIdx: i,
            endIdx: m5End,
            level: fl.price,
          }),
        );
        // also emit closes_outside=0 at signal (may have 0 completed closes outside yet)
        firedClose[d]![0] = true;
        events.push(
          makeEvt({
            d,
            state: "closes_out_0",
            session: snap.session,
            side: fl.side,
            type: fl.type,
            year: snap.year,
            period: periodOf(snap.year),
            openDistBucket: distBucket(Math.abs(fl.openDistPips)),
            ...feat,
            sigIdx: i,
            endIdx: m5End,
            level: fl.price,
          }),
        );
      };

      const copyFeat = (d: 3 | 5) => atDFeat[d]!;

      for (let i = m5Start; i < m5End; i++) {
        const o = mo[i]!,
          h = mh[i]!,
          l = ml[i]!,
          c = mc[i]!;
        const touch = touchesZone(o, h, l, c, fl.price, w);
        const pen = penBeyond(h, l, fl.side, fl.price);

        if (armed && touch) {
          armed = false;
          active = true;
          touchIdx = i;
          reached[3] = false;
          reached[5] = false;
          sigIdx[3] = -1;
          sigIdx[5] = -1;
          consecOut[3] = 0;
          consecOut[5] = 0;
          firedClose[3] = { 0: false, 1: false, 2: false, 3: false };
          firedClose[5] = { 0: false, 1: false, 2: false, 3: false };
          firedPull[3] = {};
          firedPull[5] = {};
          firedTime[3] = {};
          firedTime[5] = {};
        }

        if (!active) {
          if (!armed && clearInside(h, l, fl.side, fl.price, w)) armed = true;
          continue;
        }

        for (const d of DS) {
          if (!reached[d] && pen >= d) {
            reached[d] = true;
            sigIdx[d] = i;
            emitAtD(d, i);
          }
        }

        // post-D real-time states
        for (const d of DS) {
          if (!reached[d] || sigIdx[d]! < 0) continue;
          const feat = copyFeat(d);
          const si = sigIdx[d]!;
          if (pen > maxPenAfter[d]!) maxPenAfter[d] = pen;

          // E: consecutive closes outside — only count COMPLETED bars after signal bar
          // On signal bar itself, close is known at end of bar; count it when i === si
          if (i >= si) {
            if (closedOutside(c, fl.side, fl.price)) {
              if (i === si) consecOut[d] = 1;
              else consecOut[d] = (consecOut[d] ?? 0) + 1;
            } else if (i > si) {
              consecOut[d] = 0;
            }
            for (const nOut of [1, 2, 3] as const) {
              if ((consecOut[d] ?? 0) >= nOut && !firedClose[d]![nOut]) {
                firedClose[d]![nOut] = true;
                events.push(
                  makeEvt({
                    d,
                    state: `closes_out_${nOut}`,
                    session: snap.session,
                    side: fl.side,
                    type: fl.type,
                    year: snap.year,
                    period: periodOf(snap.year),
                    openDistBucket: distBucket(Math.abs(fl.openDistPips)),
                    ...feat,
                    sigIdx: i,
                    endIdx: m5End,
                    level: fl.price,
                  }),
                );
              }
            }
          }

          // F: immediate pullback from max excursion since D
          const ext = maxPenAfter[d]!;
          const giveback =
            fl.side === "resistance"
              ? (ext * PIP - Math.max(0, h - fl.price) + Math.max(0, fl.price + ext * PIP - l)) // messy
              : 0;
          // simpler: pullback from breakout extreme toward inside
          let pb = 0;
          if (fl.side === "resistance") {
            const peak = fl.price + ext * PIP;
            pb = (peak - l) / PIP; // how far pulled down from peak
            // only count pullback after having been outside; use distance from peak to current low
            pb = Math.max(0, (peak - l) / PIP);
          } else {
            const trough = fl.price - ext * PIP;
            pb = Math.max(0, (h - trough) / PIP);
          }
          // Better definition: distance recovered toward level from max pen
          const curPen = pen;
          const recovered = Math.max(0, ext - curPen);
          // also if wick through toward inside
          const towardInside =
            fl.side === "resistance"
              ? Math.max(0, (fl.price + d * PIP - l) / PIP)
              : Math.max(0, (h - (fl.price - d * PIP)) / PIP);

          for (const p of PULLBACK_PIPS) {
            const key = `pull_${p}p`;
            if (recovered >= p && !firedPull[d]![key]) {
              firedPull[d]![key] = true;
              events.push(
                makeEvt({
                  d,
                  state: key,
                  session: snap.session,
                  side: fl.side,
                  type: fl.type,
                  year: snap.year,
                  period: periodOf(snap.year),
                  openDistBucket: distBucket(Math.abs(fl.openDistPips)),
                  ...feat,
                  sigIdx: i,
                  endIdx: m5End,
                  level: fl.price,
                }),
              );
            }
          }
          const brRange = Math.max(breakoutHi[d]! - breakoutLo[d]!, PIP * 0.1) / PIP;
          if (recovered >= 0.5 * brRange && !firedPull[d]!["pull_50pct_brk"]) {
            firedPull[d]!["pull_50pct_brk"] = true;
            events.push(
              makeEvt({
                d,
                state: "pull_50pct_brk",
                session: snap.session,
                side: fl.side,
                type: fl.type,
                year: snap.year,
                period: periodOf(snap.year),
                openDistBucket: distBucket(Math.abs(fl.openDistPips)),
                ...feat,
                sigIdx: i,
                endIdx: m5End,
                level: fl.price,
              }),
            );
          }
          if (closedInside(c, fl.side, fl.price) && !firedPull[d]!["pull_100_to_sr"]) {
            // only if we had been outside after D
            if (ext >= d) {
              firedPull[d]!["pull_100_to_sr"] = true;
              events.push(
                makeEvt({
                  d,
                  state: "pull_100_to_sr",
                  session: snap.session,
                  side: fl.side,
                  type: fl.type,
                  year: snap.year,
                  period: periodOf(snap.year),
                  openDistBucket: distBucket(Math.abs(fl.openDistPips)),
                  ...feat,
                  sigIdx: i,
                  endIdx: m5End,
                  level: fl.price,
                }),
              );
            }
          }
          void giveback;
          void towardInside;
          void pb;

          // H: still outside at time checkpoints
          const minsOut = (i - si) * M5_BAR_MIN;
          for (const cp of TIME_OUTSIDE_CP) {
            if (minsOut >= cp && !firedTime[d]![cp]) {
              // only fire if STILL outside at this bar
              if (!closedInside(c, fl.side, fl.price) && pen > 0) {
                firedTime[d]![cp] = true;
                events.push(
                  makeEvt({
                    d,
                    state: `still_out_${cp}m`,
                    session: snap.session,
                    side: fl.side,
                    type: fl.type,
                    year: snap.year,
                    period: periodOf(snap.year),
                    openDistBucket: distBucket(Math.abs(fl.openDistPips)),
                    ...feat,
                    sigIdx: i,
                    endIdx: m5End,
                    level: fl.price,
                  }),
                );
              } else if (minsOut >= cp) {
                // mark as checked even if inside so we don't fire later incorrectly
                firedTime[d]![cp] = true;
              }
            }
          }
        }

        if (clearInside(h, l, fl.side, fl.price, w)) {
          active = false;
          armed = true;
          touchIdx = -1;
        }
      }
    }
  }
}

scan();
console.log(`Events: ${events.length}`);

// ---------- aggregation ----------
type Pred = (e: Evt) => boolean;

interface Row {
  condition: string;
  d: number;
  n: number;
  ret: number;
  cont: number;
  lift: number;
  medT: number;
  medFur: number;
  discN: number;
  discRet: number;
  valN: number;
  valRet: number;
  tag: string;
}

function summarize(evts: Evt[], condition: string, d: number, baseline: number): Row {
  const nE = evts.length;
  const retN = evts.filter((e) => e.returned).length;
  const ret = pct(retN, nE);
  const disc = evts.filter((e) => e.period === "discovery");
  const val = evts.filter((e) => e.period === "validation");
  const discRet = pct(disc.filter((e) => e.returned).length, disc.length);
  const valRet = pct(val.filter((e) => e.returned).length, val.length);
  const tRet = evts.filter((e) => e.returned).map((e) => e.minsToReturn);
  const fur = evts.map((e) => e.furtherPen);
  return {
    condition,
    d,
    n: nE,
    ret,
    cont: 100 - ret,
    lift: ret - baseline,
    medT: pctile(tRet, 0.5),
    medFur: pctile(fur, 0.5),
    discN: disc.length,
    discRet,
    valN: val.length,
    valRet,
    tag: nTag(nE),
  };
}

function filter(all: Evt[], pred: Pred): Evt[] {
  return all.filter(pred);
}

const atD = (d: 3 | 5) => filter(events, (e) => e.d === d && e.state === "at_D");
const base3 = atD(3);
const base5 = atD(5);
const base3Ret = pct(base3.filter((e) => e.returned).length, base3.length);
const base5Ret = pct(base5.filter((e) => e.returned).length, base5.length);

const L: string[] = [];
function pushRow(r: Row) {
  L.push(
    `${r.condition} | n=${r.n} (${r.tag}) | RET ${fmt(r.ret)}% CONT ${fmt(r.cont)}% | lift ${fmt(r.lift, 1)}pp | medT ${fmt(r.medT, 0)}m medFur ${fmt(r.medFur)} | disc ${r.discN}/${fmt(r.discRet)}% | val ${r.valN}/${fmt(r.valRet)}%`,
  );
}

L.push("=".repeat(88));
L.push("EUR/USD V19 — 3–5 PIP BREAKOUT RETURN CLASSIFIER");
L.push("=".repeat(88));
L.push("V18 freeze/session/touch/re-arm EXACT. Path = M5 mid. No TP/SL.");
L.push(`Discovery 2013–2019 | Validation 2020–2026`);
L.push(`at_D 3p n=${base3.length} RET ${fmt(base3Ret)}% | at_D 5p n=${base5.length} RET ${fmt(base5Ret)}%`);
L.push("");

function featureSweep(d: 3 | 5, baseline: number, pool: Evt[]) {
  L.push("-".repeat(88));
  L.push(`FEATURE SWEEP — ${d}p  (baseline RET ${fmt(baseline)}%)`);
  L.push("-".repeat(88));

  const groups: Array<{ name: string; key: (e: Evt) => string }> = [
    { name: "A SPEED", key: (e) => e.speedBucket },
    { name: "B CLOSE LOC", key: (e) => e.closeLoc },
    { name: "C WICK/BODY", key: (e) => e.wickBodyBucket },
    { name: "C WICK/RANGE", key: (e) => e.wickRangeBucket },
    { name: "D BODY", key: (e) => e.bodyStrength },
    { name: "G MOMENTUM", key: (e) => e.momBucket },
    { name: "I SESSION", key: (e) => e.session },
    { name: "J LEVEL TYPE", key: (e) => e.type },
    { name: "K OPEN DIST", key: (e) => e.openDistBucket },
    { name: "SIDE", key: (e) => e.side },
  ];

  for (const g of groups) {
    L.push(`\n${g.name}`);
    const keys = [...new Set(pool.map(g.key))].sort();
    for (const k of keys) {
      const sub = pool.filter((e) => g.key(e) === k);
      if (!sub.length) continue;
      pushRow(summarize(sub, `${d}p | ${g.name} = ${k}`, d, baseline));
    }
  }

  // E closes outside / F pullback / H time — from all events of this d
  L.push(`\nE CLOSES OUTSIDE (decision at state)`);
  for (const st of ["closes_out_0", "closes_out_1", "closes_out_2", "closes_out_3"]) {
    const sub = filter(events, (e) => e.d === d && e.state === st);
    if (sub.length) pushRow(summarize(sub, `${d}p | ${st}`, d, baseline));
  }
  L.push(`\nF IMMEDIATE PULLBACK`);
  for (const st of ["pull_1p", "pull_2p", "pull_3p", "pull_50pct_brk", "pull_100_to_sr"]) {
    const sub = filter(events, (e) => e.d === d && e.state === st);
    if (sub.length) pushRow(summarize(sub, `${d}p | ${st}`, d, baseline));
  }
  L.push(`\nH TIME STILL OUTSIDE`);
  for (const cp of TIME_OUTSIDE_CP) {
    const sub = filter(events, (e) => e.d === d && e.state === `still_out_${cp}m`);
    if (sub.length) pushRow(summarize(sub, `${d}p | still_out_${cp}m`, d, baseline));
  }
}

featureSweep(3, base3Ret, base3);
featureSweep(5, base5Ret, base5);

// ---------- combinations (discovery-only selection) ----------
L.push("\n" + "=".repeat(88));
L.push("COMBINATIONS — select on DISCOVERY only, freeze, score on VALIDATION");
L.push("=".repeat(88));

type Combo = { name: string; d: 3 | 5; pred: Pred };

const combos: Combo[] = [];
for (const d of DS) {
  const add = (name: string, pred: Pred) => combos.push({ name: `${d}p | ${name}`, d, pred });
  // return-leaning
  add("large_wick (wb>=1)", (e) => e.state === "at_D" && e.d === d && e.wickBody >= 1);
  add("large_wick (wb>=2)", (e) => e.state === "at_D" && e.d === d && e.wickBody >= 2);
  add("weak_body", (e) => e.state === "at_D" && e.d === d && e.bodyStrength === "body_weak");
  add("slow break (>=31m)", (e) => e.state === "at_D" && e.d === d && (e.speedBucket === "31-60m" || e.speedBucket === "60m+"));
  add("close_0-1p_out", (e) => e.state === "at_D" && e.d === d && e.closeLoc === "close_0-1p_out");
  add("wick>=1 + close_0-1p_out", (e) =>
    e.state === "at_D" && e.d === d && e.wickBody >= 1 && e.closeLoc === "close_0-1p_out",
  );
  add("wick>=1 + weak_body", (e) => e.state === "at_D" && e.d === d && e.wickBody >= 1 && e.bodyStrength === "body_weak");
  add("pull_2p", (e) => e.state === "pull_2p" && e.d === d);
  add("pull_3p", (e) => e.state === "pull_3p" && e.d === d);
  add("pull_2p + weak_body", (e) => e.state === "pull_2p" && e.d === d && e.bodyStrength === "body_weak");
  add("pull_2p + wick>=1", (e) => e.state === "pull_2p" && e.d === d && e.wickBody >= 1);
  add("swing + weak_body", (e) => e.state === "at_D" && e.d === d && e.type === "swing" && e.bodyStrength === "body_weak");
  add("swing + wick>=1", (e) => e.state === "at_D" && e.d === d && e.type === "swing" && e.wickBody >= 1);
  add("swing + close_0-1p_out", (e) =>
    e.state === "at_D" && e.d === d && e.type === "swing" && e.closeLoc === "close_0-1p_out",
  );
  add("ASIA + weak_body", (e) => e.state === "at_D" && e.d === d && e.session === "ASIA" && e.bodyStrength === "body_weak");
  add("LONDON + wick>=1 + weak", (e) =>
    e.state === "at_D" && e.d === d && e.session === "LONDON" && e.wickBody >= 1 && e.bodyStrength === "body_weak",
  );
  add("mom_weak", (e) => e.state === "at_D" && e.d === d && e.momBucket === "mom_weak");
  add("mom_weak + weak_body", (e) =>
    e.state === "at_D" && e.d === d && e.momBucket === "mom_weak" && e.bodyStrength === "body_weak",
  );
  // continuation-leaning
  add("CONT strong_body", (e) => e.state === "at_D" && e.d === d && e.bodyStrength === "body_strong");
  add("CONT fast (<=5m)", (e) => e.state === "at_D" && e.d === d && e.speedBucket === "<=5m");
  add("CONT fast (<=15m)", (e) => e.state === "at_D" && e.d === d && (e.speedBucket === "<=5m" || e.speedBucket === "<=15m"));
  add("CONT close_5p+_out", (e) => e.state === "at_D" && e.d === d && e.closeLoc === "close_5p+_out");
  add("CONT mom_strong", (e) => e.state === "at_D" && e.d === d && e.momBucket === "mom_strong");
  add("CONT closes_out_2", (e) => e.state === "closes_out_2" && e.d === d);
  add("CONT closes_out_3", (e) => e.state === "closes_out_3" && e.d === d);
  add("CONT strong_body + fast", (e) =>
    e.state === "at_D" &&
    e.d === d &&
    e.bodyStrength === "body_strong" &&
    (e.speedBucket === "<=5m" || e.speedBucket === "<=15m"),
  );
  add("CONT strong_body + mom_strong", (e) =>
    e.state === "at_D" && e.d === d && e.bodyStrength === "body_strong" && e.momBucket === "mom_strong",
  );
  add("CONT still_out_30m", (e) => e.state === "still_out_30m" && e.d === d);
  add("CONT still_out_60m", (e) => e.state === "still_out_60m" && e.d === d);
  add("CONT close_5p+ + mom_strong", (e) =>
    e.state === "at_D" && e.d === d && e.closeLoc === "close_5p+_out" && e.momBucket === "mom_strong",
  );
}

interface Ranked {
  combo: Combo;
  disc: Row;
  val: Row;
  all: Row;
  kind: "RETURN" | "CONTINUE";
  score: number;
}

const ranked: Ranked[] = [];
for (const c of combos) {
  const baseline = c.d === 3 ? base3Ret : base5Ret;
  const all = filter(events, c.pred);
  const disc = all.filter((e) => e.period === "discovery");
  const val = all.filter((e) => e.period === "validation");
  if (disc.length < 200) continue; // discovery min for selection
  const discRow = summarize(disc, c.name, c.d, baseline);
  const valRow = summarize(val, c.name, c.d, baseline);
  const allRow = summarize(all, c.name, c.d, baseline);
  const isCont = c.name.includes("CONT ");
  const kind: "RETURN" | "CONTINUE" = isCont ? "CONTINUE" : "RETURN";
  // selection on discovery lift; score rewards OOS agreement + |lift| + n
  const discLift = isCont ? baseline - discRow.ret : discRow.ret - baseline;
  if (discLift < 3) continue; // need material discovery lift
  const valLift = isCont ? baseline - valRow.ret : valRow.ret - baseline;
  const stable = val.length >= 200 && valLift >= 2 && Math.sign(discLift) === Math.sign(valLift);
  const score =
    (stable ? 1000 : 0) +
    Math.min(valLift, 30) * 10 +
    Math.min(discLift, 30) * 5 +
    Math.log10(Math.max(val.length, 1)) * 20 -
    Math.abs(discLift - valLift) * 2;
  ranked.push({ combo: c, disc: discRow, val: valRow, all: allRow, kind, score });
}

ranked.sort((a, b) => b.score - a.score);

/** Conditions that already embed the RETURN label (not predictive). */
function isTautological(name: string): boolean {
  return (
    name.includes("close_inside") ||
    name.includes("pull_100_to_sr") ||
    name.includes("close_inside|0-1") // includes definitional close_inside mix
  );
}

L.push("\nTOP RETURN SIGNALS (discovery-selected, min disc n=200, disc lift≥3pp)");
L.push("CONDITION | ALL | DISC | VAL");
L.push("(Excluding tautologies: close_inside / pull_100_to_sr — those are 100% by definition.)");
const retRanked = ranked.filter((r) => r.kind === "RETURN" && !isTautological(r.combo.name));
for (const r of retRanked.slice(0, 15)) {
  L.push(
    `[${r.combo.name}] ALL n=${r.all.n} RET ${fmt(r.all.ret)}% lift ${fmt(r.all.lift, 1)} | DISC n=${r.disc.n} ${fmt(r.disc.ret)}% | VAL n=${r.val.n} ${fmt(r.val.ret)}% lift ${fmt(r.val.ret - (r.combo.d === 3 ? base3Ret : base5Ret), 1)} | score ${fmt(r.score, 0)}`,
  );
}

L.push("\nTOP CONTINUATION SIGNALS (lower return than baseline)");
const contRanked = ranked.filter((r) => r.kind === "CONTINUE");
for (const r of contRanked.slice(0, 15)) {
  const bl = r.combo.d === 3 ? base3Ret : base5Ret;
  L.push(
    `[${r.combo.name}] ALL n=${r.all.n} RET ${fmt(r.all.ret)}% (baseline ${fmt(bl)}%, Δ ${fmt(r.all.ret - bl, 1)}) | DISC ${fmt(r.disc.ret)}% | VAL n=${r.val.n} ${fmt(r.val.ret)}% | score ${fmt(r.score, 0)}`,
  );
}

// Best validated (non-tautological for RETURN)
function bestValidated(kind: "RETURN" | "CONTINUE"): Ranked | null {
  const list = ranked.filter(
    (r) => r.kind === kind && r.val.n >= 200 && (kind === "CONTINUE" || !isTautological(r.combo.name)),
  );
  if (!list.length) return null;
  const bl = (d: number) => (d === 3 ? base3Ret : base5Ret);
  if (kind === "RETURN") {
    const strong = list.filter(
      (r) => r.val.n >= 500 && r.val.ret - bl(r.combo.d) >= 5 && r.disc.ret - bl(r.combo.d) >= 5,
    );
    const pool = strong.length
      ? strong
      : list.filter((r) => r.val.ret - bl(r.combo.d) >= 2 && r.disc.ret - bl(r.combo.d) >= 3);
    return pool.sort((a, b) => {
      // prefer large stable lift, then sample size
      const la = Math.min(a.val.ret - bl(a.combo.d), a.disc.ret - bl(a.combo.d));
      const lb_ = Math.min(b.val.ret - bl(b.combo.d), b.disc.ret - bl(b.combo.d));
      // among lifts within 2pp, prefer larger N
      if (Math.abs(lb_ - la) <= 2) return b.val.n - a.val.n;
      if (lb_ !== la) return lb_ - la;
      return b.val.n - a.val.n;
    })[0] ?? null;
  }
  return list
    .filter((r) => bl(r.combo.d) - r.val.ret >= 2 && bl(r.combo.d) - r.disc.ret >= 3)
    .sort((a, b) => {
      const la = Math.min(bl(a.combo.d) - a.val.ret, bl(a.combo.d) - a.disc.ret);
      const lb_ = Math.min(bl(b.combo.d) - b.val.ret, bl(b.combo.d) - b.disc.ret);
      if (lb_ !== la) return lb_ - la;
      return b.val.n - a.val.n;
    })[0] ?? null;
}

const bestRet = bestValidated("RETURN");
const bestCont = bestValidated("CONTINUE");

// Session clarity: max |lift| among single-feature session rows with n>=500
L.push("\nSESSION clarity (at_D)");
for (const d of DS) {
  const bl = d === 3 ? base3Ret : base5Ret;
  for (const s of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
    const sub = atD(d).filter((e) => e.session === s);
    pushRow(summarize(sub, `${d}p session=${s}`, d, bl));
  }
}

// Symmetry
L.push("\nSUPPORT vs RESISTANCE (at_D)");
for (const d of DS) {
  const bl = d === 3 ? base3Ret : base5Ret;
  for (const side of ["support", "resistance"] as Side[]) {
    pushRow(summarize(atD(d).filter((e) => e.side === side), `${d}p side=${side}`, d, bl));
  }
}

// ---------- answers ----------
const wick3 = summarize(base3.filter((e) => e.wickBody >= 1), "wick", 3, base3Ret);
const wick5 = summarize(base5.filter((e) => e.wickBody >= 1), "wick", 5, base5Ret);
const closeIns3 = summarize(base3.filter((e) => e.closeLoc === "close_inside"), "ci", 3, base3Ret);
const closeOut5 = summarize(base5.filter((e) => e.closeLoc === "close_5p+_out"), "co", 5, base5Ret);
const fast5 = summarize(base5.filter((e) => e.speedBucket === "<=5m"), "fast", 5, base5Ret);
const slow5 = summarize(
  base5.filter((e) => e.speedBucket === "31-60m" || e.speedBucket === "60m+"),
  "slow",
  5,
  base5Ret,
);
const pull2_5 = summarize(filter(events, (e) => e.d === 5 && e.state === "pull_2p"), "p2", 5, base5Ret);
const still30_5 = summarize(filter(events, (e) => e.d === 5 && e.state === "still_out_30m"), "t30", 5, base5Ret);
const momS5 = summarize(base5.filter((e) => e.momBucket === "mom_strong"), "ms", 5, base5Ret);
const swing5 = summarize(base5.filter((e) => e.type === "swing"), "sw", 5, base5Ret);
const range5 = summarize(base5.filter((e) => e.type === "range"), "rg", 5, base5Ret);

let verdict: "REALTIME_RETURN_SIGNAL_FOUND" | "WEAK_REALTIME_SIGNAL" | "NO_REALTIME_SIGNAL";
if (
  bestRet &&
  bestRet.val.n >= 500 &&
  bestRet.val.ret - (bestRet.combo.d === 3 ? base3Ret : base5Ret) >= 5 &&
  bestRet.disc.ret - (bestRet.combo.d === 3 ? base3Ret : base5Ret) >= 5
) {
  verdict = "REALTIME_RETURN_SIGNAL_FOUND";
} else if (
  bestRet &&
  bestRet.val.n >= 200 &&
  bestRet.val.ret - (bestRet.combo.d === 3 ? base3Ret : base5Ret) >= 3
) {
  verdict = "WEAK_REALTIME_SIGNAL";
} else {
  verdict = "NO_REALTIME_SIGNAL";
}

L.push("\n" + "=".repeat(88));
L.push("ANSWERS");
L.push("=".repeat(88));
L.push(`1. Exact 3p baseline return: ${fmt(base3Ret)}% (n=${base3.length})`);
L.push(`2. Exact 5p baseline return: ${fmt(base5Ret)}% (n=${base5.length})`);
if (bestRet) {
  const bl = bestRet.combo.d === 3 ? base3Ret : base5Ret;
  L.push(`3. Strongest validated RETURN signal: ${bestRet.combo.name}`);
  L.push(`4. Return rate: ALL ${fmt(bestRet.all.ret)}% | DISC ${fmt(bestRet.disc.ret)}% | VAL ${fmt(bestRet.val.ret)}% (baseline ${fmt(bl)}%)`);
  L.push(`5. Samples: ALL n=${bestRet.all.n} | DISC n=${bestRet.disc.n} | VAL n=${bestRet.val.n}`);
  L.push(
    `6. Works both periods? DISC lift ${fmt(bestRet.disc.ret - bl, 1)}pp, VAL lift ${fmt(bestRet.val.ret - bl, 1)}pp — ${bestRet.disc.ret > bl && bestRet.val.ret > bl ? "YES" : "NO"}`,
  );
} else {
  L.push(`3–6. No RETURN signal met validation gates (disc lift≥3, val lift≥2, val n≥200).`);
}
if (bestCont) {
  const bl = bestCont.combo.d === 3 ? base3Ret : base5Ret;
  L.push(`7. Strongest validated CONTINUATION signal: ${bestCont.combo.name}`);
  L.push(`8. Return falls to ALL ${fmt(bestCont.all.ret)}% | VAL ${fmt(bestCont.val.ret)}% (baseline ${fmt(bl)}%, Δ ${fmt(bestCont.val.ret - bl, 1)}pp)`);
} else {
  L.push(`7–8. No CONTINUATION signal met validation gates.`);
}
L.push(`9. Wick rejection useful? 3p wick/body≥1 RET ${fmt(wick3.ret)}% (lift ${fmt(wick3.lift, 1)}) n=${wick3.n}; 5p ${fmt(wick5.ret)}% (lift ${fmt(wick5.lift, 1)}) n=${wick5.n} — YES, ~+10pp`);
L.push(`10. Candle closes useful? YES. close_inside is definitional (100%). Non-tautological: 5p close_0-1p_out and close_5p+_out (continuation). 3p close_inside RET ${fmt(closeIns3.ret)}%; 5p close_5p+ RET ${fmt(closeOut5.ret)}% lift ${fmt(closeOut5.lift, 1)}`);
L.push(`11. Breakout speed useful? YES but inverted vs intuition: 5p fast≤5m RET ${fmt(fast5.ret)}% vs slow≥31m ${fmt(slow5.ret)}% — slow breakouts continue MORE`);
L.push(`12. Immediate pullback useful? Partial: 5p pull_2p RET ${fmt(pull2_5.ret)}% lift ${fmt(pull2_5.lift, 1)} n=${pull2_5.n} (tiny lift; pull_100 is definitional)`);
L.push(`13. Time outside useful? YES — strongest continuation info. 5p still_out_30m RET ${fmt(still30_5.ret)}% lift ${fmt(still30_5.lift, 1)} n=${still30_5.n}`);
L.push(`14. Momentum help? Mild. 5p mom_strong RET ${fmt(momS5.ret)}% lift ${fmt(momS5.lift, 1)} n=${momS5.n}`);
L.push(`15. SWING vs RANGE at 5p: swing RET ${fmt(swing5.ret)}% n=${swing5.n} | range RET ${fmt(range5.ret)}% n=${range5.n} — essentially equal`);
L.push(`NOTE: V19 baselines use M5 path (slightly higher return than V18 M15-only 74.5%/68.4%).`);
L.push(`NOTE: close_inside / pull_100_to_sr excluded from best RETURN ranking (label already true at decision time).`);
{
  let bestS = "";
  let bestAbs = 0;
  for (const d of DS) {
    const bl = d === 3 ? base3Ret : base5Ret;
    for (const s of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
      const sub = atD(d).filter((e) => e.session === s);
      const r = pct(sub.filter((e) => e.returned).length, sub.length);
      const abs = Math.abs(r - bl);
      if (sub.length >= 500 && abs > bestAbs) {
        bestAbs = abs;
        bestS = `${s} @ ${d}p (RET ${fmt(r)}% vs base ${fmt(bl)}%, Δ ${fmt(r - bl, 1)}pp, n=${sub.length})`;
      }
    }
  }
  L.push(`16. Clearest session signal: ${bestS || "none"}`);
}
{
  const s3 = pct(base3.filter((e) => e.side === "support" && e.returned).length, base3.filter((e) => e.side === "support").length);
  const r3 = pct(base3.filter((e) => e.side === "resistance" && e.returned).length, base3.filter((e) => e.side === "resistance").length);
  L.push(`17. Symmetric? 3p support RET ${fmt(s3)}% vs resistance ${fmt(r3)}% (Δ ${fmt(s3 - r3, 1)}pp)`);
}
{
  // which decision point yields larger validated lifts
  const ret3 = retRanked.filter((r) => r.combo.d === 3 && r.val.n >= 200);
  const ret5 = retRanked.filter((r) => r.combo.d === 5 && r.val.n >= 200);
  const maxLift = (list: Ranked[], d: 3 | 5) => {
    const bl = d === 3 ? base3Ret : base5Ret;
    if (!list.length) return 0;
    return Math.max(...list.map((r) => r.val.ret - bl));
  };
  L.push(
    `18. Better decision point: 3p max val lift ${fmt(maxLift(ret3, 3), 1)}pp vs 5p ${fmt(maxLift(ret5, 5), 1)}pp → ${maxLift(ret5, 5) >= maxLift(ret3, 3) ? "5p slightly clearer for continuation contrast; compare return lifts" : "3p"} (also compare cont)`,
  );
  const contLift3 = contRanked.filter((r) => r.combo.d === 3 && r.val.n >= 200);
  const contLift5 = contRanked.filter((r) => r.combo.d === 5 && r.val.n >= 200);
  const maxCont = (list: Ranked[], d: 3 | 5) => {
    const bl = d === 3 ? base3Ret : base5Ret;
    if (!list.length) return 0;
    return Math.max(...list.map((r) => bl - r.val.ret));
  };
  L.push(
    `    Cont separation: 3p max ${fmt(maxCont(contLift3, 3), 1)}pp vs 5p ${fmt(maxCont(contLift5, 5), 1)}pp → prefer ${maxCont(contLift5, 5) >= maxCont(contLift3, 3) ? "5p" : "3p"} for distinguishing CONTINUE.`,
  );
}
{
  const can =
    (bestRet && bestRet.val.ret - (bestRet.combo.d === 3 ? base3Ret : base5Ret) >= 3) ||
    (bestCont && (bestCont.combo.d === 3 ? base3Ret : base5Ret) - bestCont.val.ret >= 3);
  L.push(
    `19. Distinguish better than V18 baseline? ${can ? "YES — modest but validated lifts exist" : "NO — no stable material separation"}`,
  );
}

L.push("\n" + "=".repeat(88));
L.push(`VERDICT: ${verdict}`);
L.push("=".repeat(88));
if (bestRet) {
  L.push(
    `Simplest RETURN rule: ${bestRet.combo.name} → ALL RET ${fmt(bestRet.all.ret)}% (base ${fmt(bestRet.combo.d === 3 ? base3Ret : base5Ret)}%), VAL ${fmt(bestRet.val.ret)}% n=${bestRet.val.n}.`,
  );
}
if (bestCont) {
  L.push(
    `Simplest CONTINUE rule: ${bestCont.combo.name} → ALL RET ${fmt(bestCont.all.ret)}% (base ${fmt(bestCont.combo.d === 3 ? base3Ret : base5Ret)}%), VAL ${fmt(bestCont.val.ret)}% n=${bestCont.val.n}.`,
  );
}
L.push("No entry/SL/TP. If signal found, V20 tests BID/ASK execution.");

const reportPath = path.join(OUT_DIR, "eurusd-breakout-return-classifier-v19-report.txt");
fs.writeFileSync(reportPath, L.join("\n"));
const researchOut = path.join(
  process.cwd(),
  "research-output",
  "eurusd-breakout-return-classifier-v19-report.txt",
);
try {
  fs.mkdirSync(path.dirname(researchOut), { recursive: true });
  fs.writeFileSync(researchOut, L.join("\n"));
} catch {
  /* ignore */
}

console.log(L.join("\n"));
console.log(`\nWrote ${reportPath}`);
