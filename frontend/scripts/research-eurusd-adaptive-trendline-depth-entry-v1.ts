/**
 * Adaptive Swing Trendlines V1 — PULLBACK DEPTH ENTRY TEST (FROZEN indicator).
 *
 * Follow-on to eurusd-adaptive-trendline-entry-v1 (distance-only = MIXED/WEAK).
 *
 * Question: when MAJOR+CURRENT agree, does pullback DEPTH vs the prior impulse
 * (optionally combined with CURRENT trendline proximity) improve entry quality?
 *
 * RULES:
 * - Indicator FROZEN — exact analyzeAdaptiveSwingTrendlines causal replay
 * - Same window / data / execution as prior test
 * - Same pullback EVENT start/resolve/re-arm definitions as prior test (unchanged)
 * - Impulse from confirmed causal swings only (no future pivots)
 * - Threshold entries fire at FIRST causal crossing of 25/50/75/100% (not at eventual max)
 * - No parameter optimization
 *
 * IMPULSE (documented):
 * LONG: most recent confirmed swing low associated with CURRENT (prefer CURRENT.pointB)
 *       → most recent confirmed swing high after that low (knowable only once confirmationIndex <= t).
 * SHORT: inverse (prefer CURRENT.pointB high → subsequent confirmed low).
 * No minimum impulse size beyond price direction (end beyond start). ATR14 at impulse end for sizeATR.
 *
 * EVENT DE-DUP: identical to prior test (approach streak 2, bounce≥2p, re-arm +5p / new line id).
 */
import fs from "node:fs";
import path from "node:path";
import {
  analyzeAdaptiveSwingTrendlines,
  type AdaptiveTrendDirection,
  type AdaptiveTrendline,
  type ConfirmedSwing,
} from "../src/lib/adaptive-swing-trendlines";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import type { Candle, MajorInstrument } from "../src/types/forex";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const TRADING_DAYS = 30;
const WARMUP_BARS = 400;
const M15_PER_HOUR = 4;
const BARS_1H = 1 * M15_PER_HOUR;
const BARS_4H = 4 * M15_PER_HOUR;
const BARS_12H = 12 * M15_PER_HOUR;
const BARS_24H = 24 * M15_PER_HOUR;
const BOUNCE_RESOLVE_PIPS = 2;
const REARM_EXTENSION_PIPS = 5;
const MAX_PULLBACK_BARS = 48;
const APPROACH_STREAK = 2;
const THRESHOLDS = [25, 50, 75, 100] as const;
type Threshold = (typeof THRESHOLDS)[number];

const CACHE =
  process.env.ATL_M15_CACHE ??
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const OUT_DIR = path.resolve(__dirname, "../research-output");
const CSV_PATH = path.join(OUT_DIR, "eurusd-adaptive-trendline-depth-entry-v1-events.csv");
const REPORT_PATH = path.join(OUT_DIR, "eurusd-adaptive-trendline-depth-entry-v1-report.txt");

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; volume: number; complete: boolean; mid: OHLC; bid: OHLC; ask: OHLC };
type Dir = "long" | "short";
type DistBucket = "0-2p" | "2-5p" | "5-10p" | ">10p";
type Race = "plus_first" | "minus_first" | "neither" | "ambiguous";

type Impulse = {
  startTime: string;
  startPrice: number;
  endTime: string;
  endPrice: number;
  startIndex: number;
  endIndex: number;
  sizePips: number;
  sizeATR: number;
};

type EntryRow = {
  instrument: string;
  eventId: string;
  direction: Dir;
  timestamp: string;
  majorDirection: AdaptiveTrendDirection;
  currentDirection: AdaptiveTrendDirection;
  currentLineId: string;
  impulseStartTime: string;
  impulseStartPrice: number;
  impulseEndTime: string;
  impulseEndPrice: number;
  impulseSizePips: number;
  impulseSizeATR: number;
  entryThresholdPct: Threshold;
  actualRetracementPctAtEntry: number;
  maxRetracementPctInEvent: number;
  currentLinePrice: number;
  distanceToCurrentPips: number;
  distanceBucket: DistBucket;
  entryPrice: number;
  spreadPips: number;
  mfe1h: number;
  mae1h: number;
  mfe4h: number;
  mae4h: number;
  mfe12h: number;
  mae12h: number;
  mfe24h: number;
  mae24h: number;
  fivePipRace: Race;
  tenPipRace: Race;
  twentyPipRace: Race;
  maeBefore5p: number | null;
  maeBefore10p: number | null;
  maeBefore20p: number | null;
  timeTo5p: number | null;
  timeTo10p: number | null;
  timeTo20p: number | null;
};

type OpenPullback = {
  eventId: string;
  direction: Dir;
  majorLineId: string;
  currentLineId: string;
  currentStatus: string;
  majorDirection: AdaptiveTrendDirection;
  currentDirection: AdaptiveTrendDirection;
  startBar: number;
  approachStreak: number;
  minDist: number;
  minBar: number;
  impulse: Impulse | null;
  maxRetracePct: number;
  fired: Set<Threshold>;
  entries: EntryRow[];
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(1));
const f2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(2));
const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);

function projectLine(line: Pick<AdaptiveTrendline, "pointA" | "slopePerBar">, index: number) {
  return line.pointA.price + line.slopePerBar * (index - line.pointA.index);
}

function distBucketOf(dist: number): DistBucket {
  if (dist <= 2) return "0-2p";
  if (dist <= 5) return "2-5p";
  if (dist <= 10) return "5-10p";
  return ">10p";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

function tradingDayKey(iso: string): string {
  return iso.slice(0, 10);
}

function loadWindow(raw: RC[], tradingDays: number): { rows: RC[]; analysisStart: number; dayCount: number } {
  const completed = raw.filter((c) => c.complete !== false);
  const dayOrder: string[] = [];
  const seen = new Set<string>();
  for (let i = completed.length - 1; i >= 0; i -= 1) {
    const d = tradingDayKey(completed[i]!.time);
    if (!seen.has(d)) {
      seen.add(d);
      dayOrder.push(d);
      if (dayOrder.length >= tradingDays) break;
    }
  }
  const keep = new Set(dayOrder);
  let firstKeep = completed.length;
  for (let i = 0; i < completed.length; i += 1) {
    if (keep.has(tradingDayKey(completed[i]!.time))) {
      firstKeep = i;
      break;
    }
  }
  const sliceStart = Math.max(0, firstKeep - WARMUP_BARS);
  return {
    rows: completed.slice(sliceStart),
    analysisStart: firstKeep - sliceStart,
    dayCount: dayOrder.length,
  };
}

function distanceToCurrent(direction: Dir, linePrice: number, mid: OHLC): number {
  if (direction === "long") return (mid.low - linePrice) / PIP;
  return (linePrice - mid.high) / PIP;
}

function againstTrend(direction: Dir, cur: OHLC, prev: OHLC): boolean {
  if (direction === "long") return cur.low < prev.low;
  return cur.high > prev.high;
}

function excursionFromEntry(
  direction: Dir,
  entry: number,
  bars: RC[],
  from: number,
  toExclusive: number,
): { mfe: number; mae: number } {
  let mfe = 0;
  let mae = 0;
  const end = Math.min(bars.length, toExclusive);
  for (let i = from; i < end; i += 1) {
    const b = bars[i]!;
    if (direction === "long") {
      mfe = Math.max(mfe, (b.bid.high - entry) / PIP);
      mae = Math.max(mae, (entry - b.bid.low) / PIP);
    } else {
      mfe = Math.max(mfe, (entry - b.ask.low) / PIP);
      mae = Math.max(mae, (b.ask.high - entry) / PIP);
    }
  }
  return { mfe, mae };
}

function raceAndTimes(
  direction: Dir,
  entry: number,
  bars: RC[],
  from: number,
  horizon: number,
  target: number,
): { race: Race; timeToPlus: number | null; maeBeforePlus: number | null } {
  const end = Math.min(bars.length, from + horizon);
  let mae = 0;
  let timeToPlus: number | null = null;
  let timeToMinus: number | null = null;
  let maeBeforePlus: number | null = null;

  for (let i = from; i < end; i += 1) {
    const b = bars[i]!;
    let favHi: number;
    let advHi: number;
    if (direction === "long") {
      favHi = (b.bid.high - entry) / PIP;
      advHi = (entry - b.bid.low) / PIP;
    } else {
      favHi = (entry - b.ask.low) / PIP;
      advHi = (b.ask.high - entry) / PIP;
    }
    const hitPlus = favHi >= target;
    const hitMinus = advHi >= target;
    if (hitPlus && hitMinus) {
      return { race: "ambiguous", timeToPlus: null, maeBeforePlus: null };
    }
    if (hitMinus && timeToMinus == null) timeToMinus = i - from + 1;
    if (hitPlus && timeToPlus == null) {
      timeToPlus = i - from + 1;
      maeBeforePlus = Math.max(mae, advHi);
    }
    mae = Math.max(mae, advHi);
    if (timeToPlus != null && timeToMinus != null) break;
  }

  if (timeToPlus != null && timeToMinus != null) {
    if (timeToPlus < timeToMinus) return { race: "plus_first", timeToPlus, maeBeforePlus };
    if (timeToMinus < timeToPlus) return { race: "minus_first", timeToPlus, maeBeforePlus };
    return { race: "ambiguous", timeToPlus, maeBeforePlus };
  }
  if (timeToPlus != null) return { race: "plus_first", timeToPlus, maeBeforePlus };
  if (timeToMinus != null) return { race: "minus_first", timeToPlus: null, maeBeforePlus: null };
  return { race: "neither", timeToPlus: null, maeBeforePlus: null };
}

/**
 * Causal impulse for the active CURRENT structure.
 * Frozen once resolved for an event — never uses swings confirmed after freeze bar.
 *
 * Primary: structure anchor (CURRENT.pointB) → subsequent confirmed opposite swing.
 * Fallback (same event defs; technical completeness only — not a tuned filter):
 *   latest confirmed opposite swing known by t, paired with the most recent same-type
 *   structure swing before it at/after CURRENT.pointA. Needed because pivotRadius=3
 *   often means the impulse extreme is not yet confirmed when the pullback event starts.
 */
function resolveImpulse(
  direction: Dir,
  swings: ConfirmedSwing[],
  current: AdaptiveTrendline,
  mids: Candle[],
  t: number,
): Impulse | null {
  const known = swings.filter((s) => s.confirmationIndex <= t);

  const finish = (
    start: ConfirmedSwing,
    end: ConfirmedSwing,
    sizePrice: number,
  ): Impulse | null => {
    if (sizePrice <= 0) return null;
    const sizePips = sizePrice / PIP;
    const atr = atr14Of(mids.slice(0, end.confirmationIndex + 1));
    return {
      startTime: start.time,
      startPrice: start.price,
      endTime: end.time,
      endPrice: end.price,
      startIndex: start.index,
      endIndex: end.index,
      sizePips,
      sizeATR: atr > 0 ? sizePrice / atr : NaN,
    };
  };

  if (direction === "long") {
    const structureLow =
      current.pointB.type === "low"
        ? current.pointB
        : known.filter((s) => s.type === "low" && s.index <= current.pointB.index).at(-1);
    if (!structureLow) return null;

    const highsAfter = known.filter((s) => s.type === "high" && s.index > structureLow.index);
    const afterB = highsAfter.filter((h) => h.index > current.pointB.index);
    let H = (afterB.length ? afterB : highsAfter).at(-1) ?? null;

    // Fallback: latest confirmed high overall that still sits after CURRENT.pointA
    if (!H) {
      H =
        known
          .filter((s) => s.type === "high" && s.index > current.pointA.index)
          .at(-1) ?? null;
    }
    if (!H) return null;

    const lows = known.filter(
      (s) => s.type === "low" && s.index >= Math.min(structureLow.index, current.pointA.index) && s.index < H!.index,
    );
    const L = lows.at(-1) ?? (structureLow.index < H.index ? structureLow : null);
    if (!L || H.price <= L.price) return null;
    return finish(L, H, H.price - L.price);
  }

  const structureHigh =
    current.pointB.type === "high"
      ? current.pointB
      : known.filter((s) => s.type === "high" && s.index <= current.pointB.index).at(-1);
  if (!structureHigh) return null;

  const lowsAfter = known.filter((s) => s.type === "low" && s.index > structureHigh.index);
  const afterB = lowsAfter.filter((lo) => lo.index > current.pointB.index);
  let Lo = (afterB.length ? afterB : lowsAfter).at(-1) ?? null;
  if (!Lo) {
    Lo =
      known
        .filter((s) => s.type === "low" && s.index > current.pointA.index)
        .at(-1) ?? null;
  }
  if (!Lo) return null;

  const highs = known.filter(
    (s) =>
      s.type === "high" &&
      s.index >= Math.min(structureHigh.index, current.pointA.index) &&
      s.index < Lo!.index,
  );
  const Hi = highs.at(-1) ?? (structureHigh.index < Lo.index ? structureHigh : null);
  if (!Hi || Lo.price >= Hi.price) return null;
  return finish(Hi, Lo, Hi.price - Lo.price);
}

/** Retracement % of prior impulse using candle extreme toward pullback. Allows >100. */
function retracementPct(direction: Dir, impulse: Impulse, mid: OHLC): number {
  if (impulse.sizePips <= 0) return 0;
  if (direction === "long") {
    // pullback down from impulse high
    const depth = impulse.endPrice - mid.low;
    return (depth / (impulse.sizePips * PIP)) * 100;
  }
  const depth = mid.high - impulse.endPrice;
  return (depth / (impulse.sizePips * PIP)) * 100;
}

function buildEntry(
  pb: OpenPullback,
  threshold: Threshold,
  retracePct: number,
  t: number,
  linePrice: number,
  dist: number,
  bars: RC[],
): EntryRow {
  const c = bars[t]!;
  const direction = pb.direction;
  const entryPrice = direction === "long" ? c.ask.close : c.bid.close;
  const spreadPips = (c.ask.close - c.bid.close) / PIP;
  const from = t + 1;
  const impulse = pb.impulse!;

  const e1 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_1H);
  const e4 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_4H);
  const e12 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_12H);
  const e24 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_24H);
  const r5 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 5);
  const r10 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 10);
  const r20 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 20);

  return {
    instrument: INSTRUMENT,
    eventId: pb.eventId,
    direction,
    timestamp: c.time,
    majorDirection: pb.majorDirection,
    currentDirection: pb.currentDirection,
    currentLineId: pb.currentLineId,
    impulseStartTime: impulse.startTime,
    impulseStartPrice: impulse.startPrice,
    impulseEndTime: impulse.endTime,
    impulseEndPrice: impulse.endPrice,
    impulseSizePips: impulse.sizePips,
    impulseSizeATR: impulse.sizeATR,
    entryThresholdPct: threshold,
    actualRetracementPctAtEntry: retracePct,
    maxRetracementPctInEvent: pb.maxRetracePct,
    currentLinePrice: linePrice,
    distanceToCurrentPips: dist,
    distanceBucket: distBucketOf(dist),
    entryPrice,
    spreadPips,
    mfe1h: e1.mfe,
    mae1h: e1.mae,
    mfe4h: e4.mfe,
    mae4h: e4.mae,
    mfe12h: e12.mfe,
    mae12h: e12.mae,
    mfe24h: e24.mfe,
    mae24h: e24.mae,
    fivePipRace: r5.race,
    tenPipRace: r10.race,
    twentyPipRace: r20.race,
    maeBefore5p: r5.maeBeforePlus,
    maeBefore10p: r10.maeBeforePlus,
    maeBefore20p: r20.maeBeforePlus,
    timeTo5p: r5.timeToPlus,
    timeTo10p: r10.timeToPlus,
    timeTo20p: r20.timeToPlus,
  };
}

function racePct(rows: EntryRow[], key: "fivePipRace" | "tenPipRace" | "twentyPipRace"): string {
  if (!rows.length) return "-";
  return `${f1(pct(rows.filter((r) => r[key] === "plus_first").length, rows.length))}%`;
}

function printDepthTable(title: string, rows: EntryRow[], eventCount: number, reach: Map<Threshold, number>) {
  log("");
  log(title);
  log("-".repeat(78));
  log(
    `${"DEPTH".padEnd(8)}${"N".padStart(5)}  ${"%EV".padStart(6)}  ${"+5 FIRST".padStart(9)}  ${"+10 FIRST".padStart(10)}  ${"+20 FIRST".padStart(10)}  ${"MED MFE".padStart(7)}  ${"MED MAE".padStart(7)}`,
  );
  for (const th of THRESHOLDS) {
    const subset = rows.filter((r) => r.entryThresholdPct === th);
    const reached = reach.get(th) ?? 0;
    log(
      `${`${th}%`.padEnd(8)}${String(subset.length).padStart(5)}  ${f1(pct(reached, eventCount)).padStart(6)}  ${racePct(subset, "fivePipRace").padStart(9)}  ${racePct(subset, "tenPipRace").padStart(10)}  ${racePct(subset, "twentyPipRace").padStart(10)}  ${f1(median(subset.map((r) => r.mfe24h))).padStart(7)}  ${f1(median(subset.map((r) => r.mae24h))).padStart(7)}`,
    );
  }
}

function maeBeforeBlock(rows: EntryRow[]) {
  log("");
  log("MAE BEFORE SUCCESSFUL +10P");
  log(`${"DEPTH".padEnd(8)}${"P25".padStart(6)}  ${"P50".padStart(6)}  ${"P75".padStart(6)}  ${"P80".padStart(6)}  ${"P90".padStart(6)}  ${"P95".padStart(6)}  ${"N".padStart(5)}`);
  for (const th of THRESHOLDS) {
    const xs = rows
      .filter((r) => r.entryThresholdPct === th && r.maeBefore10p != null)
      .map((r) => r.maeBefore10p!);
    log(
      `${`${th}%`.padEnd(8)}${f1(percentile(xs, 0.25)).padStart(6)}  ${f1(percentile(xs, 0.5)).padStart(6)}  ${f1(percentile(xs, 0.75)).padStart(6)}  ${f1(percentile(xs, 0.8)).padStart(6)}  ${f1(percentile(xs, 0.9)).padStart(6)}  ${f1(percentile(xs, 0.95)).padStart(6)}  ${String(xs.length).padStart(5)}`,
    );
  }
}

function pairedCompare(
  label: string,
  shallow: Threshold,
  deep: Threshold,
  byEvent: Map<string, EntryRow[]>,
) {
  const pairs: Array<{ a: EntryRow; b: EntryRow }> = [];
  for (const rows of byEvent.values()) {
    const a = rows.find((r) => r.entryThresholdPct === shallow);
    const b = rows.find((r) => r.entryThresholdPct === deep);
    if (a && b) pairs.push({ a, b });
  }
  log("");
  log(`PAIRED ${label} (same event reached both; n=${pairs.length})`);
  if (pairs.length < 5) {
    log("  VERY SMALL SAMPLE — descriptive only.");
  }
  if (!pairs.length) return;

  const betterEntry = pairs.filter((p) =>
    p.a.direction === "long" ? p.b.entryPrice < p.a.entryPrice : p.b.entryPrice > p.a.entryPrice,
  ).length;
  const maeImproved = pairs.filter((p) => p.b.mae24h < p.a.mae24h).length;
  const mfeImproved = pairs.filter((p) => p.b.mfe24h > p.a.mfe24h).length;
  const ratio = (r: EntryRow) => (r.mae24h > 0 ? r.mfe24h / r.mae24h : r.mfe24h > 0 ? Infinity : 0);
  const ratioImproved = pairs.filter((p) => ratio(p.b) > ratio(p.a)).length;
  const plus10A = pairs.filter((p) => p.a.tenPipRace === "plus_first").length;
  const plus10B = pairs.filter((p) => p.b.tenPipRace === "plus_first").length;
  const medMaeA = median(pairs.map((p) => p.a.mae24h));
  const medMaeB = median(pairs.map((p) => p.b.mae24h));
  const medMfeA = median(pairs.map((p) => p.a.mfe24h));
  const medMfeB = median(pairs.map((p) => p.b.mfe24h));
  const priceImprovePips = pairs.map((p) =>
    p.a.direction === "long" ? (p.a.entryPrice - p.b.entryPrice) / PIP : (p.b.entryPrice - p.a.entryPrice) / PIP,
  );

  log(`  Better entry price when waiting: ${betterEntry}/${pairs.length} (${f1(pct(betterEntry, pairs.length))}%)`);
  log(`  Med entry improvement: ${f1(median(priceImprovePips))}p`);
  log(`  Lower MAE24 when deeper: ${maeImproved}/${pairs.length} | med MAE ${f1(medMaeA)} → ${f1(medMaeB)}`);
  log(`  Higher MFE24 when deeper: ${mfeImproved}/${pairs.length} | med MFE ${f1(medMfeA)} → ${f1(medMfeB)}`);
  log(`  Better MFE/MAE ratio when deeper: ${ratioImproved}/${pairs.length}`);
  log(
    `  +10-first: ${shallow}% ${f1(pct(plus10A, pairs.length))}% → ${deep}% ${f1(pct(plus10B, pairs.length))}%`,
  );
}

async function main() {
  if (!fs.existsSync(CACHE)) {
    console.error(`Missing cache: ${CACHE}`);
    process.exit(1);
  }
  console.error(`Loading ${CACHE} ...`);
  const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const { rows, analysisStart, dayCount } = loadWindow(raw, TRADING_DAYS);
  const mids: Candle[] = rows.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: c.volume,
    complete: true,
  }));

  const first = rows[analysisStart]!.time;
  const last = rows[rows.length - 1]!.time;
  console.error(`Window: ${dayCount} trading days | ${first} -> ${last}`);
  console.error("Causal replay + depth thresholds ...");

  const allEntries: EntryRow[] = [];
  const eventMeta: Array<{
    eventId: string;
    direction: Dir;
    maxRetrace: number;
    reached: Set<Threshold>;
    hadImpulse: boolean;
    impulseSizePips: number;
  }> = [];

  let open: OpenPullback | null = null;
  let blockedLineId: string | null = null;
  let blockUntilDist: number | null = null;
  let approachStreak = 0;
  let approachSeed: OpenPullback | null = null;
  let eventSeq = 0;

  const t0 = Date.now();

  const closeEvent = (pb: OpenPullback) => {
    // Backfill maxRetrace onto entries
    for (const e of pb.entries) {
      e.maxRetracementPctInEvent = pb.maxRetracePct;
      allEntries.push(e);
    }
    eventMeta.push({
      eventId: pb.eventId,
      direction: pb.direction,
      maxRetrace: pb.maxRetracePct,
      reached: new Set(pb.fired),
      hadImpulse: !!pb.impulse,
      impulseSizePips: pb.impulse?.sizePips ?? NaN,
    });
    blockedLineId = pb.currentLineId;
    blockUntilDist = pb.minDist + REARM_EXTENSION_PIPS;
  };

  const processBarOnOpen = (
    pb: OpenPullback,
    t: number,
    read: ReturnType<typeof analyzeAdaptiveSwingTrendlines>,
    current: AdaptiveTrendline,
    linePrice: number,
    dist: number,
  ) => {
    const resolved = resolveImpulse(pb.direction, read.swings, current, mids, t);
    if (!pb.impulse) {
      pb.impulse = resolved;
    } else if (pb.fired.size === 0 && resolved && resolved.endIndex > pb.impulse.endIndex) {
      // Upgrade to a newer confirmed impulse end before any threshold has fired
      pb.impulse = resolved;
      pb.maxRetracePct = 0;
    }
    if (!pb.impulse) return;

    const mid = rows[t]!.mid;
    const ret = retracementPct(pb.direction, pb.impulse, mid);
    if (ret > pb.maxRetracePct) pb.maxRetracePct = ret;

    for (const th of THRESHOLDS) {
      if (pb.fired.has(th)) continue;
      if (ret < th) continue;
      pb.fired.add(th);
      pb.entries.push(buildEntry(pb, th, ret, t, linePrice, dist, rows));
    }
  };

  for (let t = analysisStart; t < rows.length; t += 1) {
    if ((t - analysisStart) % 500 === 0) {
      process.stderr.write(
        `  bar ${t - analysisStart}/${rows.length - analysisStart} events=${eventMeta.length} entries=${allEntries.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
      );
    }

    const slice = mids.slice(0, t + 1);
    const read = analyzeAdaptiveSwingTrendlines(slice, INSTRUMENT);
    const major = read.major;
    const current = read.current;
    const mid = rows[t]!.mid;
    const prevMid = t > 0 ? rows[t - 1]!.mid : mid;

    const agreeLong =
      read.majorDirection === "bullish" &&
      read.currentDirection === "bullish" &&
      !!current &&
      current.status !== "broken";
    const agreeShort =
      read.majorDirection === "bearish" &&
      read.currentDirection === "bearish" &&
      !!current &&
      current.status !== "broken";
    const direction: Dir | null = agreeLong ? "long" : agreeShort ? "short" : null;

    if (!direction || !current || !major) {
      if (open) {
        closeEvent(open);
        open = null;
      }
      approachStreak = 0;
      approachSeed = null;
      continue;
    }

    const linePrice = projectLine(current, t);
    const dist = distanceToCurrent(direction, linePrice, mid);
    const prevLinePrice = projectLine(
      current,
      t - 1 >= current.pointB.confirmationIndex ? t - 1 : t,
    );
    const prevDist = t > 0 ? distanceToCurrent(direction, prevLinePrice, prevMid) : dist;

    if (blockedLineId === current.id) {
      if (dist >= (blockUntilDist ?? Infinity) || dist < 0) {
        blockedLineId = null;
        blockUntilDist = null;
      }
    } else if (blockedLineId && blockedLineId !== current.id) {
      blockedLineId = null;
      blockUntilDist = null;
    }

    const closedThrough = direction === "long" ? mid.close < linePrice : mid.close > linePrice;

    if (open) {
      const structureChange =
        open.currentLineId !== current.id ||
        open.direction !== direction ||
        current.status === "broken";
      const bounced = dist >= open.minDist + BOUNCE_RESOLVE_PIPS;
      const timedOut = t - open.startBar >= MAX_PULLBACK_BARS;

      if (dist < open.minDist && dist >= 0) {
        open.minDist = dist;
        open.minBar = t;
      }

      processBarOnOpen(open, t, read, current, linePrice, dist);

      if (structureChange || closedThrough || bounced || timedOut) {
        closeEvent(open);
        open = null;
        approachStreak = 0;
        approachSeed = null;
        continue;
      }
      continue;
    }

    if (blockedLineId === current.id || dist < 0 || closedThrough) {
      approachStreak = 0;
      approachSeed = null;
      continue;
    }

    const approaching = dist < prevDist - 0.05;
    const against = againstTrend(direction, mid, prevMid);
    if (approaching && against) {
      approachStreak += 1;
      if (!approachSeed) {
        eventSeq += 1;
        approachSeed = {
          eventId: `E${eventSeq}`,
          direction,
          majorLineId: major.id,
          currentLineId: current.id,
          currentStatus: current.status,
          majorDirection: read.majorDirection!,
          currentDirection: read.currentDirection!,
          startBar: t,
          approachStreak: 1,
          minDist: dist,
          minBar: t,
          impulse: null,
          maxRetracePct: 0,
          fired: new Set(),
          entries: [],
        };
      } else if (dist < approachSeed.minDist) {
        approachSeed.minDist = dist;
        approachSeed.minBar = t;
        approachSeed.approachStreak = approachStreak;
      }
      if (approachStreak >= APPROACH_STREAK && approachSeed) {
        open = { ...approachSeed, approachStreak, fired: new Set(), entries: [] };
        open.impulse = resolveImpulse(direction, read.swings, current, mids, t);
        processBarOnOpen(open, t, read, current, linePrice, dist);
        approachSeed = null;
        approachStreak = 0;
      }
    } else {
      approachStreak = 0;
      approachSeed = null;
    }
  }

  if (open) closeEvent(open);

  // Events that never got an impulse still count for reach-rate denominator
  const qualifyingEvents = eventMeta;
  const eventsWithImpulse = qualifyingEvents.filter((e) => e.hadImpulse);
  const reach = new Map<Threshold, number>();
  for (const th of THRESHOLDS) {
    reach.set(
      th,
      eventsWithImpulse.filter((e) => e.reached.has(th) || e.maxRetrace >= th).length,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = [
    "instrument",
    "eventId",
    "direction",
    "timestamp",
    "majorDirection",
    "currentDirection",
    "currentLineId",
    "impulseStartTime",
    "impulseStartPrice",
    "impulseEndTime",
    "impulseEndPrice",
    "impulseSizePips",
    "impulseSizeATR",
    "entryThresholdPct",
    "actualRetracementPctAtEntry",
    "maxRetracementPctInEvent",
    "currentLinePrice",
    "distanceToCurrentPips",
    "distanceBucket",
    "entryPrice",
    "spreadPips",
    "mfe1h",
    "mae1h",
    "mfe4h",
    "mae4h",
    "mfe12h",
    "mae12h",
    "mfe24h",
    "mae24h",
    "fivePipRace",
    "tenPipRace",
    "twentyPipRace",
    "maeBefore5p",
    "maeBefore10p",
    "maeBefore20p",
    "timeTo5p",
    "timeTo10p",
    "timeTo20p",
  ];
  const csvLines = [header.join(",")];
  for (const e of allEntries) {
    csvLines.push(
      [
        e.instrument,
        e.eventId,
        e.direction,
        e.timestamp,
        e.majorDirection,
        e.currentDirection,
        e.currentLineId,
        e.impulseStartTime,
        e.impulseStartPrice.toFixed(5),
        e.impulseEndTime,
        e.impulseEndPrice.toFixed(5),
        e.impulseSizePips.toFixed(3),
        Number.isFinite(e.impulseSizeATR) ? e.impulseSizeATR.toFixed(3) : "",
        e.entryThresholdPct,
        e.actualRetracementPctAtEntry.toFixed(2),
        e.maxRetracementPctInEvent.toFixed(2),
        e.currentLinePrice.toFixed(5),
        e.distanceToCurrentPips.toFixed(3),
        e.distanceBucket,
        e.entryPrice.toFixed(5),
        e.spreadPips.toFixed(3),
        e.mfe1h.toFixed(3),
        e.mae1h.toFixed(3),
        e.mfe4h.toFixed(3),
        e.mae4h.toFixed(3),
        e.mfe12h.toFixed(3),
        e.mae12h.toFixed(3),
        e.mfe24h.toFixed(3),
        e.mae24h.toFixed(3),
        e.fivePipRace,
        e.tenPipRace,
        e.twentyPipRace,
        e.maeBefore5p?.toFixed(3) ?? "",
        e.maeBefore10p?.toFixed(3) ?? "",
        e.maeBefore20p?.toFixed(3) ?? "",
        e.timeTo5p ?? "",
        e.timeTo10p ?? "",
        e.timeTo20p ?? "",
      ].join(","),
    );
  }
  fs.writeFileSync(CSV_PATH, csvLines.join("\n"));

  const nEvents = eventsWithImpulse.length;
  const nAll = qualifyingEvents.length;
  const nNoImpulse = nAll - nEvents;

  log("ADAPTIVE TRENDLINE — PULLBACK DEPTH ENTRY TEST");
  log("EURUSD M15");
  log(`${first.slice(0, 10)} → ${last.slice(0, 10)}`);
  log("");
  log("INDICATOR: Adaptive Swing Trendlines V1 FROZEN | same event defs as distance test");
  log("Impulse: confirmed CURRENT structure low/high → subsequent confirmed opposite swing");
  log("Entries: FIRST causal cross of 25/50/75/100% | LONG@ASK SHORT@BID | MID structure");
  log("");
  log("EVENTS:");
  log(`Total qualifying pullbacks: ${nAll}`);
  log(
    `With causal impulse resolved: ${nEvents}${nNoImpulse ? ` (${nNoImpulse} lacked confirmed impulse end after fallback — excluded from depth rates)` : ""}`,
  );
  log(
    "Impulse note: primary = CURRENT.pointB → later opposite swing; fallback = latest confirmed L→H (or H→L) after CURRENT.pointA (pivot confirmation lag).",
  );
  log("");
  log("THRESHOLD REACH RATE");
  for (const th of THRESHOLDS) {
    const r = reach.get(th) ?? 0;
    log(`${th}%: ${r}/${nEvents} (${f1(pct(r, nEvents))}%)`);
  }

  printDepthTable("ENTRY RESULTS (COMBINED)", allEntries, nEvents, reach);
  printDepthTable(
    "LONG",
    allEntries.filter((r) => r.direction === "long"),
    eventsWithImpulse.filter((e) => e.direction === "long").length,
    new Map(
      THRESHOLDS.map((th) => [
        th,
        eventsWithImpulse.filter((e) => e.direction === "long" && (e.reached.has(th) || e.maxRetrace >= th))
          .length,
      ]),
    ),
  );
  printDepthTable(
    "SHORT",
    allEntries.filter((r) => r.direction === "short"),
    eventsWithImpulse.filter((e) => e.direction === "short").length,
    new Map(
      THRESHOLDS.map((th) => [
        th,
        eventsWithImpulse.filter((e) => e.direction === "short" && (e.reached.has(th) || e.maxRetrace >= th))
          .length,
      ]),
    ),
  );

  maeBeforeBlock(allEntries);
  log("");
  log("MAE BEFORE +10P — LONG");
  maeBeforeBlock(allEntries.filter((r) => r.direction === "long"));
  // maeBeforeBlock prints header each time — acceptable for clarity
  log("MAE BEFORE +10P — SHORT (see rows above pattern; reprint)");
  {
    const shortRows = allEntries.filter((r) => r.direction === "short");
    log(`${"DEPTH".padEnd(8)}${"P25".padStart(6)}  ${"P50".padStart(6)}  ${"P75".padStart(6)}  ${"P80".padStart(6)}  ${"P90".padStart(6)}  ${"P95".padStart(6)}  ${"N".padStart(5)}`);
    for (const th of THRESHOLDS) {
      const xs = shortRows.filter((r) => r.entryThresholdPct === th && r.maeBefore10p != null).map((r) => r.maeBefore10p!);
      log(
        `${`${th}%`.padEnd(8)}${f1(percentile(xs, 0.25)).padStart(6)}  ${f1(percentile(xs, 0.5)).padStart(6)}  ${f1(percentile(xs, 0.75)).padStart(6)}  ${f1(percentile(xs, 0.8)).padStart(6)}  ${f1(percentile(xs, 0.9)).padStart(6)}  ${f1(percentile(xs, 0.95)).padStart(6)}  ${String(xs.length).padStart(5)}`,
      );
    }
  }

  log("");
  log("DEPTH + CURRENT LINE");
  log(
    `${"DEPTH".padEnd(8)}${"LINE".padEnd(8)}${"N".padStart(5)}  ${"+10 FIRST".padStart(10)}  ${"MED MFE".padStart(7)}  ${"MED MAE".padStart(7)}  ${"MFE/MAE".padStart(8)}  NOTE`,
  );
  for (const th of THRESHOLDS) {
    for (const db of ["0-2p", "2-5p", "5-10p", ">10p"] as DistBucket[]) {
      const subset = allEntries.filter((r) => r.entryThresholdPct === th && r.distanceBucket === db);
      if (subset.length < 5) continue;
      const medMfe = median(subset.map((r) => r.mfe24h));
      const medMae = median(subset.map((r) => r.mae24h));
      const ratio = medMfe != null && medMae != null && medMae > 0 ? medMfe / medMae : null;
      const note = subset.length < 10 ? "VERY SMALL SAMPLE" : "";
      log(
        `${`${th}%`.padEnd(8)}${db.padEnd(8)}${String(subset.length).padStart(5)}  ${racePct(subset, "tenPipRace").padStart(10)}  ${f1(medMfe).padStart(7)}  ${f1(medMae).padStart(7)}  ${f2(ratio).padStart(8)}  ${note}`,
      );
    }
  }

  // Also LONG/SHORT depth+line for cells n>=5
  for (const side of ["long", "short"] as Dir[]) {
    log("");
    log(`DEPTH + CURRENT LINE — ${side.toUpperCase()} (n≥5)`);
    log(
      `${"DEPTH".padEnd(8)}${"LINE".padEnd(8)}${"N".padStart(5)}  ${"+10 FIRST".padStart(10)}  ${"MED MFE".padStart(7)}  ${"MED MAE".padStart(7)}  ${"MFE/MAE".padStart(8)}  NOTE`,
    );
    for (const th of THRESHOLDS) {
      for (const db of ["0-2p", "2-5p", "5-10p", ">10p"] as DistBucket[]) {
        const subset = allEntries.filter(
          (r) => r.direction === side && r.entryThresholdPct === th && r.distanceBucket === db,
        );
        if (subset.length < 5) continue;
        const medMfe = median(subset.map((r) => r.mfe24h));
        const medMae = median(subset.map((r) => r.mae24h));
        const ratio = medMfe != null && medMae != null && medMae > 0 ? medMfe / medMae : null;
        const note = subset.length < 10 ? "VERY SMALL SAMPLE" : "";
        log(
          `${`${th}%`.padEnd(8)}${db.padEnd(8)}${String(subset.length).padStart(5)}  ${racePct(subset, "tenPipRace").padStart(10)}  ${f1(medMfe).padStart(7)}  ${f1(medMae).padStart(7)}  ${f2(ratio).padStart(8)}  ${note}`,
        );
      }
    }
  }

  const byEvent = new Map<string, EntryRow[]>();
  for (const e of allEntries) {
    const list = byEvent.get(e.eventId) ?? [];
    list.push(e);
    byEvent.set(e.eventId, list);
  }

  log("");
  log("PAIRED COMPARISONS");
  // Same-bar multi-threshold fire rate (M15 granularity limit)
  let multiSameBar = 0;
  let multiEvents = 0;
  for (const rows of byEvent.values()) {
    if (rows.length < 2) continue;
    multiEvents += 1;
    const times = new Set(rows.map((r) => r.timestamp));
    if (times.size === 1) multiSameBar += 1;
  }
  log(
    `Note: ${multiSameBar}/${multiEvents} multi-threshold events fired all crossed depths on the SAME M15 bar (sharp pullback) — paired price/MAE diffs collapse to ~0 for those.`,
  );
  pairedCompare("25% vs 50%", 25, 50, byEvent);
  pairedCompare("50% vs 75%", 50, 75, byEvent);
  pairedCompare("75% vs 100%", 75, 100, byEvent);

  // Missed trades from waiting
  const r25 = reach.get(25) ?? 0;
  const r50 = reach.get(50) ?? 0;
  const r75 = reach.get(75) ?? 0;
  const r100 = reach.get(100) ?? 0;
  log("");
  log("MISSED-TRADE TRADEOFF (vs events that reached 25%)");
  log(`  Wait for 50%: miss ${r25 - r50} of ${r25} (${f1(pct(r25 - r50, r25))}%)`);
  log(`  Wait for 75%: miss ${r25 - r75} of ${r25} (${f1(pct(r25 - r75, r25))}%)`);
  log(`  Wait for 100%: miss ${r25 - r100} of ${r25} (${f1(pct(r25 - r100, r25))}%)`);

  // Impulse size split (descriptive median)
  const sizes = eventsWithImpulse.map((e) => e.impulseSizePips).filter((x) => Number.isFinite(x));
  const medImpulse = median(sizes);
  log("");
  log(`IMPULSE SIZE SPLIT (descriptive median = ${f1(medImpulse)}p) — secondary only`);
  if (medImpulse != null) {
    const smallIds = new Set(
      eventsWithImpulse.filter((e) => e.impulseSizePips < medImpulse).map((e) => e.eventId),
    );
    const largeIds = new Set(
      eventsWithImpulse.filter((e) => e.impulseSizePips >= medImpulse).map((e) => e.eventId),
    );
    for (const [label, ids] of [
      ["smaller-than-median", smallIds],
      ["larger-than-median", largeIds],
    ] as const) {
      const subset = allEntries.filter((r) => ids.has(r.eventId) && r.entryThresholdPct === 50);
      log(
        `  ${label} @50% entry: n=${subset.length} +10first=${racePct(subset, "tenPipRace")} medMFE=${f1(median(subset.map((r) => r.mfe24h)))} medMAE=${f1(median(subset.map((r) => r.mae24h)))}`,
      );
    }
  }

  // ----- Plain answers -----
  const at = (th: Threshold) => allEntries.filter((r) => r.entryThresholdPct === th);
  const p10 = (th: Threshold) => pct(at(th).filter((r) => r.tenPipRace === "plus_first").length, at(th).length);
  const medMae = (th: Threshold) => median(at(th).map((r) => r.mae24h));
  const medMfe = (th: Threshold) => median(at(th).map((r) => r.mfe24h));
  const mae10 = (th: Threshold) =>
    percentile(
      at(th).filter((r) => r.maeBefore10p != null).map((r) => r.maeBefore10p!),
      0.5,
    );

  // Depth + near line (≤5p)
  const nearLine = (th: Threshold) =>
    allEntries.filter(
      (r) => r.entryThresholdPct === th && (r.distanceBucket === "0-2p" || r.distanceBucket === "2-5p"),
    );
  const farLine = (th: Threshold) =>
    allEntries.filter((r) => r.entryThresholdPct === th && r.distanceBucket === ">10p");

  log("");
  log("PLAIN ENGLISH ANSWERS");
  log("-".repeat(72));

  const maeImproves =
    medMae(25) != null &&
    medMae(75) != null &&
    (medMae(75)! < medMae(25)! - 1 || (medMae(50) != null && medMae(50)! < medMae(25)! - 1));
  const p10Improves = p10(75) > p10(25) + 3 || p10(50) > p10(25) + 3;

  log(
    `1. Deeper pullback improve entry? ${maeImproves || p10Improves ? "PARTIALLY — some deeper thresholds show better MAE and/or +10-first, but check paired results and miss rates." : "NOT CLEARLY in aggregate — deeper thresholds do not consistently dominate 25% on both MAE and +10-first."}`,
  );
  log(
    `   Med MAE24: 25%=${f1(medMae(25))} 50%=${f1(medMae(50))} 75%=${f1(medMae(75))} 100%=${f1(medMae(100))}`,
  );

  let maeDepthNote = "no clear step-down";
  if (medMae(50) != null && medMae(25) != null && medMae(50)! < medMae(25)! - 1) maeDepthNote = "from ~50%";
  if (medMae(75) != null && medMae(50) != null && medMae(75)! < medMae(50)! - 1) maeDepthNote = "more clearly toward 75%";
  log(`2. MAE begins improving meaningfully: ${maeDepthNote}.`);

  log(
    `3. +10-first by depth: 25%=${f1(p10(25))}% 50%=${f1(p10(50))}% 75%=${f1(p10(75))}% 100%=${f1(p10(100))}% → ${p10Improves ? "some improvement at deeper levels" : "no reliable improvement"}`,
  );

  log(
    `4. Missed if waiting (of ${r25} that reached 25%): 50% misses ${r25 - r50} (${f1(pct(r25 - r50, r25))}%); 75% misses ${r25 - r75} (${f1(pct(r25 - r75, r25))}%); 100% misses ${r25 - r100} (${f1(pct(r25 - r100, r25))}%).`,
  );

  // Compare depth-only vs depth+near for 50% and 75%
  const comboNotes: string[] = [];
  for (const th of [50, 75] as Threshold[]) {
    const near = nearLine(th);
    const far = farLine(th);
    const all = at(th);
    if (near.length >= 5 && all.length >= 5) {
      const nearP10 = pct(near.filter((r) => r.tenPipRace === "plus_first").length, near.length);
      const allP10 = pct(all.filter((r) => r.tenPipRace === "plus_first").length, all.length);
      const nearMae = median(near.map((r) => r.mae24h));
      const allMae = median(all.map((r) => r.mae24h));
      comboNotes.push(
        `${th}%+≤5p from line n=${near.length}${near.length < 10 ? " (SMALL)" : ""} +10=${f1(nearP10)}% medMAE=${f1(nearMae)} vs depth-only +10=${f1(allP10)}% medMAE=${f1(allMae)}${far.length >= 5 ? ` vs >10p n=${far.length} +10=${f1(pct(far.filter((r) => r.tenPipRace === "plus_first").length, far.length))}%` : ""}`,
      );
    }
  }
  log(
    `5. Depth + CURRENT proximity: ${comboNotes.length ? comboNotes.join(" | ") : "insufficient cells with n≥5 to claim combo edge over depth alone."}`,
  );

  const longP10 = pct(
    allEntries.filter((r) => r.direction === "long" && r.entryThresholdPct === 50 && r.tenPipRace === "plus_first")
      .length,
    allEntries.filter((r) => r.direction === "long" && r.entryThresholdPct === 50).length,
  );
  const shortP10 = pct(
    allEntries.filter((r) => r.direction === "short" && r.entryThresholdPct === 50 && r.tenPipRace === "plus_first")
      .length,
    allEntries.filter((r) => r.direction === "short" && r.entryThresholdPct === 50).length,
  );
  log(
    `6. LONG vs SHORT at 50% entry +10-first: ${f1(longP10)}% vs ${f1(shortP10)}% → ${Math.abs((longP10 || 0) - (shortP10 || 0)) > 8 ? "YES, materially different" : "similar"}.`,
  );

  log(
    `7. Med MAE before +10p after entry: 25%=${f1(mae10(25))}p 50%=${f1(mae10(50))}p 75%=${f1(mae10(75))}p 100%=${f1(mae10(100))}p.`,
  );

  // Zone evidence: compare adjacent buckets rather than exact %
  const zone50_75_near = allEntries.filter(
    (r) =>
      (r.entryThresholdPct === 50 || r.entryThresholdPct === 75) &&
      (r.distanceBucket === "0-2p" || r.distanceBucket === "2-5p"),
  );
  const zoneEarly = allEntries.filter((r) => r.entryThresholdPct === 25);
  log(
    `8. Practical ZONE vs exact price: 50–75% entries with ≤5p to CURRENT n=${zone50_75_near.length} +10=${racePct(zone50_75_near, "tenPipRace")} medMFE=${f1(median(zone50_75_near.map((r) => r.mfe24h)))} medMAE=${f1(median(zone50_75_near.map((r) => r.mae24h)))} vs early 25% n=${zoneEarly.length} +10=${racePct(zoneEarly, "tenPipRace")} medMAE=${f1(median(zoneEarly.map((r) => r.mae24h)))}. ${zone50_75_near.length >= 10 && median(zone50_75_near.map((r) => r.mae24h)) != null && median(zoneEarly.map((r) => r.mae24h)) != null && median(zone50_75_near.map((r) => r.mae24h))! + 1 < median(zoneEarly.map((r) => r.mae24h))! ? "Suggests a ZONE (deeper + near line) more than a single magic %." : "No strong zone signature beyond sample noise."}`,
  );

  log("");
  const overall =
    (maeImproves || p10Improves) && r50 / Math.max(1, r25) >= 0.4
      ? "LEAN MIXED-POSITIVE on geometry: deeper pullbacks (especially mid-depth) can improve MAE when reached, but opportunity cost is real and LONG/SHORT diverge. Not a production rule."
      : "NO ROBUST DEPTH EDGE in this 30-day window: pullback % alone (even with CURRENT distance) does not cleanly predict better entries after accounting for miss rates, side asymmetry, and small combo cells.";
  log(`OVERALL: ${overall}`);
  log("");
  log(`CSV: ${CSV_PATH}`);
  log(`Report: ${REPORT_PATH}`);
  log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(REPORT_PATH, L.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
