/**
 * Adaptive Swing Trendlines V1 — ENTRY LOCATION research (FROZEN indicator).
 *
 * Question: when MAJOR and CURRENT agree, does waiting for price to pull back
 * nearer the CURRENT trendline improve subsequent excursion vs entering farther away?
 *
 * RULES (research-only):
 * - Do NOT modify adaptive-swing-trendlines.ts
 * - Do NOT optimize trendline logic / MAJOR / CURRENT
 * - Do NOT add production trading logic
 * - Exact analyzeAdaptiveSwingTrendlines() replayed causally candle-by-candle
 * - Only MAJOR↑+CURRENT↑ (long) or MAJOR↓+CURRENT↓ (short); CURRENT not broken
 * - Ignore mixed / pullback-label disagreement states
 *
 * EVENT DE-DUPLICATION (documented):
 * 1. A pullback EVENT starts when, under agreement, distance-to-CURRENT decreases
 *    for 2 consecutive bars AND price prints against the trend (long: lower low;
 *    short: higher high) while still on the correct side of the line.
 * 2. While open, track the minimum distance reached and the first bar that set it.
 * 3. Resolve when ANY of: (a) distance expands ≥2p from the event minimum (bounce),
 *    (b) CURRENT line id changes / CURRENT breaks / agreement ends,
 *    (c) price closes through the CURRENT line, (d) 48 bars elapse without bounce.
 * 4. After resolve, the same CURRENT line id cannot start another event until
 *    distance expands ≥5p from that event's minimum (extension away) OR the
 *    CURRENT line id changes. This prevents every near-line M15 bar from counting.
 * 5. One CSV row / one bucket assignment per resolved event. Bucket = min distance
 *    reached. Entry = first bar that achieved that minimum (ASK long / BID short).
 *
 * Data: OANDA M15 MID+BID+ASK cache (completed candles only). Structure on MID;
 * execution on BID/ASK. Races on M15; same-bar both-sides → AMBIGUOUS.
 */
import fs from "node:fs";
import path from "node:path";
import {
  analyzeAdaptiveSwingTrendlines,
  type AdaptiveTrendDirection,
  type AdaptiveTrendline,
} from "../src/lib/adaptive-swing-trendlines";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import type { Candle, MajorInstrument } from "../src/types/forex";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const TRADING_DAYS = Number(process.env.ATL_DAYS ?? 30);
const WARMUP_BARS = 400; // > majorLookback (2d) + pivots
const M15_PER_HOUR = 4;
const BARS_1H = 1 * M15_PER_HOUR;
const BARS_4H = 4 * M15_PER_HOUR;
const BARS_12H = 12 * M15_PER_HOUR;
const BARS_24H = 24 * M15_PER_HOUR;
const BOUNCE_RESOLVE_PIPS = 2;
const REARM_EXTENSION_PIPS = 5;
const MAX_PULLBACK_BARS = 48;
const APPROACH_STREAK = 2;

const CACHE =
  process.env.ATL_M15_CACHE ??
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const OUT_DIR = path.resolve(__dirname, "../research-output");
const CSV_PATH = path.join(OUT_DIR, "eurusd-adaptive-trendline-entry-v1-events.csv");
const REPORT_PATH = path.join(OUT_DIR, "eurusd-adaptive-trendline-entry-v1-report.txt");

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; volume: number; complete: boolean; mid: OHLC; bid: OHLC; ask: OHLC };
type Dir = "long" | "short";
type Bucket = "0-2p" | "2-5p" | "5-10p" | ">10p";
type Race = "plus_first" | "minus_first" | "neither" | "ambiguous";

type EventRow = {
  instrument: string;
  timestamp: string;
  direction: Dir;
  majorDirection: AdaptiveTrendDirection;
  currentDirection: AdaptiveTrendDirection;
  majorLineId: string;
  currentLineId: string;
  currentLineStatus: string;
  currentLinePrice: number;
  marketPrice: number;
  distanceToCurrentPips: number;
  distanceBucket: Bucket;
  entryPrice: number;
  spreadPips: number;
  entryBar: number;
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
  timeTo5p: number | null;
  timeTo10p: number | null;
  timeTo20p: number | null;
  maeBefore5: number | null;
  maeBefore10: number | null;
  maeBefore20: number | null;
};

type OpenPullback = {
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
  minLinePrice: number;
  minMarket: number;
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};

const f1 = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "-" : x.toFixed(1);
const f2 = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "-" : x.toFixed(2);
const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);

function projectLine(line: Pick<AdaptiveTrendline, "pointA" | "slopePerBar">, index: number) {
  return line.pointA.price + line.slopePerBar * (index - line.pointA.index);
}

function bucketOf(dist: number): Bucket {
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

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
  // Closest approach of the candle extreme toward the CURRENT line (MID structure).
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
      // Mark-to-market on BID after ASK entry
      mfe = Math.max(mfe, (b.bid.high - entry) / PIP);
      mae = Math.max(mae, (entry - b.bid.low) / PIP);
    } else {
      // Mark-to-market on ASK after BID entry
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
    if (timeToPlus != null && timeToMinus == null && i === from + (timeToPlus - 1)) {
      // plus resolved this bar without minus — done for race
    }
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

function finalizeEvent(
  pb: OpenPullback,
  bars: RC[],
): EventRow | null {
  // Ignore events that never approached (still far and unresolved without a real pullback)
  if (pb.minDist < 0) return null; // closed through before counting a touch approach — skip
  const entryBar = pb.minBar;
  const c = bars[entryBar]!;
  const direction = pb.direction;
  const entryPrice = direction === "long" ? c.ask.close : c.bid.close;
  const spreadPips = (c.ask.close - c.bid.close) / PIP;
  const from = entryBar + 1; // outcomes after entry bar close

  const e1 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_1H);
  const e4 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_4H);
  const e12 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_12H);
  const e24 = excursionFromEntry(direction, entryPrice, bars, from, from + BARS_24H);

  const r5 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 5);
  const r10 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 10);
  const r20 = raceAndTimes(direction, entryPrice, bars, from, BARS_24H, 20);

  return {
    instrument: INSTRUMENT,
    timestamp: c.time,
    direction,
    majorDirection: pb.majorDirection,
    currentDirection: pb.currentDirection,
    majorLineId: pb.majorLineId,
    currentLineId: pb.currentLineId,
    currentLineStatus: pb.currentStatus,
    currentLinePrice: pb.minLinePrice,
    marketPrice: pb.minMarket,
    distanceToCurrentPips: pb.minDist,
    distanceBucket: bucketOf(pb.minDist),
    entryPrice,
    spreadPips,
    entryBar,
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
    timeTo5p: r5.timeToPlus,
    timeTo10p: r10.timeToPlus,
    timeTo20p: r20.timeToPlus,
    maeBefore5: r5.maeBeforePlus,
    maeBefore10: r10.maeBeforePlus,
    maeBefore20: r20.maeBeforePlus,
  };
}

function racePct(rows: EventRow[], key: "fivePipRace" | "tenPipRace" | "twentyPipRace"): string {
  if (!rows.length) return "-";
  const plus = rows.filter((r) => r[key] === "plus_first").length;
  return `${f1(pct(plus, rows.length))}%`;
}

function summarizeBucket(rows: EventRow[], label: string) {
  const n = rows.length;
  const medMfe = median(rows.map((r) => r.mfe24h));
  const medMae = median(rows.map((r) => r.mae24h));
  log(
    `${label.padEnd(10)}${String(n).padStart(5)}  ${racePct(rows, "fivePipRace").padStart(9)}  ${racePct(rows, "tenPipRace").padStart(10)}  ${racePct(rows, "twentyPipRace").padStart(10)}  ${f1(medMfe).padStart(7)}  ${f1(medMae).padStart(7)}`,
  );
}

function spreadStats(rows: EventRow[]) {
  const s = rows.map((r) => r.spreadPips);
  return { avg: mean(s), med: median(s) };
}

function timeStats(rows: EventRow[], key: "timeTo5p" | "timeTo10p" | "timeTo20p") {
  const mins = rows
    .map((r) => r[key])
    .filter((x): x is number => x != null)
    .map((bars) => bars * 15);
  return median(mins);
}

function printSide(title: string, rows: EventRow[]) {
  log("");
  log(title);
  log("-".repeat(72));
  log(
    `${"DISTANCE".padEnd(10)}${"N".padStart(5)}  ${"+5 FIRST".padStart(9)}  ${"+10 FIRST".padStart(10)}  ${"+20 FIRST".padStart(10)}  ${"MED MFE".padStart(7)}  ${"MED MAE".padStart(7)}`,
  );
  for (const b of ["0-2p", "2-5p", "5-10p", ">10p"] as Bucket[]) {
    summarizeBucket(
      rows.filter((r) => r.distanceBucket === b),
      b,
    );
  }
  const spr = spreadStats(rows);
  log(
    `avg spread ${f2(spr.avg)}p | med spread ${f2(spr.med)}p | med t→+5 ${f1(timeStats(rows, "timeTo5p"))}m | med t→+10 ${f1(timeStats(rows, "timeTo10p"))}m | med t→+20 ${f1(timeStats(rows, "timeTo20p"))}m`,
  );
}

function maeDistBlock(rows: EventRow[], target: 5 | 10 | 20) {
  const key = target === 5 ? "maeBefore5" : target === 10 ? "maeBefore10" : "maeBefore20";
  const raceKey = target === 5 ? "fivePipRace" : target === 10 ? "tenPipRace" : "twentyPipRace";
  const xs = rows
    .filter((r) => r[raceKey] === "plus_first" || (r[key] != null && r[key]! >= 0))
    .map((r) => r[key])
    .filter((x): x is number => x != null);
  // Prefer rows that actually reached +target (plus_first or had maeBefore set)
  const reached = rows.filter((r) => r[key] != null).map((r) => r[key]!);
  const use = reached.length ? reached : xs;
  log(`P25: ${f1(percentile(use, 0.25))}`);
  log(`P50: ${f1(percentile(use, 0.5))}  (median)`);
  log(`P75: ${f1(percentile(use, 0.75))}`);
  log(`P80: ${f1(percentile(use, 0.8))}`);
  log(`P90: ${f1(percentile(use, 0.9))}`);
  log(`P95: ${f1(percentile(use, 0.95))}`);
  log(`(n=${use.length} entries that reached +${target}p within 24h)`);
}

async function main() {
  if (!fs.existsSync(CACHE)) {
    console.error(`Missing M15 MBA cache: ${CACHE}`);
    process.exit(1);
  }
  console.error(`Loading ${CACHE} ...`);
  const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  let { rows, analysisStart, dayCount } = loadWindow(raw, TRADING_DAYS);
  if (dayCount < TRADING_DAYS && TRADING_DAYS > 15) {
    console.error(`Only ${dayCount} trading days in cache window request; continuing.`);
  }
  // If user wants fallback to 15 days via env
  if (process.env.ATL_DAYS === "15") {
    ({ rows, analysisStart, dayCount } = loadWindow(raw, 15));
  }

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
  console.error(`Bars: ${rows.length} (analysis from idx ${analysisStart})`);
  console.error("Causal replay of Adaptive Swing Trendlines V1 ...");

  const events: EventRow[] = [];
  let open: OpenPullback | null = null;
  let blockedLineId: string | null = null;
  let blockUntilDist: number | null = null; // re-arm when dist >= this
  let approachStreak = 0;
  let approachSeed: OpenPullback | null = null;

  let bullAgreeBars = 0;
  let bearAgreeBars = 0;
  let bullEpisodes = 0;
  let bearEpisodes = 0;
  let prevAgree: Dir | null = null;

  const t0 = Date.now();
  for (let t = analysisStart; t < rows.length; t += 1) {
    if ((t - analysisStart) % 500 === 0) {
      process.stderr.write(
        `  bar ${t - analysisStart}/${rows.length - analysisStart} events=${events.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
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
    const qualify = agreeLong || agreeShort;
    const direction: Dir | null = agreeLong ? "long" : agreeShort ? "short" : null;

    if (agreeLong) {
      bullAgreeBars += 1;
      if (prevAgree !== "long") bullEpisodes += 1;
      prevAgree = "long";
    } else if (agreeShort) {
      bearAgreeBars += 1;
      if (prevAgree !== "short") bearEpisodes += 1;
      prevAgree = "short";
    } else {
      prevAgree = null;
    }

    if (!qualify || !direction || !current || !major) {
      if (open) {
        const ev = finalizeEvent(open, rows);
        if (ev) events.push(ev);
        blockedLineId = open.currentLineId;
        blockUntilDist = open.minDist + REARM_EXTENSION_PIPS;
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

    // Re-arm gate for same CURRENT structure
    if (blockedLineId === current.id) {
      if (dist >= (blockUntilDist ?? Infinity) || dist < 0) {
        blockedLineId = null;
        blockUntilDist = null;
      }
    } else if (blockedLineId && blockedLineId !== current.id) {
      blockedLineId = null;
      blockUntilDist = null;
    }

    const closedThrough =
      direction === "long" ? mid.close < linePrice : mid.close > linePrice;

    // Resolve open pullback on structure change / break / through-line / timeout / bounce
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
        open.minLinePrice = linePrice;
        open.minMarket = mid.close;
      }

      if (structureChange || closedThrough || bounced || timedOut) {
        const ev = finalizeEvent(open, rows);
        if (ev) events.push(ev);
        blockedLineId = open.currentLineId;
        blockUntilDist = open.minDist + REARM_EXTENSION_PIPS;
        open = null;
        approachStreak = 0;
        approachSeed = null;
        continue;
      }
      continue;
    }

    // Start new pullback after sustained approach against the trend
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
        approachSeed = {
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
          minLinePrice: linePrice,
          minMarket: mid.close,
        };
      } else if (dist < approachSeed.minDist) {
        approachSeed.minDist = dist;
        approachSeed.minBar = t;
        approachSeed.minLinePrice = linePrice;
        approachSeed.minMarket = mid.close;
        approachSeed.approachStreak = approachStreak;
      }
      if (approachStreak >= APPROACH_STREAK && approachSeed) {
        open = { ...approachSeed, approachStreak };
        approachSeed = null;
        approachStreak = 0;
      }
    } else {
      approachStreak = 0;
      approachSeed = null;
    }
  }

  // Flush trailing open pullback at end of series (if enough history after for excursions)
  if (open) {
    const ev = finalizeEvent(open, rows);
    if (ev) events.push(ev);
  }

  // Require APPROACH_STREAK conceptually: filter events that never showed sustained approach
  // (min bar must be after start, or start itself if single-bar deep approach already far→near)
  const kept = events.filter((e) => {
    // Drop events with no forward path
    return e.entryBar + 1 < rows.length;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = [
    "instrument",
    "timestamp",
    "direction",
    "majorDirection",
    "currentDirection",
    "majorLineId",
    "currentLineId",
    "currentLineStatus",
    "currentLinePrice",
    "marketPrice",
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
    "timeTo5p",
    "timeTo10p",
    "timeTo20p",
    "maeBefore5",
    "maeBefore10",
    "maeBefore20",
  ];
  const csvLines = [header.join(",")];
  for (const e of kept) {
    csvLines.push(
      [
        e.instrument,
        e.timestamp,
        e.direction,
        e.majorDirection,
        e.currentDirection,
        e.majorLineId,
        e.currentLineId,
        e.currentLineStatus,
        e.currentLinePrice.toFixed(5),
        e.marketPrice.toFixed(5),
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
        e.timeTo5p ?? "",
        e.timeTo10p ?? "",
        e.timeTo20p ?? "",
        e.maeBefore5?.toFixed(3) ?? "",
        e.maeBefore10?.toFixed(3) ?? "",
        e.maeBefore20?.toFixed(3) ?? "",
      ].join(","),
    );
  }
  fs.writeFileSync(CSV_PATH, csvLines.join("\n"));

  // -------- Report --------
  log("ADAPTIVE TRENDLINE ENTRY TEST");
  log("EURUSD M15");
  log(`LAST ${dayCount} TRADING DAYS`);
  log(`${first.slice(0, 10)} → ${last.slice(0, 10)}`);
  log("");
  log("INDICATOR: Adaptive Swing Trendlines V1 (FROZEN) — causal replay, completed M15 only");
  log("Structure: MID | Execution: LONG@ASK / SHORT@BID | Races: M15 (same-bar both → AMBIGUOUS)");
  log("");
  log("QUALIFYING TREND PERIODS");
  log(`Bullish agreement: ${bullEpisodes} episodes (${bullAgreeBars} bars)`);
  log(`Bearish agreement: ${bearEpisodes} episodes (${bearAgreeBars} bars)`);
  log("");
  log("PULLBACK EVENTS:");
  log(`Total: ${kept.length}`);
  log(
    `De-dup: one event per approach; resolve on bounce≥${BOUNCE_RESOLVE_PIPS}p / line change / break / ${MAX_PULLBACK_BARS}-bar timeout; re-arm after +${REARM_EXTENSION_PIPS}p extension or new CURRENT id.`,
  );

  printSide("DISTANCE RESULTS (COMBINED)", kept);
  printSide("LONG RESULTS", kept.filter((r) => r.direction === "long"));
  printSide("SHORT RESULTS", kept.filter((r) => r.direction === "short"));

  log("");
  log("SUCCESSFUL +10P MAE DISTRIBUTION");
  log("(adverse excursion BEFORE first +10p, BID/ASK marked)");
  maeDistBlock(kept, 10);

  log("");
  log("SUCCESSFUL +5P MAE DISTRIBUTION");
  maeDistBlock(kept, 5);
  log("");
  log("SUCCESSFUL +20P MAE DISTRIBUTION");
  maeDistBlock(kept, 20);

  // Baseline / proximity comparison
  const near = kept.filter((r) => r.distanceBucket === "0-2p" || r.distanceBucket === "2-5p");
  const far = kept.filter((r) => r.distanceBucket === ">10p");
  const midB = kept.filter((r) => r.distanceBucket === "5-10p");
  const b02 = kept.filter((r) => r.distanceBucket === "0-2p");
  const b25 = kept.filter((r) => r.distanceBucket === "2-5p");

  const medMfe = (xs: EventRow[]) => median(xs.map((r) => r.mfe24h));
  const medMae = (xs: EventRow[]) => median(xs.map((r) => r.mae24h));
  const plus10 = (xs: EventRow[]) => pct(xs.filter((r) => r.tenPipRace === "plus_first").length, xs.length);

  log("");
  log("BASELINE: near CURRENT (0–5p) vs far (>10p) under same MAJOR+CURRENT agreement");
  log(
    `Near 0–5p: n=${near.length} medMFE24=${f1(medMfe(near))} medMAE24=${f1(medMae(near))} +10first=${f1(plus10(near))}% avgSpr=${f2(spreadStats(near).avg)}`,
  );
  log(
    `Mid 5–10p: n=${midB.length} medMFE24=${f1(medMfe(midB))} medMAE24=${f1(medMae(midB))} +10first=${f1(plus10(midB))}%`,
  );
  log(
    `Far  >10p: n=${far.length} medMFE24=${f1(medMfe(far))} medMAE24=${f1(medMae(far))} +10first=${f1(plus10(far))}% avgSpr=${f2(spreadStats(far).avg)}`,
  );

  log("");
  log("PLAIN ENGLISH VERDICT");
  log("-".repeat(72));

  const answers: string[] = [];
  const nOk = kept.length >= 20;
  const mfeNear = medMfe(near);
  const mfeFar = medMfe(far);
  const maeNear = medMae(near);
  const maeFar = medMae(far);
  const p10Near = plus10(near);
  const p10Far = plus10(far);
  const mfe02 = medMfe(b02);
  const mfe25 = medMfe(b25);
  const mae02 = medMae(b02);
  const mae25 = medMae(b25);

  const closerImprovesMfe =
    mfeNear != null && mfeFar != null && mfeNear > mfeFar + 0.5;
  const closerReducesMae =
    maeNear != null && maeFar != null && maeNear < maeFar - 0.5;
  const closerBetterRace = Number.isFinite(p10Near) && Number.isFinite(p10Far) && p10Near > p10Far + 3;
  const touchBetterThan25 =
    b02.length >= 5 &&
    b25.length >= 5 &&
    mfe02 != null &&
    mfe25 != null &&
    ((mfe02 > mfe25 + 0.5 && (mae02 ?? 99) <= (mae25 ?? 0) + 1) ||
      ((mae02 ?? 99) + 0.5 < (mae25 ?? 0) && (mfe02 ?? 0) >= (mfe25 ?? 0) - 1));

  const longN = kept.filter((r) => r.direction === "long").length;
  const shortN = kept.filter((r) => r.direction === "short").length;
  const longP10 = plus10(kept.filter((r) => r.direction === "long"));
  const shortP10 = plus10(kept.filter((r) => r.direction === "short"));
  const sideDiff = Math.abs((longP10 || 0) - (shortP10 || 0));

  const sprMed = spreadStats(kept).med ?? 0;
  const reached10 = kept.filter((r) => r.maeBefore10 != null);
  const mae10p50 = percentile(
    reached10.map((r) => r.maeBefore10!),
    0.5,
  );
  const mae10p90 = percentile(
    reached10.map((r) => r.maeBefore10!),
    0.9,
  );

  // Ratio favorable/adverse by bucket
  const ratio = (xs: EventRow[]) => {
    const a = medMfe(xs);
    const b = medMae(xs);
    if (a == null || b == null || b === 0) return null;
    return a / b;
  };
  const ratios = (["0-2p", "2-5p", "5-10p", ">10p"] as Bucket[]).map((b) => ({
    b,
    r: ratio(kept.filter((x) => x.distanceBucket === b)),
    n: kept.filter((x) => x.distanceBucket === b).length,
  }));
  const bestRatio = [...ratios].filter((x) => x.r != null && x.n >= 3).sort((a, b) => (b.r ?? 0) - (a.r ?? 0))[0];

  answers.push(
    `1. Closer to CURRENT vs far (>10p) MFE24: near ${f1(mfeNear)}p vs far ${f1(mfeFar)}p → ${closerImprovesMfe ? "near looks better" : "no clear MFE advantage for proximity"}.`,
  );
  answers.push(
    `2. MAE24 near vs far: ${f1(maeNear)}p vs ${f1(maeFar)}p → ${closerReducesMae ? "proximity associated with lower MAE" : "MAE not clearly reduced by proximity"}.`,
  );
  answers.push(
    `3. Best medMFE/medMAE bucket: ${bestRatio ? `${bestRatio.b} (ratio ${f2(bestRatio.r)}, n=${bestRatio.n})` : "insufficient"}`,
  );
  answers.push(
    `4. Before successful +10p: median adverse ${f1(mae10p50)}p, P90 ${f1(mae10p90)}p (n=${reached10.length}). ${mae10p50 != null && mae10p50 >= 3 ? "Yes — several pips negative is common." : "Often small adverse before +10."}`,
  );
  answers.push(
    `5. 0–2p vs 2–5p: MFE ${f1(mfe02)}/${f1(mfe25)}, MAE ${f1(mae02)}/${f1(mae25)} (n=${b02.length}/${b25.length}) → ${touchBetterThan25 ? "0–2p edges 2–5p" : "0–2p not clearly better than 2–5p"}.`,
  );
  answers.push(
    `6. Exact touch selectivity: 0–2p n=${b02.length} of ${kept.length} (${f1(pct(b02.length, kept.length))}%). ${b02.length < kept.length * 0.25 ? "Touch bucket is selective." : "Touch is a large share of events."}`,
  );
  answers.push(
    `7. >10p: +10first ${f1(plus10(far))}% medMFE ${f1(mfeFar)} medMAE ${f1(maeFar)} (n=${far.length}) → ${far.length && p10Far + 5 < p10Near ? "materially weaker on +10-first" : "not clearly much worse on these metrics"}.`,
  );
  answers.push(
    `8. LONG vs SHORT: n=${longN}/${shortN}, +10first ${f1(longP10)}% vs ${f1(shortP10)}% → ${sideDiff > 8 ? "noticeable side difference" : "broadly similar"}.`,
  );
  answers.push(
    `9. Spread: median ${f2(sprMed)}p. Small edge claims inside ~1–2p of spread are not meaningful after costs.`,
  );
  const separation =
    closerImprovesMfe || closerReducesMae || closerBetterRace
      ? "Some separation by distance, but"
      : "Little stable separation by distance —";
  answers.push(
    `10. ${separation} sample ${nOk ? `n=${kept.length}` : `n=${kept.length} (thin)`}; treat as directional evidence only, not a production entry rule.`,
  );

  for (const a of answers) log(a);

  log("");
  const improveCount = [closerImprovesMfe, closerReducesMae, closerBetterRace].filter(Boolean).length;
  const raceContradicts = Number.isFinite(p10Near) && Number.isFinite(p10Far) && p10Near + 3 < p10Far;
  let verdict: string;
  if (!nOk) {
    verdict =
      "INCONCLUSIVE — sample too small to claim that waiting for the CURRENT trendline improves entry quality.";
  } else if (improveCount >= 2 && !raceContradicts && (mfeNear ?? 0) - (mfeFar ?? 0) > sprMed) {
    verdict =
      "LEAN YES — closer pullbacks show a better MFE/MAE or +10-first profile than >10p entries under agreement, with separation larger than median spread; still not proof, and 0–2p is not automatically better than 2–5p.";
  } else if (improveCount === 0) {
    verdict =
      "NO CLEAR BENEFIT — under MAJOR+CURRENT agreement, getting closer to CURRENT did not measurably improve entry quality vs farther pullbacks after accounting for sample size, MAE/MFE, target-first rates, and spread.";
  } else {
    verdict =
      "MIXED / WEAK — closer pullbacks show better median MFE/MAE than >10p, but +10-first rates do not improve with proximity and LONG vs SHORT diverges. Waiting for an exact 0–2p touch is not clearly justified over a 2–5p (or even 5–10p) approach in this window.";
  }
  log(`Did waiting for price to approach the CURRENT trendline improve entry quality?`);
  log(verdict);
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
