/**
 * EUR/USD — OUTER S/R 10-PIP REVERSAL TIME STUDY
 *
 * Standalone structural behavior test. No strategy / SL / RR / optimization.
 *
 * Production S/R (exact):
 *   file:     frontend/src/lib/strategy/support-resistance.ts
 *   function: computeSupportResistanceLevels
 *   constants (must match that file): PIVOT_REACH=5, RANGE_LOOKBACK=60, VISIBLE_LOOKBACK=160
 *
 * Chart consumer: signal-workspace.tsx → supportResistanceLines → computeSupportResistanceLevels
 *
 * Question: after a range breakout reaches the next outer production S/R,
 * how often does price reverse ≥10 pips, and how long does that take?
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = 0.0001;
const REVERSAL_PIPS = 10;
const REVERSAL = REVERSAL_PIPS * PIP;
const BAR_MIN = 15;
const HORIZON_BARS = (24 * 60) / BAR_MIN; // 96
const DEPTHS_P = [1, 3, 5, 7.5, 10, 15, 20] as const;
const TIME_WINDOWS_MIN = [15, 30, 45, 60, 120, 240, 360, 480, 720, 1440] as const;
const EXCURSION_TARGETS_P = [2, 3, 5, 7.5, 10, 12.5, 15, 20, 30] as const;
const TIME_TO_TARGETS_P = [3, 5, 7.5, 10, 15, 20] as const;

/** Must match support-resistance.ts exactly (verified at runtime against source). */
const PIVOT_REACH = 5;
const RANGE_LOOKBACK = 60;
const VISIBLE_LOOKBACK = 160;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "sr-outer-10pip-reversal-time-study.txt");
const CACHE_PATH = path.join(OUT_DIR, "cache", "eurusd-m15-mid-for-outer-10pip.json");
const SR_SRC = path.resolve(__dirname, "../src/lib/strategy/support-resistance.ts");
const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : NaN);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const quantile = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! * (hi - idx) + s[hi]! * (idx - lo);
};
const median = (a: number[]) => quantile(a, 0.5);
const fmtHM = (mins: number) => {
  if (!Number.isFinite(mins)) return "-";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return `${h}h ${m}m`;
};

type Dir = "UP" | "DOWN";

type OuterTouchEvent = {
  id: string;
  uniqueKey: string;
  depthP: number;
  dir: Dir;
  breakIdx: number;
  breakTime: string;
  oldLevel: number;
  outerLevel: number;
  touchIdx: number;
  touchTime: string;
  touchPrice: number;
  /** minutes from touch bar to first bar that completes REVERSAL_PIPS (NaN if never ≤24h) */
  rev10Min: number;
  hit10: boolean;
  maxRevP: number;
  /** continuation beyond outer in breakout direction within 24h (failures only meaningful) */
  contBeyondP: number;
  /** minutes to each pip target (NaN if not hit ≤24h) */
  timeToTarget: Record<number, number>;
};

function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) throw new Error(`Missing ${ENV_PATH}`);
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function verifyProductionConstants(): void {
  const src = fs.readFileSync(SR_SRC, "utf8");
  const need: Array<[string, number]> = [
    ["PIVOT_REACH", PIVOT_REACH],
    ["RANGE_LOOKBACK", RANGE_LOOKBACK],
    ["VISIBLE_LOOKBACK", VISIBLE_LOOKBACK],
  ];
  for (const [name, val] of need) {
    const re = new RegExp(`const ${name} = (\\d+)`);
    const m = re.exec(src);
    if (!m) throw new Error(`Could not verify ${name} in ${SR_SRC}`);
    if (Number(m[1]) !== val) {
      throw new Error(`Constant mismatch ${name}: script=${val} production=${m[1]}`);
    }
  }
  if (!src.includes("export function computeSupportResistanceLevels")) {
    throw new Error("computeSupportResistanceLevels not found in production file");
  }
}

/** Identical pivot scan to support-resistance.ts (for next-outer above/below broken range). */
function collectSwingPivots(visible: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = PIVOT_REACH; index < visible.length - PIVOT_REACH; index += 1) {
    const candle = visible[index]!;
    const window = visible.slice(index - PIVOT_REACH, index + PIVOT_REACH + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) {
      highs.push(candle.high);
    }
    if (window.every((other) => other === candle || other.low >= candle.low)) {
      lows.push(candle.low);
    }
  }
  return { highs, lows };
}

function windowFor(candles: Candle[], endExclusive: number): Candle[] {
  const start = Math.max(0, endExclusive - VISIBLE_LOOKBACK);
  return candles.slice(start, endExclusive);
}

function findNewOuter(
  candles: Candle[],
  breakIdx: number,
  dir: Dir,
  oldLevel: number,
): number | null {
  // Levels known at breakout: completed candles through breakIdx inclusive.
  const visible = windowFor(candles, breakIdx + 1);
  const { highs, lows } = collectSwingPivots(visible);
  const eps = PIP * 0.25;
  if (dir === "UP") {
    const above = highs.filter((h) => h > oldLevel + eps);
    if (!above.length) return null;
    return Math.min(...above);
  }
  const below = lows.filter((l) => l < oldLevel - eps);
  if (!below.length) return null;
  return Math.max(...below);
}

async function loadOrFetchM15(): Promise<{ candles: Candle[]; source: string }> {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Array<{
      time: string;
      volume: number;
      complete: boolean;
      mid: { open: number; high: number; low: number; close: number };
    }>;
    const candles: Candle[] = raw
      .filter((c) => c.complete && c.mid)
      .map((c) => ({
        time: c.time,
        open: c.mid.open,
        high: c.mid.high,
        low: c.mid.low,
        close: c.mid.close,
        volume: c.volume ?? 0,
        complete: true,
      }));
    if (candles.length > 10_000) {
      return { candles, source: `local cache ${CACHE_PATH} (OANDA M15 MID)` };
    }
  }

  loadEnv();
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const START = "2013-01-01T00:00:00Z";
  const BATCH = 5000;
  const byTime = new Map<string, { time: string; volume: number; complete: boolean; mid: Candle["open"] extends number ? { open: number; high: number; low: number; close: number } : never }>();
  let cursor: string | undefined;
  let round = 0;
  process.stderr.write("Fetching OANDA EUR_USD M15 MBA (using MID)...\n");
  while (true) {
    round++;
    const batch = await getResearchCandles("EUR_USD", "M15", BATCH, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) byTime.set(c.time, c as never);
    const earliest = batch[0]!.time;
    process.stderr.write(`  round ${round}: +${batch.length} total=${byTime.size} oldest=${earliest}\n`);
    if (earliest <= START) break;
    if (cursor && earliest === cursor) break;
    cursor = earliest;
    if (round > 120) break;
  }
  const rows = [...byTime.values()]
    .filter((c) => c.complete && c.time >= START)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(rows));
  process.stderr.write(`[cache written] ${CACHE_PATH} n=${rows.length}\n`);
  const candles: Candle[] = rows.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: c.volume ?? 0,
    complete: true,
  }));
  return { candles, source: `OANDA getResearchCandles MBA→MID (cached to ${CACHE_PATH})` };
}

function measureFromTouch(
  candles: Candle[],
  touchIdx: number,
  touchPrice: number,
  dir: Dir,
): {
  rev10Min: number;
  hit10: boolean;
  maxRevP: number;
  contBeyondP: number;
  timeToTarget: Record<number, number>;
} {
  const end = Math.min(candles.length - 1, touchIdx + HORIZON_BARS);
  let maxRev = 0;
  let maxCont = 0;
  let rev10Min = NaN;
  const timeToTarget: Record<number, number> = {};
  for (const t of TIME_TO_TARGETS_P) timeToTarget[t] = NaN;

  for (let j = touchIdx; j <= end; j++) {
    const bar = candles[j]!;
    const mins = (j - touchIdx) * BAR_MIN;
    if (dir === "UP") {
      // reverse = down from touch
      const rev = touchPrice - bar.low;
      maxRev = Math.max(maxRev, rev);
      maxCont = Math.max(maxCont, bar.high - touchPrice);
      if (!Number.isFinite(rev10Min) && rev >= REVERSAL) rev10Min = mins;
      for (const t of TIME_TO_TARGETS_P) {
        if (!Number.isFinite(timeToTarget[t]!) && rev >= t * PIP) timeToTarget[t] = mins;
      }
    } else {
      const rev = bar.high - touchPrice;
      maxRev = Math.max(maxRev, rev);
      maxCont = Math.max(maxCont, touchPrice - bar.low);
      if (!Number.isFinite(rev10Min) && rev >= REVERSAL) rev10Min = mins;
      for (const t of TIME_TO_TARGETS_P) {
        if (!Number.isFinite(timeToTarget[t]!) && rev >= t * PIP) timeToTarget[t] = mins;
      }
    }
  }

  return {
    rev10Min,
    hit10: Number.isFinite(rev10Min) && rev10Min <= 24 * 60,
    maxRevP: maxRev / PIP,
    contBeyondP: maxCont / PIP,
    timeToTarget,
  };
}

function hitRateByWindow(events: OuterTouchEvent[], windowMin: number): number {
  const hits = events.filter((e) => e.hit10 && e.rev10Min <= windowMin).length;
  return pct(hits, events.length);
}

function successTimes(events: OuterTouchEvent[]): number[] {
  return events.filter((e) => e.hit10).map((e) => e.rev10Min);
}

function printTimeTable(title: string, events: OuterTouchEvent[]): void {
  log(title);
  log("-".repeat(72));
  if (!events.length) {
    log("  (no events)");
    log("");
    return;
  }
  log("TIME | 10-PIP REVERSAL HIT");
  for (const w of TIME_WINDOWS_MIN) {
    const label =
      w < 60 ? `${w}m` : w === 60 ? "1H" : w === 120 ? "2H" : w === 240 ? "4H" : w === 360 ? "6H" : w === 480 ? "8H" : w === 720 ? "12H" : "24H";
    log(`${label.padStart(4)} | ${f1(hitRateByWindow(events, w))}%`);
  }
  const st = successTimes(events);
  log(`N outer touches=${events.length}  10p≤24H successes=${st.length} (${f1(pct(st.length, events.length))}%)`);
  if (st.length) {
    log(
      `  success time min: avg=${f1(mean(st))} (${fmtHM(mean(st))}) med=${f1(median(st))} (${fmtHM(median(st))}) P25=${f1(quantile(st, 0.25))} P50=${f1(quantile(st, 0.5))} P75=${f1(quantile(st, 0.75))} P90=${f1(quantile(st, 0.9))}`,
    );
  }
  log("");
}

async function main(): Promise<void> {
  verifyProductionConstants();
  const { candles, source } = await loadOrFetchM15();
  const n = candles.length;
  if (n < VISIBLE_LOOKBACK + 50) throw new Error(`Too few candles: ${n}`);

  let lookaheadViolations = 0;
  let totalBreakoutTriggers = 0;
  let uniqueBreakoutExcursions = 0;
  let outerLevelsFound = 0;
  let outerLevelsReached = 0;

  const depthEvents: OuterTouchEvent[] = [];
  // Track open excursions so depths share one excursion id
  // After a 1p break, stay in excursion until price re-enters inside old range (close back through level).
  type Exc = {
    dir: Dir;
    oldLevel: number;
    startIdx: number;
    depthsFired: Set<number>;
    outerByDepth: Map<number, number | null>;
  };
  let openUp: Exc | null = null;
  let openDown: Exc | null = null;

  process.stderr.write(`Scanning ${n} M15 bars...\n`);

  for (let i = VISIBLE_LOOKBACK; i < n; i++) {
    if (i % 50_000 === 0) process.stderr.write(`  idx ${i}/${n}\n`);
    const bar = candles[i]!;
    // Production levels from completed candles BEFORE this bar only (no lookahead).
    const prior = windowFor(candles, i);
    if (prior.length < 20) continue;
    const levels = computeSupportResistanceLevels(prior, INSTRUMENT);
    if (!levels) continue;

    // Integrity: levels.current must equal prior last close
    if (Math.abs(levels.current - prior[prior.length - 1]!.close) > 1e-12) lookaheadViolations++;

    const oldRes = levels.rangeHigh;
    const oldSup = levels.rangeLow;

    const tryRecord = (
      exc: Exc,
      depthP: number,
      breakIdx: number,
      breakTime: string,
    ) => {
      if (exc.depthsFired.has(depthP)) return;
      const barX = candles[breakIdx]!;
      if (exc.dir === "UP") {
        if (barX.high < exc.oldLevel + depthP * PIP) return;
      } else {
        if (barX.low > exc.oldLevel - depthP * PIP) return;
      }
      exc.depthsFired.add(depthP);
      totalBreakoutTriggers++;
      const outer = findNewOuter(candles, breakIdx, exc.dir, exc.oldLevel);
      exc.outerByDepth.set(depthP, outer);
      if (outer == null) return;
      outerLevelsFound++;
      let touchIdx = -1;
      const limit = Math.min(n - 1, breakIdx + HORIZON_BARS * 5);
      for (let j = breakIdx; j <= limit; j++) {
        if (exc.dir === "UP" ? candles[j]!.high >= outer : candles[j]!.low <= outer) {
          touchIdx = j;
          break;
        }
      }
      if (touchIdx < 0) return;
      outerLevelsReached++;
      const touchPrice = outer;
      const m = measureFromTouch(candles, touchIdx, touchPrice, exc.dir);
      const id = `${exc.dir}|d${depthP}|br${breakIdx}|t${touchIdx}|o${outer.toFixed(5)}`;
      const uniqueKey = `${exc.dir}|${outer.toFixed(5)}|${touchIdx}`;
      depthEvents.push({
        id,
        uniqueKey,
        depthP,
        dir: exc.dir,
        breakIdx,
        breakTime,
        oldLevel: exc.oldLevel,
        outerLevel: outer,
        touchIdx,
        touchTime: candles[touchIdx]!.time,
        touchPrice,
        ...m,
      });
    };

    // Close open excursions if price re-enters the frozen broken level
    if (openUp && bar.close < openUp.oldLevel) openUp = null;
    if (openDown && bar.close > openDown.oldLevel) openDown = null;

    // Start UP excursion on first 1p break of current rangeHigh
    if (!openUp && bar.high >= oldRes + 1 * PIP) {
      openUp = { dir: "UP", oldLevel: oldRes, startIdx: i, depthsFired: new Set(), outerByDepth: new Map() };
      uniqueBreakoutExcursions++;
    }
    if (openUp) {
      for (const depthP of DEPTHS_P) tryRecord(openUp, depthP, i, bar.time);
    }

    // Start DOWN excursion on first 1p break of current rangeLow
    if (!openDown && bar.low <= oldSup - 1 * PIP) {
      openDown = { dir: "DOWN", oldLevel: oldSup, startIdx: i, depthsFired: new Set(), outerByDepth: new Map() };
      uniqueBreakoutExcursions++;
    }
    if (openDown) {
      for (const depthP of DEPTHS_P) tryRecord(openDown, depthP, i, bar.time);
    }
  }

  // Unique outer-touch events (one row per uniqueKey; keep first by time)
  const uniqueMap = new Map<string, OuterTouchEvent>();
  for (const e of depthEvents) {
    const prev = uniqueMap.get(e.uniqueKey);
    if (!prev || e.touchIdx < prev.touchIdx || (e.touchIdx === prev.touchIdx && e.depthP < prev.depthP)) {
      uniqueMap.set(e.uniqueKey, e);
    }
  }
  const uniqueEvents = [...uniqueMap.values()].sort((a, b) => a.touchIdx - b.touchIdx);

  const ids = depthEvents.map((e) => e.id);
  const duplicateEventIds = ids.length - new Set(ids).size;

  const successes = uniqueEvents.filter((e) => e.hit10);
  const failures = uniqueEvents.filter((e) => !e.hit10);

  // ---- REPORT ----
  log("=".repeat(78));
  log("EUR/USD — OUTER S/R 10-PIP REVERSAL TIME STUDY");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("1. DATA");
  log("-".repeat(78));
  log(`  Instrument: EUR_USD`);
  log(`  Granularity: M15`);
  log(`  Price: MID (from OANDA MBA)`);
  log(`  Pip size: ${PIP} (10 pips = ${REVERSAL})`);
  log(`  Candle count: ${n}`);
  log(`  Start: ${candles[0]!.time}`);
  log(`  End:   ${candles[n - 1]!.time}`);
  log(`  Data source: ${source}`);
  log("");
  log("2. PRODUCTION S/R");
  log("-".repeat(78));
  log(`  File:     frontend/src/lib/strategy/support-resistance.ts`);
  log(`  Function: computeSupportResistanceLevels`);
  log(`  Chart wiring: signal-workspace.tsx → supportResistanceLines → computeSupportResistanceLevels`);
  log(`  PIVOT_REACH      = ${PIVOT_REACH}  (verified against source)`);
  log(`  RANGE_LOOKBACK  = ${RANGE_LOOKBACK} (verified against source)`);
  log(`  VISIBLE_LOOKBACK= ${VISIBLE_LOOKBACK} (verified against source)`);
  log(`  Old range freeze: rangeHigh / rangeLow from computeSupportResistanceLevels(prior bars only)`);
  log(`  New outer: nearest swing pivot beyond broken rangeHigh/rangeLow using identical PIVOT_REACH scan`);
  log(`            on the same VISIBLE_LOOKBACK window (swing highs above old resistance / lows below old support)`);
  log("");

  printTimeTable("7. TIME WINDOWS — UNIQUE OUTER-TOUCH EVENTS (main)", uniqueEvents);
  printTimeTable("7b. TIME WINDOWS — ALL DEPTH-TRIGGER EVENTS (non-unique)", depthEvents);

  log("8. REVERSAL TIME (unique, successful ≤24H 10-pip only)");
  log("-".repeat(78));
  {
    const st = successTimes(uniqueEvents);
    if (!st.length) log("  (none)");
    else {
      log(`  N successes=${st.length}`);
      log(`  Average: ${f1(mean(st))} min (${fmtHM(mean(st))})`);
      log(`  Median:  ${f1(median(st))} min (${fmtHM(median(st))})`);
      log(`  P25: ${f1(quantile(st, 0.25))} min (${fmtHM(quantile(st, 0.25))})`);
      log(`  P50: ${f1(quantile(st, 0.5))} min (${fmtHM(quantile(st, 0.5))})`);
      log(`  P75: ${f1(quantile(st, 0.75))} min (${fmtHM(quantile(st, 0.75))})`);
      log(`  P90: ${f1(quantile(st, 0.9))} min (${fmtHM(quantile(st, 0.9))})`);
    }
  }
  log("");

  log("9. BREAKOUT DEPTH (depth-trigger events that reached outer)");
  log("-".repeat(78));
  log(
    "DEPTH | N OUTER TOUCHES | 10P≤15M | ≤30M | ≤1H | ≤2H | ≤4H | ≤8H | ≤12H | ≤24H | MEDIAN TIME",
  );
  for (const depthP of DEPTHS_P) {
    const ev = depthEvents.filter((e) => e.depthP === depthP);
    const st = successTimes(ev);
    const row = [
      String(depthP).padStart(5),
      String(ev.length).padStart(16),
      f1(hitRateByWindow(ev, 15)).padStart(8),
      f1(hitRateByWindow(ev, 30)).padStart(6),
      f1(hitRateByWindow(ev, 60)).padStart(5),
      f1(hitRateByWindow(ev, 120)).padStart(5),
      f1(hitRateByWindow(ev, 240)).padStart(5),
      f1(hitRateByWindow(ev, 480)).padStart(5),
      f1(hitRateByWindow(ev, 720)).padStart(6),
      f1(hitRateByWindow(ev, 1440)).padStart(6),
      (st.length ? f1(median(st)) + "m" : "-").padStart(12),
    ].join(" | ");
    log(row);
  }
  log("");

  log("10. UP VS DOWN (unique outer-touch)");
  log("-".repeat(78));
  log("DIRECTION | N | 15M | 30M | 1H | 2H | 4H | 8H | 12H | 24H | MEDIAN");
  for (const dir of ["UP", "DOWN", "COMBINED"] as const) {
    const ev = dir === "COMBINED" ? uniqueEvents : uniqueEvents.filter((e) => e.dir === dir);
    const st = successTimes(ev);
    log(
      [
        dir.padEnd(9),
        String(ev.length).padStart(2),
        f1(hitRateByWindow(ev, 15)),
        f1(hitRateByWindow(ev, 30)),
        f1(hitRateByWindow(ev, 60)),
        f1(hitRateByWindow(ev, 120)),
        f1(hitRateByWindow(ev, 240)),
        f1(hitRateByWindow(ev, 480)),
        f1(hitRateByWindow(ev, 720)),
        f1(hitRateByWindow(ev, 1440)),
        st.length ? `${f1(median(st))}m` : "-",
      ].join(" | "),
    );
  }
  log("");

  log("11. MAX REVERSAL EXCURSION within 24H (unique)");
  log("-".repeat(78));
  {
    const mx = uniqueEvents.map((e) => e.maxRevP);
    log(`  Average: ${f1(mean(mx))} pips`);
    log(`  Median:  ${f1(median(mx))} pips`);
    log(`  P25: ${f1(quantile(mx, 0.25))}  P50: ${f1(quantile(mx, 0.5))}  P75: ${f1(quantile(mx, 0.75))}  P90: ${f1(quantile(mx, 0.9))}`);
    log("  % reaching at least:");
    for (const t of EXCURSION_TARGETS_P) {
      log(`    ${String(t).padStart(4)} pips: ${f1(pct(uniqueEvents.filter((e) => e.maxRevP >= t).length, uniqueEvents.length))}%`);
    }
  }
  log("");

  log("12. TIME TO EACH PIP TARGET (unique, hit ≤24H)");
  log("-".repeat(78));
  log("TARGET | HIT ≤24H | AVG TIME | MEDIAN TIME | P25 | P75 | P90");
  for (const t of TIME_TO_TARGETS_P) {
    const times = uniqueEvents.map((e) => e.timeToTarget[t]!).filter((x) => Number.isFinite(x) && x <= 1440);
    const hit = pct(times.length, uniqueEvents.length);
    log(
      [
        `${t}p`.padStart(6),
        f1(hit).padStart(8) + "%",
        (times.length ? f1(mean(times)) + "m" : "-").padStart(9),
        (times.length ? f1(median(times)) + "m" : "-").padStart(11),
        (times.length ? f1(quantile(times, 0.25)) + "m" : "-").padStart(4),
        (times.length ? f1(quantile(times, 0.75)) + "m" : "-").padStart(4),
        (times.length ? f1(quantile(times, 0.9)) + "m" : "-").padStart(4),
      ].join(" | "),
    );
  }
  log("");

  log("13. FAILURE BEHAVIOR (unique, no 10p reverse ≤24H)");
  log("-".repeat(78));
  {
    const cont = failures.map((e) => e.contBeyondP);
    log(`  N failures=${failures.length}`);
    if (cont.length) {
      log(`  Continuation beyond outer (breakout direction):`);
      log(`    Average: ${f1(mean(cont))} pips`);
      log(`    Median:  ${f1(median(cont))} pips`);
      log(`    P75: ${f1(quantile(cont, 0.75))}  P90: ${f1(quantile(cont, 0.9))}`);
    }
  }
  log("");

  log("14. UNIQUE EVENT CHECK");
  log("-".repeat(78));
  log(`  A) Depth-trigger outer-touch events: ${depthEvents.length}`);
  log(`  B) Unique outer-touch events:        ${uniqueEvents.length}`);
  log(`  (Main 10-pip results use B.)`);
  log("");

  log("15. INTEGRITY");
  log("-".repeat(78));
  log(`  Lookahead violations:     ${lookaheadViolations}`);
  log(`  Duplicate event IDs:      ${duplicateEventIds}`);
  log(`  Total breakout triggers:  ${totalBreakoutTriggers}`);
  log(`  Unique breakout excursions: ${uniqueBreakoutExcursions}`);
  log(`  Outer levels found:       ${outerLevelsFound}`);
  log(`  Outer levels reached:     ${outerLevelsReached}`);
  log(`  Valid outer-touch events (depth): ${depthEvents.length}`);
  log(`  Valid unique outer-touch: ${uniqueEvents.length}`);
  log(`  10-pip successes ≤24H (unique): ${successes.length}`);
  log(`  10-pip failures ≤24H (unique):  ${failures.length}`);
  if (lookaheadViolations !== 0) {
    log("  *** LOOKAHEAD VIOLATIONS NON-ZERO — INVESTIGATE ***");
  }
  log("");

  log("16. FINAL SIMPLE SUMMARY");
  log("-".repeat(78));
  log("10-PIP REVERSAL STUDY");
  log("");
  log(`Unique outer-touch events: ${uniqueEvents.length}`);
  log("");
  log("10 pips reached within:");
  for (const [label, w] of [
    ["15M", 15],
    ["30M", 30],
    ["1H", 60],
    ["2H", 120],
    ["4H", 240],
    ["8H", 480],
    ["12H", 720],
    ["24H", 1440],
  ] as const) {
    log(`${label}: ${f1(hitRateByWindow(uniqueEvents, w))}%`);
  }
  log("");
  {
    const st = successTimes(uniqueEvents);
    log("Of successful ≤24H 10-pip reversals:");
    log(`AVERAGE TIME: ${fmtHM(mean(st))}`);
    log(`MEDIAN TIME: ${fmtHM(median(st))}`);
    log("");
    log(`P25: ${fmtHM(quantile(st, 0.25))}`);
    log(`P75: ${fmtHM(quantile(st, 0.75))}`);
    log(`P90: ${fmtHM(quantile(st, 0.9))}`);
  }
  log("");
  {
    const up = uniqueEvents.filter((e) => e.dir === "UP");
    const dn = uniqueEvents.filter((e) => e.dir === "DOWN");
    log(`UP 24H: ${f1(hitRateByWindow(up, 1440))}%`);
    log(`DOWN 24H: ${f1(hitRateByWindow(dn, 1440))}%`);
    log("");
    log(`UP median time: ${fmtHM(median(successTimes(up)))}`);
    log(`DOWN median time: ${fmtHM(median(successTimes(dn)))}`);
  }
  log("");
  {
    const mx = uniqueEvents.map((e) => e.maxRevP);
    log("MAX REVERSAL WITHIN 24H:");
    log(`Median: ${f1(median(mx))} pips`);
    log(`P75: ${f1(quantile(mx, 0.75))} pips`);
    log(`P90: ${f1(quantile(mx, 0.9))} pips`);
  }
  log("");
  for (const t of [3, 5, 7.5, 10, 15, 20] as const) {
    const hit = pct(
      uniqueEvents.filter((e) => Number.isFinite(e.timeToTarget[t]) && e.timeToTarget[t]! <= 1440).length,
      uniqueEvents.length,
    );
    log(`${t}P hit rate: ${f1(hit)}%`);
  }
  log("");
  log("=".repeat(78));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, L.join("\n") + "\n");
  console.error(`\n[written] ${OUT_REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
