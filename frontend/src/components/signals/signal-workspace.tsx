"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Clock3,
  Maximize,
  Minimize,
  RotateCcw,
  Search,
  Scaling,
  Sparkles,
  X,
} from "lucide-react";
import { ChartTypeSelect } from "@/components/charts/chart-type-select";
import {
  ChartOptionSheet,
  ChartTypeSheet,
  IndicatorSheet,
} from "@/components/charts/chart-sheet-controls";
import {
  ChartLoadingOverlay,
  settleChartLoad,
} from "@/components/charts/chart-loading-overlay";
import { IndicatorSelect } from "@/components/charts/indicator-select";
import {
  SetupChart,
  createFixedTenPipSetup,
  type ChartPatternLine,
  type ChartPositionTool,
  type ChartReferenceLine,
} from "@/components/charts/setup-chart";
import { PendingEntryDialog } from "@/components/charts/pending-entry-dialog";
import {
  ManualProposalModal,
  useManualProposal,
} from "@/components/analysis/manual-proposal";
import {
  ChartContextPanel,
  type ChartOverlayPreferences,
} from "@/components/charts/chart-context-panel";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { apiUrl } from "@/lib/api/url";
import { openRFromLevels } from "@/lib/open-trade-progress";
import { formatClockTime, formatDayAndTime, formatShortDay } from "@/lib/format/datetime";
import { NotificationBell } from "@/components/notifications/notification-bell";
import {
  CHART_INDICATORS,
  CHART_RANGES,
  CHART_TIMEFRAME_LABELS,
  CHART_TIMEFRAMES,
  CHART_VARIANTS,
  DEFAULT_CHART_INDICATORS,
  TIMEFRAME_TO_GRANULARITY,
  candleCountForRange,
  calculateAtr,
  deriveDominantSwingTrend,
  formatChartPrice,
  formatResultR,
  isChartIndicatorEnabled,
  mapSignalTimeframe,
  mergeRefreshedCandles,
  spreadInPips,
  type ChartIndicator,
  type ChartRange,
  type ChartTimeframe,
  type ChartVariant,
} from "@/lib/chart-utils";
import { analyzeAdaptiveSwingTrendlines, type AdaptiveTrendline } from "@/lib/adaptive-swing-trendlines";
import {
  INSTRUMENT_CATALOG,
  currenciesOf,
  pipSizeFor,
  precisionFor,
} from "@/lib/instruments/catalog";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { getMarketCondition } from "@/lib/strategy/session";
import {
  computeSessionSrLevels,
  logSessionSrDebug,
  type SessionSrCentre,
  type SessionSrLevels,
} from "@/lib/strategy/session-sr";
import { computeLastDaySrLevels } from "@/lib/strategy/last-day-sr";
import {
  computeActiveFrozen4hSr,
  computeFrozen4hBlocks,
  logFrozen4hDebug,
  type Frozen4hBlock,
} from "@/lib/strategy/frozen-4h-sr";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { StrategySetup } from "@/lib/strategy/types";
import type { PaperTradingAvailability } from "@/lib/strategy/strategy-engine";
import type { WatchlistStatusInput } from "@/lib/watchlist-status";
import type { MarketPriceTick } from "@/types/market-stream";
import type { BinaryPrediction, BinaryWatchRow } from "@/types/binary";
import type { PendingManualEntry } from "@/types/pending-entry";
import type {
  Candle,
  CandleSeries,
  ConnectionStatus,
  MajorInstrument,
  PaperChartTrade,
  PriceQuote,
  TradeSignal,
} from "@/types/forex";

const ENTRY_CHECKLIST = [
  "Structure confirms bias",
  "Entry inside zone",
  "Size matches risk policy",
  "No news within 30m",
] as const;

type MobileTab = "Overview" | "Setup";

/** Bars of breathing room kept on each side of a focused trade. */
const FOCUS_PADDING_BARS = 30;

/** Height of the desktop chart canvas before it is measured. */
const DESKTOP_CHART_HEIGHT = 680;

const CHART_PREFERENCES_STORAGE_KEY =
  "goldenxperience:signals-chart-preferences:v1";

/* Keep the mobile picker scannable. The full OANDA catalog remains available
 * as soon as someone starts typing in search. */
const DEFAULT_PAIR_PICKER_INSTRUMENTS = [
  "EUR_USD",
  "USD_JPY",
  "GBP_USD",
  "AUD_USD",
  "USD_CAD",
  "USD_CHF",
  "NZD_USD",
  "EUR_JPY",
  "EUR_GBP",
  "GBP_JPY",
  "AUD_JPY",
  "CAD_JPY",
] as const;

type StoredChartPreferences = {
  version: 1;
  timeframe: ChartTimeframe;
  range: ChartRange;
  chartVariant: ChartVariant;
  enabledIndicators: ChartIndicator[];
};

function readStoredChartPreferences(): StoredChartPreferences | null {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CHART_PREFERENCES_STORAGE_KEY) ?? "null",
    ) as Partial<StoredChartPreferences> | null;

    if (
      !parsed ||
      parsed.version !== 1 ||
      !CHART_TIMEFRAMES.includes(parsed.timeframe as ChartTimeframe) ||
      !CHART_RANGES.includes(parsed.range as ChartRange) ||
      !CHART_VARIANTS.some((variant) => variant.value === parsed.chartVariant) ||
      !Array.isArray(parsed.enabledIndicators)
    ) {
      return null;
    }

    // Drop any stored indicators that no longer exist (e.g. one that was later
    // merged into another). Keeping them would count toward the "active" badge
    // while rendering no checkbox — an indicator shown as on that can't be
    // turned off. Filtering keeps the rest of the preferences usable.
    return {
      ...(parsed as StoredChartPreferences),
      enabledIndicators: parsed.enabledIndicators.filter((indicator) =>
        CHART_INDICATORS.some((option) => option.value === indicator),
      ),
    };
  } catch {
    return null;
  }
}

export type SignalPaperPlan = WatchlistStatusInput & {
  instrument: string;
  batchNumber: number | null;
};

const GRANULARITY_MS: Record<string, number> = {
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  M30: 30 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
};

function precisionForInstrument(instrument: MajorInstrument) {
  return precisionFor(instrument);
}

function alignTimeToGranularity(time: string, granularity: string) {
  const interval = GRANULARITY_MS[granularity] ?? GRANULARITY_MS.M15;
  const parsed = Date.parse(time);
  const safeTime = Number.isFinite(parsed) ? parsed : Date.now();
  return Math.floor(safeTime / interval) * interval;
}

function mergeCandles(current: Candle[], incoming: Candle[]) {
  const byTime = new Map<string, Candle>();

  for (const candle of [...current, ...incoming]) {
    byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort(
    (left, right) => Date.parse(left.time) - Date.parse(right.time),
  );
}

/**
 * A deliberately small, visual-only support/resistance read of the displayed
 * chart. The range levels show where this market recently turned; the swing
 * levels show the nearest confirmed local pivot. They are not fed to any trade
 * evaluator, so enabling the chart indicator cannot change execution.
 */
function supportResistanceLines(
  candles: Candle[],
  instrument: MajorInstrument,
): ChartReferenceLine[] {
  // The numbers come from the shared engine so the drawn lines and the Analyze
  // market-condition read are always the same levels.
  const levels = computeSupportResistanceLevels(candles, instrument);
  if (!levels) return [];
  const { current, rangeHigh, rangeLow, swingHigh, swingLow } = levels;

  const candidates: ChartReferenceLine[] = [];
  const minimumGap = pipSizeFor(instrument) * 8;
  const add = (line: ChartReferenceLine) => {
    if (!Number.isFinite(line.price)) return;
    if (candidates.some((existing) => Math.abs(existing.price - line.price) < minimumGap)) return;
    candidates.push(line);
  };

  if (rangeHigh > current) {
    add({
      key: "sr-range-resistance",
      price: rangeHigh,
      label: "Resistance · range",
      color: "#ff9f43",
      textColor: "#111827",
      dashed: false,
      lineWidth: 2,
    });
  }
  if (rangeLow < current) {
    add({
      key: "sr-range-support",
      price: rangeLow,
      label: "Support · range",
      color: "#35d6b4",
      textColor: "#06281f",
      dashed: false,
      lineWidth: 2,
    });
  }

  if (swingHigh !== null) {
    add({
      key: "sr-swing-resistance",
      price: swingHigh,
      label: "Resistance · swing",
      color: "#ff5c7a",
      textColor: "#ffffff",
      dashed: true,
      lineWidth: 1,
    });
  }
  if (swingLow !== null) {
    add({
      key: "sr-swing-support",
      price: swingLow,
      label: "Support · swing",
      color: "#72a8ff",
      textColor: "#071426",
      dashed: true,
      lineWidth: 1,
    });
  }

  return candidates;
}

const SESSION_SR_STYLES: Record<
  SessionSrCentre,
  { label: string; highColor: string; lowColor: string; textColor: string }
> = {
  asia: {
    label: "Asia",
    highColor: "#f0b429",
    lowColor: "#d97706",
    textColor: "#1a1205",
  },
  london: {
    label: "London",
    highColor: "#72a8ff",
    lowColor: "#3b82f6",
    textColor: "#071426",
  },
  newyork: {
    label: "New York",
    highColor: "#c084fc",
    lowColor: "#a855f7",
    textColor: "#1a0b2e",
  },
};

/**
 * Frozen S/R lines for one session centre. Levels come from
 * `computeSessionSrLevels` (existing S/R engine at session open). Swing lines
 * are skipped when they sit within a few pips of the range twin so overlapping
 * labels stay readable.
 */
function sessionSrLines(
  levels: SessionSrLevels,
  instrument: MajorInstrument,
): ChartReferenceLine[] {
  const style = SESSION_SR_STYLES[levels.centre];
  const lines: ChartReferenceLine[] = [];
  const minimumGap = pipSizeFor(instrument) * 8;
  const add = (line: ChartReferenceLine) => {
    if (!Number.isFinite(line.price)) return;
    if (lines.some((existing) => Math.abs(existing.price - line.price) < minimumGap)) return;
    lines.push(line);
  };

  add({
    key: `session-sr-${levels.centre}-range-r`,
    price: levels.rangeHigh,
    label: `${style.label} R · range`,
    color: style.highColor,
    textColor: style.textColor,
    dashed: false,
    lineWidth: 2,
  });
  add({
    key: `session-sr-${levels.centre}-range-s`,
    price: levels.rangeLow,
    label: `${style.label} S · range`,
    color: style.lowColor,
    textColor: "#ffffff",
    dashed: false,
    lineWidth: 2,
  });
  if (levels.swingHigh !== null) {
    add({
      key: `session-sr-${levels.centre}-swing-r`,
      price: levels.swingHigh,
      label: `${style.label} R · swing`,
      color: style.highColor,
      textColor: style.textColor,
      dashed: true,
      lineWidth: 1,
    });
  }
  if (levels.swingLow !== null) {
    add({
      key: `session-sr-${levels.centre}-swing-s`,
      price: levels.swingLow,
      label: `${style.label} S · swing`,
      color: style.lowColor,
      textColor: "#ffffff",
      dashed: true,
      lineWidth: 1,
    });
  }

  return lines;
}

/**
 * Previous-day high/low lines. Frozen on the last completed ET calendar day —
 * today's price action does not move them.
 */
function lastDaySrLines(candles: Candle[]): ChartReferenceLine[] {
  const levels = computeLastDaySrLevels(candles);
  if (!levels) return [];
  return [
    {
      key: "last-day-sr-high",
      price: levels.high,
      label: "Prev day high",
      color: "#fbbf24",
      textColor: "#1a1205",
      dashed: false,
      lineWidth: 2,
    },
    {
      key: "last-day-sr-low",
      price: levels.low,
      label: "Prev day low",
      color: "#f59e0b",
      textColor: "#ffffff",
      dashed: true,
      lineWidth: 1,
    },
  ];
}

/**
 * Active-block tagged reference lines removed — they cluttered the chart with
 * "R · 20:00–00:00 UTC" style labels. Levels render as finite segments only.
 */
function frozen4hActiveLines(_block: Frozen4hBlock): ChartReferenceLine[] {
  return [];
}

/** One horizontal segment per level per 4H block (active + historical). */
function frozen4hPatternLines(blocks: Frozen4hBlock[]): ChartPatternLine[] {
  const lines: ChartPatternLine[] = [];
  for (const block of blocks) {
    const id = String(block.blockStartMs);
    lines.push(
      {
        key: `frozen-4h-${id}-r`,
        color: "#ff5252",
        dashed: false,
        lineWidth: 1,
        points: [
          { time: block.startTime, price: block.resistance },
          { time: block.endTime, price: block.resistance },
        ],
      },
      {
        key: `frozen-4h-${id}-mid`,
        color: "#fbbf24",
        dashed: true,
        lineWidth: 1,
        points: [
          { time: block.startTime, price: block.midpoint },
          { time: block.endTime, price: block.midpoint },
        ],
      },
      {
        key: `frozen-4h-${id}-s`,
        color: "#00e59b",
        dashed: false,
        lineWidth: 1,
        points: [
          { time: block.startTime, price: block.support },
          { time: block.endTime, price: block.support },
        ],
      },
    );
  }
  return lines;
}

/**
 * A visual, close-confirmed breakout read of the twenty completed candles
 * preceding the newest completed candle. Its levels are deliberately kept out
 * of strategy evaluation: this overlay describes the chart; it does not place
 * or qualify a trade.
 */
function breakoutLines(candles: Candle[]): ChartReferenceLine[] {
  const completed = candles.filter((candle) => candle.complete !== false);
  const last = completed.at(-1);
  const range = completed.slice(-21, -1);
  const atr = calculateAtr(completed, 14).at(-1) ?? 0;
  if (!last || range.length < 20 || atr <= 0) return [];

  const high = Math.max(...range.map((candle) => candle.high));
  const low = Math.min(...range.map((candle) => candle.low));
  const buffer = atr * 0.5;
  const brokeUp = last.close > high + buffer;
  const brokeDown = last.close < low - buffer;

  // Fakeouts are signalled by the on-candle FB arrows (the merged false-breakout
  // detector), so these level lines only mark the range edges and whether the
  // latest close has confirmed a break through them.
  return [
    {
      key: "breakout-ceiling",
      price: high,
      label: brokeUp ? "Breakout ↑ confirmed" : "Breakout ↑ watch",
      color: brokeUp ? "#31d38a" : "#f6c35b",
      textColor: "#06281f",
      dashed: !brokeUp,
      lineWidth: 2,
    },
    {
      key: "breakout-floor",
      price: low,
      label: brokeDown ? "Breakdown ↓ confirmed" : "Breakdown ↓ watch",
      color: brokeDown ? "#fb7185" : "#9c8cff",
      textColor: "#ffffff",
      dashed: !brokeDown,
      lineWidth: 2,
    },
  ];
}

type PatternOverlay = {
  lines: ChartPatternLine[];
  tags: ChartReferenceLine[];
};

type SwingPoint = {
  index: number;
  time: string;
  price: number;
};

/**
 * A visual-only structural trend read. A pivot is confirmed only after three
 * completed candles print on either side, so the lines do not move with the
 * forming bar or get treated as execution inputs.
 */
function swingTrendLines(candles: Candle[]): ChartPatternLine[] {
  const trend = deriveDominantSwingTrend(candles);
  if (!trend) return [];

  const slope = (trend.second.price - trend.first.price) / (trend.second.index - trend.first.index);
  return [{
    key: `swing-trend-${trend.direction}`,
    color: trend.direction === "bullish" ? "#3b82f6" : "#f0526b",
    dashed: false,
    lineWidth: 2,
    points: [
      { time: trend.first.time, price: trend.first.price },
      { time: trend.last.time, price: trend.second.price + slope * (trend.last.index - trend.second.index) },
    ],
  }];
}

function adaptiveSwingTrendlineOverlay(candles: Candle[], instrument: MajorInstrument): PatternOverlay {
  const read = analyzeAdaptiveSwingTrendlines(candles, instrument);
  const lines: ChartPatternLine[] = [];
  const tags: ChartReferenceLine[] = [];
  const last = candles.filter((candle) => candle.complete !== false).at(-1);
  const add = (line: AdaptiveTrendline | null, label: string, color: string, dashed = false) => {
    if (!line || !last) return;
    const endPrice = line.pointA.price + line.slopePerBar * (candles.length - 1 - line.pointA.index);
    lines.push({ key: `adaptive-${line.id}`, color, dashed, lineWidth: line.type === "major" ? 2 : 1, points: [{ time: line.pointA.time, price: line.pointA.price }, { time: last.time, price: endPrice }] });
    tags.push({ key: `adaptive-${line.id}`, label, price: endPrice, color, textColor: "#ffffff", dashed, lineWidth: line.type === "major" ? 2 : 1 });
  };
  add(read.major, read.major?.status === "broken" ? "MAJOR BROKEN" : `MAJOR ${read.majorDirection === "bullish" ? "↑" : "↓"}`, read.majorDirection === "bullish" ? "#2563eb" : "#dc2626", read.major?.status === "broken");
  add(read.current, `CURRENT ${read.currentDirection === "bullish" ? "↑" : "↓"}${read.majorDirection && read.currentDirection && read.majorDirection !== read.currentDirection ? " PULLBACK" : ""}`, read.currentDirection === "bullish" ? "#16a34a" : "#ea580c");
  if (read.previous?.status === "broken") add(read.previous, "PREV BROKEN", "#71717a", true);
  return { lines, tags };
}

/**
 * Draw only two defensible breakout geometries: a repeatedly respected box or
 * converging confirmed swings. The overlay is explanatory and never reaches
 * any execution code.
 */
function breakoutPatternOverlay(candles: Candle[]): PatternOverlay {
  const completed = candles.filter((candle) => candle.complete !== false).slice(-96);
  const last = completed.at(-1);
  const atr = calculateAtr(completed, 14).at(-1) ?? 0;
  if (!last || completed.length < 32 || atr <= 0) return { lines: [], tags: [] };

  const reach = 3;
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let index = reach; index < completed.length - reach; index += 1) {
    const candle = completed[index]!;
    const window = completed.slice(index - reach, index + reach + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) {
      highs.push({ index, time: candle.time, price: candle.high });
    }
    if (window.every((other) => other === candle || other.low >= candle.low)) {
      lows.push({ index, time: candle.time, price: candle.low });
    }
  }

  const highA = highs.at(-2);
  const highB = highs.at(-1);
  const lowA = lows.at(-2);
  const lowB = lows.at(-1);
  if (highA && highB && lowA && lowB && highB.index > highA.index && lowB.index > lowA.index) {
    const upperSlope = (highB.price - highA.price) / (highB.index - highA.index);
    const lowerSlope = (lowB.price - lowA.price) / (lowB.index - lowA.index);
    const upperAtLast = highB.price + upperSlope * (completed.length - 1 - highB.index);
    const lowerAtLast = lowB.price + lowerSlope * (completed.length - 1 - lowB.index);
    const converging = highB.price < highA.price - atr * 0.15
      && lowB.price > lowA.price + atr * 0.15
      && upperAtLast > lowerAtLast + atr * 0.25;

    if (converging) {
      const buffer = atr * 0.25;
      const brokeUp = last.close > upperAtLast + buffer;
      const brokeDown = last.close < lowerAtLast - buffer;
      const previous = completed.at(-2)!;
      const upperAtPrevious = highB.price + upperSlope * (completed.length - 2 - highB.index);
      const lowerAtPrevious = lowB.price + lowerSlope * (completed.length - 2 - lowB.index);
      return {
        lines: [
          {
            key: "triangle-ceiling",
            color: "#e8eaed",
            dashed: false,
            lineWidth: 2,
            points: [{ time: highA.time, price: highA.price }, { time: last.time, price: upperAtLast }],
          },
          {
            key: "triangle-floor",
            color: "#e8eaed",
            dashed: false,
            lineWidth: 2,
            points: [{ time: lowA.time, price: lowA.price }, { time: last.time, price: lowerAtLast }],
          },
          ...(brokeUp ? [{
            key: "triangle-breakout-up",
            color: "#31d38a",
            lineWidth: 2 as const,
            points: [{ time: previous.time, price: upperAtPrevious }, { time: last.time, price: last.close }],
          }] : brokeDown ? [{
            key: "triangle-breakout-down",
            color: "#fb7185",
            lineWidth: 2 as const,
            points: [{ time: previous.time, price: lowerAtPrevious }, { time: last.time, price: last.close }],
          }] : []),
        ],
        tags: [],
      };
    }
  }

  const box = completed.slice(-25);
  const high = Math.max(...box.map((candle) => candle.high));
  const low = Math.min(...box.map((candle) => candle.low));
  const tolerance = atr * 0.35;
  const highTouches = box.filter((candle) => candle.high >= high - tolerance).length;
  const lowTouches = box.filter((candle) => candle.low <= low + tolerance).length;
  const rangeWidth = high - low;
  const rectangle = highTouches >= 2 && lowTouches >= 2 && rangeWidth >= atr && rangeWidth <= atr * 7;
  if (!rectangle) return { lines: [], tags: [] };

  const buffer = atr * 0.25;
  const brokeUp = last.close > high + buffer;
  const brokeDown = last.close < low - buffer;
  const previous = box.at(-2)!;
  return {
    lines: [
      { key: "rectangle-ceiling", color: "#e8eaed", dashed: false, lineWidth: 2, points: [{ time: box[0]!.time, price: high }, { time: last.time, price: high }] },
      { key: "rectangle-floor", color: "#e8eaed", dashed: false, lineWidth: 2, points: [{ time: box[0]!.time, price: low }, { time: last.time, price: low }] },
      ...(brokeUp ? [{
        key: "rectangle-breakout-up",
        color: "#31d38a",
        lineWidth: 2 as const,
        points: [{ time: previous.time, price: high }, { time: last.time, price: last.close }],
      }] : brokeDown ? [{
        key: "rectangle-breakout-down",
        color: "#fb7185",
        lineWidth: 2 as const,
        points: [{ time: previous.time, price: low }, { time: last.time, price: last.close }],
      }] : []),
    ],
    tags: [],
  };
}

function applyTickToCandles(
  series: CandleSeries,
  tick: MarketPriceTick,
): {
  series: CandleSeries;
  liveCandle: Candle | null;
  appended: boolean;
  changed: boolean;
} {
  if (series.instrument !== tick.instrument || !series.candles.length) {
    return { series, liveCandle: null, appended: false, changed: false };
  }

  const interval = GRANULARITY_MS[series.granularity] ?? GRANULARITY_MS.M15;
  const precision = precisionForInstrument(tick.instrument);
  const close = Number(tick.mid.toFixed(precision));
  const tickBucket = alignTimeToGranularity(tick.time, series.granularity);
  const candles = [...series.candles];
  const last = candles[candles.length - 1]!;
  const lastBucket = alignTimeToGranularity(last.time, series.granularity);

  if (tickBucket < lastBucket) {
    return { series, liveCandle: null, appended: false, changed: false };
  }

  if (tickBucket >= lastBucket + interval) {
    const liveCandle = {
      time: new Date(tickBucket).toISOString(),
      open: last.close,
      high: Math.max(last.close, close),
      low: Math.min(last.close, close),
      close,
      volume: 0,
      complete: false,
    };
    candles.push(liveCandle);

    return {
      series: {
        ...series,
        source: tick.source,
        candles: candles.slice(-5_500),
      },
      liveCandle,
      appended: true,
      changed: true,
    };
  }

  const liveCandle = {
    ...last,
    high: Math.max(last.high, close),
    low: Math.min(last.low, close),
    close,
    complete: false,
  };
  candles[candles.length - 1] = liveCandle;

  return {
    series: {
      ...series,
      source: tick.source,
      candles,
    },
    liveCandle,
    appended: false,
    changed: true,
  };
}

function normalizeSearchValue(value: string) {
  return value.toLowerCase().replace(/[\s/_-]+/g, "");
}

interface SearchResult {
  instrument: string;
  displayName: string;
  /** The setup for this pair, when one exists. */
  signal: TradeSignal | undefined;
  searchText: string;
}

function buildSearchIndex(signals: TradeSignal[]): SearchResult[] {
  const signalByInstrument = new Map(
    signals.map((signal) => [signal.instrument, signal]),
  );

  // Every tradeable OANDA pair is browsable in the picker, not just the
  // featured ones — the pairs with a live setup still sort to the top.
  return INSTRUMENT_CATALOG.map((info) => {
    const signal = signalByInstrument.get(info.name);
    const { base, quote } = currenciesOf(info.name);

    return {
      instrument: info.name,
      displayName: info.displayName,
      signal,
      searchText: normalizeSearchValue(
        [
          info.name,
          info.displayName,
          base,
          quote,
          // Setup metadata stays searchable for the pairs that have one.
          signal?.strategy,
          signal?.bias,
          signal?.direction,
          signal?.timeframe,
          signal?.note,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    };
  });
}

function toDisplaySignal(setup: StrategySetup): TradeSignal[] {
  if (
    !setup.direction ||
    setup.entry === null ||
    setup.stop === null ||
    setup.target === null ||
    setup.riskReward === null
  ) {
    return [];
  }

  return [{
    instrument: setup.instrument,
    pair: setup.pair,
    timeframe: setup.timeframe,
    direction: setup.direction,
    bias: setup.direction === "long" ? "Bullish" : "Bearish",
    entry: setup.entry,
    stop: setup.stop,
    target: setup.target,
    riskReward: setup.riskReward,
    strategy: setup.status === "valid" ? "Setup ready" : "Blocked",
    note: setup.summary,
    freshness: `Evaluated ${formatClockTime(setup.evaluatedAt)}`,
  }];
}

/** Status pill / dot colour. */
type StatusKind = "ready" | "blocked" | "waiting";

/**
 * The live status shown on the signals page, read from the Binary Prediction
 * engine (the "new engine") for the selected pair rather than the paper-cycle
 * entry-window schedule. `row` is null when the engine does not monitor the pair.
 */
function binaryEngineStatus(row: BinaryWatchRow | null): {
  label: string;
  kind: StatusKind;
} {
  if (!row) return { label: "Not on the binary monitor", kind: "waiting" };
  if (row.activePredictionId && row.activeDirection) {
    return {
      label: `Prediction live · ${row.activeDirection === "up" ? "UP" : "DOWN"}`,
      kind: "ready",
    };
  }
  if (row.dataStatus !== "connected") return { label: "Waiting for market data", kind: "blocked" };
  if (!row.bias || row.bias === "wait") return { label: "Waiting for a signal", kind: "waiting" };
  return {
    label: row.bias === "up" ? "Model favours UP" : "Model favours DOWN",
    kind: "ready",
  };
}

/** Text tone class for the desktop status line, from a status kind. */
function toneClassForKind(kind: StatusKind): string {
  if (kind === "ready") return "text-[color:var(--success)]";
  if (kind === "blocked") return "text-[color:var(--danger)]";
  return "text-[color:var(--pending)]";
}

function marketSessionCaption() {
  return getMarketCondition().label;
}

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = "segment",
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  variant?: "segment" | "tabs";
  labels?: Partial<Record<T, string>>;
}) {
  const isTabs = variant === "tabs";

  return (
    <div
      className={isTabs ? "workspace-tabs" : "workspace-segment"}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`pressable ${
              isTabs ? "workspace-tab-btn" : "workspace-segment-btn"
            } ${selected ? (isTabs ? "workspace-tab-btn-active" : "workspace-segment-btn-active") : ""}`}
          >
            {labels?.[option] ?? option}
          </button>
        );
      })}
    </div>
  );
}

function RangeSelect({
  value,
  onChange,
}: {
  value: ChartRange;
  onChange: (next: ChartRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Chart history range"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`gx-toolbar-btn pressable ${open ? "is-active" : ""}`}
      >
        <Clock3 className="size-3.5" strokeWidth={2} />
        {value}
        <ChevronDown className="size-3" strokeWidth={2} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Chart history range"
          className="menu-popover absolute right-0 top-[calc(100%+6px)] z-50 min-w-[7.5rem] origin-top-right overflow-hidden rounded-lg p-1"
        >
          {CHART_RANGES.map((option) => {
            const selected = option === value;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={selected}
                className={`pressable flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[length:var(--text-sm)] font-medium ${
                  selected
                    ? "menu-item-active"
                    : "text-[color:var(--muted-strong)] hover:bg-[color:var(--surface-raised)] hover:text-[color:var(--foreground)]"
                }`}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function subscribeDesktopChartViewport(onStoreChange: () => void) {
  const media = window.matchMedia("(min-width: 1024px)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function getDesktopChartViewport() {
  return window.matchMedia("(min-width: 1024px)").matches;
}

function useDesktopChartViewport() {
  return useSyncExternalStore(
    subscribeDesktopChartViewport,
    getDesktopChartViewport,
    () => true,
  );
}

function SignalSearch({
  signals,
  activeInstrument,
  tradingInstruments,
  query,
  onQueryChange,
  onSelect,
  className = "",
  compact = false,
  pairLabel,
}: {
  signals: TradeSignal[];
  activeInstrument: MajorInstrument;
  /** Pairs that currently have an open paper position. */
  tradingInstruments: ReadonlySet<string>;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (result: SearchResult) => void;
  className?: string;
  compact?: boolean;
  pairLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const isDesktop = useDesktopChartViewport();
  const normalizedQuery = normalizeSearchValue(query);
  const index = useMemo(() => buildSearchIndex(signals), [signals]);
  const matches = useMemo(() => {
    if (!normalizedQuery) {
      const byInstrument = new Map(index.map((result) => [result.instrument, result]));
      return DEFAULT_PAIR_PICKER_INSTRUMENTS.flatMap((instrument) => {
        const result = byInstrument.get(instrument);
        return result ? [result] : [];
      });
    }

    return index
      .filter((item) => item.searchText.includes(normalizedQuery))
      .sort((left, right) => {
        // Prefix matches on the symbol itself beat mid-string hits.
        const leftRank = normalizeSearchValue(left.instrument).startsWith(
          normalizedQuery,
        )
          ? 0
          : 1;
        const rightRank = normalizeSearchValue(right.instrument).startsWith(
          normalizedQuery,
        )
          ? 0
          : 1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return Number(!!right.signal) - Number(!!left.signal);
      });
  }, [index, normalizedQuery]);
  const visibleMatches = compact ? matches : matches.slice(0, 5);
  const showResults = open;
  const useDesktopDropdown = compact && isDesktop;

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    if (!compact || useDesktopDropdown) {
      document.addEventListener("keydown", handleEscape);
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    if (!compact) {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    }

    return () => {
      if (!compact || useDesktopDropdown) {
        document.removeEventListener("keydown", handleEscape);
      }
      if (!compact) {
        document.body.style.overflow = previousBodyOverflow;
        document.documentElement.style.overflow = previousRootOverflow;
      }
    };
  }, [compact, open, useDesktopDropdown]);

  useEffect(() => {
    if (!open || !useDesktopDropdown) {
      setMenuPosition(null);
      return;
    }

    function syncPosition() {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({ top: rect.bottom + 8, left: rect.left });
    }

    syncPosition();
    window.addEventListener("resize", syncPosition);
    window.addEventListener("scroll", syncPosition, true);
    return () => {
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("scroll", syncPosition, true);
    };
  }, [open, useDesktopDropdown]);

  useEffect(() => {
    if (!open || !useDesktopDropdown) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
      onQueryChange("");
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onQueryChange, open, useDesktopDropdown]);

  if (compact) {
    function closePicker() {
      setOpen(false);
      onQueryChange("");
    }

    const pairList = (
      <div className="signals-pair-sheet">
        <div className="signals-search">
          <Search
            className="size-3.5 shrink-0 text-[color:var(--muted)]"
            strokeWidth={2}
          />
          <input
            aria-label="Search all forex pairs"
            className="min-w-0 flex-1 bg-transparent text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)]"
            placeholder="Search pairs"
            style={useDesktopDropdown ? undefined : { fontSize: 16 }}
            type="search"
            value={query}
            autoFocus={useDesktopDropdown && open}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                closePicker();
                event.currentTarget.blur();
              }

              if (event.key === "Enter" && matches[0]) {
                event.preventDefault();
                onSelect(matches[0]);
                closePicker();
              }
            }}
          />
          {query ? (
            <button
              aria-label="Clear search"
              className="signals-icon-btn pressable !size-6 shrink-0"
              type="button"
              onClick={() => onQueryChange("")}
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          ) : null}
        </div>
        <div className={useDesktopDropdown ? "signals-pair-dropdown-results" : "mt-2"}>
          {matches.length ? (
            visibleMatches.map((result) => {
              const active = result.instrument === activeInstrument;
              const isTrading = tradingInstruments.has(result.instrument);

              return (
                <button
                  key={result.instrument}
                  type="button"
                  onClick={() => {
                    onSelect(result);
                    closePicker();
                  }}
                  className={`signals-search-result pressable flex w-full items-center gap-2.5 text-left ${
                    useDesktopDropdown ? "px-2.5 py-2" : "rounded-lg px-2 py-2"
                  } ${active ? "is-active" : ""}`}
                >
                  {useDesktopDropdown ? null : (
                    <PairAvatar instrument={result.instrument} size={26} />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.02em]">
                    {result.displayName}
                  </span>
                  {isTrading ? (
                    <span className="signals-search-trading-badge">Trading</span>
                  ) : null}
                  {active && useDesktopDropdown ? (
                    <span className="signals-search-current">Current</span>
                  ) : null}
                </button>
              );
            })
          ) : (
            <div className="px-2 py-3 text-center text-xs text-[color:var(--muted)]">
              No matching pair
            </div>
          )}
        </div>
      </div>
    );

    return (
      <>
        <div ref={rootRef} className={`relative ${className}`}>
          <button
            type="button"
            aria-label="Search pairs"
            aria-expanded={open}
            aria-haspopup={useDesktopDropdown ? "listbox" : undefined}
            onClick={() => setOpen((current) => {
              if (current) onQueryChange("");
              return !current;
            })}
            className={`signals-tool-btn pressable ${open ? "is-active" : ""}`}
          >
            {pairLabel ? (
              <><span>{pairLabel}</span><ChevronDown className="size-3.5" strokeWidth={2} /></>
            ) : <Search className="size-4" strokeWidth={2} />}
          </button>
        </div>

        {useDesktopDropdown && open && menuPosition && typeof document !== "undefined"
          ? createPortal(
              <div
                ref={menuRef}
                className="signals-pair-dropdown menu-popover"
                role="listbox"
                aria-label="Select a pair"
                style={{ top: menuPosition.top, left: menuPosition.left }}
              >
                {pairList}
              </div>,
              document.body,
            )
          : null}

        {!useDesktopDropdown ? (
          <MobileSheet
            open={open}
            onClose={closePicker}
            title="Select a pair"
            resetPageScrollOnOpen
            resetPageScrollOnInputFocus
            keyboardAvoiding
            className="signals-pair-mobile-sheet"
          >
            {pairList}
          </MobileSheet>
        ) : null}
      </>
    );
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label="Search all forex pairs"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="signals-search signals-search-trigger"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5 shrink-0 text-[color:var(--muted)]" strokeWidth={2} />
        <span className="min-w-0 flex-1 text-left text-[color:var(--muted)]">Search pairs</span>
      </button>

      {showResults && typeof document !== "undefined"
        ? createPortal(
            <div
              className="signals-search-overlay"
              role="presentation"
              onPointerDown={(event) => {
                if (event.currentTarget === event.target) setOpen(false);
              }}
            >
              <section
                className="signals-view signals-minimal signals-search-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Search forex pairs"
              >
                <header className="signals-search-dialog-head">
                  <div>
                    <h2>Search pairs</h2>
                    <p>Select a market to open its chart</p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close pair search"
                    className="signals-icon-btn pressable"
                    onClick={() => setOpen(false)}
                  >
                    <X className="size-4" strokeWidth={2} />
                  </button>
                </header>

                <div className="signals-search-dialog-field signals-search">
                  <Search className="size-4 shrink-0 text-[color:var(--muted)]" strokeWidth={2} />
                  <input
                    autoFocus
                    aria-label="Search all forex pairs"
                    className="min-w-0 flex-1 bg-transparent text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)]"
                    placeholder="EUR/USD, yen, GBP…"
                    type="search"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setOpen(false);
                      }

                      if (event.key === "Enter" && matches[0]) {
                        event.preventDefault();
                        onSelect(matches[0]);
                        setOpen(false);
                      }
                    }}
                  />
                  {query ? (
                    <button
                      aria-label="Clear search"
                      className="signals-icon-btn pressable !size-7 shrink-0"
                      type="button"
                      onClick={() => onQueryChange("")}
                    >
                      <X className="size-3.5" strokeWidth={2} />
                    </button>
                  ) : null}
                </div>

                <div className="signals-search-dialog-results">
                  {matches.length ? (
                    visibleMatches.map((result) => {
                      const active = result.instrument === activeInstrument;
                      const isTrading = tradingInstruments.has(result.instrument);

                      return (
                        <button
                          key={result.instrument}
                          type="button"
                          onClick={() => {
                            onSelect(result);
                            setOpen(false);
                          }}
                          className={`signals-search-result pressable flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                            active ? "is-active" : ""
                          }`}
                        >
                          <PairAvatar instrument={result.instrument} size={30} />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.02em]">
                            {result.displayName}
                          </span>
                          {isTrading ? (
                            <span className="signals-search-trading-badge">Trading</span>
                          ) : null}
                          {active ? <span className="signals-search-current">Current</span> : null}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-3 py-8 text-center text-sm text-[color:var(--muted)]">
                      No matching pair
                    </div>
                  )}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Restores the default view by bumping the same revision the chart already
 * uses after a timeframe change, so reset lands wherever that would: the
 * focused trade when one is open, otherwise the latest candles.
 */
function ResetViewButton({
  onReset,
  className = "signals-tool-btn",
}: {
  onReset: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label="Reset chart view"
      title="Reset chart view"
      className={`${className} pressable`}
    >
      <RotateCcw className="size-3.5" strokeWidth={2} />
    </button>
  );
}

function FullscreenToggle({
  fullscreen,
  onToggle,
  className = "signals-tool-btn",
}: {
  fullscreen: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = fullscreen ? Minimize : Maximize;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={fullscreen}
      aria-label={fullscreen ? "Exit fullscreen chart" : "Fullscreen chart"}
      className={`${className} pressable ${fullscreen ? "is-active" : ""}`}
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  );
}

function ActivePositionStrip({
  signal,
  currentPrice,
  pairLabel,
}: {
  signal: TradeSignal | null;
  currentPrice: number | null;
  pairLabel: string;
}) {
  if (!signal) {
    return (
      <div className="gx-active-position gx-active-position-empty">
        <span className="gx-strip-label">Active position</span>
        <span>No open position for {pairLabel}</span>
      </div>
    );
  }

  const openR = openRFromLevels({
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    current: currentPrice,
  });

  return (
    <div className="gx-active-position">
      <span className="gx-strip-label">Active position</span>
      <span className="gx-position-pair">{signal.pair}</span>
      <span className={`gx-position-side is-${signal.direction}`}>{signal.direction}</span>
      <span><small>Entry</small><b className="metric-number">{formatChartPrice(signal.entry, signal.instrument)}</b></span>
      <span><small>Current</small><b className="metric-number">{currentPrice === null ? "—" : formatChartPrice(currentPrice, signal.instrument)}</b></span>
      <span><small>SL</small><b className="metric-number is-negative">{formatChartPrice(signal.stop, signal.instrument)}</b></span>
      <span><small>TP</small><b className="metric-number is-positive">{formatChartPrice(signal.target, signal.instrument)}</b></span>
      <span><small>R:R</small><b>{formatRiskReward(signal.riskReward)}</b></span>
      <span><small>Open R</small><b className={openR !== null && openR < 0 ? "is-negative" : "is-positive"}>{openR === null ? "—" : `${openR >= 0 ? "+" : ""}${openR.toFixed(2)}R`}</b></span>
      {signal.openedAt ? <PositionOpenTiming openedAt={signal.openedAt} /> : null}
    </div>
  );
}

function formatRiskReward(value: number) {
  return `${value.toFixed(Number.isInteger(value) ? 0 : 1)}:1`;
}

function PositionOpenTiming({ openedAt }: { openedAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const started = Date.parse(openedAt);
  const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : null;
  const duration = minutes === null
    ? "—"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1_440
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;

  return (
    <>
      <span className="gx-position-mobile-detail gx-position-opened">
        <small>Opened</small>
        <b>{formatShortDay(openedAt)} · {formatClockTime(openedAt)}</b>
      </span>
      <span className="gx-position-mobile-detail">
        <small>Duration</small>
        <b>{duration}</b>
      </span>
    </>
  );
}

function SetupStats({ active }: { active: TradeSignal }) {
  return (
    <p className="signals-setup-prices metric-number">
      <span>{formatChartPrice(active.entry, active.instrument)}</span>
      <span className="signals-price-arrow">→</span>
      <span>{formatChartPrice(active.target, active.instrument)}</span>
      <span className="signals-price-levels">
        SL {formatChartPrice(active.stop, active.instrument)}
      </span>
      <span className="text-[color:var(--accent)]">
        {formatRiskReward(active.riskReward)}
      </span>
    </p>
  );
}

function SetupRangeBar({ active }: { active: TradeSignal }) {
  const low = Math.min(active.stop, active.entry, active.target);
  const high = Math.max(active.stop, active.entry, active.target);
  const span = high - low || 1;
  const stopPct = ((active.stop - low) / span) * 100;
  const entryPct = ((active.entry - low) / span) * 100;
  const targetPct = ((active.target - low) / span) * 100;
  const riskLeft = Math.min(stopPct, entryPct);
  const riskWidth = Math.abs(entryPct - stopPct);
  const rewardLeft = Math.min(entryPct, targetPct);
  const rewardWidth = Math.abs(targetPct - entryPct);

  return (
    <div className="mt-3">
      <div className="setup-range-track relative h-1 overflow-hidden rounded-full">
        <div
          className="setup-range-risk absolute inset-y-0 rounded-full"
          style={{ left: `${riskLeft}%`, width: `${Math.max(riskWidth, 4)}%` }}
        />
        <div
          className="setup-range-reward absolute inset-y-0 rounded-full"
          style={{
            left: `${rewardLeft}%`,
            width: `${Math.max(rewardWidth, 4)}%`,
          }}
        />
        <div
          className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${entryPct}%` }}
        >
          <span className="setup-range-entry block size-2 rounded-full bg-[color:var(--foreground)]" />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-[color:var(--muted)]">
        <span>{formatChartPrice(active.stop, active.instrument)}</span>
        <span className="text-center font-medium text-[color:var(--foreground)]">
          {formatChartPrice(active.entry, active.instrument)}
        </span>
        <span className="text-right">
          {formatChartPrice(active.target, active.instrument)}
        </span>
      </div>
    </div>
  );
}

function SetupMeta({
  active,
  riskDistance,
}: {
  active: TradeSignal;
  riskDistance: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-[color:var(--muted)]">
      <span>
        {(riskDistance / pipSizeFor(active.instrument)).toFixed(1)} pips risk
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-3.5" strokeWidth={1.75} />
        {active.freshness}
      </span>
    </div>
  );
}

function SetupNote({ active }: { active: TradeSignal }) {
  if (!active.note) return null;
  return (
    <p className="text-sm leading-snug text-[color:var(--muted)]">
      {active.note}
    </p>
  );
}

function EntryChecklist() {
  return (
    <ul className="signals-checklist">
      {ENTRY_CHECKLIST.map((item) => (
        <li key={item}>
          <span className="signals-checklist-icon">·</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function StrategyStatus({
  setup,
  availability,
}: {
  setup: StrategySetup;
  availability: PaperTradingAvailability;
}) {
  const actionable = setup.status === "valid";
  const waiting = !actionable && availability.state !== "entry_window_open";
  const title = actionable ? "Status" : waiting ? "Schedule" : "Blocked";
  const tone = actionable
    ? "text-[color:var(--success)]"
    : waiting
      ? "text-[color:var(--muted)]"
      : "text-[color:var(--danger)]";
  const label = actionable
    ? "Ready"
    : waiting
      ? availability.label
      : "No setup";

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        <span className={`text-xs font-medium ${tone}`}>{label}</span>
      </div>
      {!actionable && !waiting && setup.failedConditions.length ? (
        <ul className="space-y-1.5 text-xs leading-5 text-[color:var(--muted)]">
          {setup.failedConditions.map((condition) => (
            <li key={condition.name}>
              <span className="font-medium text-[color:var(--foreground)]">
                {condition.name}
              </span>
              {condition.reason ? ` · ${condition.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function tradeMoment(value: string) {
  return formatDayAndTime(value);
}

function TradeFocusBar({
  trade,
  onClear,
}: {
  trade: PaperChartTrade;
  onClear: () => void;
}) {
  const long = trade.direction === "long";
  const closed = trade.closedAt !== null && trade.exit !== null;
  const won = (trade.resultR ?? 0) >= 0;

  return (
    <div
      className="trade-focus-bar"
      data-side={long ? "buy" : "sell"}
      aria-label={`Focused ${long ? "buy" : "sell"} trade ${trade.tradeSequence}`}
    >
      <div className="trade-focus-bar-id">
        <span className="trade-focus-bar-side">{long ? "Buy" : "Sell"}</span>
        <span className="trade-focus-bar-seq">#{trade.tradeSequence}</span>
        {trade.resultR !== null ? (
          <span
            className={`trade-focus-bar-r metric-number ${won ? "is-won" : "is-lost"}`}
          >
            {formatResultR(trade.resultR)}
          </span>
        ) : null}
      </div>

      <div className="trade-focus-bar-end">
        <button
          type="button"
          onClick={onClear}
          className="trade-focus-bar-clear pressable"
          aria-label="Clear trade"
        >
          <X className="size-3.5" strokeWidth={2} />
          <span className="trade-focus-bar-clear-label">Clear</span>
        </button>
      </div>

      <div className="trade-focus-bar-legs">
        <div className="trade-focus-bar-leg">
          <span className="trade-focus-bar-label">Entry</span>
          <span className="trade-focus-bar-price metric-number">
            {formatChartPrice(trade.entry, trade.instrument)}
          </span>
          <span className="trade-focus-bar-time">{tradeMoment(trade.openedAt)}</span>
        </div>
        <div className="trade-focus-bar-leg">
          <span className="trade-focus-bar-label">Exit</span>
          {closed ? (
            <>
              <span className="trade-focus-bar-price metric-number">
                {formatChartPrice(trade.exit!, trade.instrument)}
              </span>
              <span className="trade-focus-bar-time">{tradeMoment(trade.closedAt!)}</span>
            </>
          ) : (
            <>
              <span className="trade-focus-bar-price is-open">Open</span>
              <span className="trade-focus-bar-time">Still open</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PredictionFocusBar({
  prediction,
  currentPrice,
  now,
  onClear,
}: {
  prediction: BinaryPrediction;
  currentPrice: number | null;
  now: number;
  onClear: () => void;
}) {
  const up = prediction.direction === "up";
  const expiresAt = Date.parse(prediction.intendedExpiration);
  const expired = prediction.status === "active" && Number.isFinite(expiresAt) && now >= expiresAt;
  const resolved =
    prediction.status !== "active" &&
    prediction.resolutionPrice !== null &&
    prediction.resolvedAt !== null;
  const secondsRemaining = Number.isFinite(expiresAt)
    ? Math.max(0, Math.ceil((expiresAt - now) / 1_000))
    : null;
  const countdown = secondsRemaining === null
    ? null
    : `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, "0")}`;
  const movement = currentPrice === null
    ? null
    : (currentPrice - prediction.entryPrice) * (up ? 1 : -1);
  const winning = movement !== null && movement > 0;
  const losing = movement !== null && movement < 0;
  const movementPips = movement === null ? null : movement / pipSizeFor(prediction.instrument);
  const liveStatus = prediction.status === "active" && !expired;
  const won =
    prediction.result === "won" || (liveStatus && winning);
  const lost =
    prediction.result === "lost" || (liveStatus && losing);

  let statusLabel: string;
  if (liveStatus) {
    if (movementPips !== null && (winning || losing)) {
      statusLabel = `${movementPips >= 0 ? "+" : ""}${movementPips.toFixed(1)} pips`;
    } else {
      statusLabel = "At entry";
    }
  } else if (prediction.status === "active") {
    statusLabel = "Resolving";
  } else if (prediction.result === "won") {
    statusLabel = "Won";
  } else if (prediction.result === "lost") {
    statusLabel = "Lost";
  } else if (prediction.result === "tie") {
    statusLabel = "Tie";
  } else {
    statusLabel = "Pending";
  }

  return (
    <div
      className="trade-focus-bar trade-focus-bar--prediction"
      data-side={up ? "buy" : "sell"}
      aria-label={`Focused ${up ? "up" : "down"} binary prediction ${prediction.sequence}`}
    >
      <div className="trade-focus-bar-id">
        <span className="trade-focus-bar-side">{up ? "Up" : "Down"}</span>
        <span className="trade-focus-bar-seq">#{prediction.sequence}</span>
        <span className="trade-focus-bar-seq metric-number">
          {prediction.confidence.toFixed(2)}
        </span>
        <span
          className={`trade-focus-bar-r metric-number ${won ? "is-won" : lost ? "is-lost" : ""}`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="trade-focus-bar-end">
        <button
          type="button"
          onClick={onClear}
          className="trade-focus-bar-clear pressable"
          aria-label="Clear prediction"
        >
          <X className="size-3.5" strokeWidth={2} />
          <span className="trade-focus-bar-clear-label">Clear</span>
        </button>
      </div>

      <div className="trade-focus-bar-legs">
        <div className="trade-focus-bar-leg trade-focus-bar-leg--entry">
          <span className="trade-focus-bar-label">Entry</span>
          <span className="trade-focus-bar-price metric-number">
            {formatChartPrice(prediction.entryPrice, prediction.instrument)}
          </span>
          <span className="trade-focus-bar-time">{tradeMoment(prediction.startAt)}</span>
        </div>
        <div className="trade-focus-bar-leg">
          <span className="trade-focus-bar-label">{resolved ? "Exit" : "Expires"}</span>
          {resolved ? (
            <>
              <span className="trade-focus-bar-price metric-number">
                {formatChartPrice(prediction.resolutionPrice!, prediction.instrument)}
              </span>
              <span className="trade-focus-bar-time">{tradeMoment(prediction.resolvedAt!)}</span>
            </>
          ) : expired ? (
            <>
              <span className="trade-focus-bar-price is-open">Resolving</span>
              <span className="trade-focus-bar-time">
                Expired {formatClockTime(prediction.intendedExpiration)}
              </span>
            </>
          ) : (
            <>
              <span className="trade-focus-bar-price is-open metric-number">
                {countdown ?? "Open"}
              </span>
              <span className="trade-focus-bar-time">
                {formatClockTime(prediction.intendedExpiration)}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MobileSignalDetails({
  tab,
  active,
  setup,
  riskDistance,
  openPaperTrade,
  availability,
}: {
  tab: MobileTab;
  active: TradeSignal | null;
  setup: StrategySetup;
  riskDistance: number | null;
  openPaperTrade: boolean;
  availability: PaperTradingAvailability;
}) {
  switch (tab) {
    case "Setup":
      return (
        <div className="space-y-4">
          <EntryChecklist />
        </div>
      );
    case "Overview":
      return (
        <div className="space-y-4">
          {active && riskDistance !== null ? (
            <>
              <SetupStats active={active} />
              <SetupRangeBar active={active} />
              <SetupNote active={active} />
              <SetupMeta active={active} riskDistance={riskDistance} />
            </>
          ) : (
            <p className="text-sm text-[color:var(--muted)]">
              {availability.state === "entry_window_open"
                ? "No valid setup."
                : availability.detail}
            </p>
          )}
          {openPaperTrade ? (
            <p className="text-sm text-[color:var(--accent)]">Open paper trade</p>
          ) : (
            <StrategyStatus setup={setup} availability={availability} />
          )}
        </div>
      );
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

export function SignalWorkspace({
  strategySetups,
  initialInstrument,
  primarySeries,
  initialStatus,
  paperPlans,
  initialPaperTrades = [],
  initialFocusTradeId = null,
  initialPredictionFocus = null,
  initialManualProposal = null,
}: {
  strategySetups: StrategySetup[];
  initialInstrument: MajorInstrument;
  primarySeries: CandleSeries;
  initialStatus: ConnectionStatus;
  paperPlans: SignalPaperPlan[];
  initialPaperTrades?: PaperChartTrade[];
  initialFocusTradeId?: string | null;
  initialPredictionFocus?: BinaryPrediction | null;
  /** Exact prospective setup selected from Home, kept stable across the route transition. */
  initialSetupFocus?: { entry: number; stop: number; target: number } | null;
  /** A user accepted a test-only AI proposal; this opens a reviewable draft, never an order. */
  initialManualProposal?: { direction: "long" | "short"; entry: number; stop: number; target: number; confidence: number | null; rationale: string; preferredEntryTime: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const workspacePath = pathname.startsWith("/signals") ? "/signals" : "/chart";
  const signals = useMemo(
    () => strategySetups.flatMap(toDisplaySignal),
    [strategySetups],
  );
  const [selectedInstrument, setSelectedInstrument] = useState(
    initialInstrument,
  );
  const instrument = selectedInstrument;
  const initialSignal = signals.find((signal) => signal.instrument === instrument);

  // Paper decisions are taken on completed M15 candles, so a trade opened from
  // the dashboard always lands on the timeframe it was actually decided on.
  const [timeframe, setTimeframe] = useState<ChartTimeframe>(
    initialPredictionFocus ? "1m" as const : initialFocusTradeId ? "15m" as const : mapSignalTimeframe(initialSignal?.timeframe ?? "15m"),
  );
  const [range, setRange] = useState<ChartRange>(initialPredictionFocus ? "1D" : "6M");
  const [chartVariant, setChartVariant] = useState<ChartVariant>("candle");
  const [enabledIndicators, setEnabledIndicators] = useState<ChartIndicator[]>(
    DEFAULT_CHART_INDICATORS,
  );
  const [chartPreferencesReady, setChartPreferencesReady] = useState(false);

  useEffect(() => {
    const saved = readStoredChartPreferences();
    if (saved) {
      setTimeframe(saved.timeframe);
      setRange(saved.range);
      setChartVariant(saved.chartVariant);
      setEnabledIndicators(saved.enabledIndicators);
    } else if (window.matchMedia("(max-width: 1023.98px)").matches) {
      // First visit only: mobile starts on the area chart. Once the user makes
      // a choice, the stored preference wins on every later visit.
      setChartVariant("area");
    }
    setChartPreferencesReady(true);
  }, []);

  useEffect(() => {
    if (!chartPreferencesReady) return;
    const preferences: StoredChartPreferences = {
      version: 1,
      timeframe,
      range,
      chartVariant,
      enabledIndicators,
    };
    try {
      window.localStorage.setItem(
        CHART_PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      // Storage can be unavailable in private/restricted browsing. The chart
      // remains usable for the current session even when persistence is denied.
    }
  }, [chartPreferencesReady, chartVariant, enabledIndicators, range, timeframe]);
  const [series, setSeries] = useState(primarySeries);
  const seriesRef = useRef(primarySeries);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  // Dedicated completed-M15 history for session S/R freezes. Independent of the
  // chart timeframe so a 5m/1h view cannot change or invalidate the snapshot.
  const [sessionSrM15Candles, setSessionSrM15Candles] = useState<Candle[]>([]);
  const sessionSrDebugKeyRef = useRef("");
  const overlayPreferences: ChartOverlayPreferences = {
    levels: true,
    signalMarkers: true,
    positionMarkers: true,
  };
  const [dataNotice, setDataNotice] = useState<string | null>(
    initialStatus.state === "connected" ? null : initialStatus.message,
  );
  const [loading, setLoading] = useState(false);
  const [refreshingChart, setRefreshingChart] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollToLatestRevision, setScrollToLatestRevision] = useState(0);
  const [preserveViewportRevision, setPreserveViewportRevision] = useState(0);
  // Both charts are sized from the box they are given rather than from the
  // viewport: the mobile layout is a single non-scrolling column and the
  // desktop card grows to the screen in fullscreen, so only a measurement
  // knows how tall the canvas actually is.
  const [mobileChartHeight, setMobileChartHeight] = useState(320);
  const [desktopChartHeight, setDesktopChartHeight] = useState(DESKTOP_CHART_HEIGHT);
  const [fullscreen, setFullscreen] = useState(false);
  const mobileChartShellRef = useRef<HTMLDivElement>(null);
  const desktopChartShellRef = useRef<HTMLDivElement>(null);
  const [paperTrades, setPaperTrades] = useState<PaperChartTrade[]>(initialPaperTrades);
  const [livePaperPlans, setLivePaperPlans] = useState<SignalPaperPlan[]>(paperPlans);
  const [binaryWatch, setBinaryWatch] = useState<BinaryWatchRow[]>([]);
  const [focusTradeId, setFocusTradeId] = useState<string | null>(initialFocusTradeId);
  const [predictionFocus, setPredictionFocus] = useState<BinaryPrediction | null>(initialPredictionFocus);
  const [predictionClock, setPredictionClock] = useState(() => Date.now());
  const [pendingEntries, setPendingEntries] = useState<PendingManualEntry[]>([]);
  const [allPendingEntries, setAllPendingEntries] = useState<PendingManualEntry[]>([]);
  const [tradeActionBusy, setTradeActionBusy] = useState(false);
  const [tradeActionError, setTradeActionError] = useState<string | null>(null);
  const [tradeConfirm, setTradeConfirm] = useState<"cancel" | "close" | null>(null);
  const [pendingEntryDialogOpen, setPendingEntryDialogOpen] = useState(false);
  const [selectedPendingEntry, setSelectedPendingEntry] = useState<PendingManualEntry | null>(null);
  const [pendingEntryNotice, setPendingEntryNotice] = useState<string | null>(null);
  const [pendingEntryClock, setPendingEntryClock] = useState(() => Date.now());
  const [entryComposerRevision, setEntryComposerRevision] = useState(0);
  const [positionTool, setPositionTool] = useState<ChartPositionTool | null>(null);
  const [positionToolPrompt, setPositionToolPrompt] = useState(false);
  const [entryDraftProposal, setEntryDraftProposal] = useState<{
    direction: "long" | "short";
    entry: number;
    stop: number;
    target: number;
    confidence: number | null;
    rationale: string;
    preferredEntryTime: string;
  } | null>(null);
  const openedManualProposalRef = useRef(false);

  function isCompactChartViewport() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  }

  function openPendingEntryManager(entry: PendingManualEntry | null = null) {
    if (!entry && hasActivePosition) {
      setPendingEntryNotice("This pair already has an active position. Close it before creating another entry.");
      return;
    }
    setSelectedPendingEntry(entry);
    if (isCompactChartViewport()) {
      setPendingEntryDialogOpen(true);
    } else {
      setPendingEntryDialogOpen(false);
    }
  }

  function clearPendingEntrySelection() {
    setSelectedPendingEntry(null);
    setPendingEntryDialogOpen(false);
    setEntryDraftProposal(null);
    setEntryComposerRevision((revision) => revision + 1);
  }

  function submitPositionTool(tool: ChartPositionTool) {
    const precision = precisionFor(instrument);
    const round = (value: number) => Number(value.toFixed(precision));
    setEntryDraftProposal({
      direction: tool.direction,
      entry: round(tool.entry),
      stop: round(tool.stop),
      target: round(tool.target),
      confidence: null,
      rationale: "Fixed 10-pip 1:1 setup from chart",
      preferredEntryTime: new Date().toISOString(),
    });
    setPositionTool(null);
    openPendingEntryManager(null);
    setEntryComposerRevision((revision) => revision + 1);
  }

  const {
    proposal: manualProposal,
    setProposal: setManualProposal,
    analyze: analyzeInstrument,
    analyzingInstrument,
    analysisError,
    acceptProposal: acceptManualProposal,
  } = useManualProposal();

  useEffect(() => {
    if (!initialManualProposal || openedManualProposalRef.current) return;
    openedManualProposalRef.current = true;
    // The same chart workspace can survive a query-string navigation. Clear
    // its previous proposal state before opening the pending-entry sheet so
    // the two dialogs never stack.
    setManualProposal(null);
    openPendingEntryManager(null);
    setEntryComposerRevision((revision) => revision + 1);
  }, [initialManualProposal, setManualProposal]);
  const olderRequestInFlightRef = useRef(false);
  const pendingTickRef = useRef<MarketPriceTick | null>(null);
  const marketFrameRef = useRef<number | null>(null);

  const refreshPaperPlans = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/watchlist"), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json() as { watchlist?: SignalPaperPlan[] };
      if (response.ok && payload.watchlist) setLivePaperPlans(payload.watchlist);
    } catch {
      // Retain the last known strategy verdict while a refresh is unavailable.
    }
  }, []);

  const refreshBinaryWatch = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/binary/watchlist"), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json() as { watchlist?: BinaryWatchRow[] };
      if (response.ok && payload.watchlist) setBinaryWatch(payload.watchlist);
    } catch {
      // Keep the last known engine read while a refresh is unavailable.
    }
  }, []);

  const refreshPaperTrades = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/paper-cycle/trades?instrument=${instrument}`),
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { trades: PaperChartTrade[] };
      setPaperTrades(payload.trades);
    } catch {
      // Markers are supplementary — the chart stays usable without them.
    }
  }, [instrument]);

  const refreshPendingEntries = useCallback(async () => {
    try {
      // Read every non-terminal manual entry, not only the selected pair. The
      // picker uses this same source to mark a pair whose manual trade filled.
      const response = await fetch(apiUrl("/api/pending-entries"), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = await response.json() as { entries?: PendingManualEntry[] };
      if (response.ok && payload.entries) {
        const entriesForInstrument = payload.entries.filter((entry) => entry.instrument === instrument);
        setAllPendingEntries(payload.entries);
        setPendingEntries(entriesForInstrument);
        setSelectedPendingEntry((current) => current ? entriesForInstrument.find((entry) => entry.id === current.id) ?? current : null);
      }
    } catch {
      // Existing chart data remains usable while the persisted entry read retries.
    }
  }, [instrument]);

  const refreshActivePrediction = useCallback(async () => {
    if (!predictionFocus || predictionFocus.status !== "active") return;
    try {
      const response = await fetch(apiUrl(`/api/binary/prediction?id=${predictionFocus.id}`), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = (await response.json()) as { prediction?: BinaryPrediction };
      if (response.ok && payload.prediction) setPredictionFocus(payload.prediction);
    } catch {
      // The countdown can continue while the next server resolution check retries.
    }
  }, [predictionFocus]);

  useEffect(() => {
    void refreshPaperPlans();
    const timer = window.setInterval(() => void refreshPaperPlans(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshPaperPlans]);

  useEffect(() => {
    void refreshBinaryWatch();
    const timer = window.setInterval(() => void refreshBinaryWatch(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshBinaryWatch]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshPendingEntries(), 0);
    const timer = window.setInterval(() => {
      setPendingEntryClock(Date.now());
      void refreshPendingEntries();
    }, 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshPendingEntries]);

  useEffect(() => {
    if (!pendingEntryNotice) return;
    const timer = window.setTimeout(() => setPendingEntryNotice(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [pendingEntryNotice]);

  useEffect(() => {
    setPredictionFocus(initialPredictionFocus);
  }, [initialPredictionFocus]);

  useEffect(() => {
    if (!predictionFocus || predictionFocus.status !== "active") return;

    const controller = new AbortController();
    const refreshPrediction = async () => {
      try {
        const response = await fetch(apiUrl(`/api/binary/prediction?id=${predictionFocus.id}`), {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as { prediction?: BinaryPrediction };
        if (response.ok && payload.prediction) setPredictionFocus(payload.prediction);
      } catch {
        // The countdown can continue while the next server resolution check retries.
      }
    };
    const expirationDelay = Math.max(0, Date.parse(predictionFocus.intendedExpiration) - Date.now()) + 1_000;
    const interval = window.setInterval(() => void refreshPrediction(), 15_000);
    const timeout = window.setTimeout(() => void refreshPrediction(), expirationDelay);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [predictionFocus?.id, predictionFocus?.intendedExpiration, predictionFocus?.status]);

  useEffect(() => {
    if (!predictionFocus || predictionFocus.status !== "active") return;
    const interval = window.setInterval(() => setPredictionClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [predictionFocus?.id, predictionFocus?.status]);

  useEffect(() => {
    const mobileShell = mobileChartShellRef.current;
    const desktopShell = desktopChartShellRef.current;

    // The hidden breakpoint's shell reports a zero box, which is why an empty
    // measurement is dropped rather than pushed into the chart.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const measured = Math.round(entry.contentRect.height);
        if (measured <= 0) continue;

        if (entry.target === mobileShell) {
          setMobileChartHeight(measured);
        } else {
          setDesktopChartHeight(measured);
        }
      }
    });

    if (mobileShell) observer.observe(mobileShell);
    if (desktopShell) observer.observe(desktopShell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!fullscreen) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false);
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    document.body.classList.add("signals-fullscreen-active");
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = overflow;
      document.body.classList.remove("signals-fullscreen-active");
      document.removeEventListener("keydown", handleEscape);
    };
  }, [fullscreen]);

  const replaceSeries = useCallback((nextSeries: CandleSeries) => {
    seriesRef.current = nextSeries;
    setSeries(nextSeries);
  }, []);

  /**
   * Quiet refetch used when the PWA returns to the foreground. Keeps the last
   * candles/quote on screen (no loading skeleton) while replacing them with
   * fresh broker data — backgrounded mobile timers and sockets otherwise leave
   * the chart sitting on a frozen snapshot.
   */
  const refreshMarketQuietly = useCallback(async () => {
    try {
      const [candlesResponse, pricingResponse] = await Promise.all([
        fetch(
          apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=${candleCountForRange(timeframe, range)}`),
          { credentials: "include", cache: "no-store" },
        ),
        fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), {
          credentials: "include",
          cache: "no-store",
        }),
      ]);

      if (!candlesResponse.ok || !pricingResponse.ok) return;

      const candlesPayload = (await candlesResponse.json()) as {
        data: CandleSeries;
        status: ConnectionStatus;
      };
      const pricingPayload = (await pricingResponse.json()) as {
        data: PriceQuote[];
        status: ConnectionStatus;
      };

      const currentSeries = seriesRef.current;
      if (
        candlesPayload.data.instrument !== instrument ||
        candlesPayload.data.granularity !== TIMEFRAME_TO_GRANULARITY[timeframe] ||
        currentSeries.instrument !== instrument ||
        currentSeries.granularity !== candlesPayload.data.granularity
      ) return;

      replaceSeries({
        ...candlesPayload.data,
        candles: mergeRefreshedCandles(
          currentSeries.candles,
          candlesPayload.data.candles,
        ),
      });
      // The refreshed bars update in place while the already loaded history
      // remains, so logical viewport indexes keep pointing at the same times.
      setPreserveViewportRevision((revision) => revision + 1);
      setHistoryExhausted(false);
      setLiveCandle(null);
      setQuote(
        pricingPayload.data.find((price) => price.instrument === instrument) ??
          null,
      );

      if (candlesPayload.status.state !== "connected") {
        setDataNotice(candlesPayload.status.message);
      } else if (pricingPayload.status.state !== "connected") {
        setDataNotice(pricingPayload.status.message);
      } else {
        setDataNotice(null);
      }
    } catch {
      // Keep the last loaded chart while the next resume refresh retries.
    }
  }, [instrument, range, replaceSeries, timeframe]);

  const refreshChart = useCallback(async () => {
    setRefreshingChart(true);
    await refreshMarketQuietly();
    setRefreshingChart(false);
  }, [refreshMarketQuietly]);

  useForegroundRefresh(
    useCallback(async () => {
      await Promise.all([
        refreshMarketQuietly(),
        refreshPaperPlans(),
        refreshBinaryWatch(),
        refreshPaperTrades(),
        refreshPendingEntries(),
        refreshActivePrediction(),
      ]);
    }, [
      refreshActivePrediction,
      refreshBinaryWatch,
      refreshMarketQuietly,
      refreshPaperPlans,
      refreshPaperTrades,
      refreshPendingEntries,
    ]),
  );

  const handleMarketPrice = useCallback(
    (tick: MarketPriceTick) => {
      if (tick.instrument !== instrument) return;
      pendingTickRef.current = tick;
      if (marketFrameRef.current !== null) return;

      marketFrameRef.current = window.requestAnimationFrame(() => {
        marketFrameRef.current = null;
        const latestTick = pendingTickRef.current;
        pendingTickRef.current = null;
        if (!latestTick || latestTick.instrument !== instrument) return;

        setQuote({
          instrument: latestTick.instrument,
          displayName: latestTick.displayName,
          bid: latestTick.bid,
          ask: latestTick.ask,
          mid: latestTick.mid,
          changePercent: 0,
          status: latestTick.status,
          time: latestTick.time,
          source: latestTick.source,
        });

        const liveUpdate = applyTickToCandles(
          seriesRef.current,
          latestTick,
        );
        if (!liveUpdate.changed) return;

        seriesRef.current = liveUpdate.series;
        setLiveCandle(liveUpdate.liveCandle);

        if (liveUpdate.appended) {
          setSeries(liveUpdate.series);
        }
      });
    },
    [instrument],
  );
  useMarketStream(instrument, handleMarketPrice, {
    trackPrice: false,
  });

  const activeSetup =
    strategySetups.find((setup) => setup.instrument === instrument) ??
    strategySetups[0];
  const activeCandidate = toDisplaySignal(activeSetup)[0] ?? null;
  const selectedPlan = livePaperPlans.find((plan) => plan.instrument === instrument) ?? null;
  const paperPlan = selectedPlan?.openTradeId ? selectedPlan : null;
  // Memoised because this feeds the chart's `levels` prop through `active`.
  // A fresh object here on every render reached SetupChart as a changed
  // dependency and tore the chart down mid-gesture on each live tick.
  const openSignal: TradeSignal | null = useMemo(
    () => paperPlan?.direction && paperPlan.entry !== null && paperPlan.stop !== null && paperPlan.target !== null ? {
      instrument,
      pair: activeSetup.pair,
      timeframe: "15m",
      direction: paperPlan.direction,
      bias: paperPlan.direction === "long" ? "Bullish" : "Bearish",
      entry: paperPlan.entry,
      stop: paperPlan.stop,
      target: paperPlan.target,
      riskReward: Math.abs(paperPlan.target - paperPlan.entry) / Math.abs(paperPlan.entry - paperPlan.stop),
      strategy: `Paper · Batch ${paperPlan.batchNumber ?? "—"}`,
      note: `Trade #${paperPlan.tradeSequence ?? "—"}`,
      freshness: "Open",
    } : null,
    [paperPlan, instrument, activeSetup.pair],
  );
  // Blocked setups can still have a concrete draft entry, stop and target.
  // Show those levels when a Watchlist card is opened; execution remains gated
  // by setup.status === "valid" in the paper-cycle backend.
  const active = openSignal ?? activeCandidate;
  const planIsOpen = Boolean(openSignal);
  // The status line reflects the Binary Prediction engine (the "new engine") for
  // the selected pair, not the paper-cycle entry window.
  const binaryRow = binaryWatch.find((row) => row.instrument === instrument) ?? null;
  const engineStatus = binaryEngineStatus(binaryRow);
  const riskDistance = active ? Math.abs(active.entry - active.stop) : null;
  const focusTrade = useMemo(
    () =>
      paperTrades.find(
        (trade) => trade.id === focusTradeId && trade.instrument === instrument,
      ) ?? null,
    [focusTradeId, instrument, paperTrades],
  );
  // The page receives this list from the server before the workspace renders.
  // Prefer it over the watchlist's `openTradeId`, which can lag the paper
  // collector by one refresh. That way a chart opened directly always shows
  // an existing position and its levels before falling back to the no-position
  // state.
  const openPaperTrade = useMemo(
    () =>
      paperTrades.find(
        (trade) => trade.instrument === instrument && trade.status === "open" && trade.closedAt === null,
      ) ?? null,
    [instrument, paperTrades],
  );
  // A closed trade may remain selected so its historical entry/exit markers
  // and focused time range stay available. It is not an active plan though:
  // showing its Entry / SL / TP as live chart levels made completed positions
  // look as if they were still open.
  const displayedTrade = openPaperTrade ?? focusTrade;
  const triggeredManualEntry = useMemo(
    () => pendingEntries.find((entry) =>
      entry.status === "TRIGGERED" &&
      entry.paperTradeStatus === "open" &&
      entry.stopPrice !== null &&
      entry.targetPrice !== null,
    ) ?? null,
    [pendingEntries],
  );
  // The pair's one non-terminal manual entry drives the Analyze / Cancel / Close
  // button. A resting or scheduled order is cancellable; a filled (active) trade
  // is closeable; anything else means the pair is free to analyze.
  const pendingManualEntry = useMemo(
    () => pendingEntries.find((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING") ?? null,
    [pendingEntries],
  );
  const activeManualTrade = triggeredManualEntry ?? pendingEntries.find((entry) => entry.status === "TRIGGERED" && entry.paperTradeStatus === "open") ?? null;
  const manualTradeMode: "analyze" | "cancel" | "close" = activeManualTrade ? "close" : pendingManualEntry ? "cancel" : "analyze";
  const hasActivePosition = Boolean(openPaperTrade || activeManualTrade);

  useEffect(() => {
    // A fixed setup would create a competing entry. Clear any draft as soon as
    // an open position is observed, including the brief watchlist-lag window.
    if (!hasActivePosition) return;
    setPositionTool(null);
    setPositionToolPrompt(false);
  }, [hasActivePosition]);

  // The watchlist is the only chart payload that covers every pair. Add the
  // current chart's direct trade read too, because the watchlist can trail a
  // just-opened position by one collector refresh.
  const tradingInstruments = useMemo(() => {
    const instruments = new Set(
      livePaperPlans
        .filter((plan) => Boolean(plan.openTradeId))
        .map((plan) => plan.instrument),
    );
    for (const entry of allPendingEntries) {
      if (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open") {
        instruments.add(entry.instrument);
      }
    }
    if (hasActivePosition) instruments.add(instrument);
    return instruments;
  }, [allPendingEntries, hasActivePosition, instrument, livePaperPlans]);

  const cancelManualTrade = useCallback(async () => {
    if (!pendingManualEntry) return;
    setTradeActionBusy(true);
    setTradeActionError(null);
    try {
      const res = await fetch(apiUrl(`/api/pending-entries/${pendingManualEntry.id}`), { method: "DELETE", credentials: "include" });
      const payload = await res.json() as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not cancel the trade.");
    } catch (error) {
      setTradeActionError(error instanceof Error ? error.message : "Could not cancel the trade.");
    } finally {
      await Promise.all([refreshPendingEntries(), refreshPaperTrades()]);
      setTradeActionBusy(false);
    }
  }, [pendingManualEntry, refreshPendingEntries, refreshPaperTrades]);

  const closeManualTrade = useCallback(async () => {
    if (!activeManualTrade) return;
    setTradeActionBusy(true);
    setTradeActionError(null);
    try {
      const res = await fetch(apiUrl(`/api/pending-entries/${activeManualTrade.id}/close`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument }),
      });
      const payload = await res.json() as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not close the trade.");
    } catch (error) {
      setTradeActionError(error instanceof Error ? error.message : "Could not close the trade.");
    } finally {
      // Refresh paper trades too so openPaperTrade clears and its Entry/SL/TP
      // overlay disappears immediately instead of on the next 15s poll.
      await Promise.all([refreshPendingEntries(), refreshPaperTrades()]);
      setTradeActionBusy(false);
    }
  }, [activeManualTrade, instrument, refreshPendingEntries, refreshPaperTrades]);
  const focusedPrediction = predictionFocus?.instrument === instrument
    ? predictionFocus
    : null;
  const activeFocusId = displayedTrade?.id ?? null;
  // A direct chart visit can arrive before the watchlist collector has
  // refreshed its `openTradeId`. Prefer the chart's own open-trade read so
  // Active Position never says "no open position" while that trade is live.
  const positionSignal = useMemo<TradeSignal | null>(() => {
    if (openPaperTrade) {
      const risk = Math.abs(openPaperTrade.entry - openPaperTrade.stop);
      return {
        instrument,
        pair: activeSetup.pair,
        timeframe: "15m",
        direction: openPaperTrade.direction,
        bias: openPaperTrade.direction === "long" ? "Bullish" : "Bearish",
        entry: openPaperTrade.entry,
        stop: openPaperTrade.stop,
        target: openPaperTrade.target,
        riskReward: risk > 0 ? Math.abs(openPaperTrade.target - openPaperTrade.entry) / risk : 0,
        strategy: `Paper · Batch ${openPaperTrade.batchNumber ?? "—"}`,
        note: `Trade #${openPaperTrade.tradeSequence}`,
        freshness: "Open",
        openedAt: openPaperTrade.openedAt,
      };
    }
    if (triggeredManualEntry?.triggerPrice && triggeredManualEntry.stopPrice !== null && triggeredManualEntry.targetPrice !== null) {
      const risk = Math.abs(triggeredManualEntry.triggerPrice - triggeredManualEntry.stopPrice);
      return {
        instrument,
        pair: activeSetup.pair,
        timeframe: "1h",
        direction: triggeredManualEntry.direction,
        bias: triggeredManualEntry.direction === "long" ? "Bullish" : "Bearish",
        entry: triggeredManualEntry.triggerPrice,
        stop: triggeredManualEntry.stopPrice,
        target: triggeredManualEntry.targetPrice,
        riskReward: risk > 0 ? Math.abs(triggeredManualEntry.targetPrice - triggeredManualEntry.triggerPrice) / risk : 2,
        strategy: "Pending manual entry",
        note: "Simulated paper execution",
        freshness: "Triggered",
        openedAt: triggeredManualEntry.triggeredAt ?? triggeredManualEntry.createdAt,
      };
    }
    return openSignal;
  }, [activeSetup.pair, instrument, openPaperTrade, openSignal, triggeredManualEntry]);

  const startPositionTool = useCallback((direction: "long" | "short") => {
    const candles = series.candles;
    const entry =
      liveCandle?.close
      ?? candles.at(-1)?.close
      ?? null;
    if (entry === null || !Number.isFinite(entry) || candles.length === 0) {
      setPositionToolPrompt(false);
      return;
    }
    const pip = pipSizeFor(instrument);
    const lastIndex = candles.length - 1;
    const spanBars = Math.min(36, Math.max(lastIndex, 1));
    const toLogical = lastIndex;
    const fromLogical = Math.max(0, lastIndex - spanBars);
    setPositionTool(createFixedTenPipSetup(direction, entry, pip, fromLogical, toLogical));
    setPositionToolPrompt(false);
  }, [instrument, liveCandle?.close, series.candles]);

  // Only an open trade owns live Entry / SL / TP overlays. Manual positions
  // already render their clickable levels through pendingEntryReferenceLines,
  // so suppress the strategy draft while one is open instead of drawing both.
  // A closed focused trade can retain its markers and path without live levels.
  const setupLevels = useMemo(
    () => openPaperTrade ? ({
      entry: openPaperTrade.entry,
      stop: openPaperTrade.stop,
      target: openPaperTrade.target,
      exit: openPaperTrade.exit,
      outcome: openPaperTrade.outcome,
    }) : focusTrade || triggeredManualEntry ? null : openSignal ? ({
      entry: openSignal.entry,
      stop: openSignal.stop,
      target: openSignal.target,
    }) : null,
    [openSignal, focusTrade, openPaperTrade, triggeredManualEntry],
  );
  const pendingEntryReferenceLines = useMemo(() => {
    const openManager = (entry: PendingManualEntry) => {
      openPendingEntryManager(entry);
    };
    return pendingEntries.flatMap((entry) => {
      if (entry.status === "PENDING" || entry.status === "TRIGGERING") {
        const remaining = entry.expiresAt
          ? Math.max(0, Date.parse(entry.expiresAt) - pendingEntryClock)
          : null;
        const remainingMinutes = remaining === null ? null : Math.ceil(remaining / 60_000);
        const countdown = remainingMinutes === null ? "" : remainingMinutes >= 60
          ? ` • ${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`
          : ` • ${remainingMinutes}m`;
        const lines: ChartReferenceLine[] = [{
          key: `pending-${entry.id}`,
          price: entry.entryPrice,
          label: `${entry.direction.toUpperCase()} ENTRY ${formatChartPrice(entry.entryPrice, instrument)}${countdown}`,
          color: entry.direction === "long" ? "#00b377" : "#e67e22",
          textColor: "#ffffff",
          dashed: false,
          lineWidth: 2 as const,
          onSelect: () => openManager(entry),
        }];
        // A pending manual entry is a complete trade plan, not merely a price
        // alert. Keep its protective stop and profit objective visible from
        // the moment it is created, just as we do after it has triggered.
        if (entry.stopPrice !== null && entry.targetPrice !== null) {
          const risk = Math.abs(entry.entryPrice - entry.stopPrice);
          const rewardR = risk > 0
            ? Math.abs(entry.targetPrice - entry.entryPrice) / risk
            : null;
          lines.push(
            {
              key: `pending-stop-${entry.id}`,
              price: entry.stopPrice,
              label: `SL ${formatChartPrice(entry.stopPrice, instrument)} · -1R`,
              color: "#e74c3c",
              textColor: "#ffffff",
              dashed: true,
              lineWidth: 1 as const,
              onSelect: () => openManager(entry),
            },
            {
              key: `pending-target-${entry.id}`,
              price: entry.targetPrice,
              label: `TP ${formatChartPrice(entry.targetPrice, instrument)}${rewardR === null ? "" : ` · +${rewardR.toFixed(rewardR >= 10 ? 0 : 1)}R`}`,
              color: "#00b377",
              textColor: "#ffffff",
              dashed: true,
              lineWidth: 1 as const,
              onSelect: () => openManager(entry),
            },
          );
        }
        if (entry.invalidationPrice !== null) lines.push({
          key: `cancel-${entry.id}`,
          price: entry.invalidationPrice,
          label: `CANCEL ${formatChartPrice(entry.invalidationPrice, instrument)}`,
          color: "#8c8c93",
          textColor: "#ffffff",
          dashed: true,
          lineWidth: 1 as const,
          onSelect: () => openManager(entry),
        });
        return lines;
      }
      // TRIGGERED describes how the pending order ended; it does not mean the
      // resulting trade is still active. Draw its plan only while the linked
      // paper trade is open, otherwise every completed manual trade accumulates
      // another Entry / SL / TP set on the chart.
      if (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open" && entry.triggerPrice !== null && entry.stopPrice !== null && entry.targetPrice !== null) {
        return [
          { key: `manual-entry-${entry.id}`, price: entry.triggerPrice, label: `ENTRY ${formatChartPrice(entry.triggerPrice, instrument)}`, color: "#00a06a", textColor: "#ffffff", dashed: false, lineWidth: 2 as const, onSelect: () => openManager(entry) },
          { key: `manual-stop-${entry.id}`, price: entry.stopPrice, label: `SL ${formatChartPrice(entry.stopPrice, instrument)} · -1R`, color: "#e74c3c", textColor: "#ffffff", dashed: true, lineWidth: 1 as const, onSelect: () => openManager(entry) },
          { key: `manual-target-${entry.id}`, price: entry.targetPrice, label: `TP ${formatChartPrice(entry.targetPrice, instrument)} · +2R`, color: "#00b377", textColor: "#ffffff", dashed: true, lineWidth: 1 as const, onSelect: () => openManager(entry) },
        ];
      }
      return [];
    });
  }, [instrument, pendingEntries, pendingEntryClock]);
  const supportResistanceReferenceLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "support-resistance")
      ? supportResistanceLines(series.candles, instrument)
      : [],
    [enabledIndicators, instrument, series.candles],
  );
  const sessionSrEnabled = useMemo(
    () =>
      isChartIndicatorEnabled(enabledIndicators, "session-sr-asia")
      || isChartIndicatorEnabled(enabledIndicators, "session-sr-london")
      || isChartIndicatorEnabled(enabledIndicators, "session-sr-newyork"),
    [enabledIndicators],
  );
  const frozen4hSrEnabled = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "frozen-4h-sr"),
    [enabledIndicators],
  );
  const m15OverlayEnabled = sessionSrEnabled || frozen4hSrEnabled;
  // Prefer the dedicated M15 feed; when the chart is already on M15 and that
  // feed has not arrived yet, fall back so the overlay is not blank.
  const sessionSrSourceCandles = useMemo(() => {
    if (sessionSrM15Candles.length >= 20) return sessionSrM15Candles;
    if (TIMEFRAME_TO_GRANULARITY[timeframe] === "M15") return series.candles;
    return sessionSrM15Candles;
  }, [sessionSrM15Candles, series.candles, timeframe]);
  const sessionSrSnapshots = useMemo(() => {
    if (!sessionSrEnabled) return [] as SessionSrLevels[];
    const centres: SessionSrCentre[] = [];
    if (isChartIndicatorEnabled(enabledIndicators, "session-sr-asia")) centres.push("asia");
    if (isChartIndicatorEnabled(enabledIndicators, "session-sr-london")) centres.push("london");
    if (isChartIndicatorEnabled(enabledIndicators, "session-sr-newyork")) centres.push("newyork");
    return centres
      .map((centre) => computeSessionSrLevels(sessionSrSourceCandles, centre, instrument))
      .filter((levels): levels is SessionSrLevels => levels !== null);
  }, [enabledIndicators, instrument, sessionSrEnabled, sessionSrSourceCandles]);
  const sessionSrReferenceLines = useMemo(
    () => sessionSrSnapshots.flatMap((levels) => sessionSrLines(levels, instrument)),
    [instrument, sessionSrSnapshots],
  );
  const frozen4hBlocks = useMemo(
    () => frozen4hSrEnabled
      ? computeFrozen4hBlocks(sessionSrSourceCandles, instrument)
      : [],
    [frozen4hSrEnabled, instrument, sessionSrSourceCandles],
  );
  const frozen4hActive = useMemo(
    () => frozen4hSrEnabled
      ? computeActiveFrozen4hSr(sessionSrSourceCandles, instrument)
      : null,
    [frozen4hSrEnabled, instrument, sessionSrSourceCandles],
  );
  const frozen4hReferenceLines = useMemo(
    () => frozen4hActive ? frozen4hActiveLines(frozen4hActive) : [],
    [frozen4hActive],
  );
  const frozen4hHistoryLines = useMemo(
    () => frozen4hSrEnabled ? frozen4hPatternLines(frozen4hBlocks) : [],
    [frozen4hBlocks, frozen4hSrEnabled],
  );
  const lastDaySrReferenceLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "last-day-sr")
      ? lastDaySrLines(series.candles)
      : [],
    [enabledIndicators, series.candles],
  );

  // Load a dedicated M15 window whenever session S/R or 4H Frozen S/R is on.
  useEffect(() => {
    if (!m15OverlayEnabled) {
      setSessionSrM15Candles([]);
      return;
    }

    const controller = new AbortController();

    async function loadSessionSrM15() {
      try {
        const response = await fetch(
          apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=500`),
          { credentials: "include", cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data: CandleSeries;
        };
        if (payload.data.instrument !== instrument) return;
        setSessionSrM15Candles(payload.data.candles);
      } catch (error) {
        if (controller.signal.aborted) return;
        // Keep any prior M15 snapshot on transient failures.
      }
    }

    void loadSessionSrM15();
    return () => controller.abort();
  }, [instrument, m15OverlayEnabled]);

  // Log freeze diagnostics once per centre+sessionStart so a refresh can be
  // compared against the original open without spamming every tick.
  useEffect(() => {
    if (!sessionSrSnapshots.length) return;
    const key = sessionSrSnapshots
      .map((levels) => `${levels.centre}:${levels.sessionStart}:${levels.debug.historicalCandleCount}`)
      .join("|");
    if (key === sessionSrDebugKeyRef.current) return;
    sessionSrDebugKeyRef.current = key;
    for (const levels of sessionSrSnapshots) {
      logSessionSrDebug(levels);
    }
  }, [sessionSrSnapshots]);

  useEffect(() => {
    if (!frozen4hActive) return;
    logFrozen4hDebug(frozen4hActive);
  }, [frozen4hActive?.blockStartMs, frozen4hActive?.resistance, frozen4hActive?.support, frozen4hActive?.sourceBarCount]);

  const breakoutReferenceLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "breakout")
      ? breakoutLines(series.candles)
      : [],
    [enabledIndicators, series.candles],
  );
  const patternOverlay = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "breakout-patterns")
      ? breakoutPatternOverlay(series.candles)
      : { lines: [], tags: [] },
    [enabledIndicators, series.candles],
  );
  const swingTrendPatternLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "swing-trend-lines")
      ? swingTrendLines(series.candles)
      : [],
    [enabledIndicators, series.candles],
  );
  const adaptiveSwingTrendOverlay = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "adaptive-swing-trendlines-v1") && timeframe === "15m"
      ? adaptiveSwingTrendlineOverlay(series.candles, instrument)
      : { lines: [], tags: [] },
    [enabledIndicators, instrument, series.candles, timeframe],
  );
  const chartPatternLines = useMemo(
    () => [...patternOverlay.lines, ...swingTrendPatternLines, ...adaptiveSwingTrendOverlay.lines, ...frozen4hHistoryLines],
    [adaptiveSwingTrendOverlay.lines, frozen4hHistoryLines, patternOverlay.lines, swingTrendPatternLines],
  );
  const chartReferenceLines = useMemo(
    () => [
      ...pendingEntryReferenceLines,
      ...supportResistanceReferenceLines,
      ...sessionSrReferenceLines,
      ...lastDaySrReferenceLines,
      ...frozen4hReferenceLines,
      ...(patternOverlay.lines.length ? [] : breakoutReferenceLines),
    ],
    [breakoutReferenceLines, frozen4hReferenceLines, lastDaySrReferenceLines, patternOverlay.lines, pendingEntryReferenceLines, sessionSrReferenceLines, supportResistanceReferenceLines],
  );
  // The chart refreshes paper trades in the background. Depending on the whole
  // trade object here made an otherwise identical refresh look like a new
  // focus request and snapped a user's panned/zoomed result view back again.
  const focusedTradeId = displayedTrade?.id ?? null;
  const focusedTradeOpenedAt = displayedTrade?.openedAt ?? null;
  const focusedTradeClosedAt = displayedTrade?.closedAt ?? null;
  const focusedPredictionId = focusedPrediction?.id ?? null;
  const focusedPredictionStartedAt = focusedPrediction?.startAt ?? null;
  const focusedPredictionResolvedAt = focusedPrediction?.resolvedAt ?? null;
  const focusedPredictionExpiration = focusedPrediction?.intendedExpiration ?? null;
  const focusRange = useMemo(() => {
    const interval =
      GRANULARITY_MS[TIMEFRAME_TO_GRANULARITY[timeframe]] ?? GRANULARITY_MS.M15;
    const padding = (FOCUS_PADDING_BARS * interval) / 1_000;

    if (focusedPredictionStartedAt) {
      const opened = Date.parse(focusedPredictionStartedAt) / 1_000;
      const closed = focusedPredictionResolvedAt
        ? Date.parse(focusedPredictionResolvedAt) / 1_000
        : focusedPredictionExpiration
          ? Date.parse(focusedPredictionExpiration) / 1_000
          : opened;

      if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null;

      return {
        from: Math.floor(opened - padding),
        to: Math.ceil(Math.max(opened, closed) + padding),
      };
    }

    if (!focusedTradeOpenedAt) return null;

    const opened = Date.parse(focusedTradeOpenedAt) / 1_000;
    const closed = focusedTradeClosedAt
      ? Date.parse(focusedTradeClosedAt) / 1_000
      : opened;

    if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null;

    return {
      from: Math.floor(opened - padding),
      to: Math.ceil(Math.max(opened, closed) + padding),
    };
  }, [focusedPredictionExpiration, focusedPredictionId, focusedPredictionResolvedAt, focusedPredictionStartedAt, focusedTradeClosedAt, focusedTradeId, focusedTradeOpenedAt, timeframe]);

  useEffect(() => {
    return () => {
      pendingTickRef.current = null;
      if (marketFrameRef.current !== null) {
        window.cancelAnimationFrame(marketFrameRef.current);
        marketFrameRef.current = null;
      }
    };
  }, [instrument, timeframe]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMarketData() {
      const loadStartedAt = Date.now();
      setLoading(true);
      setQuote(null);
      setLiveCandle(null);
      setDataNotice(null);

      try {
        const [candlesResponse, pricingResponse] = await Promise.all([
          fetch(
            apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=${candleCountForRange(timeframe, range)}`),
            { credentials: "include", signal: controller.signal },
          ),
          fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), {
            credentials: "include",
            signal: controller.signal,
          }),
        ]);

        if (!candlesResponse.ok || !pricingResponse.ok) {
          throw new Error("Market data endpoint returned an error.");
        }

        const candlesPayload = (await candlesResponse.json()) as {
          data: CandleSeries;
          status: ConnectionStatus;
        };
        const pricingPayload = (await pricingResponse.json()) as {
          data: PriceQuote[];
          status: ConnectionStatus;
        };

        replaceSeries(candlesPayload.data);
        setScrollToLatestRevision((revision) => revision + 1);
        setHistoryExhausted(false);
        setQuote(
          pricingPayload.data.find((price) => price.instrument === instrument) ??
            null,
        );

        if (candlesPayload.status.state !== "connected") {
          setDataNotice(candlesPayload.status.message);
        } else if (pricingPayload.status.state !== "connected") {
          setDataNotice(pricingPayload.status.message);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setDataNotice(
          "Could not refresh market data. The last loaded candles remain visible.",
        );
      } finally {
        if (!controller.signal.aborted) {
          await settleChartLoad(loadStartedAt);
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        }
      }
    }

    loadMarketData();

    return () => controller.abort();
  }, [instrument, timeframe, range, replaceSeries]);

  const loadOlderCandles = useCallback(async () => {
    const currentSeries = seriesRef.current;

    if (
      olderRequestInFlightRef.current ||
      loadingOlder ||
      historyExhausted ||
      currentSeries.instrument !== instrument ||
      !currentSeries.candles.length
    ) {
      return;
    }

    olderRequestInFlightRef.current = true;
    setLoadingOlder(true);
    const loadStartedAt = Date.now();

    try {
      const firstCandle = currentSeries.candles[0]!;
      const response = await fetch(
        apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=500&to=${encodeURIComponent(firstCandle.time)}`),
        { credentials: "include" },
      );

      if (!response.ok) return;

      const payload = (await response.json()) as {
        data: CandleSeries;
        status: ConnectionStatus;
      };

      const latestSeries = seriesRef.current;
      if (latestSeries.instrument !== payload.data.instrument) {
        return;
      }

      const merged = mergeCandles(latestSeries.candles, payload.data.candles);
      if (merged.length <= latestSeries.candles.length) {
        setHistoryExhausted(true);
        return;
      }

      replaceSeries({
        ...latestSeries,
        source: payload.data.source,
        candles: merged,
      });
    } catch {
      setDataNotice(
        "Could not load older candles. Keep the current range and retry.",
      );
    } finally {
      olderRequestInFlightRef.current = false;
      await settleChartLoad(loadStartedAt, 360);
      setLoadingOlder(false);
    }
  }, [
    historyExhausted,
    instrument,
    loadingOlder,
    replaceSeries,
    timeframe,
  ]);

  // A paper-cycle close happens on the server. Refresh independently of a
  // route or pair change so the old plan disappears shortly after it resolves.
  useEffect(() => {
    void refreshPaperTrades();
    const timer = window.setInterval(() => void refreshPaperTrades(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshPaperTrades]);

  const clearFocusTrade = useCallback(() => {
    setFocusTradeId(null);
    router.replace(`${workspacePath}?instrument=${encodeURIComponent(instrument)}`, {
      scroll: false,
    });
  }, [instrument, router, workspacePath]);

  const clearFocusPrediction = useCallback(() => {
    setPredictionFocus(null);
    router.replace(`${workspacePath}?instrument=${encodeURIComponent(instrument)}`, {
      scroll: false,
    });
  }, [instrument, router, workspacePath]);

  const selectTimeframe = useCallback((nextTimeframe: ChartTimeframe) => {
    if (nextTimeframe === timeframe) return;
    setLiveCandle(null);
    setScrollToLatestRevision((revision) => revision + 1);
    setTimeframe(nextTimeframe);
  }, [timeframe]);

  const selectRange = useCallback((nextRange: ChartRange) => {
    if (nextRange === range) return;
    setLiveCandle(null);
    setScrollToLatestRevision((revision) => revision + 1);
    setRange(nextRange);
  }, [range]);

  const priceStats = useMemo(() => {
    const lastClose = series.candles.at(-1)?.close ?? active?.entry ?? 0;
    const prevClose = series.candles.at(-2)?.close ?? lastClose;
    const change = lastClose - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;
    const displayPrice = quote?.mid ?? lastClose;

    return {
      displayPrice,
      change,
      changePercent,
      positive: change >= 0,
    };
  }, [active?.entry, quote, series.candles]);

  const predictionCurrentPrice = focusedPrediction
    ? quote?.mid ?? series.candles.at(-1)?.close ?? null
    : null;
  const predictionReferenceLine = focusedPrediction
    ? {
        price: focusedPrediction.entryPrice,
        label: "Prediction entry",
        // This marker must not change with every tick. A live winning/losing
        // color here recreated Lightweight Charts whenever price crossed entry.
        color: "#5856d6",
        textColor: "#ffffff",
      }
    : null;

  const spreadPips = useMemo(() => {
    if (!quote || quote.instrument !== instrument) return null;
    return Number(spreadInPips(instrument, quote.bid, quote.ask));
  }, [instrument, quote]);

  function selectSearchResult(result: SearchResult) {
    setLiveCandle(null);
    setFocusTradeId(null);
    // Clear the prior pair's pan/zoom immediately. The data loader also bumps
    // this once fresh candles arrive, covering both the transition and result.
    setScrollToLatestRevision((revision) => revision + 1);
    setSelectedInstrument(result.instrument);
    router.replace(`${workspacePath}?instrument=${encodeURIComponent(result.instrument)}`, { scroll: false });
    setSearchQuery("");
  }

  const sessionLabel = marketSessionCaption();
  const mobileTradeAction = manualTradeMode === "close"
    ? {
        label: tradeActionBusy ? "Closing…" : "Close Trade",
        className: " is-close",
        onClick: () => setTradeConfirm("close"),
        disabled: tradeActionBusy,
        title: "Close the active position",
      }
    : manualTradeMode === "cancel"
      ? {
          label: tradeActionBusy ? "Cancelling…" : "Cancel Trade",
          className: " is-cancel",
          onClick: () => setTradeConfirm("cancel"),
          disabled: tradeActionBusy,
          title: "Cancel the pending trade",
        }
      : {
          label: "Trade",
          className: "",
          onClick: () => openPendingEntryManager(null),
          disabled: hasActivePosition,
          title: hasActivePosition ? "Close the active position before creating another entry" : undefined,
        };

  return (
    <div
      className={`signals-view signals-minimal grid w-full gap-5${
        fullscreen ? " signals-view-fullscreen" : ""
      }`}
    >
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full">
        <div className="signals-chart-mobile lg:hidden">
          <div className="signals-mobile-content">
            <div className="signals-mobile-actions flex items-center justify-between">
              <SignalSearch
                compact
                pairLabel={activeSetup.pair}
                signals={signals}
                activeInstrument={instrument}
                tradingInstruments={tradingInstruments}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onSelect={selectSearchResult}
                className="gx-pair-search"
              />
              <div className="signals-mobile-header-actions flex items-center gap-2">
                {manualTradeMode === "analyze" ? (
                  <button
                    type="button"
                    className="signals-analyze-desktop pressable"
                    onClick={() => void analyzeInstrument(instrument)}
                    disabled={analyzingInstrument === instrument}
                    title="Run a test-only AI analysis of this chart"
                  >
                    <Sparkles className="size-3.5" />
                    {analyzingInstrument === instrument ? "Analyzing…" : "Analyze"}
                  </button>
                ) : null}
                <NotificationBell compact className="signals-icon-btn signals-fullscreen-reserve" />
              </div>
            </div>

            <div className="gx-mobile-quote-row">
              <span className="signals-mobile-price metric-number">
                {formatChartPrice(priceStats.displayPrice, instrument)}
              </span>
              {quote?.instrument === instrument && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) ? (
                <span className="gx-mobile-bid-ask" aria-label="Live bid and ask prices">
                  <span><small>Bid</small><b className="metric-number">{formatChartPrice(quote.bid, instrument)}</b></span>
                  <span><small>Ask</small><b className="metric-number">{formatChartPrice(quote.ask, instrument)}</b></span>
                </span>
              ) : null}
              <span className="gx-mobile-quote-meta">
                <span className={priceStats.positive ? "gx-chart-change is-positive" : "gx-chart-change is-negative"}>
                  {priceStats.positive ? "+" : ""}{priceStats.change.toFixed(precisionForInstrument(instrument))}
                  <span>{priceStats.positive ? "+" : ""}{priceStats.changePercent.toFixed(2)}%</span>
                </span>
                <span className="gx-mobile-session">{sessionLabel}</span>
              </span>
            </div>
            <div className="gx-mobile-timeframes">
              <SegmentControl
                ariaLabel="Chart timeframe"
                options={CHART_TIMEFRAMES}
                value={timeframe}
                onChange={selectTimeframe}
              />
            </div>
            {dataNotice ? (
              <p className="signals-notice mt-2">
                {series.source === "mock" ? "Demo data · " : ""}
                {dataNotice}
              </p>
            ) : null}
          </div>

          {focusTrade && focusTrade.closedAt !== null ? (
            <TradeFocusBar trade={focusTrade} onClear={clearFocusTrade} />
          ) : null}
          {focusedPrediction ? (
            <PredictionFocusBar
              prediction={focusedPrediction}
              currentPrice={predictionCurrentPrice}
              now={predictionClock}
              onClear={clearFocusPrediction}
            />
          ) : null}

          <div
            ref={mobileChartShellRef}
            className={`relative overflow-hidden chart-data-shell${loading ? " chart-data-shell-loading" : ""}`}
          >
            <div className="signals-fs-overlay" aria-hidden={!fullscreen}>
              <PairAvatar instrument={instrument} size={22} />
              <span className="signals-fs-pair">{activeSetup.pair}</span>
              <span
                className={`signals-fs-dot is-${engineStatus.kind}`}
                title={engineStatus.label}
              />
              <span className="signals-fs-price metric-number">
                {formatChartPrice(priceStats.displayPrice, instrument)}
              </span>
              <span
                className={`signals-fs-change ${priceStats.positive ? "is-up" : "is-down"}`}
              >
                {priceStats.positive ? "+" : "−"}
                {Math.abs(priceStats.changePercent).toFixed(2)}%
              </span>
            </div>
            <SetupChart
              series={series}
              levels={setupLevels}
              enabledIndicators={enabledIndicators}
              liveCandle={liveCandle}
              variant={chartVariant}
              range={range}
              height={mobileChartHeight}
              embedded
              scrollToLatestRevision={scrollToLatestRevision}
              preserveViewportRevision={preserveViewportRevision}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderCandles}
              trades={paperTrades}
              focusTradeId={activeFocusId}
              focusPrediction={focusedPrediction}
              focusRange={focusRange}
              referenceLine={predictionReferenceLine}
              referenceLines={chartReferenceLines}
              patternLines={chartPatternLines}
              patternTags={adaptiveSwingTrendOverlay.tags}
              positionTool={positionTool}
              onPositionToolChange={setPositionTool}
              onPositionToolSubmit={submitPositionTool}
            />
            <ChartLoadingOverlay visible={loading} />
          </div>

          <div className="gx-mobile-chart-toolbar">
            <IndicatorSheet enabled={enabledIndicators} onChange={setEnabledIndicators} />
            <button
              type="button"
              className={`gx-mobile-tool-button pressable${positionTool ? " is-active" : ""}`}
              onClick={() => {
                if (positionTool) {
                  setPositionTool(null);
                  return;
                }
                setPositionToolPrompt(true);
              }}
              disabled={hasActivePosition}
              aria-label="Draw a fixed 10-pip 1:1 risk/reward setup"
              title={hasActivePosition ? "Close the active position before creating another entry" : "Fixed 10-pip 1:1 setup"}
            >
              <Scaling className="size-3.5" strokeWidth={2} />
            </button>
            {fullscreen ? (
              <ChartOptionSheet
                title="Timeframe"
                options={CHART_TIMEFRAMES}
                value={timeframe}
                onChange={selectTimeframe}
              />
            ) : null}
            <ChartOptionSheet title="Range" options={CHART_RANGES} value={range} onChange={selectRange} />
            <ChartTypeSheet value={chartVariant} onChange={setChartVariant} />
            <button
              type="button"
              className={`gx-mobile-tool-button pressable${refreshingChart ? " is-refreshing" : ""}`}
              onClick={() => void refreshChart()}
              disabled={refreshingChart}
              aria-label="Refresh chart"
              title="Refresh chart"
            >
              <RotateCcw className="size-3.5" strokeWidth={2} />
            </button>
            <FullscreenToggle
              className="gx-mobile-tool-button"
              fullscreen={fullscreen}
              onToggle={() => setFullscreen((open) => !open)}
            />
          </div>

          <div className="gx-mobile-analyze-section">
            <button
              type="button"
              className={`gx-mobile-analyze pressable${mobileTradeAction.className}`}
              onClick={mobileTradeAction.onClick}
              disabled={mobileTradeAction.disabled}
              title={mobileTradeAction.title}
            >
              {mobileTradeAction.label}
            </button>
            {(tradeActionError || analysisError) ? (
              <p className="gx-mobile-analyze-error" role="alert">{tradeActionError ?? analysisError}</p>
            ) : null}
          </div>
        </div>

        <div className="hidden lg:grid signals-chart-desktop gx-chart-terminal">
          <div className="signals-chart-head">
            <div className="signals-chart-head-main">
              <SignalSearch
                compact
                pairLabel={activeSetup.pair}
                signals={signals}
                activeInstrument={instrument}
                tradingInstruments={tradingInstruments}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onSelect={selectSearchResult}
                className="gx-pair-search"
              />
              <div className="signals-chart-quote">
                <span className="signals-chart-price metric-number">
                  {formatChartPrice(priceStats.displayPrice, instrument)}
                </span>
                <span className={priceStats.positive ? "gx-chart-change is-positive" : "gx-chart-change is-negative"}>
                  {priceStats.positive ? "+" : ""}{priceStats.change.toFixed(precisionForInstrument(instrument))}
                  <span>{priceStats.positive ? "+" : ""}{priceStats.changePercent.toFixed(2)}%</span>
                </span>
              </div>
            </div>

            <SegmentControl
              variant="tabs"
              ariaLabel="Chart timeframe"
              options={CHART_TIMEFRAMES}
              labels={CHART_TIMEFRAME_LABELS}
              value={timeframe}
              onChange={selectTimeframe}
            />

            <div className="signals-chart-head-tools">
              {manualTradeMode === "close" ? (
                <button type="button" className="signals-analyze-desktop pressable is-close" onClick={() => setTradeConfirm("close")} disabled={tradeActionBusy}>
                  {tradeActionBusy ? "Closing…" : "Close Trade"}
                </button>
              ) : manualTradeMode === "cancel" ? (
                <button type="button" className="signals-analyze-desktop pressable is-cancel" onClick={() => setTradeConfirm("cancel")} disabled={tradeActionBusy}>
                  {tradeActionBusy ? "Cancelling…" : "Cancel Trade"}
                </button>
              ) : (
                <button
                  type="button"
                  className="signals-analyze-desktop pressable"
                  onClick={() => void analyzeInstrument(instrument)}
                  disabled={analyzingInstrument === instrument}
                  title="Run a test-only AI analysis of this chart"
                >
                  <Sparkles className="size-3.5" />
                  {analyzingInstrument === instrument ? "Analyzing…" : "Analyze"}
                </button>
              )}
              {(tradeActionError || analysisError) ? (
                <span className="signals-analyze-error" role="alert">{tradeActionError ?? analysisError}</span>
              ) : null}
              <IndicatorSelect
                toolbar
                enabled={enabledIndicators}
                onChange={setEnabledIndicators}
              />
              <button
                type="button"
                className={`gx-toolbar-btn pressable${positionTool ? " is-active" : ""}`}
                onClick={() => {
                  if (positionTool) {
                    setPositionTool(null);
                    return;
                  }
                  setPositionToolPrompt(true);
                }}
                disabled={hasActivePosition}
                title={hasActivePosition ? "Close the active position before creating another entry" : "Draw a fixed 10-pip 1:1 risk/reward setup"}
              >
                <Scaling className="size-3.5" />
                10p · 1:1
              </button>
              <ChartTypeSelect toolbar value={chartVariant} onChange={setChartVariant} />
              <RangeSelect value={range} onChange={selectRange} />
              <ResetViewButton
                className="gx-toolbar-icon-btn"
                onReset={() =>
                  setScrollToLatestRevision((revision) => revision + 1)
                }
              />
              <FullscreenToggle
                className="gx-toolbar-icon-btn"
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((open) => !open)}
              />
            </div>
          </div>

          <div className="gx-chart-stage">
            {dataNotice ? (
              <p className="signals-notice signals-chart-notice">
                {series.source === "mock" ? "Demo data · " : ""}
                {dataNotice}
              </p>
            ) : null}

            {focusTrade && focusTrade.closedAt !== null ? (
              <TradeFocusBar trade={focusTrade} onClear={clearFocusTrade} />
            ) : null}
            {focusedPrediction ? (
              <PredictionFocusBar
                prediction={focusedPrediction}
                currentPrice={predictionCurrentPrice}
                now={predictionClock}
                onClear={clearFocusPrediction}
              />
            ) : null}

            <div
              ref={desktopChartShellRef}
              className={`signals-chart-canvas chart-data-shell${loading ? " chart-data-shell-loading" : ""}`}
            >
              <SetupChart
                key={`desktop-chart:${instrument}:${timeframe}:${range}`}
                series={series}
                levels={overlayPreferences.levels ? setupLevels : null}
                enabledIndicators={enabledIndicators}
                liveCandle={liveCandle}
                variant={chartVariant}
                range={range}
                height={desktopChartHeight}
                spreadPips={spreadPips}
                scrollToLatestRevision={scrollToLatestRevision}
                preserveViewportRevision={preserveViewportRevision}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlderCandles}
                trades={paperTrades}
                showTradeMarkers={overlayPreferences.signalMarkers}
                showTradePath={overlayPreferences.positionMarkers}
                focusTradeId={activeFocusId}
                focusPrediction={focusedPrediction}
                focusRange={focusRange}
                referenceLine={predictionReferenceLine}
                referenceLines={chartReferenceLines}
                patternLines={chartPatternLines}
                patternTags={adaptiveSwingTrendOverlay.tags}
                positionTool={positionTool}
                onPositionToolChange={setPositionTool}
                onPositionToolSubmit={submitPositionTool}
              />
              <ChartLoadingOverlay visible={loading} />
            </div>
          </div>
          <ActivePositionStrip
            signal={positionSignal}
            currentPrice={quote?.mid ?? null}
            pairLabel={activeSetup.pair}
          />
          <ChartContextPanel
            instrument={instrument}
            bid={quote?.bid ?? null}
            ask={quote?.ask ?? null}
            selectedEntry={selectedPendingEntry}
            initialProposal={entryDraftProposal ?? initialManualProposal}
            creationBlocked={hasActivePosition}
            composerKey={`${instrument}:${selectedPendingEntry?.id ?? "new"}:${entryComposerRevision}`}
            onClearSelection={clearPendingEntrySelection}
            onChanged={(message) => {
              setPendingEntryNotice(message);
              void refreshPendingEntries();
            }}
          />
        </div>
        </section>
      </div>

      {pendingEntryDialogOpen ? <PendingEntryDialog
        key={selectedPendingEntry?.id ?? "new-pending-entry"}
        open={pendingEntryDialogOpen}
        instrument={instrument}
        bid={quote?.bid ?? null}
        ask={quote?.ask ?? null}
        selectedEntry={selectedPendingEntry}
        initialProposal={entryDraftProposal ?? initialManualProposal}
        creationBlocked={hasActivePosition}
        onClose={() => setPendingEntryDialogOpen(false)}
        onChanged={(message) => {
          setPendingEntryNotice(message);
          void refreshPendingEntries();
        }}
      /> : null}
      {pendingEntryNotice ? <div className="pending-entry-toast" role="status">{pendingEntryNotice}</div> : null}

      <ManualProposalModal
        proposal={manualProposal}
        currentPrice={manualProposal
          ? manualProposal.direction === "long" ? quote?.ask ?? null : quote?.bid ?? null
          : null}
        onDismiss={() => setManualProposal(null)}
        onAccept={acceptManualProposal}
      />

      {tradeConfirm ? createPortal(
        <div className="custom-expiration-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && setTradeConfirm(null)}>
          <section className="custom-expiration-dialog trade-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="trade-confirm-title">
            <header><div><span>{instrument.replace("_", "/")}</span><h3 id="trade-confirm-title">{tradeConfirm === "cancel" ? "Cancel pending trade?" : "Close active trade?"}</h3></div></header>
            <p>{tradeConfirm === "cancel"
              ? "This removes the resting order from OANDA so it will not fill. You can create a new one afterward."
              : "This closes the position on OANDA at the current market price and books the result. This cannot be undone."}</p>
            <footer>
              <button type="button" onClick={() => setTradeConfirm(null)}>Keep it</button>
              <button
                type="button"
                className={tradeConfirm === "close" ? "is-danger" : "is-warning"}
                onClick={() => { const action = tradeConfirm; setTradeConfirm(null); void (action === "cancel" ? cancelManualTrade() : closeManualTrade()); }}
              >
                {tradeConfirm === "cancel" ? "Cancel Trade" : "Close Trade"}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}

      {positionToolPrompt ? createPortal(
        <div
          className="custom-expiration-backdrop"
          data-pull-to-refresh-ignore="true"
          onMouseDown={(event) => event.target === event.currentTarget && setPositionToolPrompt(false)}
        >
          <section
            className="custom-expiration-dialog trade-confirm-dialog position-tool-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="position-tool-title"
          >
            <header>
              <div>
                <span>{instrument.replace("_", "/")}</span>
                <h3 id="position-tool-title">Fixed 10-pip setup</h3>
              </div>
            </header>
            <p>Choose a direction. Risk and reward are both fixed at 10 pips (1:1). You can move the complete setup, but its size cannot be changed.</p>
            <div className="position-tool-direction">
              <button type="button" className="is-long" onClick={() => startPositionTool("long")}>
                Long
              </button>
              <button type="button" className="is-short" onClick={() => startPositionTool("short")}>
                Short
              </button>
            </div>
            <footer>
              <button type="button" onClick={() => setPositionToolPrompt(false)}>Cancel</button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}

    </div>
  );
}
