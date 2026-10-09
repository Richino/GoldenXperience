/**
 * Analyze V2, Phase 2 (deterministic foundation): data checks, price maths,
 * trend structure, zones and pullback states. Fixed synthetic candles, no
 * network, no randomness. Asserts behaviour, not profitability.
 *
 *   npm run analyze-v2:test
 */
import assert from "node:assert/strict";
import { ANALYZE_V2, v20Config, type ModeConfig } from "../src/lib/strategy/analyze-v2/config";
import { checkCandleFreshness, checkIntegrity, checkQuote, isMarketOpen, normalizeCandles } from "../src/lib/strategy/analyze-v2/data-quality";
import { executableEntry, executableRewardRisk, exitSide, fromPips, levelsAreOrdered, pipsBetween, roundPrice, spreadPipsOf, toPips } from "../src/lib/strategy/analyze-v2/instrument-math";
import { readMarketFoundation } from "../src/lib/strategy/analyze-v2/foundation";
import { analyzeV2, type AnalysisResult, type CheckId } from "../src/lib/strategy/analyze-v2/decide";
import { analyzeV2Context } from "../src/lib/strategy/analyze-v2/context";
import { explanationFacts, numbersIn, parseExplanationFacts, validateExplanation } from "../src/lib/strategy/analyze-v2/explain";
import { toMarketAnalysis } from "../src/lib/strategy/analyze-v2/adapter";
import { assessNews, assessVolatility } from "../src/lib/strategy/analyze-v2/risk";
import { assessLiquidity, buildLiquidityLevels, classifyLevel, sessionWindows, tradingDay, type LiquidityLevel } from "../src/lib/strategy/analyze-v2/liquidity";
import { readPullback } from "../src/lib/strategy/analyze-v2/pullback";
import { alignmentOf, readTrend, type TrendRead } from "../src/lib/strategy/analyze-v2/structure";
import { buildZones } from "../src/lib/strategy/analyze-v2/zones";
import { confirmedPivots } from "../src/lib/strategy/market-regime";
import type { Candle } from "../src/types/forex";

const NORMAL = ANALYZE_V2.NORMAL;
const EU = "EUR_USD";
let passed = 0;
function test(name: string, run: () => void) {
  try {
    run();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

/** Monday 2026-09-21 00:00 UTC: a full trading week ahead, no weekend inside 200 M15 bars. */
const START = Date.parse("2026-09-21T00:00:00Z");
const M15 = 15 * 60_000;

/**
 * Candles along straight legs between turning prices, `bars` candles per leg.
 * Each candle opens at the previous close; wicks extend `wick` past the body.
 */
function path(turns: number[], bars: number, { start = START, step = M15, wick = 0.0001 } = {}): Candle[] {
  const closes: number[] = [];
  for (let leg = 0; leg < turns.length - 1; leg += 1) {
    for (let i = 1; i <= bars; i += 1) closes.push(turns[leg]! + ((turns[leg + 1]! - turns[leg]!) * i) / bars);
  }
  let previous = turns[0]!;
  return closes.map((close, index) => {
    const candle = {
      time: new Date(start + index * step).toISOString(),
      open: previous,
      high: Math.max(previous, close) + wick,
      low: Math.min(previous, close) - wick,
      close,
      volume: 100,
      complete: true,
    };
    previous = close;
    return candle;
  });
}

/** Append straight-line candles from the last close to each of `targets`. */
function extend(candles: Candle[], targets: Array<[price: number, bars: number]>, { step = M15, wick = 0.0001 } = {}): Candle[] {
  const out = [...candles];
  for (const [target, bars] of targets) {
    const from = out.at(-1)!.close;
    for (let i = 1; i <= bars; i += 1) {
      const close = from + ((target - from) * i) / bars;
      const open = out.at(-1)!.close;
      out.push({
        time: new Date(Date.parse(out.at(-1)!.time) + step).toISOString(),
        open,
        high: Math.max(open, close) + wick,
        low: Math.min(open, close) - wick,
        close,
        volume: 100,
        complete: true,
      });
    }
  }
  return out;
}

/** Reflect prices about `center`: an uptrend becomes its downtrend mirror. */
function mirror(candles: Candle[], center: number): Candle[] {
  return candles.map((candle) => ({
    ...candle,
    open: 2 * center - candle.open,
    close: 2 * center - candle.close,
    high: 2 * center - candle.low,
    low: 2 * center - candle.high,
  }));
}

// Higher highs and higher lows, ending at a fresh high.
const UP = path([1.1030, 1.1000, 1.1060, 1.1030, 1.1090, 1.1060, 1.1120], 15);

// ---------------------------------------------------------------- price maths

test("pip size and pip distances follow instrument metadata", () => {
  assert.equal(toPips(EU, 0.0015), 15);
  assert.equal(toPips("USD_JPY", 0.15), 15);
  assert.equal(Number(fromPips("USD_JPY", 20).toFixed(2)), 0.2);
  assert.equal(Number(pipsBetween(EU, 1.10123, 1.10023).toFixed(1)), 10);
  assert.equal(roundPrice("USD_JPY", 150.12345), 150.123);
  assert.equal(roundPrice(EU, 1.123456), 1.12346);
});

test("longs enter at the ask and exit at the bid; shorts the reverse", () => {
  const quote = { bid: 1.1000, ask: 1.10015 };
  assert.equal(executableEntry("LONG", quote), 1.10015);
  assert.equal(executableEntry("SHORT", quote), 1.1);
  assert.equal(exitSide("LONG"), "bid");
  assert.equal(exitSide("SHORT"), "ask");
  assert.equal(Number(spreadPipsOf(EU, quote).toFixed(1)), 1.5);
});

test("effective R uses the executable entry, so the spread is counted once", () => {
  // Chart idea: 1.1000 entry, 10-pip stop, 15-pip target = 1.5R on mid.
  // Bought at the ask 1.10015, the same stop and target give less.
  const r = executableRewardRisk("LONG", 1.10015, 1.0990, 1.1015)!;
  assert.ok(Math.abs(r - 13.5 / 11.5) < 1e-9);
  assert.equal(executableRewardRisk("SHORT", 1.1000, 1.0990, 1.0980), null, "stop on the wrong side");
  assert.ok(levelsAreOrdered("LONG", 1.1, 1.099, 1.102));
  assert.ok(!levelsAreOrdered("SHORT", 1.1, 1.099, 1.098));
  assert.ok(levelsAreOrdered("SHORT", 1.1, 1.101, 1.098));
});

// ---------------------------------------------------------------- data checks

test("candles are sorted, de-duplicated and the forming candle split off", () => {
  const base = UP.slice(0, 10);
  const forming = { ...UP[10]!, complete: false };
  const messy = [base[2]!, base[0]!, base[1]!, base[1]!, ...base.slice(3), forming];
  const normalized = normalizeCandles(messy, "M15");
  assert.equal(normalized.closed.length, 10);
  assert.equal(normalized.duplicates, 1);
  assert.equal(normalized.reordered, true);
  assert.equal(normalized.forming?.time, forming.time);
  assert.deepEqual(normalized.closed.map((candle) => candle.time), base.map((candle) => candle.time));
});

test("a weekend is not a gap; a missing weekday candle is", () => {
  // Friday 20:30 and 20:45 UTC (16:30/16:45 New York), then Sunday 21:00 UTC (17:00 NY) onward.
  const friday = path([1.1, 1.101, 1.1], 1, { start: Date.parse("2026-09-25T20:30:00Z") });
  const sunday = path([1.1, 1.101, 1.1, 1.101], 1, { start: Date.parse("2026-09-27T21:00:00Z") });
  assert.equal(normalizeCandles([...friday, ...sunday], "M15").missing, 0);
  const holed = UP.slice(0, 20).filter((_, index) => index !== 7 && index !== 8);
  const normalized = normalizeCandles(holed, "M15");
  assert.equal(normalized.missing, 2);
  assert.equal(checkIntegrity("x", normalized, 0.05).status, "CAUTION");
  assert.equal(checkIntegrity("x", normalizeCandles(UP, "M15"), 0.05).status, "PASS");
});

test("market hours follow New York daylight saving", () => {
  assert.equal(isMarketOpen(Date.parse("2026-07-12T21:30:00Z")), true, "Sunday 17:30 EDT");
  assert.equal(isMarketOpen(Date.parse("2026-01-11T21:30:00Z")), false, "Sunday 16:30 EST");
  assert.equal(isMarketOpen(Date.parse("2026-01-11T22:30:00Z")), true, "Sunday 17:30 EST");
  assert.equal(isMarketOpen(Date.parse("2026-07-10T21:30:00Z")), false, "Friday 17:30 EDT");
});

test("stale candles fail while open; old candles are expected while closed", () => {
  const lastClose = Date.parse(UP.at(-1)!.time) + M15;
  assert.equal(checkCandleFreshness("f", UP, "M15", lastClose + 5 * 60_000, 2).status, "PASS");
  assert.equal(checkCandleFreshness("f", UP, "M15", lastClose + 3 * 60 * 60_000, 2).status, "FAIL");
  const saturday = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(checkCandleFreshness("f", UP, "M15", saturday, 2).status, "CAUTION");
  assert.equal(checkCandleFreshness("f", [], "M15", saturday, 2).status, "UNKNOWN");
});

test("quotes: missing is UNKNOWN, stale or crossed FAIL, fresh PASS", () => {
  const now = Date.parse("2026-09-22T14:00:00Z");
  assert.equal(checkQuote(EU, null, now, 120_000).status, "UNKNOWN");
  assert.equal(checkQuote(EU, null, now, 120_000).executable, null);
  const fresh = checkQuote(EU, { bid: 1.1, ask: 1.10012, time: new Date(now - 5_000).toISOString() }, now, 120_000);
  assert.equal(fresh.status, "PASS");
  assert.equal(Number(fresh.executable!.spreadPips.toFixed(1)), 1.2);
  const stale = checkQuote(EU, { bid: 1.1, ask: 1.10012, time: new Date(now - 10 * 60_000).toISOString() }, now, 120_000);
  assert.equal(stale.status, "FAIL");
  assert.equal(stale.executable, null, "a stale quote is never used as a price");
  assert.equal(checkQuote(EU, { bid: 1.1002, ask: 1.1, time: new Date(now).toISOString() }, now, 120_000).status, "FAIL");
});

// ---------------------------------------------------------------- structure

test("pivots are causal: confirmed only after `reach` closed candles, never repainted", () => {
  const reach = 3;
  const full = confirmedPivots(UP, reach);
  for (let end = 30; end <= UP.length; end += 7) {
    const prefix = confirmedPivots(UP.slice(0, end), reach);
    for (const pivot of prefix) {
      assert.ok(pivot.index + reach < end, "no pivot without its confirming candles");
      const later = full.find((other) => other.index === pivot.index && other.type === pivot.type);
      assert.ok(later, "a confirmed pivot stays confirmed");
      assert.equal(later!.confirmedAt, pivot.confirmedAt);
      assert.equal(pivot.confirmedAt, UP[pivot.index + reach]!.time);
    }
  }
});

test("higher highs and higher lows read UPTREND; the mirror reads DOWNTREND", () => {
  const up = readTrend(EU, "M15", UP, NORMAL.regime);
  assert.equal(up.direction, "UPTREND");
  assert.equal(up.sufficient, true);
  assert.ok(Math.abs(up.structureLevel! - 1.1059) < 0.00005, `structure at the latest higher low, got ${up.structureLevel}`);
  assert.ok(up.evidence.some((line) => line.includes("(higher)")));
  const down = readTrend(EU, "M15", mirror(UP, 1.1060), NORMAL.regime);
  assert.equal(down.direction, "DOWNTREND");
  assert.ok(Math.abs(down.structureLevel! - (2 * 1.1060 - 1.1059)) < 0.00005);
});

test("a repeating box reads RANGE", () => {
  const box = path([1.1020, 1.1000, 1.1040, 1.1000, 1.1040, 1.1001, 1.1039, 1.1000, 1.1040, 1.1020], 12);
  assert.equal(readTrend(EU, "M15", box, NORMAL.regime).direction, "RANGE");
});

test("a close through the higher low reads TRANSITION", () => {
  const broken = extend(UP, [[1.1040, 12]]);
  const read = readTrend(EU, "M15", broken, NORMAL.regime);
  assert.equal(read.direction, "TRANSITION");
  assert.ok(read.broken);
});

test("too little data, or conflicting swings, read UNCLEAR", () => {
  assert.equal(readTrend(EU, "M15", UP.slice(0, 20), NORMAL.regime).direction, "UNCLEAR");
  assert.equal(readTrend(EU, "M15", UP.slice(0, 20), NORMAL.regime).sufficient, false);
  // Expanding swings: a higher high and a lower low.
  const expanding = path([1.1020, 1.1000, 1.1040, 1.0940, 1.1100, 1.1050], 15);
  assert.equal(readTrend(EU, "M15", expanding, NORMAL.regime).direction, "UNCLEAR");
});

test("higher-timeframe alignment", () => {
  const stub = (direction: TrendRead["direction"], sufficient = true) => ({ direction, sufficient } as TrendRead);
  assert.equal(alignmentOf(stub("UPTREND"), stub("UPTREND")), "ALIGNED");
  assert.equal(alignmentOf(stub("DOWNTREND"), stub("UPTREND")), "OPPOSED");
  assert.equal(alignmentOf(stub("UPTREND"), stub("RANGE")), "HIGHER_NOT_TRENDING");
  assert.equal(alignmentOf(stub("RANGE"), stub("UPTREND")), "PRIMARY_NOT_TRENDING");
  assert.equal(alignmentOf(stub("UPTREND"), null), "UNKNOWN");
  assert.equal(alignmentOf(stub("UPTREND"), stub("UNCLEAR", false)), "UNKNOWN");
});

// ---------------------------------------------------------------- zones

test("zones: typed by side, broken when closed through, reactions not a strength score", () => {
  const trend = readTrend(EU, "M15", UP, NORMAL.regime);
  const price = UP.at(-1)!.close;
  const zones = buildZones({ primary: { timeframe: "M15", candles: UP }, trend, price, config: NORMAL });
  assert.ok(zones.length >= 3);
  for (const zone of zones) {
    assert.ok(zone.low < zone.high);
    assert.ok(!("strength" in zone));
    assert.ok(zone.status === "ACTIVE" || zone.flipped, "stale broken zones are left out");
    assert.equal(zone.type, price > zone.high ? "SUPPORT" : price < zone.low ? "RESISTANCE" : "MIXED");
  }
  // The old 1.1090 swing high was closed through on the way to 1.1120.
  const oldHigh = zones.find((zone) => zone.low <= 1.1091 && zone.high >= 1.1091)!;
  assert.ok(oldHigh, "zone at the old high");
  assert.equal(oldHigh.status, "BROKEN");
  assert.equal(oldHigh.flipped, true, "old resistance now below price");
  // The higher low that defines the trend is structural and still active.
  const structural = zones.find((zone) => zone.low <= trend.structureLevel! && zone.high >= trend.structureLevel!)!;
  assert.equal(structural.relevance, "STRUCTURAL");
  assert.equal(structural.status, "ACTIVE");
  assert.equal(structural.type, "SUPPORT");
});

test("nearby pivots merge into one zone", () => {
  // Two lows a pip apart: 1.1030 and 1.1031.
  const twin = path([1.1060, 1.1030, 1.1070, 1.1031, 1.1080, 1.1060], 15);
  const trend = readTrend(EU, "M15", twin, NORMAL.regime);
  const zones = buildZones({ primary: { timeframe: "M15", candles: twin }, trend, price: twin.at(-1)!.close, config: NORMAL });
  const twinZone = zones.filter((zone) => zone.low <= 1.10305 && zone.high >= 1.10295);
  assert.equal(twinZone.length, 1);
  assert.equal(twinZone[0]!.lows, 2);
});

// ---------------------------------------------------------------- pullback states

function pullbackOf(candles: Candle[], livePrice: number | null = null) {
  const trend = readTrend(EU, "M15", candles, NORMAL.regime);
  const zones = buildZones({ primary: { timeframe: "M15", candles }, trend, price: livePrice ?? candles.at(-1)!.close, config: NORMAL });
  return { trend, read: readPullback({ trend, zones, candles, config: NORMAL, livePrice }) };
}

test("pullback: at the impulse high there is no pullback yet", () => {
  assert.equal(pullbackOf(UP).read.state, "NO_PULLBACK");
});

const DEVELOPING = extend(UP, [[1.1105, 6]]);
const AT_ZONE = extend(DEVELOPING, [[1.1091, 5]]);
const TRIGGERED = extend(AT_ZONE, [[1.1096, 1], [1.1098, 1]]);

test("pullback: retracing toward the next zone is DEVELOPING", () => {
  const { read } = pullbackOf(DEVELOPING);
  assert.equal(read.state, "DEVELOPING");
  assert.ok(read.nextZone, "a zone lies ahead");
  assert.ok(read.depth! >= NORMAL.pullback.minRetrace);
});

test("pullback: reaching the old high is AT_ZONE until a close confirms", () => {
  const { read } = pullbackOf(AT_ZONE);
  assert.equal(read.state, "AT_ZONE");
  assert.ok(read.zone);
  assert.equal(read.trigger, null);
});

test("pullback: a close above the lowest candle's high is TRIGGERED, and stays so", () => {
  const { read } = pullbackOf(TRIGGERED);
  assert.equal(read.state, "TRIGGERED");
  assert.ok(read.trigger);
  const next = pullbackOf(extend(TRIGGERED, [[1.1102, 1]])).read;
  assert.equal(next.trigger?.time, read.trigger!.time, "the trigger time does not move");
});

test("pullback: once price runs away from the trigger the entry has EXPIRED", () => {
  assert.equal(pullbackOf(extend(TRIGGERED, [[1.1118, 3]])).read.state, "EXPIRED");
  // A live price far past the trigger expires it before the candles show it.
  assert.equal(pullbackOf(TRIGGERED, 1.1125).read.state, "EXPIRED");
});

test("pullback: a close through the higher low is INVALIDATED (or no longer a trend)", () => {
  const { trend, read } = pullbackOf(extend(AT_ZONE, [[1.1062, 6], [1.1056, 1]]));
  if (trend.direction === "UPTREND") assert.equal(read.state, "INVALIDATED");
  else assert.equal(read.state, "NOT_APPLICABLE");
});

test("pullback: a range or transition is NOT_APPLICABLE", () => {
  const box = path([1.1020, 1.1000, 1.1040, 1.1000, 1.1040, 1.1001, 1.1039, 1.1000, 1.1040, 1.1020], 12);
  assert.equal(pullbackOf(box).read.state, "NOT_APPLICABLE");
});

test("pullback states mirror for a downtrend", () => {
  const center = 1.1060;
  assert.equal(pullbackOf(mirror(UP, center)).read.state, "NO_PULLBACK");
  assert.equal(pullbackOf(mirror(DEVELOPING, center)).read.state, "DEVELOPING");
  assert.equal(pullbackOf(mirror(AT_ZONE, center)).read.state, "AT_ZONE");
  const triggered = pullbackOf(mirror(TRIGGERED, center)).read;
  assert.equal(triggered.state, "TRIGGERED");
  assert.equal(triggered.direction, "SHORT");
});

// ---------------------------------------------------------------- foundation

test("foundation: same snapshot, same result; missing quote is UNKNOWN, not a price", () => {
  const h1 = path([1.0950, 1.0900, 1.1000, 1.0960, 1.1060, 1.1020, 1.1110], 12, { step: 60 * 60_000, wick: 0.0002, start: START - 90 * 60 * 60_000 });
  const now = Date.parse(TRIGGERED.at(-1)!.time) + M15 + 60_000;
  const quote = { bid: 1.10975, ask: 1.10987, time: new Date(now - 3_000).toISOString() };
  const input = { instrument: EU, mode: "NORMAL" as const, candles: { M15: TRIGGERED, H1: h1 }, quote, now };
  const a = readMarketFoundation(input);
  const b = readMarketFoundation(input);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), "deterministic");
  assert.equal(a.primary?.direction, "UPTREND");
  assert.equal(a.pullback?.state, "TRIGGERED");
  assert.equal(a.data.quote.status, "PASS");
  assert.equal(a.referencePrice, (quote.bid + quote.ask) / 2);
  const noQuote = readMarketFoundation({ ...input, quote: null });
  assert.equal(noQuote.data.quote.status, "UNKNOWN");
  assert.equal(noQuote.data.quote.executable, null);
  assert.equal(noQuote.referencePrice, TRIGGERED.at(-1)!.close, "reference only, never executable");
});

// ---------------------------------------------------------------- decision (Phase 3)

const H = 60 * 60_000;
/** An H1 uptrend (or its mirror) ending at the M15 fixture's last candle. */
function h1For(m15: Candle[], down = false) {
  const end = Math.floor(Date.parse(m15.at(-1)!.time) / H) * H;
  const up = path([1.0950, 1.0900, 1.1000, 1.0960, 1.1060, 1.1020, 1.1100], 12, { step: H, wick: 0.0002, start: end - 71 * H });
  return down ? mirror(up, 1.1060) : up;
}
interface Scenario {
  m15: Candle[];
  mid: number;
  spreadPips?: number;
  quoteAgeMs?: number;
  news?: Parameters<typeof analyzeV2>[0]["news"];
  h1Down?: boolean;
  mirrored?: boolean;
  /**
   * The check-mechanics scenarios below were built around v2.0's stop (behind
   * the pullback low), so they run on v20Config; v2.1 (live) has its own tests.
   */
  config?: ModeConfig;
}
function decide({ m15, mid, spreadPips = 1.2, quoteAgeMs = 2_000, news = [], h1Down = false, mirrored = false, config = v20Config("NORMAL") }: Scenario): AnalysisResult {
  const candles = mirrored ? mirror(m15, 1.1060) : m15;
  const h1 = mirrored ? mirror(h1For(m15, h1Down), 1.1060) : h1For(m15, h1Down);
  const now = Date.parse(candles.at(-1)!.time) + M15 + 30_000;
  const center = mirrored ? 2 * 1.1060 - mid : mid;
  const half = (spreadPips * 0.0001) / 2;
  return analyzeV2({
    instrument: EU,
    mode: "NORMAL",
    candles: { M15: candles, H1: h1 },
    quote: { bid: center - half, ask: center + half, time: new Date(now - quoteAgeMs).toISOString() },
    now,
    news,
    config,
  });
}
const status = (result: AnalysisResult, id: CheckId) => result.checks.find((check) => check.id === id)!.status;
function noTrade(result: AnalysisResult, failing: CheckId) {
  assert.equal(result.decision, "NO_TRADE", result.headline);
  assert.equal(result.execution, null, "NO_TRADE never carries prices");
  assert.ok(["FAIL", "UNKNOWN"].includes(status(result, failing)), `${failing} should block: ${JSON.stringify(result.checks.find((check) => check.id === failing))}`);
}

const LONG_SETUP = extend(AT_ZONE, [[1.1096, 1]]);

test("decision: bullish trend + confirmed pullback at support is LONG with a full plan", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096 });
  assert.equal(result.decision, "LONG", `${result.headline} ${JSON.stringify(result.checks.filter((check) => check.status !== "PASS"))}`);
  const plan = result.execution!;
  assert.ok(plan.entry > plan.stop && plan.target > plan.entry);
  assert.equal(plan.entry, roundPrice(EU, 1.1096 + 0.00006), "entry at the ask");
  assert.ok(plan.stop < result.foundation.pullback!.extreme!.price, "stop beyond the pullback low");
  assert.ok(plan.rewardRisk >= 1.5);
  assert.ok(Math.abs(plan.targetPips - 15) < 0.2, `Normal aims for 15 pips when it fits (got ${plan.targetPips})`);
  for (const check of result.checks) assert.ok(check.status === "PASS" || check.status === "CAUTION", check.id);
  assert.equal(result.watch, null);
});

test("decision: the mirror image is SHORT", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, mirrored: true });
  assert.equal(result.decision, "SHORT", result.headline);
  const plan = result.execution!;
  assert.ok(plan.entry < plan.stop && plan.target < plan.entry);
  assert.equal(plan.entry, roundPrice(EU, 2 * 1.1060 - 1.1096 - 0.00006), "entry at the bid");
});

test("decision: an uptrend still at its high is NO_TRADE (no pullback, no chasing)", () => {
  noTrade(decide({ m15: UP, mid: UP.at(-1)!.close }), "pullback");
});

test("decision: a range is NO_TRADE", () => {
  const box = path([1.1020, 1.1000, 1.1040, 1.1000, 1.1040, 1.1001, 1.1039, 1.1000, 1.1040, 1.1020], 12);
  const result = decide({ m15: box, mid: 1.1020 });
  noTrade(result, "structure");
  assert.equal(result.setup.type, "NONE");
});

test("decision: higher timeframe against the trade is NO_TRADE", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, h1Down: true });
  noTrade(result, "higher");
  assert.equal(result.watch, null, "no watch zone for a setup other checks rule out");
});

test("decision: at the zone without confirmation is NO_TRADE with a watch zone", () => {
  const result = decide({ m15: AT_ZONE, mid: AT_ZONE.at(-1)!.close });
  noTrade(result, "trigger");
  assert.ok(result.watch, "tells you what to wait for");
  assert.match(result.watch!.condition, /close above/);
});

test("decision: an expired trigger is NO_TRADE", () => {
  const expired = extend(TRIGGERED, [[1.1118, 3]]);
  noTrade(decide({ m15: expired, mid: expired.at(-1)!.close }), "trigger");
});

test("decision: a wide spread is NO_TRADE", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, spreadPips: 4 });
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(status(result, "spread"), "FAIL");
});

test("decision: high-impact news inside the buffer is NO_TRADE", () => {
  const now = Date.parse(LONG_SETUP.at(-1)!.time) + M15 + 30_000;
  const news = [{ title: "CPI", currency: "USD", impact: 3, timestamp: new Date(now + 10 * 60_000).toISOString() }];
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, news });
  noTrade(result, "news-volatility");
  assert.equal(result.news.state, "BLOCKED");
});

test("decision: an unreadable calendar is NEWS_UNKNOWN and NO_TRADE, never 'no news'", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, news: null });
  noTrade(result, "news-volatility");
  assert.equal(result.news.state, "NEWS_UNKNOWN");
});

test("decision: a stale quote is NO_TRADE", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, quoteAgeMs: 10 * 60_000 });
  noTrade(result, "data");
  assert.equal(status(result, "stop"), "UNKNOWN", "no plan without an executable price");
});

test("decision: not enough room before the impulse high is NO_TRADE", () => {
  const cramped = extend(path([1.1030, 1.1000, 1.1060, 1.1030, 1.1090, 1.1060, 1.1103], 15), [[1.1097, 4], [1.1091, 3], [1.1095, 1]]);
  const result = decide({ m15: cramped, mid: 1.1095 });
  assert.equal(result.decision, "NO_TRADE", result.headline);
  assert.equal(result.execution, null);
});

test("decision: same snapshot, same decision and numbers", () => {
  const a = decide({ m15: LONG_SETUP, mid: 1.1096 });
  const b = decide({ m15: LONG_SETUP, mid: 1.1096 });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("news: medium impact is a caution; swing holds through ordinary releases", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  assert.equal(assessNews(EU, [{ title: "PMI", currency: "EUR", impact: 2, timestamp: at(20) }], now, "NORMAL").status, "CAUTION");
  assert.equal(assessNews(EU, [{ title: "NFP", currency: "USD", impact: 3, timestamp: at(-10) }], now, "NORMAL").status, "FAIL", "first 15 min after");
  assert.equal(assessNews(EU, [{ title: "NFP", currency: "USD", impact: 3, timestamp: at(-20) }], now, "NORMAL").status, "PASS");
  assert.equal(assessNews(EU, [{ title: "BoJ", currency: "JPY", impact: 3, timestamp: at(5) }], now, "NORMAL").status, "PASS", "other currencies ignored");
  const swing = assessNews(EU, [{ title: "ECB", currency: "EUR", impact: 3, timestamp: at(24 * 60) }], now, "SWING");
  assert.equal(swing.status, "CAUTION", "listed as exposure, not blocked");
});

test("volatility: an outsized candle is flagged, a huge one blocks", () => {
  const calm = UP.slice(0, 40);
  assert.equal(assessVolatility(calm, 0.0006).status, "PASS");
  const last = calm.at(-1)!;
  const spike = [...calm, { ...last, time: "2026-09-21T10:00:00.000Z", open: last.close, high: last.close + 0.0030, low: last.close - 0.0001, close: last.close + 0.0025 }];
  assert.equal(assessVolatility(spike, 0.0006).status, "FAIL");
});

test("order context: version-1 envelope the server keeps, under its 8,000-character limit", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096 });
  const context = analyzeV2Context(result);
  assert.equal(context.version, 1);
  assert.equal(context.setup, "analyze-v2-normal");
  assert.equal(context.direction, "long");
  const size = JSON.stringify(context).length;
  assert.ok(size < 8000, `context is ${size} characters`);
});

test("adapter: the legacy shape carries V2 numbers and a NO TRADE has no trade", () => {
  const long = toMarketAnalysis(decide({ m15: LONG_SETUP, mid: 1.1096 }));
  assert.equal(long.decision, "LONG");
  assert.equal(long.trade!.entry, long.v2!.execution!.entry);
  assert.equal(long.trade!.stopLoss, long.v2!.execution!.stop);
  const none = toMarketAnalysis(decide({ m15: UP, mid: UP.at(-1)!.close }));
  assert.equal(none.decision, "NO TRADE");
  assert.equal(none.trade, null);
  assert.ok(none.reason.length > 0);
});

// ---------------------------------------------------------------- liquidity (Phase 4)

test("liquidity: session windows and the trading day follow London and New York DST", () => {
  const summer = sessionWindows(Date.parse("2026-07-13T00:00:00Z"));
  assert.equal(new Date(summer.asia.end).toISOString(), "2026-07-13T07:00:00.000Z", "London 08:00 BST");
  assert.equal(new Date(summer.london.end).toISOString(), "2026-07-13T12:00:00.000Z", "New York 08:00 EDT");
  const winter = sessionWindows(Date.parse("2026-01-12T00:00:00Z"));
  assert.equal(new Date(winter.asia.end).toISOString(), "2026-01-12T08:00:00.000Z", "London 08:00 GMT");
  assert.equal(new Date(winter.london.end).toISOString(), "2026-01-12T13:00:00.000Z", "New York 08:00 EST");
  // US already on summer time, UK not yet.
  const gap = sessionWindows(Date.parse("2026-03-16T00:00:00Z"));
  assert.equal(new Date(gap.asia.end).toISOString(), "2026-03-16T08:00:00.000Z");
  assert.equal(new Date(gap.london.end).toISOString(), "2026-03-16T12:00:00.000Z");
  assert.equal(new Date(tradingDay(Date.parse("2026-07-13T00:00:00Z")).end).toISOString(), "2026-07-13T21:00:00.000Z");
  assert.equal(new Date(tradingDay(Date.parse("2026-01-12T00:00:00Z")).end).toISOString(), "2026-01-12T22:00:00.000Z");
});

/** Candles from explicit [open, high, low, close] rows, 15 minutes apart. */
function rows(start: string, data: Array<[number, number, number, number]>): Candle[] {
  return data.map(([open, high, low, close], index) => ({
    time: new Date(Date.parse(start) + index * M15).toISOString(),
    open, high, low, close, volume: 1, complete: true,
  }));
}
const LOW_LEVEL = { price: 1.1000, kind: "LOW" as const, source: "ASIA" as const, label: "Asia low", timeframe: "M15", formedAt: Date.parse("2026-09-22T07:00:00Z") };
const classifyRows = (data: Array<[number, number, number, number]>) =>
  classifyLevel(LOW_LEVEL, rows("2026-09-22T07:00:00Z", data), 0.0001, 0.0005).status;

test("liquidity: a wick is not a reclaim until a closed candle confirms it", () => {
  assert.equal(classifyRows([[1.1010, 1.1012, 1.1004, 1.1006], [1.1006, 1.1009, 1.1003, 1.1008]]), "UNTESTED");
  // Wick below and close back above, still the latest candle: only a candidate.
  assert.equal(classifyRows([[1.1006, 1.1008, 1.0996, 1.1004]]), "SWEEP_CANDIDATE");
  // ...then a closed candle that holds above: swept and reclaimed.
  assert.equal(classifyRows([[1.1006, 1.1008, 1.0996, 1.1004], [1.1004, 1.1010, 1.1002, 1.1009]]), "SWEPT_AND_RECLAIMED");
  // ...or one that closes below again: inconclusive.
  assert.equal(classifyRows([[1.1006, 1.1008, 1.0996, 1.1004], [1.1004, 1.1005, 1.0990, 1.0992]]), "INCONCLUSIVE");
});

test("liquidity: two closes beyond is an accepted breakout; failing later is inconclusive", () => {
  const accepted: Array<[number, number, number, number]> = [[1.1004, 1.1005, 1.0996, 1.0997], [1.0997, 1.0998, 1.0993, 1.0995]];
  assert.equal(classifyRows(accepted), "BREAKOUT_ACCEPTED");
  assert.equal(classifyRows([[1.1004, 1.1005, 1.0985, 1.0990]]), "BREAKOUT_ACCEPTED", "one decisive close");
  assert.equal(classifyRows([...accepted, [1.0995, 1.1008, 1.0994, 1.1006]]), "INCONCLUSIVE", "breakout failed back above");
});

test("liquidity: Asia, London and previous-day levels come from completed windows", () => {
  // Tuesday 2026-09-22 (BST/EDT): Asia 00:00–07:00 UTC, London 07:00–12:00 UTC.
  const day = path([1.1000, 1.1010, 1.1000, 1.1010, 1.1000, 1.1010, 1.1000, 1.1010, 1.1000], 12, { start: Date.parse("2026-09-21T12:00:00Z") });
  const marked = day.map((candle) => {
    if (candle.time === "2026-09-22T03:00:00.000Z") return { ...candle, high: 1.1040 };
    if (candle.time === "2026-09-22T09:00:00.000Z") return { ...candle, low: 1.0970 };
    return candle;
  });
  const trend = readTrend(EU, "M15", marked, NORMAL.regime);
  const levels = buildLiquidityLevels({ instrument: EU, mode: "NORMAL", candles: marked, timeframe: "M15", trend, spread: 0.00012, reach: 3 });
  const asiaHigh = levels.find((level) => level.labels.includes("Asia high"))!;
  assert.ok(asiaHigh, "Asia high");
  assert.equal(asiaHigh.price, 1.1040);
  // Merged with the swing high at the same price, which was known earlier (03:45, its pivot confirmation).
  assert.ok(Date.parse(asiaHigh.formedAt) <= Date.parse("2026-09-22T07:00:00.000Z"));
  assert.equal(asiaHigh.status, "UNTESTED");
  const londonLow = levels.find((level) => level.labels.includes("London low"))!;
  assert.equal(londonLow.price, 1.0970);
  assert.ok(Date.parse(londonLow.formedAt) <= Date.parse("2026-09-22T12:00:00.000Z"));
  const asiaOnly = levels.filter((level) => level.sources.includes("ASIA") && level.sources.length === 1);
  for (const level of asiaOnly) assert.equal(level.formedAt, "2026-09-22T07:00:00.000Z", "a session level forms when the session ends");
  for (const level of levels) assert.ok(Date.parse(level.formedAt) <= Date.parse(marked.at(-1)!.time) + M15, "no level from an unfinished window");
});

const LEVEL = (price: number, kind: "HIGH" | "LOW", status: LiquidityLevel["status"], crossedAt: string | null = null): LiquidityLevel => ({
  price, kind, status, crossedAt, resolvedAt: null, sources: ["ASIA"], labels: [kind === "HIGH" ? "Asia high" : "Asia low"], timeframe: "M15", formedAt: "2026-09-22T07:00:00.000Z",
});
const assess = (levels: LiquidityLevel[], plan: { entry: number; stop: number; target: number } | null, price = 1.1050, side: "LONG" | "SHORT" = "LONG") =>
  assessLiquidity({ instrument: EU, levels, atr: 0.0010, price, side, plan, pullbackStart: "2026-09-22T08:00:00.000Z" });
const PLAN = { entry: 1.1050, stop: 1.1010, target: 1.1090 };

test("liquidity: a long against an accepted breakdown is BLOCKed with the rule named", () => {
  const result = assess([LEVEL(1.1060, "LOW", "BREAKOUT_ACCEPTED")], PLAN);
  assert.equal(result.risk, "BLOCK");
  assert.match(result.findings[0]!, /Conflicting breakout/);
});

test("liquidity: an untouched level just inside or behind the stop is a caution, not a block", () => {
  const inside = assess([LEVEL(1.1012, "LOW", "UNTESTED")], PLAN);
  assert.equal(inside.risk, "CAUTION");
  assert.equal(inside.stopExposed, true);
  const behind = assess([LEVEL(1.1003, "LOW", "UNTESTED")], PLAN);
  assert.equal(behind.risk, "CAUTION");
  assert.equal(behind.stopExposed, true);
  const farBelow = assess([LEVEL(1.0980, "LOW", "UNTESTED")], PLAN);
  assert.equal(farBelow.risk, "CLEAR", "an unswept level far away is not a reason to worry");
});

test("liquidity: an untouched high before the target is a caution", () => {
  const result = assess([LEVEL(1.1070, "HIGH", "UNTESTED")], PLAN);
  assert.equal(result.risk, "CAUTION");
  assert.match(result.findings[0]!, /before the target/);
});

test("liquidity: a sweep-and-reclaim during the pullback is reported as confirmation, not scored", () => {
  const result = assess([LEVEL(1.1030, "LOW", "SWEPT_AND_RECLAIMED", "2026-09-22T09:00:00.000Z")], PLAN);
  assert.equal(result.risk, "CLEAR");
  assert.ok(result.confirmation);
  assert.match(result.confirmation!, /not proof of stop orders/);
  const before = assess([LEVEL(1.1030, "LOW", "SWEPT_AND_RECLAIMED", "2026-09-22T06:00:00.000Z")], PLAN);
  assert.equal(before.confirmation, null, "a sweep before the pullback started does not count");
});

test("liquidity: mirrored for shorts; nearest levels reported both sides", () => {
  const result = assessLiquidity({
    instrument: EU, atr: 0.0010, price: 1.1050, side: "SHORT", pullbackStart: null,
    levels: [LEVEL(1.1088, "HIGH", "UNTESTED"), LEVEL(1.1020, "LOW", "UNTESTED")],
    plan: { entry: 1.1050, stop: 1.1090, target: 1.1010 },
  });
  assert.equal(result.stopExposed, true);
  assert.equal(result.nearestAbove!.level.price, 1.1088);
  assert.equal(Number(result.nearestAbove!.distancePips.toFixed(1)), 38);
  assert.equal(result.nearestBelow!.level.price, 1.1020);
  assert.equal(assess([], PLAN).risk, "UNKNOWN");
});

test("decision: liquidity is evaluated for a qualified trade and never blocks for missing data", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096 });
  const check = result.checks.find((item) => item.id === "liquidity")!;
  assert.equal(check.evaluated, true);
  assert.ok(check.status === "PASS" || check.status === "CAUTION", check.reason);
  assert.ok(result.liquidity.levels.length > 0);
  const waiting = decide({ m15: AT_ZONE, mid: AT_ZONE.at(-1)!.close });
  assert.equal(waiting.checks.find((item) => item.id === "liquidity")!.evaluated, false);
  assert.ok(waiting.liquidity.levels.length > 0, "the map is still provided");
});

// ---------------------------------------------------------------- AI explanation (Phase 5)

const GOOD_LONG = {
  decision: "LONG",
  summary: "The M15 uptrend pulled back into support and a closed candle confirmed the turn, so a long qualified.",
  direction: "Swing highs and lows are both rising on M15, and H1 agrees.",
  location: "Price reacted inside the old high that now acts as support.",
  support: "Both timeframes trend up and nothing blocks the entry.",
  risks: "A close below the pullback low ends the idea; the spread is a sizeable share of the risk.",
  levels: "The stop sits below the pullback low with a buffer; the target is the 15-pip day-trade target.",
};

test("explanation: facts carry the engine's numbers and no plan for NO_TRADE", () => {
  const long = explanationFacts(decide({ m15: LONG_SETUP, mid: 1.1096 }));
  assert.equal(long.decision, "LONG");
  assert.equal(long.plan!.entry, "1.10966");
  assert.equal(long.plan!.targetPips, "15.0");
  const none = explanationFacts(decide({ m15: AT_ZONE, mid: AT_ZONE.at(-1)!.close }));
  assert.equal(none.plan, null);
  assert.ok(none.watch);
  assert.ok(JSON.stringify(none).length < 16_000);
});

test("explanation: a faithful answer passes; digits inside M15/H1 are not numbers", () => {
  const facts = explanationFacts(decide({ m15: LONG_SETUP, mid: 1.1096 }));
  const checked = validateExplanation({ ...GOOD_LONG, levels: "Entry 1.10966, stop 1.10883, target 1.11116: 8.3 pips risk for 15.0 pips, 1.81R." }, facts);
  assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
  assert.deepEqual(numbersIn("M15 and H1 at 1.1096, 8.3 pips, D1"), ["1.1096", "8.3"]);
});

test("explanation: a different decision, an invented number or win-probability talk is rejected", () => {
  const facts = explanationFacts(decide({ m15: LONG_SETUP, mid: 1.1096 }));
  const wrongDecision = validateExplanation({ ...GOOD_LONG, decision: "SHORT" }, facts);
  assert.equal(wrongDecision.ok, false);
  const invented = validateExplanation({ ...GOOD_LONG, levels: "A better target would be 1.11250." }, facts);
  assert.equal(invented.ok, false);
  assert.match(invented.ok ? "" : invented.reason, /1\.11250/);
  const odds = validateExplanation({ ...GOOD_LONG, summary: "This setup has a high probability of success." }, facts);
  assert.equal(odds.ok, false);
  const missing = validateExplanation({ ...GOOD_LONG, risks: "" }, facts);
  assert.equal(missing.ok, false);
  const tooLong = validateExplanation({ ...GOOD_LONG, summary: "x".repeat(600) }, facts);
  assert.equal(tooLong.ok, false);
});

test("explanation: the server rejects malformed or inconsistent facts", () => {
  const facts = explanationFacts(decide({ m15: LONG_SETUP, mid: 1.1096 }));
  assert.ok(parseExplanationFacts(facts));
  assert.equal(parseExplanationFacts({ ...facts, decision: "NO_TRADE" }), null, "NO_TRADE cannot carry a plan");
  assert.equal(parseExplanationFacts({ ...facts, decision: "MAYBE" }), null);
  assert.equal(parseExplanationFacts({ ...facts, headline: "x".repeat(20_000) }), null, "size-capped");
  assert.equal(parseExplanationFacts("facts"), null);
});

// ---------------------------------------------------------------- v2.1 stop (structure level)

const LIVE = ANALYZE_V2.NORMAL;
// Higher low at 1.1052 sits close under the old 1.1060 high the pullback tests.
const V21_SETUP = extend(path([1.1030, 1.1000, 1.1040, 1.1025, 1.1060, 1.1052, 1.1100], 15), [[1.1080, 5], [1.1060, 5], [1.1067, 1]]);

test("v2.1: the live stop sits behind the trend's higher low, not the pullback low", () => {
  assert.equal(LIVE.plan.stopAnchor, "STRUCTURE_LEVEL");
  const result = decide({ m15: V21_SETUP, mid: 1.1067, config: LIVE });
  assert.equal(result.decision, "LONG", `${result.headline} ${JSON.stringify(result.checks.filter((check) => check.status !== "PASS"))}`);
  const plan = result.execution!;
  const structure = result.marketStructure.structureLevel!;
  assert.ok(plan.stop < structure, "stop beyond the higher low");
  assert.ok(plan.stop > structure - 0.0005, "by the buffer, not more");
  assert.match(plan.stopBasis, /higher low/);
  assert.ok(plan.rewardRisk >= 1.5);
  assert.ok(plan.targetPips <= 30, "inside the day-trade horizon");
  assert.equal(result.strategy, "analyze-v2.1");
});

test("v2.1: mirrored, the short's stop sits above the lower high", () => {
  const result = decide({ m15: V21_SETUP, mid: 1.1067, mirrored: true, config: LIVE });
  assert.equal(result.decision, "SHORT", result.headline);
  assert.ok(result.execution!.stop > result.marketStructure.structureLevel!);
});

test("v2.1: a structure stop wider than 6 ATR fails rather than being accepted", () => {
  const result = decide({ m15: LONG_SETUP, mid: 1.1096, config: LIVE });
  assert.equal(result.decision, "NO_TRADE");
  const stop = result.checks.find((check) => check.id === "stop")!;
  assert.equal(stop.status, "FAIL");
  assert.match(stop.reason, /6 ATR limit/);
});

test("v2.1 vs v2.0 on the same setup: the structure stop is the wider one", () => {
  const live = decide({ m15: V21_SETUP, mid: 1.1067, config: LIVE });
  const old = decide({ m15: V21_SETUP, mid: 1.1067 });
  assert.ok(live.execution && old.execution, "both qualify here");
  assert.ok(live.execution!.stop < old.execution!.stop);
  assert.ok(live.execution!.stopPips > old.execution!.stopPips);
});

console.log(`\n${passed} tests passed`);
