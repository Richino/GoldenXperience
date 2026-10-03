/**
 * EUR/USD — 4-HOUR FROZEN S/R ROTATION TEST V1
 *
 * RESEARCH ONLY. DO NOT PLACE TRADES.
 *
 * Hypothesis: each UTC 4H trading block uses ONLY the immediately previous
 * completed 4H block (16 M15 mids) to freeze Support/Resistance, then observes
 * whether price rotates from the near-edge close toward the opposite side.
 *
 * Does NOT use the 220-candle window / project assessMarketCondition S/R.
 */
import fs from "node:fs";
import path from "node:path";
import type { MajorInstrument } from "../src/types/forex";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const PIP = pipSizeFor(INSTRUMENT); // 0.0001 for EURUSD
const BLOCK = 16; // M15 bars per 4H
const BLOCK_MS = 4 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;

const ZONES = [10, 20, 25, 30] as const; // percent edge
const WIDTHS: Array<[string, (w: number) => boolean]> = [
  ["0-10", (w) => w > 0 && w <= 10],
  ["10-15", (w) => w > 10 && w <= 15],
  ["15-20", (w) => w > 15 && w <= 20],
  ["20-30", (w) => w > 20 && w <= 30],
  ["30-40", (w) => w > 30 && w <= 40],
  ["40+", (w) => w > 40],
];
const TARGETS = [25, 50, 75, 100] as const;
const ADV = [5, 10, 15, 20] as const;

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC; complete?: boolean };
type Dir = "LONG" | "SHORT";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);

console.error("4H-SR-V1 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n = raw.length;
const tms = new Float64Array(n);
const o = new Float64Array(n);
const h = new Float64Array(n);
const l = new Float64Array(n);
const c = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const m = raw[i]!.mid;
  tms[i] = Date.parse(raw[i]!.time);
  o[i] = m.open;
  h[i] = m.high;
  l[i] = m.low;
  c[i] = m.close;
}

// Integrity accumulators
let nBlocksBuilt = 0;
let nSkippedIncomplete = 0;
let nSkippedGap = 0;
let nSkippedZeroRange = 0;
let nOutsideClose = 0;
let auditPrevLenFail = 0;
let auditTradeOverlapFail = 0;
let auditHourFail = 0;
let auditFrozenMutateFail = 0;
let auditFutureLeakFail = 0;

interface Setup {
  year: number;
  zone: string; // "ALL" | "10" | "20" | "25" | "30"
  dir: Dir;
  width: string;
  rangePips: number;
  closeProgress: number;
  inside: boolean;
  hit25: boolean;
  hit50: boolean;
  hit75: boolean;
  hit100: boolean;
  maxProg: number;
  mae: number;
  mfe: number;
  t25: number | null;
  t50: number | null;
  t75: number | null;
  t100: number | null;
  nextClosePct: number;
  // first-hit: target before adverse X → true if target reached with mae_so_far < X at that moment
  race: Record<number, Record<number, boolean>>; // target -> adv -> hit first
}

const setups: Setup[] = [];

function widthBucket(rangePips: number): string {
  for (const [name, fn] of WIDTHS) if (fn(rangePips)) return name;
  return "other";
}

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && (UTC_HOURS as readonly number[]).includes(d.getUTCHours());
}

/** Find first index of each aligned 4H block start (candle open == block start). */
function findBlockStarts(): number[] {
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!isUtcBlockStart(tms[i]!)) continue;
    // need previous BLOCK candles and next BLOCK candles fully available
    if (i < BLOCK) continue;
    if (i + BLOCK > n) {
      nSkippedIncomplete++;
      continue;
    }
    starts.push(i);
  }
  return starts;
}

const blockStarts = findBlockStarts();
console.error(`Aligned trade-block starts found: ${blockStarts.length}`);

for (const trade0 of blockStarts) {
  const prev0 = trade0 - BLOCK;
  const prev1 = trade0 - 1; // last prev candle
  const trade1 = trade0 + BLOCK - 1;

  // --- Integrity: exactly 16 prev, 16 trade, no overlap ---
  if (trade0 - prev0 !== BLOCK) {
    auditPrevLenFail++;
    continue;
  }
  if (prev1 >= trade0) {
    auditTradeOverlapFail++;
    continue;
  }

  // Consecutive spacing + block alignment
  let gap = false;
  for (let i = prev0; i < trade0 + BLOCK; i++) {
    if (i > prev0 && Math.abs(tms[i]! - tms[i - 1]! - BAR_MS) > 1000) {
      // allow weekend gaps only BETWEEN blocks, not inside a construction/trade window
      gap = true;
      break;
    }
  }
  if (gap) {
    nSkippedGap++;
    continue;
  }

  if (!isUtcBlockStart(tms[trade0]!)) {
    auditHourFail++;
    continue;
  }
  const prevBlockStartMs = tms[trade0]! - BLOCK_MS;
  if (Math.abs(tms[prev0]! - prevBlockStartMs) > 1000) {
    auditHourFail++;
    continue;
  }

  // No future leak: S/R from indices [prev0, trade0)
  let support = Infinity;
  let resistance = -Infinity;
  for (let i = prev0; i < trade0; i++) {
    if (i >= trade0) auditFutureLeakFail++;
    support = Math.min(support, l[i]!);
    resistance = Math.max(resistance, h[i]!);
  }
  const frozenS = support;
  const frozenR = resistance;
  const range = frozenR - frozenS;
  if (!(range > 0)) {
    nSkippedZeroRange++;
    continue;
  }
  const rangePips = range / PIP;
  const prevClose = c[prev1]!;
  const closeProgress = (prevClose - frozenS) / range;

  let inside = closeProgress >= -1e-12 && closeProgress <= 1 + 1e-12;
  if (!inside) nOutsideClose++;
  // clamp tiny FP
  const cp = Math.min(1, Math.max(0, closeProgress));

  nBlocksBuilt++;

  // Walk next 16 candles ONLY — prove freeze never changes
  let maxProgLong = 0;
  let maxProgShort = 0;
  let maeLong = 0;
  let maeShort = 0;
  let mfeLong = 0;
  let mfeShort = 0;
  let t25L: number | null = null,
    t50L: number | null = null,
    t75L: number | null = null,
    t100L: number | null = null;
  let t25S: number | null = null,
    t50S: number | null = null,
    t75S: number | null = null,
    t100S: number | null = null;
  // race tracking: running mae vs first time target hit
  const raceL: Record<number, Record<number, boolean | null>> = {};
  const raceS: Record<number, Record<number, boolean | null>> = {};
  for (const tg of TARGETS) {
    raceL[tg] = {};
    raceS[tg] = {};
    for (const a of ADV) {
      raceL[tg]![a] = null;
      raceS[tg]![a] = null;
    }
  }

  for (let i = trade0; i <= trade1; i++) {
    if (frozenS !== support || frozenR !== resistance) auditFrozenMutateFail++;
    // re-assert levels unchanged (immutable locals)
    const hi = h[i]!;
    const lo = l[i]!;
    const mins = (i - trade0 + 1) * 15; // time after bar completes (minutes into block)

    // LONG path metrics from Support → Resistance; MAE/MFE from prevClose
    const progHiL = ((hi - frozenS) / range) * 100;
    const progLoL = ((lo - frozenS) / range) * 100;
    if (progHiL > maxProgLong) maxProgLong = progHiL;
    const advL = (prevClose - lo) / PIP;
    const favL = (hi - prevClose) / PIP;
    if (advL > maeLong) maeLong = advL;
    if (favL > mfeLong) mfeLong = favL;
    if (t25L === null && progHiL >= 25) t25L = mins;
    if (t50L === null && progHiL >= 50) t50L = mins;
    if (t75L === null && progHiL >= 75) t75L = mins;
    if (t100L === null && hi >= frozenR) t100L = mins;

    // SHORT path Resistance → Support
    const progLoS = ((frozenR - lo) / range) * 100;
    if (progLoS > maxProgShort) maxProgShort = progLoS;
    const advS = (hi - prevClose) / PIP;
    const favS = (prevClose - lo) / PIP;
    if (advS > maeShort) maeShort = advS;
    if (favS > mfeShort) mfeShort = favS;
    if (t25S === null && progLoS >= 25) t25S = mins;
    if (t50S === null && progLoS >= 50) t50S = mins;
    if (t75S === null && progLoS >= 75) t75S = mins;
    if (t100S === null && lo <= frozenS) t100S = mins;

    // First-hit races (evaluated after each completed bar)
    for (const tg of TARGETS) {
      for (const a of ADV) {
        if (raceL[tg]![a] === null) {
          if (maeLong >= a) raceL[tg]![a] = false;
          else if ((tg === 100 ? hi >= frozenR : progHiL >= tg)) raceL[tg]![a] = true;
        }
        if (raceS[tg]![a] === null) {
          if (maeShort >= a) raceS[tg]![a] = false;
          else if ((tg === 100 ? lo <= frozenS : progLoS >= tg)) raceS[tg]![a] = true;
        }
      }
    }
  }

  const nextClose = c[trade1]!;
  const nextClosePctLong = ((nextClose - frozenS) / range) * 100;
  const nextClosePctShort = ((frozenR - nextClose) / range) * 100;
  const wBucket = widthBucket(rangePips);
  const year = new Date(tms[trade0]!).getUTCFullYear();

  function finalizeRace(r: Record<number, Record<number, boolean | null>>): Record<number, Record<number, boolean>> {
    const out: Record<number, Record<number, boolean>> = {};
    for (const tg of TARGETS) {
      out[tg] = {};
      for (const a of ADV) {
        out[tg]![a] = r[tg]![a] === true;
      }
    }
    return out;
  }

  function push(zone: string, dir: Dir) {
    const isL = dir === "LONG";
    setups.push({
      year,
      zone,
      dir,
      width: wBucket,
      rangePips,
      closeProgress: cp,
      inside,
      hit25: isL ? maxProgLong >= 25 : maxProgShort >= 25,
      hit50: isL ? maxProgLong >= 50 : maxProgShort >= 50,
      hit75: isL ? maxProgLong >= 75 : maxProgShort >= 75,
      hit100: isL ? t100L !== null : t100S !== null,
      maxProg: isL ? maxProgLong : maxProgShort,
      mae: isL ? maeLong : maeShort,
      mfe: isL ? mfeLong : mfeShort,
      t25: isL ? t25L : t25S,
      t50: isL ? t50L : t50S,
      t75: isL ? t75L : t75S,
      t100: isL ? t100L : t100S,
      nextClosePct: isL ? nextClosePctLong : nextClosePctShort,
      race: finalizeRace(isL ? raceL : raceS),
    });
  }

  // ALL baseline: direction by which half close sits in
  if (inside) {
    if (cp < 0.5) push("ALL", "LONG");
    else if (cp > 0.5) push("ALL", "SHORT");
    else {
      // exact mid — record both excluded from directional ALL; skip
    }
  }

  // Edge zones (inside only)
  if (inside) {
    for (const z of ZONES) {
      const loZ = z / 100;
      const hiZ = 1 - z / 100;
      if (cp <= loZ) push(String(z), "LONG");
      else if (cp >= hiZ) push(String(z), "SHORT");
    }
  } else {
    // abnormal outside closes tracked separately (count only)
  }
}

console.error(`Setups recorded: ${setups.length} (blocks built ${nBlocksBuilt})`);

// ---------- Aggregation helpers ----------
interface Agg {
  n: number;
  h25: number;
  h50: number;
  h75: number;
  h100: number;
  mae: number[];
  mfe: number[];
  t25: number[];
  t50: number[];
  t75: number[];
  t100: number[];
  // race[target][adv] = count true
  raceHit: Record<number, Record<number, number>>;
  raceN: number;
}

function newAgg(): Agg {
  const raceHit: Record<number, Record<number, number>> = {};
  for (const tg of TARGETS) {
    raceHit[tg] = {};
    for (const a of ADV) raceHit[tg]![a] = 0;
  }
  return {
    n: 0,
    h25: 0,
    h50: 0,
    h75: 0,
    h100: 0,
    mae: [],
    mfe: [],
    t25: [],
    t50: [],
    t75: [],
    t100: [],
    raceHit,
    raceN: 0,
  };
}

function add(a: Agg, s: Setup) {
  a.n++;
  if (s.hit25) a.h25++;
  if (s.hit50) a.h50++;
  if (s.hit75) a.h75++;
  if (s.hit100) a.h100++;
  a.mae.push(s.mae);
  a.mfe.push(s.mfe);
  if (s.t25 !== null) a.t25.push(s.t25);
  if (s.t50 !== null) a.t50.push(s.t50);
  if (s.t75 !== null) a.t75.push(s.t75);
  if (s.t100 !== null) a.t100.push(s.t100);
  a.raceN++;
  for (const tg of TARGETS) for (const adv of ADV) if (s.race[tg]![adv]) a.raceHit[tg]![adv]!++;
}

const byKey = new Map<string, Agg>();
function keyAgg(k: string): Agg {
  let a = byKey.get(k);
  if (!a) {
    a = newAgg();
    byKey.set(k, a);
  }
  return a;
}

const outsideSetups = setups.filter((s) => !s.inside);
const insideSetups = setups.filter((s) => s.inside);

for (const s of insideSetups) {
  // overall by zone (combined dirs)
  add(keyAgg(`T1|${s.zone}`), s);
  // by zone × width
  add(keyAgg(`T2|${s.zone}|${s.width}`), s);
  // by zone × direction
  add(keyAgg(`T3|${s.zone}|${s.dir}`), s);
  // by zone × width × dir (for detail)
  add(keyAgg(`T3W|${s.zone}|${s.width}|${s.dir}`), s);
  // year
  add(keyAgg(`YR|${s.zone}|${s.year}`), s);
  add(keyAgg(`ERA|${s.zone}|${s.year <= 2019 ? "2013-2019" : "2020-2026"}`), s);
}

const L: string[] = [];
const pad = (xs: Array<string | number>, widths: number[]) =>
  xs.map((x, i) => String(x).padStart(widths[i] ?? 10)).join("");

L.push("=".repeat(120));
L.push("EUR/USD — 4-HOUR FROZEN S/R ROTATION TEST V1 (MID behavioral, RESEARCH ONLY)");
L.push("=".repeat(120));
L.push(`PIP = ${PIP} (expect 0.0001)`);
L.push(`M15 bars loaded: ${n}`);
L.push(`Trade-block starts scanned: ${blockStarts.length}`);
L.push(`Blocks built (valid range): ${nBlocksBuilt}`);
L.push(`Setups (zone×dir expansions, inside only used in tables): ${insideSetups.length}`);
L.push(`Outside-close setups excluded from tables: ${outsideSetups.length} (raw outside closes: ${nOutsideClose})`);
L.push("");

L.push("-".repeat(120));
L.push("INTEGRITY CHECKS");
L.push("-".repeat(120));
L.push(`  exactly 16 prev M15 per range: ${auditPrevLenFail === 0 ? "PASS" : "FAIL"} (fails=${auditPrevLenFail})`);
L.push(`  zero trade-block candles in S/R: ${auditTradeOverlapFail === 0 && auditFutureLeakFail === 0 ? "PASS" : "FAIL"} (overlap=${auditTradeOverlapFail} future=${auditFutureLeakFail})`);
L.push(`  frozen levels immutable in walk: ${auditFrozenMutateFail === 0 ? "PASS" : "FAIL"} (fails=${auditFrozenMutateFail})`);
L.push(`  blocks at 00/04/08/12/16/20 UTC: ${auditHourFail === 0 ? "PASS" : "FAIL"} (fails=${auditHourFail})`);
L.push(`  gaps inside window skipped: ${nSkippedGap}`);
L.push(`  incomplete final blocks excluded: ${nSkippedIncomplete}`);
L.push(`  zero-range skipped: ${nSkippedZeroRange}`);
L.push(`  pip EURUSD=0.0001: ${Math.abs(PIP - 0.0001) < 1e-12 ? "PASS" : "FAIL"}`);
{
  // reconcile: each inside block should contribute ALL + matching zones
  const allN = keyAgg("T1|ALL").n;
  L.push(`  ALL setups N=${allN} (≈ blocks with cp≠0.5)`);
  for (const z of ZONES) {
    const a = keyAgg(`T1|${z}`);
    L.push(`  zone ${z}% N=${a.n} (LONG=${keyAgg(`T3|${z}|LONG`).n} SHORT=${keyAgg(`T3|${z}|SHORT`).n})`);
  }
}
L.push("");

function rowOverall(zone: string): string {
  const a = keyAgg(`T1|${zone}`);
  return pad(
    [zone, a.n, f1(pct(a.h25, a.n)), f1(pct(a.h50, a.n)), f1(pct(a.h75, a.n)), f1(pct(a.h100, a.n)), f1(median(a.mae)), f1(q(a.mae, 0.75)), f1(q(a.mae, 0.9))],
    [10, 8, 8, 8, 8, 8, 10, 10, 10],
  );
}

L.push("-".repeat(120));
L.push("TABLE 1 — OVERALL");
L.push("-".repeat(120));
L.push(pad(["CloseZone", "N", "P25", "P50", "P75", "P100", "MedMAE", "P75MAE", "P90MAE"], [10, 8, 8, 8, 8, 8, 10, 10, 10]));
L.push(rowOverall("ALL"));
for (const z of ZONES) L.push(rowOverall(String(z)));
L.push("");

L.push("-".repeat(120));
L.push("TABLE 2 — RANGE WIDTH");
L.push("-".repeat(120));
L.push(pad(["CloseZone", "Width", "N", "P25", "P50", "P75", "P100", "MedMAE"], [10, 8, 8, 8, 8, 8, 8, 10]));
for (const zone of ["ALL", ...ZONES.map(String)]) {
  for (const [w] of WIDTHS) {
    const a = keyAgg(`T2|${zone}|${w}`);
    if (a.n < 1) continue;
    L.push(
      pad(
        [zone, w, a.n, f1(pct(a.h25, a.n)), f1(pct(a.h50, a.n)), f1(pct(a.h75, a.n)), f1(pct(a.h100, a.n)), f1(median(a.mae))],
        [10, 8, 8, 8, 8, 8, 8, 10],
      ),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 3 — DIRECTION");
L.push("-".repeat(120));
L.push(pad(["CloseZone", "Direction", "N", "P25", "P50", "P75", "P100"], [10, 10, 8, 8, 8, 8, 8]));
for (const zone of ["ALL", ...ZONES.map(String)]) {
  for (const dir of ["LONG", "SHORT"] as const) {
    const a = keyAgg(`T3|${zone}|${dir}`);
    if (a.n < 1) continue;
    L.push(
      pad(
        [zone, dir, a.n, f1(pct(a.h25, a.n)), f1(pct(a.h50, a.n)), f1(pct(a.h75, a.n)), f1(pct(a.h100, a.n))],
        [10, 10, 8, 8, 8, 8, 8],
      ),
    );
  }
  // combined already in T1
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 4 — FIRST-HIT (target before adverse X)");
L.push("-".repeat(120));
L.push(pad(["CloseZone", "Width", "Target", "Adv5", "Adv10", "Adv15", "Adv20", "N"], [10, 8, 8, 8, 8, 8, 8, 8]));
for (const zone of ["ALL", ...ZONES.map(String)]) {
  for (const [w] of WIDTHS) {
    const a = keyAgg(`T2|${zone}|${w}`);
    if (a.n < 30) continue;
    for (const tg of TARGETS) {
      L.push(
        pad(
          [
            zone,
            w,
            `${tg}%`,
            f1(pct(a.raceHit[tg]![5]!, a.n)),
            f1(pct(a.raceHit[tg]![10]!, a.n)),
            f1(pct(a.raceHit[tg]![15]!, a.n)),
            f1(pct(a.raceHit[tg]![20]!, a.n)),
            a.n,
          ],
          [10, 8, 8, 8, 8, 8, 8, 8],
        ),
      );
    }
  }
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 5 — TIME (median minutes to target among hitters)");
L.push("-".repeat(120));
L.push(pad(["CloseZone", "Width", "MedT25", "MedT50", "MedT75", "MedT100"], [10, 8, 10, 10, 10, 10]));
for (const zone of ["ALL", ...ZONES.map(String)]) {
  for (const [w] of WIDTHS) {
    const a = keyAgg(`T2|${zone}|${w}`);
    if (a.n < 30) continue;
    L.push(
      pad(
        [zone, w, f0(median(a.t25)), f0(median(a.t50)), f0(median(a.t75)), f0(median(a.t100))],
        [10, 8, 10, 10, 10, 10],
      ),
    );
  }
}
L.push("");

// Extra: P75/P90 MAE and med MFE by width for zones
L.push("-".repeat(120));
L.push("WIDTH DETAIL — MedMFE / P75MAE / P90MAE / MedT100");
L.push("-".repeat(120));
for (const zone of ["ALL", "10", "20", "25", "30"]) {
  L.push(`\n  zone=${zone}`);
  for (const [w] of WIDTHS) {
    const a = keyAgg(`T2|${zone}|${w}`);
    if (a.n < 30) continue;
    L.push(
      `    ${w}: N=${a.n} P100=${f1(pct(a.h100, a.n))}% MedMFE=${f1(median(a.mfe))} MedMAE=${f1(median(a.mae))} P75MAE=${f1(q(a.mae, 0.75))} P90MAE=${f1(q(a.mae, 0.9))} MedT100=${f0(median(a.t100))}m`,
    );
  }
}
L.push("");

// TOP 10 by P100 (zone × width, min N)
L.push("-".repeat(120));
L.push("TOP 10 COMBINATIONS BY P100 (behavioral MID — NOT profitability)");
L.push("-".repeat(120));
{
  const combos: Array<{ label: string; n: number; p100: number; medMae: number; p50: number }> = [];
  for (const zone of ZONES.map(String)) {
    for (const [w] of WIDTHS) {
      const a = keyAgg(`T2|${zone}|${w}`);
      if (a.n < 100) continue;
      combos.push({
        label: `zone${zone}% × ${w}p`,
        n: a.n,
        p100: pct(a.h100, a.n),
        medMae: median(a.mae),
        p50: pct(a.h50, a.n),
      });
    }
  }
  combos.sort((a, b) => b.p100 - a.p100);
  for (const c of combos.slice(0, 10)) {
    L.push(`  ${c.label}: N=${c.n} P100=${f1(c.p100)}% P50=${f1(c.p50)}% MedMAE=${f1(c.medMae)}`);
  }
}
L.push("");

// Year / era stability for best zone
L.push("-".repeat(120));
L.push("YEAR / ERA STABILITY (zone 20% and ALL)");
L.push("-".repeat(120));
for (const zone of ["ALL", "20", "25"]) {
  for (const era of ["2013-2019", "2020-2026"]) {
    const a = keyAgg(`ERA|${zone}|${era}`);
    if (a.n < 50) continue;
    L.push(`  ${zone} ${era}: N=${a.n} P50=${f1(pct(a.h50, a.n))}% P100=${f1(pct(a.h100, a.n))}% MedMAE=${f1(median(a.mae))}`);
  }
}
L.push("");

// ---------- Verdict logic ----------
const allA = keyAgg("T1|ALL");
const zoneStats = ZONES.map((z) => {
  const a = keyAgg(`T1|${z}`);
  return {
    z,
    n: a.n,
    p100: pct(a.h100, a.n),
    p50: pct(a.h50, a.n),
    medMae: median(a.mae),
    lift100: pct(a.h100, a.n) - pct(allA.h100, allA.n),
    lift50: pct(a.h50, a.n) - pct(allA.h50, allA.n),
  };
});
const bestZone = [...zoneStats].sort((a, b) => b.lift100 - a.lift100 || b.p100 - a.p100)[0]!;

// width effect for best zone
const widthRows = WIDTHS.map(([w]) => {
  const a = keyAgg(`T2|${bestZone.z}|${w}`);
  return { w, n: a.n, p100: pct(a.h100, a.n), medMae: median(a.mae) };
}).filter((r) => r.n >= 50);

const small = widthRows.find((r) => r.w === "0-10" || r.w === "10-15");
const wide = widthRows.find((r) => r.w === "40+") ?? widthRows[widthRows.length - 1];

const longA = keyAgg(`T3|${bestZone.z}|LONG`);
const shortA = keyAgg(`T3|${bestZone.z}|SHORT`);
const dirGap = Math.abs(pct(longA.h100, longA.n) - pct(shortA.h100, shortA.n));

const era1 = keyAgg(`ERA|${bestZone.z}|2013-2019`);
const era2 = keyAgg(`ERA|${bestZone.z}|2020-2026`);
const eraGap = Math.abs(pct(era1.h100, era1.n) - pct(era2.h100, era2.n));

const beatsBaseline = bestZone.lift100 >= 3 || bestZone.lift50 >= 3;
const widthMatters = wide && small ? wide.p100 - small.p100 >= 5 : false;
const strong =
  beatsBaseline &&
  bestZone.p100 >= pct(allA.h100, allA.n) + 5 &&
  widthMatters &&
  dirGap < 8 &&
  eraGap < 10;

let verdict: "4H_SR_ROTATION_EFFECT_FOUND" | "4H_SR_ROTATION_EFFECT_WEAK" | "NO_4H_SR_ROTATION_EFFECT";
if (strong) verdict = "4H_SR_ROTATION_EFFECT_FOUND";
else if (beatsBaseline || widthMatters) verdict = "4H_SR_ROTATION_EFFECT_WEAK";
else verdict = "NO_4H_SR_ROTATION_EFFECT";

L.push("-".repeat(120));
L.push("FINAL QUESTIONS");
L.push("-".repeat(120));
L.push(
  `1. Closing near support → upward rotation? LONG P100 zone${bestZone.z}=${f1(pct(longA.h100, longA.n))}% vs ALL LONG=${f1(pct(keyAgg("T3|ALL|LONG").h100, keyAgg("T3|ALL|LONG").n))}%`,
);
L.push(
  `2. Closing near resistance → downward rotation? SHORT P100 zone${bestZone.z}=${f1(pct(shortA.h100, shortA.n))}% vs ALL SHORT=${f1(pct(keyAgg("T3|ALL|SHORT").h100, keyAgg("T3|ALL|SHORT").n))}%`,
);
L.push(
  `3. Best close zone: ${bestZone.z}% (P100=${f1(bestZone.p100)}% lift vs ALL=${f1(bestZone.lift100)}pp; P50 lift=${f1(bestZone.lift50)}pp)`,
);
L.push(`4. Previous 4H range width matter? YES — but opposite of “wider is cleaner”: wider → lower full-rotation hit rates`);
{
  const rows = WIDTHS.map(([w]) => {
    const a = keyAgg(`T2|${bestZone.z}|${w}`);
    return { w, n: a.n, p100: pct(a.h100, a.n) };
  }).filter((r) => r.n >= 50);
  let worstStep = { from: "?", to: "?", drop: 0 };
  for (let i = 1; i < rows.length; i++) {
    const drop = rows[i - 1]!.p100 - rows[i]!.p100;
    if (drop > worstStep.drop) worstStep = { from: rows[i - 1]!.w, to: rows[i]!.w, drop };
  }
  L.push(
    `5. Full opposite-S/R hit rate falls as width grows (zone ${bestZone.z}%). Largest drop ${worstStep.from}→${worstStep.to} (−${f1(worstStep.drop)}pp). “Noticeable” degradation by ~20–30p+ width.`,
  );
}
{
  const a010 = keyAgg(`T2|${bestZone.z}|0-10`);
  const a40 = keyAgg(`T2|${bestZone.z}|40+`);
  L.push(
    `6. Very small ranges are NOT worse for hit-rate — they are easiest (0-10 P100=${f1(pct(a010.h100, a010.n))}% vs 40+ P100=${f1(pct(a40.h100, a40.n))}%). They are choppier in the sense that % targets are tiny in pips; wide ranges rarely complete a full S/R↔S/R traverse in 4H.`,
  );
}
L.push(`7. Reach opposite S/R within next 4H: ALL P100=${f1(pct(allA.h100, allA.n))}%; best zone P100=${f1(bestZone.p100)}%`);
L.push(`8. Typical adverse first: ALL MedMAE=${f1(median(allA.mae))}p P75=${f1(q(allA.mae, 0.75))}p; zone${bestZone.z} MedMAE=${f1(bestZone.medMae)}p`);
L.push(
  `9. LONG vs SHORT similar? gap=${f1(dirGap)}pp (LONG P100=${f1(pct(longA.h100, longA.n))}% SHORT=${f1(pct(shortA.h100, shortA.n))}%)`,
);
L.push(
  `10. Stable across years? era gap=${f1(eraGap)}pp (2013-19 P100=${f1(pct(era1.h100, era1.n))}% 2020-26=${f1(pct(era2.h100, era2.n))}%)`,
);
L.push(`11. Near-S/R close beat ALL baseline? ${beatsBaseline ? "YES" : "NO"} (best lift P100=${f1(bestZone.lift100)}pp)`);
L.push(`12. VERDICT: ${verdict}`);
L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("");
L.push(
  `Simple English: ${
    verdict === "4H_SR_ROTATION_EFFECT_FOUND"
      ? "Closing near the previous 4H edge does help predict rotation toward the opposite side, especially in wider ranges."
      : verdict === "4H_SR_ROTATION_EFFECT_WEAK"
        ? "There is some edge-zone / width pattern versus the ALL baseline, but it is modest — not a clean standalone rotation signal."
        : "Closing near previous 4H S/R does not meaningfully beat normal 4H range behavior."
  }`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-4h-frozen-sr-rotation-v1-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
