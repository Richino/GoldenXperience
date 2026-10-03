/**
 * EUR/USD V18 — FROZEN SESSION S/R BEHAVIOR MAP (research-only).
 *
 * V16/V17 untouched. No TP/SL/P&L/strategy optimization.
 *
 * Question: if project S/R is calculated at session OPEN from already-completed
 * candles only, then FROZEN for the whole session, how does price behave when
 * it encounters those levels?
 *
 * Sessions (project session.ts): local 08:00–17:00 wall clock via Intl DST
 *   ASIA      = Asia/Tokyo
 *   LONDON    = Europe/London
 *   NEW_YORK  = America/New_York
 * (Project display Asia = Tokyo OR Sydney; this test uses Tokyo as the Asia
 *  research session so each centre is a single unambiguous clock.)
 *
 * S/R: computeSupportResistanceLevels EXACTLY (PIVOT_REACH=5, RANGE=60,
 * VISIBLE=160). Only candles fully completed before session open are passed,
 * so pivots that still need future confirmation bars are excluded automatically.
 *
 * Touch / re-arm: PRICE_REACTION touchAtr * ATR14; re-arm after price clears
 * the touch band on the original/inside side.
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
const CACHE = path.join(PAD, "eurusd-m15-mba-cache.json");
const OUT_DIR = PAD;
const WINDOW = 220;
const TOUCH_ATR = PR.touchAtr;
const MEANINGFUL_PEN_ATR = PR.minPenetrationAtr;
const BAR_MIN = 15;
const DUP_PIP = 1; // skip swing if within 1 pip of range twin
const PEN_DS = [1, 2, 3, 5, 7.5, 10, 15, 20] as const;
const ROT_PCTS = [10, 25, 50, 60, 70, 75, 100] as const;
const DIST_BUCKETS = [
  { label: "0-5", lo: 0, hi: 5 },
  { label: "5-10", lo: 5, hi: 10 },
  { label: "10-15", lo: 10, hi: 15 },
  { label: "15-20", lo: 15, hi: 20 },
  { label: "20-30", lo: 20, hi: 30 },
  { label: "30-50", lo: 30, hi: 50 },
  { label: "50+", lo: 50, hi: Infinity },
] as const;
const RETURN_WINDOWS_MIN = [15, 30, 60, 120, 240] as const;

type SessionName = "ASIA" | "LONDON" | "NEW_YORK";
type Side = "support" | "resistance";
type LevelType = "range" | "swing";
type ClassA = "REJECT" | "BREAK_RETURN" | "BREAK_STAY";
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
  openIdx: number; // first M15 bar of session
  closeIdx: number; // last M15 bar index exclusive-ish (scan end)
  freezeIdx: number;
  openPrice: number;
  atr: number;
  levels: FrozenLevel[];
  year: number;
}

interface Encounter {
  session: SessionName;
  side: Side;
  type: LevelType;
  level: number;
  openDistPips: number;
  openDistBucket: string;
  year: number;
  atr: number;
  t0: number; // first touch bar
  maxPenPips: number;
  maxInsidePips: number; // max move back inside after encounter start
  mfeFadePips: number; // favorable for fade = inside excursion after first touch
  maeFadePips: number; // adverse for fade = max penetration
  minsToMaxPen: number;
  minsToFirstReturn: number; // NaN if never
  minsMaxPenToReturn: number; // NaN if never
  retests: number;
  hitOtherSr: boolean;
  cls: ClassA;
  meaningfulBreak: boolean;
  // penetration-conditional
  reachedD: Record<number, boolean>;
  returnedAfterD: Record<number, boolean>;
  minsReturnAfterD: Record<number, number>;
  furtherPenAfterD: Record<number, number>;
  // rotation
  rotValid: boolean;
  rotReach: Record<number, boolean>;
  maxRotPct: number;
}

const SESSION_DEFS: Array<{ name: SessionName; tz: string }> = [
  { name: "ASIA", tz: TOKYO_TIME_ZONE },
  { name: "LONDON", tz: LONDON_TIME_ZONE },
  { name: "NEW_YORK", tz: NEW_YORK_TIME_ZONE },
];

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
const timesMs = raw.map((c) => Date.parse(c.time));

console.log(
  `V18 load: ${n} M15 MBA candles ${raw[0]!.time.slice(0, 10)} → ${raw[n - 1]!.time.slice(0, 10)}`,
);

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
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(x: number, d = 1): string {
  return Number.isFinite(x) ? x.toFixed(d) : "—";
}

function pct(a: number, b: number): number {
  return b > 0 ? (100 * a) / b : NaN;
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
        // last completed candle before session: bar i opens at/after 08:00,
        // so freezeIdx = i-1 must have fully completed (open+15m <= session open).
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

        // find session end: last bar still in same local session day
        let j = i;
        while (j < n && inCentreSession(timesMs[j]!, def.tz) && localYmd(timesMs[j]!, def.tz) === day) {
          j += 1;
        }
        const openMs = timesMs[i]!;
        const closeMs = j > i ? timesMs[j - 1]! + BAR_MIN * 60_000 : openMs + 9 * 3600_000;

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

function touchesZone(c: OHLC, level: number, w: number): boolean {
  return c.low <= level + w && c.high >= level - w;
}

function clearInside(c: OHLC, side: Side, level: number, w: number): boolean {
  // fully clear of touch band on original/inside side
  if (side === "resistance") return c.high < level - w;
  return c.low > level + w;
}

function penBeyond(c: OHLC, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (c.high - level) / PIP);
  return Math.max(0, (level - c.low) / PIP);
}

function insideDist(c: OHLC, side: Side, level: number): number {
  if (side === "resistance") return Math.max(0, (level - c.low) / PIP);
  return Math.max(0, (c.high - level) / PIP);
}

function closedInside(c: OHLC, side: Side, level: number): boolean {
  if (side === "resistance") return c.close <= level;
  return c.close >= level;
}

function closedOutside(c: OHLC, side: Side, level: number): boolean {
  if (side === "resistance") return c.close > level;
  return c.close < level;
}

function oppositeLevel(snap: SessionSnap, side: Side, type: LevelType): number | null {
  const wantSide: Side = side === "resistance" ? "support" : "resistance";
  const same = snap.levels.find((l) => l.side === wantSide && l.type === type);
  if (same) return same.price;
  const any = snap.levels.find((l) => l.side === wantSide);
  return any ? any.price : null;
}

function scanEncounters(snaps: SessionSnap[]): Encounter[] {
  const out: Encounter[] = [];
  for (const snap of snaps) {
    const w = TOUCH_ATR * snap.atr;
    const meaningful = MEANINGFUL_PEN_ATR * snap.atr / PIP; // pips
    const encounterOrdinal = new Map<string, number>(); // prior completed encounters per level
    for (const fl of snap.levels) {
      const levelKey = `${fl.side}|${fl.type}|${fl.price}`;
      let armed = true;
      let active: {
        t0: number;
        maxPen: number;
        maxInside: number;
        barMaxPen: number;
        firstReturnBar: number;
        retests: number;
        hitOther: boolean;
        reachedD: Record<number, boolean>;
        firstDBar: Record<number, number>;
        returnedAfterD: Record<number, boolean>;
        minsReturnAfterD: Record<number, number>;
        furtherPenAfterD: Record<number, number>;
        maxRot: number;
        rotReach: Record<number, boolean>;
        wasOutside: boolean;
      } | null = null;

      const opp = oppositeLevel(snap, fl.side, fl.type);
      const rangeSpan =
        opp !== null ? Math.abs(opp - fl.price) / PIP : NaN;
      const rotValid =
        opp !== null &&
        rangeSpan >= 5 &&
        (fl.side === "resistance" ? opp < fl.price : opp > fl.price);

      for (let t = snap.openIdx; t < snap.closeIdx; t++) {
        const c = raw[t]!.mid;
        const touch = touchesZone(c, fl.price, w);
        const pen = penBeyond(c, fl.side, fl.price);
        const inside = insideDist(c, fl.side, fl.price);

        if (armed && touch) {
          armed = false;
          active = {
            t0: t,
            maxPen: pen,
            maxInside: inside,
            barMaxPen: t,
            firstReturnBar: -1,
            retests: 0,
            hitOther: false,
            reachedD: Object.fromEntries(PEN_DS.map((d) => [d, false])),
            firstDBar: Object.fromEntries(PEN_DS.map((d) => [d, -1])),
            returnedAfterD: Object.fromEntries(PEN_DS.map((d) => [d, false])),
            minsReturnAfterD: Object.fromEntries(PEN_DS.map((d) => [d, NaN])),
            furtherPenAfterD: Object.fromEntries(PEN_DS.map((d) => [d, 0])),
            maxRot: 0,
            rotReach: Object.fromEntries(ROT_PCTS.map((p) => [p, false])),
            wasOutside: pen > 0 || closedOutside(c, fl.side, fl.price),
          };
          for (const d of PEN_DS) {
            if (pen >= d) {
              active.reachedD[d] = true;
              active.firstDBar[d] = t;
            }
          }
        } else if (active) {
          if (pen > active.maxPen) {
            active.maxPen = pen;
            active.barMaxPen = t;
          }
          if (inside > active.maxInside) active.maxInside = inside;

          for (const d of PEN_DS) {
            if (!active.reachedD[d] && pen >= d) {
              active.reachedD[d] = true;
              active.firstDBar[d] = t;
            }
            if (active.reachedD[d]) {
              active.furtherPenAfterD[d] = Math.max(
                active.furtherPenAfterD[d]!,
                Math.max(0, pen - d),
              );
            }
          }

          if (active.wasOutside && closedInside(c, fl.side, fl.price) && active.firstReturnBar < 0) {
            active.firstReturnBar = t;
          }
          if (pen > 0 || closedOutside(c, fl.side, fl.price)) active.wasOutside = true;

          for (const d of PEN_DS) {
            if (
              active.reachedD[d] &&
              !active.returnedAfterD[d] &&
              closedInside(c, fl.side, fl.price)
            ) {
              active.returnedAfterD[d] = true;
              active.minsReturnAfterD[d] =
                (t - active.firstDBar[d]!) * BAR_MIN;
            }
          }

          // retest: left touch band then touched again while still active? count touches after clear
          // simpler: if was clear inside then touch again before finalize — handled via re-arm
          // During active encounter, count return-to-zone after being outside break side then back
          if (touch && active.maxPen >= meaningful) {
            // count wick retests from break side back into zone after leaving beyond
          }

          if (rotValid && opp !== null) {
            // progress from origin toward opposite (fade direction)
            let prog = 0;
            if (fl.side === "resistance") {
              // travel down: level -> opp
              prog = ((fl.price - c.low) / PIP / rangeSpan) * 100;
            } else {
              prog = ((c.high - fl.price) / PIP / rangeSpan) * 100;
            }
            prog = Math.max(0, prog);
            if (prog > active.maxRot) active.maxRot = prog;
            for (const rp of ROT_PCTS) {
              if (prog >= rp) active.rotReach[rp] = true;
            }
          }

          // other frozen S/R hit after encounter
          if (!active.hitOther) {
            for (const other of snap.levels) {
              if (other.price === fl.price && other.type === fl.type) continue;
              if (touchesZone(c, other.price, w)) {
                active.hitOther = true;
                break;
              }
            }
          }

          // end encounter when cleared inside (re-arm), or session ends
          if (clearInside(c, fl.side, fl.price, w)) {
            // finalize below
            const meaningfulBreak = active.maxPen >= meaningful;
            let cls: ClassA;
            if (!meaningfulBreak) cls = "REJECT";
            else if (active.firstReturnBar >= 0) cls = "BREAK_RETURN";
            else cls = "BREAK_STAY";

            // retests = how many prior encounters of this same frozen level
            // already completed earlier in the session (0 = first visit)
            const retests = encounterOrdinal.get(levelKey) ?? 0;
            encounterOrdinal.set(levelKey, retests + 1);

            // intra-encounter zone re-entries from the break side
            let intra = 0;
            let leftZone = false;
            for (let k = active.t0 + 1; k <= t; k++) {
              const ck = raw[k]!.mid;
              const inZ = touchesZone(ck, fl.price, w);
              if (!inZ) leftZone = true;
              if (leftZone && inZ) {
                intra += 1;
                leftZone = false;
              }
            }
            const retestCount = retests + intra;

            out.push({
              session: snap.session,
              side: fl.side,
              type: fl.type,
              level: fl.price,
              openDistPips: fl.openDistPips,
              openDistBucket: distBucket(Math.abs(fl.openDistPips)),
              year: snap.year,
              atr: snap.atr,
              t0: active.t0,
              maxPenPips: active.maxPen,
              maxInsidePips: active.maxInside,
              mfeFadePips: active.maxInside,
              maeFadePips: active.maxPen,
              minsToMaxPen: (active.barMaxPen - active.t0) * BAR_MIN,
              minsToFirstReturn:
                active.firstReturnBar >= 0
                  ? (active.firstReturnBar - active.t0) * BAR_MIN
                  : NaN,
              minsMaxPenToReturn:
                active.firstReturnBar >= 0
                  ? (active.firstReturnBar - active.barMaxPen) * BAR_MIN
                  : NaN,
              retests: retestCount,
              hitOtherSr: active.hitOther,
              cls,
              meaningfulBreak,
              reachedD: { ...active.reachedD },
              returnedAfterD: { ...active.returnedAfterD },
              minsReturnAfterD: { ...active.minsReturnAfterD },
              furtherPenAfterD: { ...active.furtherPenAfterD },
              rotValid,
              rotReach: { ...active.rotReach },
              maxRotPct: active.maxRot,
            });
            active = null;
            armed = true;
          }
        } else if (!armed && clearInside(c, fl.side, fl.price, w)) {
          armed = true;
        }
      }

      // session-end finalize active encounter
      if (active) {
        const meaningfulBreak = active.maxPen >= meaningful;
        let cls: ClassA;
        if (!meaningfulBreak) cls = "REJECT";
        else if (active.firstReturnBar >= 0) cls = "BREAK_RETURN";
        else cls = "BREAK_STAY";

        const retests = encounterOrdinal.get(levelKey) ?? 0;
        encounterOrdinal.set(levelKey, retests + 1);
        let intra = 0;
        let leftZone = false;
        for (let k = active.t0 + 1; k < snap.closeIdx; k++) {
          const ck = raw[k]!.mid;
          const inZ = touchesZone(ck, fl.price, w);
          if (!inZ) leftZone = true;
          if (leftZone && inZ) {
            intra += 1;
            leftZone = false;
          }
        }

        out.push({
          session: snap.session,
          side: fl.side,
          type: fl.type,
          level: fl.price,
          openDistPips: fl.openDistPips,
          openDistBucket: distBucket(Math.abs(fl.openDistPips)),
          year: snap.year,
          atr: snap.atr,
          t0: active.t0,
          maxPenPips: active.maxPen,
          maxInsidePips: active.maxInside,
          mfeFadePips: active.maxInside,
          maeFadePips: active.maxPen,
          minsToMaxPen: (active.barMaxPen - active.t0) * BAR_MIN,
          minsToFirstReturn:
            active.firstReturnBar >= 0
              ? (active.firstReturnBar - active.t0) * BAR_MIN
              : NaN,
          minsMaxPenToReturn:
            active.firstReturnBar >= 0
              ? (active.firstReturnBar - active.barMaxPen) * BAR_MIN
              : NaN,
          retests: retests + intra,
          hitOtherSr: active.hitOther,
          cls,
          meaningfulBreak,
          reachedD: { ...active.reachedD },
          returnedAfterD: { ...active.returnedAfterD },
          minsReturnAfterD: { ...active.minsReturnAfterD },
          furtherPenAfterD: { ...active.furtherPenAfterD },
          rotValid,
          rotReach: { ...active.rotReach },
          maxRotPct: active.maxRot,
        });
      }
    }
  }
  return out;
}

type Filter = (e: Encounter) => boolean;

function statsBlock(vals: number[]) {
  const v = vals.filter((x) => Number.isFinite(x));
  return {
    n: v.length,
    avg: mean(v),
    med: pctile(v, 0.5),
    p25: pctile(v, 0.25),
    p50: pctile(v, 0.5),
    p75: pctile(v, 0.75),
    p80: pctile(v, 0.8),
    p90: pctile(v, 0.9),
    p95: pctile(v, 0.95),
    p99: pctile(v, 0.99),
    max: v.length ? Math.max(...v) : NaN,
  };
}

function summarize(enc: Encounter[], label: string, L: string[]) {
  const nEnc = enc.length;
  if (!nEnc) {
    L.push(`${label}: n=0`);
    return;
  }
  const rej = enc.filter((e) => e.cls === "REJECT").length;
  const br = enc.filter((e) => e.cls === "BREAK_RETURN").length;
  const bs = enc.filter((e) => e.cls === "BREAK_STAY").length;
  const broken = br + bs;
  const pen = statsBlock(enc.map((e) => e.maxPenPips));
  const rev = statsBlock(enc.map((e) => e.maxInsidePips));
  L.push(
    `${label} | n=${nEnc} | REJECT ${fmt(pct(rej, nEnc))}% | BREAK ${fmt(pct(broken, nEnc))}% | BREAK+RETURN ${fmt(pct(br, nEnc))}% | BREAK+STAY ${fmt(pct(bs, nEnc))}% | medPen ${fmt(pen.med)} p75 ${fmt(pen.p75)} p90 ${fmt(pen.p90)} | medRev ${fmt(rev.med)} p75 ${fmt(rev.p75)} p90 ${fmt(rev.p90)}`,
  );
}

function primaryRow(enc: Encounter[]): string {
  const nEnc = enc.length;
  const rej = enc.filter((e) => e.cls === "REJECT").length;
  const br = enc.filter((e) => e.cls === "BREAK_RETURN").length;
  const bs = enc.filter((e) => e.cls === "BREAK_STAY").length;
  const broken = br + bs;
  const pen = statsBlock(enc.map((e) => e.maxPenPips));
  const rev = statsBlock(enc.map((e) => e.maxInsidePips));
  return [
    nEnc,
    fmt(pct(rej, nEnc)),
    fmt(pct(broken, nEnc)),
    fmt(pct(br, nEnc)),
    fmt(pct(bs, nEnc)),
    fmt(pen.med),
    fmt(pen.p75),
    fmt(pen.p90),
    fmt(rev.med),
    fmt(rev.p75),
    fmt(rev.p90),
  ].join(" | ");
}

function filterEnc(all: Encounter[], f: Filter): Encounter[] {
  return all.filter(f);
}

console.log("Building session snapshots (freeze S/R at each open)...");
const snaps = buildSnaps();
console.log(`Sessions frozen: ${snaps.length}`);
for (const s of SESSION_DEFS) {
  console.log(`  ${s.name}: ${snaps.filter((x) => x.session === s.name).length}`);
}

console.log("Scanning encounters...");
const encounters = scanEncounters(snaps);
console.log(`Encounters: ${encounters.length}`);

const allPen = encounters.map((e) => e.maxPenPips).filter((x) => Number.isFinite(x));
const p99Pen = pctile(allPen, 0.99);
const primary = encounters;
const robust = encounters.filter((e) => e.maxPenPips < p99Pen);

const L: string[] = [];
L.push("=".repeat(88));
L.push("EUR/USD V18 — FROZEN SESSION S/R BEHAVIOR MAP");
L.push("=".repeat(88));
L.push("");
L.push("DATA");
L.push(`  Instrument: EUR/USD  Timeframe: M15 (OANDA MID)`);
L.push(`  Candles: ${n}  Range: ${raw[0]!.time} → ${raw[n - 1]!.time}`);
L.push(`  Sessions frozen: ${snaps.length}  Encounters: ${encounters.length}`);
L.push(`  Extreme threshold (P99 max penetration): ${fmt(p99Pen, 2)} pips`);
L.push("");
L.push("SESSION DEFINITIONS (from frontend/src/lib/strategy/session.ts)");
L.push("  Project rule: each centre is OPEN when local wall-clock is 08:00–17:00");
L.push("  (exclusive of 17:00), resolved with Intl so UK/US DST do not shift the");
L.push("  intended local session. Asia display in app = Tokyo OR Sydney; V18 uses");
L.push("  Tokyo alone as the Asia research session.");
L.push("");
L.push("  ASIA (Asia/Tokyo) — no DST");
L.push("    Local: 08:00–17:00 JST");
L.push("    UTC:   23:00–08:00 UTC (previous calendar evening → morning)");
L.push("    ET:    18:00–03:00 ET when US on EST; 19:00–04:00 ET when US on EDT");
L.push("");
L.push("  LONDON (Europe/London)");
L.push("    Local: 08:00–17:00 London time");
L.push("    UTC winter (GMT): 08:00–17:00 UTC = 03:00–12:00 ET");
L.push("    UTC summer (BST): 07:00–16:00 UTC = 03:00–12:00 ET");
L.push("");
L.push("  NEW YORK (America/New_York)");
L.push("    Local: 08:00–17:00 ET");
L.push("    UTC winter (EST): 13:00–22:00 UTC");
L.push("    UTC summer (EDT): 12:00–21:00 UTC");
L.push("");
L.push("FREEZE / NO-LOOKAHEAD");
L.push("  At first M15 bar of each session day, S/R is computed on the prior");
L.push(`  ${WINDOW} fully completed M15 candles only (last bar ends at/before open).`);
L.push("  computeSupportResistanceLevels: PIVOT_REACH=5, RANGE_LOOKBACK=60,");
L.push("  VISIBLE_LOOKBACK=160. A swing at index i needs bars [i-5..i+5]; because");
L.push("  the series ends at the last pre-open candle, any pivot that would need");
L.push("  post-open bars to confirm is simply not present. Levels then NEVER move");
L.push("  until that session ends; next session gets a fresh snapshot.");
L.push("");
L.push("ENCOUNTER / RE-ARM");
L.push(`  Touch zone: ± touchAtr*ATR14 = ±${TOUCH_ATR}*ATR (PRICE_REACTION).`);
L.push(`  Meaningful break (primary class): max wick penetration ≥ minPenetrationAtr*ATR`);
L.push(`    = ${MEANINGFUL_PEN_ATR}*ATR (~project real-penetration floor).`);
L.push("  Encounter starts on first touch while armed.");
L.push("  Encounter ends / re-arm when a candle is fully clear of the touch band");
L.push("  on the ORIGINAL/INSIDE side (resistance: high < level−w; support:");
L.push("  low > level+w). New encounter only after re-arm + return to zone.");
L.push("  Session-end open encounters are finalized at session close.");
L.push("");

L.push("-".repeat(88));
L.push("PRIMARY TABLE");
L.push(
  "SESSION | TYPE | SIDE | ENCOUNTERS | REJECT% | BREAK% | BREAK+RETURN% | BREAK+STAY% | MED PEN | P75 PEN | P90 PEN | MED REVERSAL | P75 REVERSAL | P90 REVERSAL",
);
const sessions: Array<SessionName | "ALL"> = ["ASIA", "LONDON", "NEW_YORK", "ALL"];
const types: Array<LevelType | "ALL"> = ["range", "swing", "ALL"];
const sides: Array<Side | "ALL"> = ["support", "resistance", "ALL"];

for (const sess of sessions) {
  for (const typ of types) {
    for (const side of sides) {
      if (sess === "ALL" && typ === "ALL" && side === "ALL") {
        // keep combined
      }
      const enc = filterEnc(primary, (e) => {
        if (sess !== "ALL" && e.session !== sess) return false;
        if (typ !== "ALL" && e.type !== typ) return false;
        if (side !== "ALL" && e.side !== side) return false;
        return true;
      });
      if (!enc.length) continue;
      // skip ultra-granular empty; print all non-empty including ALL combos of interest
      const show =
        (sess !== "ALL" && typ !== "ALL" && side !== "ALL") ||
        (sess !== "ALL" && typ === "ALL" && side === "ALL") ||
        (sess === "ALL" && typ === "ALL" && side === "ALL") ||
        (sess === "ALL" && typ !== "ALL" && side !== "ALL") ||
        (sess !== "ALL" && typ === "ALL" && side !== "ALL") ||
        (sess !== "ALL" && typ !== "ALL" && side === "ALL");
      if (!show) continue;
      L.push(
        `${sess} | ${typ} | ${side} | ${primaryRow(enc)}`,
      );
    }
  }
}
L.push("");

L.push("-".repeat(88));
L.push("PENETRATION-CONDITIONAL TABLE");
L.push(
  "SESSION | SIDE | TYPE | D | REACHED | %ENC | RETURNED | RETURN% | STAYED OUT | MED TIME RET (m) | MED FURTHER PEN",
);
for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  for (const side of ["support", "resistance"] as Side[]) {
    for (const typ of ["range", "swing"] as LevelType[]) {
      const enc = filterEnc(primary, (e) => e.session === sess && e.side === side && e.type === typ);
      if (!enc.length) continue;
      for (const d of PEN_DS) {
        const reached = enc.filter((e) => e.reachedD[d]);
        const returned = reached.filter((e) => e.returnedAfterD[d]);
        const stayed = reached.length - returned.length;
        const tRet = statsBlock(returned.map((e) => e.minsReturnAfterD[d]!));
        const fur = statsBlock(reached.map((e) => e.furtherPenAfterD[d]!));
        L.push(
          `${sess} | ${side} | ${typ} | ${d}p | ${reached.length} | ${fmt(pct(reached.length, enc.length))} | ${returned.length} | ${fmt(pct(returned.length, reached.length))} | ${stayed} | ${fmt(tRet.med, 0)} | ${fmt(fur.med)}`,
        );
      }
    }
  }
}
L.push("");
L.push("PENETRATION-CONDITIONAL (ALL sessions combined, by side)");
for (const side of ["support", "resistance"] as Side[]) {
  const enc = filterEnc(primary, (e) => e.side === side);
  for (const d of PEN_DS) {
    const reached = enc.filter((e) => e.reachedD[d]);
    const returned = reached.filter((e) => e.returnedAfterD[d]);
    L.push(
      `ALL | ${side} | ${d}p | reached ${reached.length} (${fmt(pct(reached.length, enc.length))}%) | return ${fmt(pct(returned.length, reached.length))}% | stayed ${reached.length - returned.length}`,
    );
  }
}
L.push("");

L.push("-".repeat(88));
L.push("TIME-TO-RETURN (breaks that eventually return inside)");
L.push("SESSION | SIDE | TYPE | nReturn | ≤15m | ≤30m | ≤1h | ≤2h | ≤4h | before session end");
for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  for (const side of ["support", "resistance"] as Side[]) {
    for (const typ of ["range", "swing"] as LevelType[]) {
      const ret = filterEnc(primary, (e) => e.session === sess && e.side === side && e.type === typ && e.cls === "BREAK_RETURN");
      if (!ret.length) continue;
      const times = ret.map((e) => e.minsToFirstReturn);
      const counts = RETURN_WINDOWS_MIN.map((w) => times.filter((t) => t <= w).length);
      L.push(
        `${sess} | ${side} | ${typ} | ${ret.length} | ${counts.map((c) => fmt(pct(c, ret.length), 1)).join("% | ")}% | 100%`,
      );
    }
  }
}
L.push("");

L.push("-".repeat(88));
L.push("RANGE ROTATION (origin S/R=0%, opposite frozen S/R=100%, valid geometry only)");
L.push("SESSION | SIDE | TYPE | nValid | ≥10% | ≥25% | ≥50% | ≥60% | ≥70% | ≥75% | ≥100% | medMax%");
for (const sess of ["ASIA", "LONDON", "NEW_YORK", "ALL"] as Array<SessionName | "ALL">) {
  for (const side of ["support", "resistance"] as Side[]) {
    for (const typ of ["range", "swing", "ALL"] as Array<LevelType | "ALL">) {
      if (typ === "ALL" && sess !== "ALL") continue;
      const enc = filterEnc(primary, (e) => {
        if (!e.rotValid) return false;
        if (sess !== "ALL" && e.session !== sess) return false;
        if (side !== "ALL" && e.side !== side) return false;
        if (typ !== "ALL" && e.type !== typ) return false;
        return true;
      });
      // only print useful rows
      if (!(sess !== "ALL" && typ !== "ALL") && !(sess === "ALL" && typ === "ALL")) {
        if (!(sess !== "ALL" && typ === "range")) continue;
      }
      if (!enc.length) continue;
      if (sess !== "ALL" && typ === "ALL") continue;
      const nV = enc.length;
      const hits = ROT_PCTS.map((rp) => enc.filter((e) => e.rotReach[rp]).length);
      const medMax = pctile(enc.map((e) => e.maxRotPct), 0.5);
      L.push(
        `${sess} | ${side} | ${typ} | ${nV} | ${hits.map((h) => fmt(pct(h, nV), 1)).join("% | ")}% | ${fmt(medMax, 1)}`,
      );
    }
  }
}
// cleaner rotation block
L.push("");
L.push("RANGE ROTATION (clean grid)");
for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  for (const side of ["support", "resistance"] as Side[]) {
    for (const typ of ["range", "swing"] as LevelType[]) {
      const enc = filterEnc(primary, (e) => e.rotValid && e.session === sess && e.side === side && e.type === typ);
      if (!enc.length) continue;
      const nV = enc.length;
      const hits = ROT_PCTS.map((rp) => enc.filter((e) => e.rotReach[rp]).length);
      L.push(
        `${sess} | ${side} | ${typ} | n=${nV} | 10% ${fmt(pct(hits[0]!, nV))} | 25% ${fmt(pct(hits[1]!, nV))} | 50% ${fmt(pct(hits[2]!, nV))} | 75% ${fmt(pct(hits[5]!, nV))} | 100% ${fmt(pct(hits[6]!, nV))} | medMax ${fmt(pctile(enc.map((e) => e.maxRotPct), 0.5))}`,
      );
    }
  }
}
L.push("");

L.push("-".repeat(88));
L.push("SESSION-OPEN DISTANCE BUCKETS");
L.push("BUCKET | n | REJECT% | BREAK+RETURN% | BREAK+STAY% | MED PEN | MED REVERSAL");
for (const sess of ["ASIA", "LONDON", "NEW_YORK", "ALL"] as Array<SessionName | "ALL">) {
  L.push(`-- ${sess} --`);
  for (const b of DIST_BUCKETS) {
    const enc = filterEnc(primary, (e) => {
      if (sess !== "ALL" && e.session !== sess) return false;
      return e.openDistBucket === b.label;
    });
    if (!enc.length) continue;
    const rej = enc.filter((e) => e.cls === "REJECT").length;
    const br = enc.filter((e) => e.cls === "BREAK_RETURN").length;
    const bs = enc.filter((e) => e.cls === "BREAK_STAY").length;
    L.push(
      `${b.label} | ${enc.length} | ${fmt(pct(rej, enc.length))} | ${fmt(pct(br, enc.length))} | ${fmt(pct(bs, enc.length))} | ${fmt(pctile(enc.map((e) => e.maxPenPips), 0.5))} | ${fmt(pctile(enc.map((e) => e.maxInsidePips), 0.5))}`,
    );
  }
}
L.push("");

L.push("-".repeat(88));
L.push("PIP MOVEMENT DISTRIBUTIONS (all encounters)");
{
  const pen = statsBlock(primary.map((e) => e.maxPenPips));
  const rev = statsBlock(primary.map((e) => e.maxInsidePips));
  const tPen = statsBlock(primary.map((e) => e.minsToMaxPen));
  const tRet = statsBlock(primary.filter((e) => Number.isFinite(e.minsToFirstReturn)).map((e) => e.minsToFirstReturn));
  const tMPR = statsBlock(primary.filter((e) => Number.isFinite(e.minsMaxPenToReturn)).map((e) => e.minsMaxPenToReturn));
  L.push(`Max penetration pips: avg ${fmt(pen.avg)} med ${fmt(pen.med)} p25 ${fmt(pen.p25)} p75 ${fmt(pen.p75)} p80 ${fmt(pen.p80)} p90 ${fmt(pen.p90)} p95 ${fmt(pen.p95)} p99 ${fmt(pen.p99)} max ${fmt(pen.max)}`);
  L.push(`Max inside (reversal) pips: avg ${fmt(rev.avg)} med ${fmt(rev.med)} p25 ${fmt(rev.p25)} p75 ${fmt(rev.p75)} p80 ${fmt(rev.p80)} p90 ${fmt(rev.p90)} p95 ${fmt(rev.p95)} p99 ${fmt(rev.p99)} max ${fmt(rev.max)}`);
  L.push(`Mins to max pen: med ${fmt(tPen.med, 0)} | Mins to first return (of returners): med ${fmt(tRet.med, 0)} | MaxPen→return: med ${fmt(tMPR.med, 0)}`);
  L.push(`Retests mean ${fmt(mean(primary.map((e) => e.retests)), 2)} | Hit other frozen S/R ${fmt(pct(primary.filter((e) => e.hitOtherSr).length, primary.length))}%`);
}
L.push("");

L.push("-".repeat(88));
L.push("ROBUSTNESS (exclude encounters with maxPen ≥ global P99)");
L.push(`Excluded: ${primary.length - robust.length} / ${primary.length} (P99=${fmt(p99Pen, 2)}p)`);
summarize(primary, "PRIMARY all", L);
summarize(robust, "ROBUST  all", L);
for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  summarize(filterEnc(primary, (e) => e.session === sess), `PRIMARY ${sess}`, L);
  summarize(filterEnc(robust, (e) => e.session === sess), `ROBUST  ${sess}`, L);
}
L.push("");

L.push("-".repeat(88));
L.push("PERIOD STABILITY");
const early = filterEnc(primary, (e) => e.year >= 2013 && e.year <= 2019);
const late = filterEnc(primary, (e) => e.year >= 2020 && e.year <= 2026);
summarize(early, "2013–2019", L);
summarize(late, "2020–2026", L);
L.push("Year-by-year:");
for (let y = 2013; y <= 2026; y++) {
  const ye = filterEnc(primary, (e) => e.year === y);
  if (ye.length) summarize(ye, `  ${y}`, L);
}
L.push("");

L.push("-".repeat(88));
L.push("LONG/SHORT SYMMETRY (support vs resistance)");
summarize(filterEnc(primary, (e) => e.side === "support"), "SUPPORT (long-fade side)", L);
summarize(filterEnc(primary, (e) => e.side === "resistance"), "RESISTANCE (short-fade side)", L);
for (const sess of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  summarize(filterEnc(primary, (e) => e.session === sess && e.side === "support"), `${sess} SUPPORT`, L);
  summarize(filterEnc(primary, (e) => e.session === sess && e.side === "resistance"), `${sess} RESISTANCE`, L);
}
L.push("");

// ---- Answer the 19 questions ----
function rate(enc: Encounter[], pred: (e: Encounter) => boolean): number {
  return pct(enc.filter(pred).length, enc.length);
}

const all = primary;
const q1 = rate(all, (e) => e.cls === "REJECT");
const q2 = rate(all, (e) => e.cls === "BREAK_RETURN");
const q3 = rate(all, (e) => e.cls === "BREAK_STAY");

function sessionReturnRate(sess: SessionName): number {
  const e = filterEnc(all, (x) => x.session === sess && x.meaningfulBreak);
  return pct(e.filter((x) => x.cls === "BREAK_RETURN").length, e.length);
}
function sessionMedPenAmongReturn(sess: SessionName): number {
  const e = filterEnc(all, (x) => x.session === sess && x.cls === "BREAK_RETURN");
  return pctile(e.map((x) => x.maxPenPips), 0.5);
}

const sessReturn: Record<SessionName, number> = {
  ASIA: sessionReturnRate("ASIA"),
  LONDON: sessionReturnRate("LONDON"),
  NEW_YORK: sessionReturnRate("NEW_YORK"),
};
const bestReturnSess = (Object.entries(sessReturn) as Array<[SessionName, number]>).sort(
  (a, b) => b[1] - a[1],
)[0]!;
const sessPenReturn: Record<SessionName, number> = {
  ASIA: sessionMedPenAmongReturn("ASIA"),
  LONDON: sessionMedPenAmongReturn("LONDON"),
  NEW_YORK: sessionMedPenAmongReturn("NEW_YORK"),
};
const deepestSess = (Object.entries(sessPenReturn) as Array<[SessionName, number]>).sort(
  (a, b) => b[1] - a[1],
)[0]!;

const returners = filterEnc(all, (e) => e.cls === "BREAK_RETURN");
const medPenReturn = pctile(returners.map((e) => e.maxPenPips), 0.5);
const allPenStats = statsBlock(all.map((e) => e.maxPenPips));
const afterReturnInside = statsBlock(returners.map((e) => e.maxInsidePips));

function returnRateAfterD(d: number, enc = all): number {
  const r = enc.filter((e) => e.reachedD[d]);
  return pct(r.filter((e) => e.returnedAfterD[d]).length, r.length);
}

const rotAll = filterEnc(all, (e) => e.rotValid);
const rotHits = (rp: number) => pct(rotAll.filter((e) => e.rotReach[rp]).length, rotAll.length);

const rangeEnc = filterEnc(all, (e) => e.type === "range");
const swingEnc = filterEnc(all, (e) => e.type === "swing");

const timeRet = statsBlock(returners.map((e) => e.minsToFirstReturn));

const earlyRej = rate(early, (e) => e.cls === "REJECT");
const lateRej = rate(late, (e) => e.cls === "REJECT");
const earlyBR = rate(early, (e) => e.cls === "BREAK_RETURN");
const lateBR = rate(late, (e) => e.cls === "BREAK_RETURN");

const avgPen = allPenStats.avg;
const medPen = allPenStats.med;
const avgDistorted = avgPen > medPen * 1.5;

// Verdict heuristics from behavior (not P&L)
const rejectStrong = q1 >= 40;
const returnStrong = q2 >= 35;
const stayWeak = q3 <= 30;
const d5Return = returnRateAfterD(5);
const d10Return = returnRateAfterD(10);
let verdict: "FROZEN_S/R_BEHAVIOR_STRONG" | "FROZEN_S/R_BEHAVIOR_MODERATE" | "FROZEN_S/R_BEHAVIOR_WEAK";
if (q1 + q2 >= 70 && d5Return >= 55 && stayWeak) verdict = "FROZEN_S/R_BEHAVIOR_STRONG";
else if (q1 + q2 >= 55 && d5Return >= 40) verdict = "FROZEN_S/R_BEHAVIOR_MODERATE";
else verdict = "FROZEN_S/R_BEHAVIOR_WEAK";

const sessStrength = (["ASIA", "LONDON", "NEW_YORK"] as SessionName[]).map((s) => {
  const e = filterEnc(all, (x) => x.session === s);
  return { s, score: rate(e, (x) => x.cls === "REJECT") + rate(e, (x) => x.cls === "BREAK_RETURN") };
});
sessStrength.sort((a, b) => b.score - a.score);
const strongestSession = sessStrength[0]!.s;
const weakestSession = sessStrength[sessStrength.length - 1]!.s;

const typeStrength = [
  { t: "range" as LevelType, score: rate(rangeEnc, (e) => e.cls === "REJECT") + rate(rangeEnc, (e) => e.cls === "BREAK_RETURN") },
  { t: "swing" as LevelType, score: rate(swingEnc, (e) => e.cls === "REJECT") + rate(swingEnc, (e) => e.cls === "BREAK_RETURN") },
];
typeStrength.sort((a, b) => b.score - a.score);

L.push("=".repeat(88));
L.push("ANSWERS TO THE 19 QUESTIONS");
L.push("=".repeat(88));
L.push(`1. Reject without meaningful break: ${fmt(q1)}%`);
L.push(`2. Break + later return inside: ${fmt(q2)}%`);
L.push(`3. Break + stay outside: ${fmt(q3)}%`);
L.push(`4. Asia/London/NY differences:`);
for (const s of ["ASIA", "LONDON", "NEW_YORK"] as SessionName[]) {
  const e = filterEnc(all, (x) => x.session === s);
  L.push(
    `   ${s}: n=${e.length} REJECT ${fmt(rate(e, (x) => x.cls === "REJECT"))}% BR ${fmt(rate(e, (x) => x.cls === "BREAK_RETURN"))}% BS ${fmt(rate(e, (x) => x.cls === "BREAK_STAY"))}% medPen ${fmt(pctile(e.map((x) => x.maxPenPips), 0.5))}`,
  );
}
L.push(`5. Highest return-inside rate after break: ${bestReturnSess[0]} (${fmt(bestReturnSess[1])}%)`);
L.push(`6. Deepest median penetration among successful returns: ${deepestSess[0]} (${fmt(deepestSess[1])}p)`);
L.push(`7. Median penetration before successful return: ${fmt(medPenReturn)}p`);
L.push(`8. Penetration percentiles (all encounters): P75=${fmt(allPenStats.p75)} P90=${fmt(allPenStats.p90)} P95=${fmt(allPenStats.p95)}`);
L.push(`9. Once 3p beyond: return rate ${fmt(returnRateAfterD(3))}%`);
L.push(`10. Return rates: 5p=${fmt(returnRateAfterD(5))}% 10p=${fmt(returnRateAfterD(10))}% 15p=${fmt(returnRateAfterD(15))}% 20p=${fmt(returnRateAfterD(20))}%`);
L.push(`11. After returning inside, median further inside travel: ${fmt(afterReturnInside.med)}p (P75 ${fmt(afterReturnInside.p75)} P90 ${fmt(afterReturnInside.p90)})`);
L.push(`12. Frozen-range rotation reach: 25% ${fmt(rotHits(25))}% | 50% ${fmt(rotHits(50))}% | 75% ${fmt(rotHits(75))}% | 100% ${fmt(rotHits(100))}% (nValid=${rotAll.length})`);
L.push(`13. RANGE vs SWING: range REJECT ${fmt(rate(rangeEnc, (e) => e.cls === "REJECT"))}% BR ${fmt(rate(rangeEnc, (e) => e.cls === "BREAK_RETURN"))}% | swing REJECT ${fmt(rate(swingEnc, (e) => e.cls === "REJECT"))}% BR ${fmt(rate(swingEnc, (e) => e.cls === "BREAK_RETURN"))}%`);
L.push(`14. Support vs Resistance: SUP REJECT ${fmt(rate(filterEnc(all, (e) => e.side === "support"), (e) => e.cls === "REJECT"))}% BR ${fmt(rate(filterEnc(all, (e) => e.side === "support"), (e) => e.cls === "BREAK_RETURN"))}% | RES REJECT ${fmt(rate(filterEnc(all, (e) => e.side === "resistance"), (e) => e.cls === "REJECT"))}% BR ${fmt(rate(filterEnc(all, (e) => e.side === "resistance"), (e) => e.cls === "BREAK_RETURN"))}%`);
L.push(`15. Distance-from-open matters:`);
for (const b of DIST_BUCKETS) {
  const e = filterEnc(all, (x) => x.openDistBucket === b.label);
  if (!e.length) continue;
  L.push(`   ${b.label}p: n=${e.length} REJECT ${fmt(rate(e, (x) => x.cls === "REJECT"))}% BR ${fmt(rate(e, (x) => x.cls === "BREAK_RETURN"))}% medPen ${fmt(pctile(e.map((x) => x.maxPenPips), 0.5))}`);
}
L.push(`16. Successful failed-breakout return time: med ${fmt(timeRet.med, 0)}m | P75 ${fmt(timeRet.p75, 0)}m | P90 ${fmt(timeRet.p90, 0)}m`);
L.push(`17. Period stability: 2013–19 REJECT ${fmt(earlyRej)}% BR ${fmt(earlyBR)}% | 2020–26 REJECT ${fmt(lateRej)}% BR ${fmt(lateBR)}%`);
L.push(`18. Rare giants distort averages? avgPen ${fmt(avgPen)} vs medPen ${fmt(medPen)} (ratio ${fmt(avgPen / medPen, 2)}). Robust medPen ${fmt(pctile(robust.map((e) => e.maxPenPips), 0.5))} vs primary ${fmt(medPen)}. ${avgDistorted ? "YES — means pulled by tail." : "Mild — medians preferred anyway."}`);
L.push(`19. Freezing S/R at session open: reject+return still ${fmt(q1 + q2)}% of encounters; after 5p break return ${fmt(d5Return)}%; after 10p ${fmt(d10Return)}%. This is ${(q1 + q2) >= 60 ? "still meaningful frozen-level behavior" : "weaker than classic dynamic-S/R charts suggest"} — dynamic repaint was ${(q1 + q2) >= 60 ? "not the sole source" : "likely a large contributor"} of previously observed respect.`);
L.push("");
L.push("=".repeat(88));
L.push(`VERDICT: ${verdict}`);
L.push("=".repeat(88));
L.push(`Strongest session: ${strongestSession} (by REJECT%+BREAK+RETURN%; post-break return leader: ${bestReturnSess[0]})`);
L.push(`Weakest session:   ${weakestSession}`);
L.push(`Strongest level type: ${typeStrength[0]!.t}`);
L.push(`Typical penetration (median all): ${fmt(medPen)}p`);
L.push(`Typical reversal distance (median inside): ${fmt(statsBlock(all.map((e) => e.maxInsidePips)).med)}p`);
L.push(
  `Most important discovery: with S/R frozen at session open (no repaint), ${fmt(q1)}% reject without meaningful break and ${fmt(q2)}% break-then-return; once price is already 5p beyond the frozen level, ${fmt(d5Return)}% still return inside before session end (${bestReturnSess[0]} best post-break return ${fmt(bestReturnSess[1])}%).`,
);
L.push("");
L.push(`Criteria note: STRONG if (REJECT+BR)≥70% and 5p-return≥55% and BREAK+STAY≤30%; MODERATE if (REJECT+BR)≥55% and 5p-return≥40%; else WEAK.`);
L.push(`Flags: rejectStrong=${rejectStrong} returnStrong=${returnStrong} stayWeak=${stayWeak}`);

const reportPath = path.join(OUT_DIR, "eurusd-frozen-session-sr-v18-report.txt");
const csvPath = path.join(OUT_DIR, "eurusd-frozen-session-sr-v18-encounters.csv");
fs.writeFileSync(reportPath, L.join("\n"));

const csvHeader = [
  "session",
  "side",
  "type",
  "year",
  "open_dist_pips",
  "open_dist_bucket",
  "class",
  "max_pen_pips",
  "max_inside_pips",
  "mins_to_max_pen",
  "mins_to_return",
  "retests",
  "hit_other_sr",
  "rot_valid",
  "max_rot_pct",
].join(",");
const csvLines = [csvHeader];
for (const e of encounters) {
  csvLines.push(
    [
      e.session,
      e.side,
      e.type,
      e.year,
      e.openDistPips.toFixed(2),
      e.openDistBucket,
      e.cls,
      e.maxPenPips.toFixed(3),
      e.maxInsidePips.toFixed(3),
      e.minsToMaxPen,
      Number.isFinite(e.minsToFirstReturn) ? e.minsToFirstReturn : "",
      e.retests,
      e.hitOtherSr ? 1 : 0,
      e.rotValid ? 1 : 0,
      e.maxRotPct.toFixed(1),
    ].join(","),
  );
}
fs.writeFileSync(csvPath, csvLines.join("\n"));

console.log(L.join("\n"));
console.log(`\nWrote ${reportPath}`);
console.log(`Wrote ${csvPath}`);
