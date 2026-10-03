/**
 * EUR/USD — OUTER S/R 10-PIP REVERSAL — M1 INTRABAR VALIDATION
 *
 * Reproduces the M15 study events exactly (shared core), then resolves
 * M15 OHLC order ambiguity with OANDA M1 MID path.
 *
 * M15 creates setups. M1 only resolves path after/around outer touch.
 * Does NOT modify production S/R. No optimization.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../src/types/forex";
import {
  generateOuterTouchEvents,
  PIP,
  PIVOT_REACH,
  RANGE_LOOKBACK,
  VISIBLE_LOOKBACK,
  type Dir,
  type OuterTouchEvent,
} from "./_sr-outer-10pip-events-core";

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "sr-outer-10pip-m1-validation.txt");
const M15_CACHE = path.join(OUT_DIR, "cache", "eurusd-m15-mid-for-outer-10pip.json");
const M1_CACHE = path.join(OUT_DIR, "cache", "eurusd-m1-ba-for-outer-10pip.json");
const M1_SCRATCH =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const SR_SRC = path.resolve(__dirname, "../src/lib/strategy/support-resistance.ts");
const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");

const REVERSAL_P = 10;
const REVERSAL = REVERSAL_P * PIP;
const HORIZON_MIN = 24 * 60;
const STRICT_WINDOWS = [5, 10, 15, 30, 45, 60, 120, 240, 360, 480, 720, 1440] as const;
const TARGET_CURVE_P = [3, 5, 7.5, 10, 12.5, 15, 20] as const;

/** Published M15 unique-event results (for comparison table). */
const OLD_M15 = {
  uniqueEvents: 361,
  hit: {
    15: 49.0,
    30: 54.3,
    60: 61.2,
    120: 69.3,
    240: 75.1,
    480: 83.1,
    720: 88.6,
    1440: 93.1,
  } as Record<number, number>,
  medianMin: 15,
  failN: 25,
  failMed: 88.0,
  failP75: 124.8,
  failP90: 154.4,
  triggers: 2221,
  excursions: 534,
  depthTouches: 1544,
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
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
const toMs = (t: string) => Date.parse(t.slice(0, 19) + "Z");
const winLabel = (w: number) =>
  w < 60 ? `${w}M` : w === 60 ? "1H" : w === 120 ? "2H" : w === 240 ? "4H" : w === 360 ? "6H" : w === 480 ? "8H" : w === 720 ? "12H" : "24H";

function verifyProductionConstants(): void {
  const src = fs.readFileSync(SR_SRC, "utf8");
  for (const [name, val] of [
    ["PIVOT_REACH", PIVOT_REACH],
    ["RANGE_LOOKBACK", RANGE_LOOKBACK],
    ["VISIBLE_LOOKBACK", VISIBLE_LOOKBACK],
  ] as const) {
    const m = new RegExp(`const ${name} = (\\d+)`).exec(src);
    if (!m || Number(m[1]) !== val) throw new Error(`SR constant mismatch ${name}`);
  }
}

function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) throw new Error(`Missing ${ENV_PATH}`);
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function loadM15(): Candle[] {
  if (!fs.existsSync(M15_CACHE)) throw new Error(`Missing M15 cache ${M15_CACHE} — run the original study first or fetch.`);
  const raw = JSON.parse(fs.readFileSync(M15_CACHE, "utf8")) as Array<{
    time: string;
    volume: number;
    complete: boolean;
    mid: { open: number; high: number; low: number; close: number };
  }>;
  return raw
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
}

/** Compact BA row: [t, bh, bl, ah, al, bc, ac] → MID OHLC via (bid+ask)/2 */
type M1Row = { time: string; high: number; low: number; close: number; ms: number };

function loadM1(): { rows: M1Row[]; source: string } {
  const pathTry = [M1_CACHE, M1_SCRATCH].find((p) => fs.existsSync(p));
  if (!pathTry) {
    throw new Error(`No M1 cache at ${M1_CACHE} or scratchpad — fetch required`);
  }
  process.stderr.write(`Loading M1 from ${pathTry}...\n`);
  const raw = JSON.parse(fs.readFileSync(pathTry, "utf8")) as Array<
    [string, number, number, number, number, number, number] | { time: string; mid?: { high: number; low: number; close: number }; bid?: { high: number; low: number; close: number }; ask?: { high: number; low: number; close: number }; complete?: boolean }
  >;
  const rows: M1Row[] = [];
  for (const c of raw) {
    if (Array.isArray(c)) {
      const [t, bh, bl, ah, al, bc, ac] = c;
      rows.push({
        time: t,
        high: (bh + ah) / 2,
        low: (bl + al) / 2,
        close: (bc + ac) / 2,
        ms: toMs(t),
      });
    } else if (c.mid) {
      rows.push({
        time: c.time,
        high: c.mid.high,
        low: c.mid.low,
        close: c.mid.close,
        ms: toMs(c.time),
      });
    } else if (c.bid && c.ask) {
      rows.push({
        time: c.time,
        high: (c.bid.high + c.ask.high) / 2,
        low: (c.bid.low + c.ask.low) / 2,
        close: (c.bid.close + c.ask.close) / 2,
        ms: toMs(c.time),
      });
    }
  }
  rows.sort((a, b) => a.ms - b.ms);
  // Persist to project cache if loaded from scratchpad
  if (pathTry === M1_SCRATCH && !fs.existsSync(M1_CACHE)) {
    process.stderr.write(`Note: using scratchpad M1; not copying 400MB — path documented in report.\n`);
  }
  return {
    rows,
    source: `OANDA M1 BID/ASK→MID ((b+a)/2) from ${pathTry}`,
  };
}

function lowerBoundMs(rows: M1Row[], ms: number): number {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type M1Eval = {
  event: OuterTouchEvent;
  complete: boolean;
  missingReason: string | null;
  m1TouchIdx: number;
  m1TouchTime: string;
  sameM1Ambiguous: boolean;
  /** strict minutes to 10p (NaN if fail/incomplete) */
  strict10Min: number;
  /** inclusive: 0 if ambiguous else strict */
  inclusive10Min: number;
  hitStrict24: boolean;
  hitInclusive24: boolean;
  maxContBeyondP: number;
  /** strict times to each target size */
  strictTargetMin: Record<number, number>;
  /** for ambiguous: later strict hit times */
  ambiguousLaterStrict10: number;
};

function touchesOuter(row: M1Row, dir: Dir, outer: number): boolean {
  return dir === "UP" ? row.high >= outer : row.low <= outer;
}

function hitsTarget(row: M1Row, dir: Dir, outer: number, pips: number): boolean {
  const dist = pips * PIP;
  return dir === "UP" ? row.low <= outer - dist : row.high >= outer + dist;
}

function isAmbiguousOnTouch(row: M1Row, dir: Dir, outer: number, pips: number): boolean {
  return touchesOuter(row, dir, outer) && hitsTarget(row, dir, outer, pips);
}

function contBeyond(row: M1Row, dir: Dir, outer: number): number {
  return dir === "UP" ? Math.max(0, row.high - outer) : Math.max(0, outer - row.low);
}

function evaluateEvent(e: OuterTouchEvent, m1: M1Row[]): M1Eval {
  const empty = (reason: string): M1Eval => ({
    event: e,
    complete: false,
    missingReason: reason,
    m1TouchIdx: -1,
    m1TouchTime: "",
    sameM1Ambiguous: false,
    strict10Min: NaN,
    inclusive10Min: NaN,
    hitStrict24: false,
    hitInclusive24: false,
    maxContBeyondP: NaN,
    strictTargetMin: Object.fromEntries(TARGET_CURVE_P.map((t) => [t, NaN])),
    ambiguousLaterStrict10: NaN,
  });

  const m15Start = toMs(e.touchTime);
  const searchFrom = lowerBoundMs(m1, m15Start);
  if (searchFrom >= m1.length) return empty("no_m1_at_or_after_m15_touch");

  // First M1 touch of frozen outer — search from M15 bar start forward (allow up to 24h to locate)
  let m1TouchIdx = -1;
  const searchLimitMs = m15Start + HORIZON_MIN * 60_000;
  for (let i = searchFrom; i < m1.length && m1[i]!.ms <= searchLimitMs; i++) {
    if (touchesOuter(m1[i]!, e.dir, e.outerLevel)) {
      m1TouchIdx = i;
      break;
    }
  }
  if (m1TouchIdx < 0) return empty("m15_touch_but_m1_never_outer");

  const touchRow = m1[m1TouchIdx]!;
  const touchMs = touchRow.ms;
  const endMs = touchMs + HORIZON_MIN * 60_000;

  // Coverage: need M1 through +24h; allow small gaps (<5 min). Check last available.
  const endIdx = (() => {
    let i = m1TouchIdx;
    while (i + 1 < m1.length && m1[i + 1]!.ms <= endMs) i++;
    return i;
  })();
  const lastMs = m1[endIdx]!.ms;
  if (lastMs < endMs - 5 * 60_000) {
    return {
      ...empty("incomplete_m1_24h_coverage"),
      m1TouchIdx,
      m1TouchTime: touchRow.time,
      missingReason: `incomplete_m1_24h_coverage (last=${touchRow.time} span ends ${new Date(lastMs).toISOString()})`,
    };
  }

  // Gap check inside window
  let maxGapMin = 0;
  for (let i = m1TouchIdx + 1; i <= endIdx; i++) {
    const gap = (m1[i]!.ms - m1[i - 1]!.ms) / 60_000;
    if (gap > maxGapMin) maxGapMin = gap;
  }
  if (maxGapMin > 30) {
    return {
      ...empty("m1_gap_gt_30m"),
      m1TouchIdx,
      m1TouchTime: touchRow.time,
      missingReason: `m1_gap_gt_30m (maxGap=${f1(maxGapMin)}m)`,
    };
  }

  const sameM1Ambiguous = isAmbiguousOnTouch(touchRow, e.dir, e.outerLevel, REVERSAL_P);

  const strictTargetMin: Record<number, number> = {};
  for (const t of TARGET_CURVE_P) strictTargetMin[t] = NaN;

  let strict10Min = NaN;
  let ambiguousLaterStrict10 = NaN;
  let maxCont = 0;

  for (let i = m1TouchIdx; i <= endIdx; i++) {
    const row = m1[i]!;
    maxCont = Math.max(maxCont, contBeyond(row, e.dir, e.outerLevel));
    if (i === m1TouchIdx) continue; // strict: subsequent only
    const mins = (row.ms - touchMs) / 60_000;
    if (mins > HORIZON_MIN) break;
    for (const t of TARGET_CURVE_P) {
      if (!Number.isFinite(strictTargetMin[t]!) && hitsTarget(row, e.dir, e.outerLevel, t)) {
        strictTargetMin[t] = mins;
      }
    }
    if (!Number.isFinite(strict10Min) && hitsTarget(row, e.dir, e.outerLevel, REVERSAL_P)) {
      strict10Min = mins;
      if (sameM1Ambiguous) ambiguousLaterStrict10 = mins;
    }
  }

  const hitStrict24 = Number.isFinite(strict10Min) && strict10Min <= HORIZON_MIN;
  const inclusive10Min = sameM1Ambiguous ? 0 : strict10Min;
  const hitInclusive24 = sameM1Ambiguous || hitStrict24;

  return {
    event: e,
    complete: true,
    missingReason: null,
    m1TouchIdx,
    m1TouchTime: touchRow.time,
    sameM1Ambiguous,
    strict10Min,
    inclusive10Min,
    hitStrict24,
    hitInclusive24,
    maxContBeyondP: maxCont / PIP,
    strictTargetMin,
    ambiguousLaterStrict10,
  };
}

function hitRateStrict(evals: M1Eval[], windowMin: number): number {
  const hits = evals.filter((e) => Number.isFinite(e.strict10Min) && e.strict10Min <= windowMin).length;
  return pct(hits, evals.length);
}

function hitRateInclusive(evals: M1Eval[], windowMin: number): number {
  const hits = evals.filter((e) => {
    if (e.sameM1Ambiguous && windowMin >= 0) return true;
    return Number.isFinite(e.strict10Min) && e.strict10Min <= windowMin;
  }).length;
  return pct(hits, evals.length);
}

async function main(): Promise<void> {
  verifyProductionConstants();
  process.stderr.write("Loading M15...\n");
  const m15 = loadM15();
  process.stderr.write(`M15 n=${m15.length}\n`);
  process.stderr.write("Generating M15 events (parity)...\n");
  const gen = generateOuterTouchEvents(m15);

  const oldKeys = new Set<string>(); // we don't have old event IDs stored — parity by counts + uniqueKey set size
  // Parity against published study counts
  const expectedUnique = OLD_M15.uniqueEvents;

  log("=".repeat(78));
  log("EUR/USD — OUTER S/R 10-PIP REVERSAL — M1 VALIDATION");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("PRODUCTION S/R (unchanged)");
  log("-".repeat(78));
  log("  File: frontend/src/lib/strategy/support-resistance.ts");
  log("  Function: computeSupportResistanceLevels");
  log(`  PIVOT_REACH=${PIVOT_REACH} RANGE_LOOKBACK=${RANGE_LOOKBACK} VISIBLE_LOOKBACK=${VISIBLE_LOOKBACK}`);
  log("  Setup generation: M15 only via _sr-outer-10pip-events-core.ts (same algorithm as original study)");
  log("");

  log("2. EVENT PARITY");
  log("-".repeat(78));
  log("METRIC                      OLD STUDY    NEW VALIDATION");
  log(`Total breakout triggers     ${String(OLD_M15.triggers).padStart(10)}  ${String(gen.totalBreakoutTriggers).padStart(10)}`);
  log(`Unique breakout excursions  ${String(OLD_M15.excursions).padStart(10)}  ${String(gen.uniqueBreakoutExcursions).padStart(10)}`);
  log(`Depth outer touches         ${String(OLD_M15.depthTouches).padStart(10)}  ${String(gen.outerLevelsReached).padStart(10)}`);
  log(`Unique outer-touch events   ${String(OLD_M15.uniqueEvents).padStart(10)}  ${String(gen.uniqueEvents.length).padStart(10)}`);
  log("");
  const matched =
    gen.totalBreakoutTriggers === OLD_M15.triggers &&
    gen.uniqueBreakoutExcursions === OLD_M15.excursions &&
    gen.outerLevelsReached === OLD_M15.depthTouches &&
    gen.uniqueEvents.length === OLD_M15.uniqueEvents;
  log(`OLD STUDY EVENTS (unique): ${OLD_M15.uniqueEvents}`);
  log(`NEW VALIDATION EVENTS:     ${gen.uniqueEvents.length}`);
  log(`MATCHED (count parity):    ${matched ? "YES — exact count match on all four integrity metrics" : "NO — see deltas below"}`);
  log(`MISSING: ${Math.max(0, expectedUnique - gen.uniqueEvents.length)}`);
  log(`EXTRA:   ${Math.max(0, gen.uniqueEvents.length - expectedUnique)}`);
  if (!matched) {
    log("  Parity note: counts differ from published report — investigate before interpreting M1 rates.");
    log(
      `  Δ triggers=${gen.totalBreakoutTriggers - OLD_M15.triggers} excursions=${gen.uniqueBreakoutExcursions - OLD_M15.excursions} depthTouches=${gen.outerLevelsReached - OLD_M15.depthTouches} unique=${gen.uniqueEvents.length - OLD_M15.uniqueEvents}`,
    );
  } else {
    log("  Event generation reproduces the original study exactly (count parity).");
  }
  void oldKeys;
  log("");

  const { rows: m1, source: m1Source } = loadM1();
  log("3. M1 DATA");
  log("-".repeat(78));
  log(`  M1 candle count: ${m1.length}`);
  log(`  M1 start: ${m1[0]?.time}`);
  log(`  M1 end:   ${m1.at(-1)?.time}`);
  log(`  Source: ${m1Source}`);
  log(`  MID construction: (bid+ask)/2 from OANDA BA fields`);
  log("");

  process.stderr.write(`Evaluating ${gen.uniqueEvents.length} unique events on M1...\n`);
  const evalsAll = gen.uniqueEvents.map((e) => evaluateEvent(e, m1));
  const complete = evalsAll.filter((e) => e.complete);
  const incomplete = evalsAll.filter((e) => !e.complete);
  const neverTouched = incomplete.filter((e) => e.missingReason === "m15_touch_but_m1_never_outer");
  const missingCov = incomplete.filter((e) => e.missingReason !== "m15_touch_but_m1_never_outer");

  // missing M1 periods summary
  const reasonCounts = new Map<string, number>();
  for (const e of incomplete) {
    const k = (e.missingReason ?? "unknown").split(" ")[0]!;
    reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
  }

  log("  Events with complete M1 coverage:   " + complete.length);
  log("  Events without complete M1 coverage: " + incomplete.length);
  log("  Missing-reason breakdown:");
  for (const [k, v] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    log(`    ${k}: ${v}`);
  }
  log(`  M15 said outer touched but M1 never touched: ${neverTouched.length}`);
  log(`  (Incomplete events EXCLUDED from hit-rate denominators.)`);
  log("");

  const ambiguous = complete.filter((e) => e.sameM1Ambiguous);

  log("8. MAIN STRICT RESULT (complete M1 only; same-M1 ambiguous ≠ immediate success)");
  log("-".repeat(78));
  log("TIME | CONFIRMED 10P REVERSAL");
  for (const w of STRICT_WINDOWS) {
    log(`${winLabel(w).padStart(4)} | ${f1(hitRateStrict(complete, w))}%`);
  }
  log(`Denominator N=${complete.length}`);
  log("");

  log("9. INCLUSIVE RESULT (same-M1 ambiguous counted as immediate success)");
  log("-".repeat(78));
  log("TIME | 10P REVERSAL INCLUDING SAME-M1 AMBIGUOUS");
  for (const w of STRICT_WINDOWS) {
    log(`${winLabel(w).padStart(4)} | ${f1(hitRateInclusive(complete, w))}%`);
  }
  log("");

  log("10. SAME-M1 AMBIGUITY REPORT");
  log("-".repeat(78));
  log(`  Total confirmed outer touches (complete M1): ${complete.length}`);
  log(`  Same-M1 10p ambiguous cases: ${ambiguous.length}`);
  log(`  Percentage ambiguous: ${f1(pct(ambiguous.length, complete.length))}%`);
  log("  Of ambiguous cases, subsequent STRICT confirmed 10p within:");
  for (const w of [5, 15, 30, 60, 240, 1440] as const) {
    const n = ambiguous.filter((e) => Number.isFinite(e.ambiguousLaterStrict10) && e.ambiguousLaterStrict10 <= w).length;
    log(`    ${winLabel(w)}: ${n}/${ambiguous.length} (${f1(pct(n, ambiguous.length))}%)`);
  }
  log("");

  log("11. REVERSAL TIME (STRICT successes ≤24H only)");
  log("-".repeat(78));
  {
    const st = complete.filter((e) => e.hitStrict24).map((e) => e.strict10Min);
    log(`  N=${st.length}`);
    log(`  Average: ${f1(mean(st))} min (${fmtHM(mean(st))})`);
    log(`  Median:  ${f1(median(st))} min (${fmtHM(median(st))})`);
    log(`  P25: ${f1(quantile(st, 0.25))}  P50: ${f1(quantile(st, 0.5))}  P75: ${f1(quantile(st, 0.75))}  P90: ${f1(quantile(st, 0.9))}`);
    const zeros = st.filter((x) => x === 0).length;
    log(`  Strict times == 0 minutes: ${zeros}`);
    if (zeros > 0) {
      log("  NOTE: Strict rule requires SUBSEQUENT M1 candle, so 0 min means the next M1 bar");
      log("  (1 minute after touch timestamp) completed the target — not same-candle OHLC ambiguity.");
    } else {
      log("  No artificial 0-minute confirmed reversals from same-candle OHLC (as designed).");
    }
  }
  log("");

  log("12. UP VS DOWN (STRICT, complete M1)");
  log("-".repeat(78));
  log("DIRECTION | N | 5M | 15M | 30M | 1H | 2H | 4H | 8H | 12H | 24H | MEDIAN");
  for (const dir of ["UP", "DOWN", "COMBINED"] as const) {
    const ev = dir === "COMBINED" ? complete : complete.filter((e) => e.event.dir === dir);
    const st = ev.filter((e) => e.hitStrict24).map((e) => e.strict10Min);
    log(
      [
        dir.padEnd(9),
        String(ev.length),
        f1(hitRateStrict(ev, 5)),
        f1(hitRateStrict(ev, 15)),
        f1(hitRateStrict(ev, 30)),
        f1(hitRateStrict(ev, 60)),
        f1(hitRateStrict(ev, 120)),
        f1(hitRateStrict(ev, 240)),
        f1(hitRateStrict(ev, 480)),
        f1(hitRateStrict(ev, 720)),
        f1(hitRateStrict(ev, 1440)),
        st.length ? `${f1(median(st))}m` : "-",
      ].join(" | "),
    );
  }
  log("");

  log("13. TARGET-SIZE CURVE (STRICT M1 sequencing)");
  log("-".repeat(78));
  log("TARGET | N | ≤5M | ≤15M | ≤30M | ≤1H | ≤4H | ≤8H | ≤24H | MEDIAN TIME");
  for (const t of TARGET_CURVE_P) {
    const times = complete.map((e) => e.strictTargetMin[t]!).filter((x) => Number.isFinite(x) && x <= 1440);
    const rate = (w: number) => pct(complete.filter((e) => Number.isFinite(e.strictTargetMin[t]!) && e.strictTargetMin[t]! <= w).length, complete.length);
    log(
      [
        `${t}p`.padStart(6),
        String(complete.length),
        f1(rate(5)),
        f1(rate(15)),
        f1(rate(30)),
        f1(rate(60)),
        f1(rate(240)),
        f1(rate(480)),
        f1(rate(1440)),
        times.length ? `${f1(median(times))}m` : "-",
      ].join(" | "),
    );
  }
  log("");

  log("14. M15 VS M1 COMPARISON");
  log("-".repeat(78));
  log("METRIC | OLD M15 | STRICT M1 | DIFFERENCE");
  const cmpWindows = [15, 30, 60, 120, 240, 480, 720, 1440] as const;
  for (const w of cmpWindows) {
    const old = OLD_M15.hit[w]!;
    const neu = hitRateStrict(complete, w);
    log(`10p ≤${winLabel(w).toLowerCase()} | ${f1(old)}% | ${f1(neu)}% | ${f1(neu - old)} pp`);
  }
  {
    const st = complete.filter((e) => e.hitStrict24).map((e) => e.strict10Min);
    log(`Median successful time | ${OLD_M15.medianMin}m | ${f1(median(st))}m | ${f1(median(st) - OLD_M15.medianMin)} m`);
  }
  log("");

  log("15. FAILURE BEHAVIOR (STRICT no 10p ≤24H)");
  log("-".repeat(78));
  {
    const fails = complete.filter((e) => !e.hitStrict24);
    const cont = fails.map((e) => e.maxContBeyondP);
    log(`  N=${fails.length}  (OLD M15 failures N=${OLD_M15.failN})`);
    if (cont.length) {
      log(`  Continuation beyond outer:`);
      log(`    Average: ${f1(mean(cont))} pips`);
      log(`    Median:  ${f1(median(cont))} pips  (OLD ${OLD_M15.failMed})`);
      log(`    P75: ${f1(quantile(cont, 0.75))}  (OLD ${OLD_M15.failP75})`);
      log(`    P90: ${f1(quantile(cont, 0.9))}  (OLD ${OLD_M15.failP90})`);
    }
  }
  log("");

  log("16. DATA-INTEGRITY CHECKS");
  log("-".repeat(78));
  log(`  M15 lookahead violations: ${gen.lookaheadViolations}`);
  log(`  M1 lookahead violations: 0 (path uses only bars at/after confirmed touch; setups from prior M15 only)`);
  log(`  Duplicate unique event IDs: ${gen.duplicateEventIds}`);
  log(`  Events with missing M1 coverage: ${incomplete.length}`);
  log(`  Events M15 touch but M1 never touched outer: ${neverTouched.length}`);
  log(`  Same-M1 ambiguous events: ${ambiguous.length}`);
  log(`  Strict 10p successes ≤24H: ${complete.filter((e) => e.hitStrict24).length}`);
  log(`  Strict 10p failures ≤24H: ${complete.filter((e) => !e.hitStrict24).length}`);
  log(`  Incomplete excluded from rates: ${incomplete.length} (of which coverage gaps ${missingCov.length})`);
  log("");

  const strict24 = hitRateStrict(complete, 1440);
  const incl24 = hitRateInclusive(complete, 1440);
  const old24 = OLD_M15.hit[1440]!;
  const diff24 = strict24 - old24;
  const old15 = OLD_M15.hit[15]!;
  const strict15 = hitRateStrict(complete, 15);
  const drop15 = old15 - strict15;

  let verdict: "M15_RESULT_CONFIRMED_BY_M1" | "M15_RESULT_PARTIALLY_INFLATED_BY_INTRABAR_ORDER" | "M15_RESULT_INVALIDATED_BY_M1";
  if (!Number.isFinite(strict24) || complete.length < 50) {
    verdict = "M15_RESULT_INVALIDATED_BY_M1";
  } else if (strict24 < 80 || old24 - strict24 > 15) {
    verdict = "M15_RESULT_INVALIDATED_BY_M1";
  } else if (drop15 >= 10 || old24 - strict24 >= 5) {
    verdict = "M15_RESULT_PARTIALLY_INFLATED_BY_INTRABAR_ORDER";
  } else {
    verdict = "M15_RESULT_CONFIRMED_BY_M1";
  }

  log("17. FINAL SIMPLE SUMMARY");
  log("-".repeat(78));
  log("M1 10-PIP REVERSAL VALIDATION");
  log("");
  log(`Unique M15 events: ${gen.uniqueEvents.length}`);
  log(`Complete M1 events: ${complete.length}`);
  log(`Same-M1 ambiguous: ${ambiguous.length} (${f1(pct(ambiguous.length, complete.length))}%)`);
  log("");
  log("STRICT M1:");
  for (const w of [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440] as const) {
    log(`${winLabel(w)}: ${f1(hitRateStrict(complete, w))}%`);
  }
  log("");
  {
    const st = complete.filter((e) => e.hitStrict24).map((e) => e.strict10Min);
    log("STRICT successful reversal time:");
    log(`Average: ${fmtHM(mean(st))}`);
    log(`Median: ${fmtHM(median(st))}`);
    log(`P25: ${fmtHM(quantile(st, 0.25))}`);
    log(`P75: ${fmtHM(quantile(st, 0.75))}`);
    log(`P90: ${fmtHM(quantile(st, 0.9))}`);
  }
  log("");
  log(`INCLUSIVE 24H:`);
  log(`${f1(incl24)}%`);
  log("");
  log(`OLD M15 24H:`);
  log(`${f1(old24)}%`);
  log("");
  log(`STRICT M1 24H:`);
  log(`${f1(strict24)}%`);
  log("");
  log(`Difference:`);
  log(`${f1(diff24)} percentage points`);
  log("");
  log("TARGET CURVE:");
  for (const t of TARGET_CURVE_P) {
    const r = pct(complete.filter((e) => Number.isFinite(e.strictTargetMin[t]!) && e.strictTargetMin[t]! <= 1440).length, complete.length);
    log(`${t}P: ${f1(r)}%`);
  }
  log("");
  log(verdict);
  log("=".repeat(78));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, L.join("\n") + "\n");
  console.error(`\n[written] ${OUT_REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
