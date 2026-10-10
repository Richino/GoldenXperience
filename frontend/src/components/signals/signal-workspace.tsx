"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "next-themes";
import {
  ArrowRight,
  CalendarRange,
  Check,
  ChevronDown,
  CircleStop,
  MoveVertical,
  Clock3,
  History,
  Maximize,
  Minimize,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { MarketDataNotice } from "@/components/signals/market-data-notice";
import { MarketObserverBubble } from "@/components/analysis/market-observer-bubble";
import { NEW_PAIR_TRADE, PairTradePicker } from "@/components/charts/pair-trade-picker";
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
import { ChartLoadingSkeleton } from "@/components/ui/chart-loading-skeleton";
import {
  SetupChart,
  chartLevelInvalid,
  createFixedTenPipSetup,
  type ChartLevelEdit,
  type ChartPatternLine,
  type ChartPositionTool,
  type ChartReferenceLine,
} from "@/components/charts/setup-chart";
import { PendingEntryDialog } from "@/components/charts/pending-entry-dialog";
import { ChartHealthCard, ChartLevelEditor, ChartNewsCard, ChartOhlcReadout, type ChartHealthLevels, type ChartPositionCardSignal } from "@/components/charts/chart-ledger-parts";
import {
  ManualProposalModal,
  useManualProposal,
} from "@/components/analysis/manual-proposal";
import { AnalyzeCard, AnalyzeSheet } from "@/components/analysis/analyze-card";
import { TradeConfirmDialog } from "@/components/signals/trade-confirm-dialog";
import type { ChartOverlayPreferences } from "@/components/charts/chart-context-panel";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { apiUrl } from "@/lib/api/url";
import { PairStrengthTag, usePairStrength } from "@/components/signals/pair-strength-tag";
import { TradabilityTag, useNyTradability } from "@/components/signals/tradability-tag";
import { formatClockTime, formatDayAndTime } from "@/lib/format/datetime";
import { NotificationBell } from "@/components/notifications/notification-bell";
import {
  CHART_INDICATORS,
  CHART_RANGES,
  CHART_TIMEFRAME_LABELS,
  CHART_TIMEFRAMES,
  CHART_VARIANTS,
  DEFAULT_CHART_INDICATORS,
  TIMEFRAME_TO_GRANULARITY,
  candleCountForChartViewport,
  calculateAtr,
  deriveDominantSwingTrend,
  deriveFibonacciRetracement,
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
import { marketAnalysisContext, type AnalysisMode, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import { ANALYZE_HANDOFF_KEY, runMarketAnalysis, type AnalyzeHandoff } from "@/lib/strategy/run-market-analysis";
import {
  INSTRUMENT_CATALOG,
  currenciesOf,
  isKnownInstrument,
  pipSizeFor,
  precisionFor,
} from "@/lib/instruments/catalog";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { getMarketCondition } from "@/lib/strategy/session";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import {
  computeSessionSrLevels,
  logSessionSrDebug,
  type SessionSrCentre,
  type SessionSrLevels,
} from "@/lib/strategy/session-sr";
import { computeLastDaySrLevels } from "@/lib/strategy/last-day-sr";
import { computeAmdDays } from "@/lib/strategy/amd";
import { computeAmdSessionBoxes } from "@/lib/strategy/amd-sessions";
import { amdRelatedPair, computeAmdRanges, type AmdRange } from "@/lib/strategy/amd-range";
import type { ChartBox } from "@/components/charts/chart-box-primitive";
import type { DisplacementCandle, FvgZone } from "@/lib/strategy/fvg";
import { MAX_SPREAD_PIPS } from "@/lib/strategy/strategy-common";
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

// A day only contains six 4H candles, which makes that chart look artificially
// zoomed even when its viewport is working correctly. One month, however,
// over-compresses the mobile H4 chart. These defaults keep the chart near a
// readable 24–42 candle window. They are visible range changes, not hidden data
// changes: the range control always reflects the amount of history shown.
const DEFAULT_RANGE_BY_TIMEFRAME: Record<ChartTimeframe, ChartRange> = {
  "1m": "1D",
  "5m": "1D",
  "15m": "1D",
  "1h": "1D",
  "4h": "1W",
};

const CHART_PREFERENCES_STORAGE_KEY =
  "goldenxperience:signals-chart-preferences:v1";
const LAST_CHART_INSTRUMENT_COOKIE = "gx-last-chart-instrument";

/* Keep the mobile picker scannable. The full OANDA catalog remains available
 * as soon as someone starts typing in search. */
/** Pair picker order: tradable trends first (a pullback is the setup Analyze trades), flat pairs last. */
const PICKER_GRADE_ORDER = { pullback: 0, strong: 1, turning: 2, weak: 3, range: 4 } as const;
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

/** " · +0.5R" for a filled manual trade's target, from its own entry and stop. */
function triggeredRewardR(entry: PendingManualEntry) {
  if (entry.triggerPrice === null || entry.stopPrice === null || entry.targetPrice === null) return "";
  // No R once the stop has been moved past entry: there is no risk left to measure against.
  const risk = entry.direction === "long" ? entry.triggerPrice - entry.stopPrice : entry.stopPrice - entry.triggerPrice;
  if (!(risk > 0)) return "";
  const reward = Math.abs(entry.targetPrice - entry.triggerPrice) / risk;
  return ` · +${reward.toFixed(reward >= 10 ? 0 : 1)}R`;
}

function pairMayHaveOpenManualTrade(
  instrument: MajorInstrument,
  trades: PaperChartTrade[],
  plans: SignalPaperPlan[],
) {
  const hasOpenPaper = trades.some(
    (trade) =>
      trade.instrument === instrument &&
      trade.status === "open" &&
      trade.closedAt === null,
  );
  const hasOpenPlan = plans.some(
    (plan) => plan.instrument === instrument && Boolean(plan.openTradeId),
  );
  return hasOpenPaper || hasOpenPlan;
}

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
  // Two lines closer than one average candle are the same level. A fixed 8 pips
  // swallowed most lines on 1m/5m, where the whole range can be under 8 pips.
  const atr = calculateAtr(candles.filter((candle) => candle.complete !== false), 14).at(-1) ?? null;
  const pip = pipSizeFor(instrument);
  const minimumGap = atr !== null && atr > 0 ? Math.min(8 * pip, Math.max(pip, atr)) : 8 * pip;
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

/** Visual-only automatic Fib of the latest confirmed directional impulse. */
function fibonacciRetracementLines(candles: Candle[]): ChartReferenceLine[] {
  const fib = deriveFibonacciRetracement(candles);
  if (!fib) return [];
  return fib.levels.map(({ ratio, price }) => {
    const boundary = ratio === 0 || ratio === 1;
    const midpoint = ratio === 0.5;
    return {
      key: `fib-${fib.direction}-${ratio}`,
      price,
      label: `Fib ${(ratio * 100).toFixed(ratio === 0 || ratio === 1 || midpoint ? 0 : 1)}%`,
      color: boundary ? "#f59e0b" : midpoint ? "#14b8a6" : "#a78bfa",
      textColor: "#ffffff",
      dashed: !boundary,
      lineWidth: boundary ? 2 as const : 1 as const,
    };
  });
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
        color: "#c8f560",
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

const AMD_COLORS = {
  accumulation: "#ff8a5b",
  manipulation: "#ffc14d",
  distribution: "#c8f560",
  fvg: "#a855f7",
};

/** Tag on the displacement candle: where a move away from the range showed. */
function displacementBox(key: string, candle: DisplacementCandle): ChartBox {
  return {
    key,
    startTime: candle.time,
    endTime: candle.endTime,
    top: candle.high,
    bottom: candle.low,
    color: AMD_COLORS.distribution,
    label: candle.direction === "long" ? "D ↑" : "D ↓",
    faded: true,
  };
}

function fvgBox(key: string, fvg: FvgZone): ChartBox {
  return {
    key,
    startTime: fvg.startTime,
    endTime: fvg.endTime,
    top: fvg.top,
    bottom: fvg.bottom,
    color: AMD_COLORS.fvg,
    label: "FVG",
  };
}

const AMD_HINT_LABEL = {
  "expect-highs-down": "A · highs ↓",
  "expect-lows-up": "A · lows ↑",
} as const;

/** "Any range" AMD: same three colours; the A label carries the related-pair hint. */
function amdRangeBoxes(ranges: AmdRange[], showFvg: boolean): ChartBox[] {
  const boxes: ChartBox[] = [];
  for (const range of ranges) {
    boxes.push({
      key: `${range.key}-a`,
      startTime: range.startTime,
      endTime: range.endTime,
      top: range.high,
      bottom: range.low,
      color: AMD_COLORS.accumulation,
      label: range.hint ? AMD_HINT_LABEL[range.hint] : "A",
    });
    if (showFvg && range.fvg) boxes.push(fvgBox(`${range.key}-fvg`, range.fvg));
    if (range.displacement) boxes.push(displacementBox(`${range.key}-disp`, range.displacement));
    const m = range.manipulation;
    if (m) {
      boxes.push({
        key: `${range.key}-m`,
        startTime: m.sweepTime,
        endTime: m.reclaimTime,
        top: m.high,
        bottom: m.low,
        color: AMD_COLORS.manipulation,
        label: "M",
      });
    }
    const d = range.distribution;
    if (!d || Date.parse(d.endTime) <= Date.parse(d.startTime)) continue;
    boxes.push({
      key: `${range.key}-d`,
      startTime: d.startTime,
      endTime: d.endTime,
      top: Math.max(d.from, d.best),
      bottom: Math.min(d.from, d.best),
      color: AMD_COLORS.distribution,
      label: "D",
    });
  }
  return boxes;
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
  // A two-day window can be structurally mixed even though it contains a
  // legitimate support or resistance trendline. The analyzer treats that as
  // no confirmation; the visual legacy overlay still selects the most relevant
  // confirmed line, rather than disappearing or drawing a steep local segment.
  const completed = candles.filter((candle) => candle.complete !== false);
  // Use trading bars rather than elapsed wall-clock time. Around the FX
  // weekend, "last 48 hours" only contains the first few candles of the new
  // session, which makes a confirmed-pivot overlay disappear despite a full
  // M15 history being available. 192 M15 bars is the intended two-session
  // structural read and remains stable over market closures.
  const scoped = completed.slice(-192);
  const reach = 3;
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let index = reach; index < scoped.length - reach; index += 1) {
    const candle = scoped[index]!;
    const window = scoped.slice(index - reach, index + reach + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) {
      highs.push({ index, time: candle.time, price: candle.high });
    }
    if (window.every((other) => other === candle || other.low >= candle.low)) {
      lows.push({ index, time: candle.time, price: candle.low });
    }
  }
  const fallbackCandidates: Array<{
    direction: "bullish" | "bearish";
    first: SwingPoint;
    second: SwingPoint;
    last: SwingPoint;
    distanceFromCurrent: number;
    span: number;
  }> = [];
  const last = scoped.at(-1);
  if (last) {
    const addCandidates = (points: SwingPoint[], direction: "bullish" | "bearish") => {
      for (let start = 0; start < points.length - 1; start += 1) {
        for (let end = start + 1; end < points.length; end += 1) {
          const first = points[start]!;
          const second = points[end]!;
          const span = second.index - first.index;
          // M15 source: four hours keeps this from selecting a steep intraday
          // micro-line when the requested legacy read is two days.
          if (span < 16) continue;
          const movesWithDirection = direction === "bullish"
            ? second.price > first.price
            : second.price < first.price;
          if (!movesWithDirection) continue;
          const slope = (second.price - first.price) / span;
          const projected = second.price + slope * (scoped.length - 1 - second.index);
          fallbackCandidates.push({
            direction,
            first,
            second,
            last: { index: scoped.length - 1, time: last.time, price: last.close },
            distanceFromCurrent: Math.abs(projected - last.close),
            span,
          });
        }
      }
    };
    addCandidates(lows, "bullish");
    addCandidates(highs, "bearish");
  }
  const fallback = fallbackCandidates.sort((left, right) =>
    left.distanceFromCurrent - right.distanceFromCurrent || right.span - left.span,
  )[0] ?? null;
  const visibleTrend = trend ?? fallback;
  if (!last) return [];
  if (!visibleTrend) {
    // A ranging market has no honest single directional trend. The old
    // behaviour returned nothing, which made an enabled Swing trend lines
    // control look broken. Keep the same confirmed (three candles each side)
    // pivots, then show the most recent sufficiently-separated support and
    // resistance swings as visual context only.
    const latestConfirmedLine = (
      points: SwingPoint[],
      key: string,
      color: string,
    ): ChartPatternLine | null => {
      const lastPoint = points.at(-1);
      if (!lastPoint) return null;
      const firstPoint = [...points]
        .reverse()
        .find((point) => point.index < lastPoint.index && lastPoint.index - point.index >= 8);
      if (!firstPoint) return null;
      const slope = (lastPoint.price - firstPoint.price) / (lastPoint.index - firstPoint.index);
      return {
        key,
        color,
        dashed: false,
        lineWidth: 2,
        points: [
          { time: firstPoint.time, price: firstPoint.price },
          {
            time: last.time,
            price: lastPoint.price + slope * (scoped.length - 1 - lastPoint.index),
          },
        ],
      };
    };

    return [
      latestConfirmedLine(lows, "swing-support", "#3b82f6"),
      latestConfirmedLine(highs, "swing-resistance", "#f0526b"),
    ].filter((line): line is ChartPatternLine => line !== null);
  }

  const slope = (visibleTrend.second.price - visibleTrend.first.price)
    / (visibleTrend.second.index - visibleTrend.first.index);
  return [{
    key: `swing-trend-${visibleTrend.direction}`,
    color: visibleTrend.direction === "bullish" ? "#3b82f6" : "#f0526b",
    dashed: false,
    lineWidth: 2,
    points: [
      { time: visibleTrend.first.time, price: visibleTrend.first.price },
      {
        time: visibleTrend.last.time,
        price: visibleTrend.second.price + slope * (visibleTrend.last.index - visibleTrend.second.index),
      },
    ],
  }];
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

/** Same wording as the app's chart header: "London session" / "Market closed". */
function marketSessionCaption() {
  const condition = getMarketCondition();
  return condition.marketOpen ? `${condition.label} session` : "Market closed";
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
  const pairStrength = usePairStrength(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const isDesktop = useDesktopChartViewport();
  const normalizedQuery = normalizeSearchValue(query);
  const index = useMemo(() => buildSearchIndex(signals), [signals]);
  const matches = useMemo(() => {
    if (!normalizedQuery) {
      const byInstrument = new Map(index.map((result) => [result.instrument, result]));
      // Tradable pairs on top, cleaner trends first within a grade; a pair
      // without a strength read yet keeps its usual place after them.
      const rank = (instrument: string) => {
        const strength = pairStrength.get(instrument);
        return strength ? PICKER_GRADE_ORDER[strength.trend.grade] : 9;
      };
      return DEFAULT_PAIR_PICKER_INSTRUMENTS.flatMap((instrument) => {
        const result = byInstrument.get(instrument);
        return result ? [result] : [];
      }).sort((left, right) => rank(left.instrument) - rank(right.instrument)
        || (pairStrength.get(right.instrument)?.trend.score ?? 0) - (pairStrength.get(left.instrument)?.trend.score ?? 0));
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
  }, [index, normalizedQuery, pairStrength]);
  const visibleMatches = compact ? matches : matches.slice(0, 5);
  // The chart's Select pair picker (the compact one) shows NY session
  // tradability in place of the strength read; one batched request covers
  // the listed pairs. The strength read still orders the default list.
  const tradability = useNyTradability(
    compact ? visibleMatches.map((result) => result.instrument) : [],
    open && compact,
  );
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
                  onPointerDown={(event) => {
                    if (useDesktopDropdown || !event.isPrimary || event.button !== 0) return;
                    const input = event.currentTarget.closest(".signals-pair-sheet")?.querySelector("input");
                    // Keep the keyboard and drawer in place until the click
                    // selects this result. Blurring on pointer-down can move
                    // the row out from under the finger before pointer-up.
                    if (input === document.activeElement) event.preventDefault();
                  }}
                  onClick={() => {
                    onSelect(result);
                    closePicker();
                  }}
                  role={useDesktopDropdown ? "option" : undefined}
                  aria-selected={useDesktopDropdown ? active : undefined}
                  className={`signals-search-result pressable flex w-full items-center gap-2.5 text-left ${
                    useDesktopDropdown ? "px-2.5 py-2" : "px-2 py-2"
                  } ${active ? "is-active" : ""}`}
                >
                  <PairAvatar instrument={result.instrument} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium tracking-[-0.02em]">
                      {result.displayName}
                    </span>
                    <TradabilityTag item={tradability.get(result.instrument)} />
                  </span>
                  {isTrading ? (
                    <span className="signals-search-trading-badge">Trading</span>
                  ) : null}
                  {active ? (
                    <span className="signals-search-current" aria-label="Current pair">
                      <Check className="size-4" strokeWidth={2.4} aria-hidden="true" />
                    </span>
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
            eyebrow="Chart"
            title="Select pair"
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
                      const strength = pairStrength.get(result.instrument);

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
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold tracking-[-0.02em]">
                              {result.displayName}
                            </span>
                            {strength ? (
                              <PairStrengthTag strength={strength} />
                            ) : null}
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

function formatRiskReward(value: number) {
  return `${value.toFixed(Number.isInteger(value) ? 0 : 1)}:1`;
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

/** "46m", "3h 12m", "2d 4h": how long a trade was held. */
function heldFor(fromIso: string, toIso: string) {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
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
  const label = /^\d+$/.test(String(trade.tradeSequence)) ? `#${trade.tradeSequence}` : String(trade.tradeSequence);
  const pips = closed
    ? ((long ? trade.exit! - trade.entry : trade.entry - trade.exit!) / pipSizeFor(trade.instrument))
    : null;

  return (
    <div
      className="trade-focus-bar nl-tfb"
      data-side={long ? "buy" : "sell"}
      aria-label={`Focused ${long ? "buy" : "sell"} trade ${trade.tradeSequence}`}
    >
      <div className="nl-tfb-id">
        <span className={`nl-tfb-side ${long ? "is-up" : "is-down"}`}>{long ? "Long" : "Short"}</span>
        <span className="nl-tfb-meta">
          {label} · {closed ? `held ${heldFor(trade.openedAt, trade.closedAt!)}` : "open"}
        </span>
      </div>

      <div className="nl-tfb-path">
        <div className="nl-tfb-leg">
          <span>Entry</span>
          <b className="metric-number">{formatChartPrice(trade.entry, trade.instrument)}</b>
          <small>{tradeMoment(trade.openedAt)}</small>
        </div>
        <ArrowRight className="nl-tfb-arrow" aria-hidden="true" />
        <div className="nl-tfb-leg">
          <span>Exit</span>
          {closed ? (
            <>
              <b className="metric-number">{formatChartPrice(trade.exit!, trade.instrument)}</b>
              <small>{tradeMoment(trade.closedAt!)}</small>
            </>
          ) : (
            <>
              <b className="is-open">Open</b>
              <small>Still running</small>
            </>
          )}
        </div>
      </div>

      <div className="nl-tfb-end">
        {trade.resultR !== null ? (
          <span className={`nl-tfb-result ${won ? "is-won" : "is-lost"}`}>
            <b className="metric-number">{formatResultR(trade.resultR)}</b>
            {pips !== null ? <small className="metric-number">{pips >= 0 ? "+" : "−"}{Math.abs(pips).toFixed(1)} pips</small> : null}
          </span>
        ) : null}
        <button type="button" onClick={onClear} className="nl-tfb-clear pressable" aria-label="Clear trade">
          <X aria-hidden="true" />
        </button>
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
  strategySetups: initialStrategySetups,
  initialInstrument,
  primarySeries,
  primarySeriesRange,
  initialTimeframe,
  initialRange,
  initialVariant,
  initialStatus,
  paperPlans,
  initialPaperTrades = [],
  initialFocusTradeId = null,
  initialPredictionFocus = null,
  initialManualProposal = null,
  initialPlanHandoff = false,
  embeddedSurfaceOnly = false,
}: {
  strategySetups: StrategySetup[];
  initialInstrument: MajorInstrument;
  primarySeries: CandleSeries;
  /**
   * The range `primarySeries` was fetched for. When it matches the opening
   * view, the first market-data load reuses it instead of downloading the same
   * candles again.
   */
  primarySeriesRange?: ChartRange;
  initialTimeframe?: ChartTimeframe;
  initialRange?: ChartRange;
  initialVariant?: ChartVariant;
  initialStatus: ConnectionStatus;
  paperPlans: SignalPaperPlan[];
  initialPaperTrades?: PaperChartTrade[];
  initialFocusTradeId?: string | null;
  initialPredictionFocus?: BinaryPrediction | null;
  /** Exact prospective setup selected from Home, kept stable across the route transition. */
  initialSetupFocus?: { entry: number; stop: number; target: number } | null;
  /** A user accepted a test-only AI proposal; this opens a reviewable draft, never an order. */
  initialManualProposal?: { direction: "long" | "short"; entry: number; stop: number; target: number; confidence: number | null; rationale: string; preferredEntryTime: string } | null;
  /** Open the entry form with a plan accepted on Markets (?plan=analyze; the plan is in sessionStorage). */
  initialPlanHandoff?: boolean;
  /** Renders the live chart canvas without the GX workspace shell for the native WebView. */
  embeddedSurfaceOnly?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Local visual-debug switch. It deliberately only works on localhost, so a
  // shared/deployed chart can never get stuck loading.
  const forceChartSkeleton = typeof window !== "undefined"
    && window.location.hostname === "localhost"
    && searchParams.get("debugChartSkeleton") === "1";
  // Only the native Chart tab drives this: it embeds this exact page in a
  // WebView, which starts from next-themes' own default/system resolution
  // and has no way to know the app's in-settings theme choice otherwise.
  const { setTheme } = useTheme();
  // Strategy evaluation reads candles for every pair, so it must never block
  // the first chart paint on either the workspace or native embed.
  const [loadedStrategySetups, setLoadedStrategySetups] = useState<StrategySetup[] | null>(null);
  const strategySetups = loadedStrategySetups ?? initialStrategySetups;
  useEffect(() => {
    if (initialStrategySetups.length) return;
    const controller = new AbortController();
    void fetch(apiUrl("/api/strategy"), { credentials: "include", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((snapshot: { strategy?: { setups?: StrategySetup[] } } | null) => {
        if (snapshot?.strategy?.setups) setLoadedStrategySetups(snapshot.strategy.setups);
      })
      .catch(() => {
        // Candidate levels are optional on the chart; it stays usable without them.
      });
    return () => controller.abort();
  }, [embeddedSurfaceOnly, initialStrategySetups]);
  const workspacePath = pathname.startsWith("/signals") ? "/signals" : "/chart";
  const signals = useMemo(
    () => strategySetups.flatMap(toDisplaySignal),
    [strategySetups],
  );
  const [selectedInstrument, setSelectedInstrument] = useState(
    initialInstrument,
  );
  const instrument = selectedInstrument;
  // The chart header's trend pill; the picker reads its own copy when opened.
  const headerStrength = usePairStrength(true, 60_000).get(instrument);
  useEffect(() => {
    // Keep the next server-rendered /chart visit on the pair the user actually
    // chose. A cookie avoids the EUR/USD flash that localStorage cannot prevent.
    document.cookie = `${LAST_CHART_INSTRUMENT_COOKIE}=${instrument}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [instrument]);
  const initialSignal = signals.find((signal) => signal.instrument === instrument);

  // Paper decisions are taken on completed M15 candles, so a trade opened from
  // the dashboard always lands on the timeframe it was actually decided on.
  const [timeframe, setTimeframe] = useState<ChartTimeframe>(
    initialTimeframe ?? (initialPredictionFocus ? "1m" as const : initialFocusTradeId ? "15m" as const : mapSignalTimeframe(initialSignal?.timeframe ?? "15m")),
  );
  const [range, setRange] = useState<ChartRange>(
    initialRange ?? (embeddedSurfaceOnly ? "1D" : initialPredictionFocus ? "1D" : "6M"),
  );
  // A timeframe switch may choose a legible default range until the person
  // deliberately selects one. We do not overwrite an explicit range choice.
  const hasExplicitRangeSelectionRef = useRef(false);
  const [chartVariant, setChartVariant] = useState<ChartVariant>(initialVariant ?? "candle");
  const [enabledIndicators, setEnabledIndicators] = useState<ChartIndicator[]>(
    DEFAULT_CHART_INDICATORS,
  );
  const [chartPreferencesReady, setChartPreferencesReady] = useState(false);
  // Wait for the real viewport before mounting a chart engine. CSS-hiding
  // the other layout still initialized a second live chart during hydration.
  const chartDesktopViewport = useSyncExternalStore(
    subscribeDesktopChartViewport,
    getDesktopChartViewport,
    () => null,
  );

  useEffect(() => {
    if (embeddedSurfaceOnly) {
      if (!initialVariant) setChartVariant("area");
      setChartPreferencesReady(true);
      return;
    }
    const saved = readStoredChartPreferences();
    if (saved) {
      setTimeframe(saved.timeframe);
      // The short-lived H4 -> 1M automatic default was persisted like a
      // deliberate preference. Migrate that exact generated combination to
      // the readable H4 default rather than reopening the stretched view.
      setRange(
        saved.timeframe === "4h" && saved.range === "1M"
          ? DEFAULT_RANGE_BY_TIMEFRAME["4h"]
          : saved.range,
      );
      setChartVariant(saved.chartVariant);
      setEnabledIndicators(saved.enabledIndicators);
    } else if (window.matchMedia("(max-width: 1023.98px)").matches) {
      // First visit only: mobile starts on the area chart. Once the user makes
      // a choice, the stored preference wins on every later visit.
      setChartVariant("area");
    }
    setChartPreferencesReady(true);
  }, [embeddedSurfaceOnly, initialVariant]);

  useEffect(() => {
    if (!chartPreferencesReady || embeddedSurfaceOnly) return;
    const preferences: StoredChartPreferences = {
      version: 1,
      timeframe,
      range,
      chartVariant,
      enabledIndicators,
    };
    // Server-render the same timeframe/history on the next visit instead of
    // painting M15 before localStorage preferences hydrate.
    document.cookie = `gx-chart-timeframe=${timeframe}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.cookie = `gx-chart-range=${range}; Path=/; Max-Age=31536000; SameSite=Lax`;
    try {
      window.localStorage.setItem(
        CHART_PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      // Storage can be unavailable in private/restricted browsing. The chart
      // remains usable for the current session even when persistence is denied.
    }
  }, [chartPreferencesReady, chartVariant, embeddedSurfaceOnly, enabledIndicators, range, timeframe]);
  const [series, setSeries] = useState(primarySeries);
  const seriesRef = useRef(primarySeries);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  // Dedicated completed-M15 history for session S/R freezes. Independent of the
  // chart timeframe so a 5m/1h view cannot change or invalidate the snapshot.
  const [sessionSrM15Candles, setSessionSrM15Candles] = useState<Candle[]>([]);
  // Fib needs enough completed bars to establish its structural impulse. The
  // visible range can be only one day, which is not enough on H1/4H.
  const [fibonacciHistory, setFibonacciHistory] = useState<CandleSeries | null>(null);
  const sessionSrDebugKeyRef = useRef("");
  const overlayPreferences: ChartOverlayPreferences = {
    levels: true,
    signalMarkers: true,
    positionMarkers: true,
  };
  const [dataNotice, setDataNotice] = useState<string | null>(
    initialStatus.state === "connected" ? null : initialStatus.message,
  );
  // Cover the plot from its first paint, before effects start data loading.
  const [loading, setLoading] = useState(true);
  const chartLoadingVisible = loading || forceChartSkeleton;
  const [refreshingChart, setRefreshingChart] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollToLatestRevision, setScrollToLatestRevision] = useState(0);
  const [preserveViewportRevision, setPreserveViewportRevision] = useState(0);
  // Replay is intentionally display-only. It cuts the chart off at a selected
  // completed candle; live prices, analysis, and trade-entry controls remain
  // unavailable until the user exits back to the live chart.
  const [replayEndTime, setReplayEndTime] = useState<string | null>(null);
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
  // Do not expose an entry action until the browser has checked the current
  // trade state. A server render can lack the browser session needed to fill
  // initialPaperTrades, which otherwise flashes Trade before Close Trade on a
  // chart opened from Journal.
  const [paperTradesHydrated, setPaperTradesHydrated] = useState(false);
  const [livePaperPlans, setLivePaperPlans] = useState<SignalPaperPlan[]>(paperPlans);
  const replayEndIndex = useMemo(() => {
    if (!replayEndTime) return -1;
    const cutoff = Date.parse(replayEndTime);
    if (!Number.isFinite(cutoff)) return -1;
    let index = -1;
    for (let cursor = 0; cursor < series.candles.length; cursor += 1) {
      const timestamp = Date.parse(series.candles[cursor]!.time);
      if (!Number.isFinite(timestamp) || timestamp > cutoff) break;
      index = cursor;
    }
    return index;
  }, [replayEndTime, series.candles]);
  const replayActive = replayEndTime !== null && replayEndIndex >= 0;
  const replaySeries = useMemo(
    () => replayActive
      ? { ...series, candles: series.candles.slice(0, replayEndIndex + 1) }
      : series,
    [replayActive, replayEndIndex, series],
  );
  // Every visual indicator must receive the same cutoff as the candles. Using
  // the live series here would reveal future pivots/levels during replay.
  const chartIndicatorCandles = replaySeries.candles;
  const beginReplay = useCallback(() => {
    const latest = series.candles.at(-1);
    if (!latest) return;
    // Replay starts at the current/latest completed candle. From there the
    // user walks backward one hour at a time, just like a normal chart replay.
    setPositionTool(null);
    setReplayEndTime(latest.time);
    setPreserveViewportRevision((revision) => revision + 1);
  }, [series.candles]);
  /** Move the replay cutoff by `minutes` (negative = back), at least one candle. */
  const stepReplay = useCallback((minutes: number) => {
    if (!replayEndTime || !series.candles.length) return;
    const current = Date.parse(replayEndTime);
    if (!Number.isFinite(current)) return;
    const target = current + minutes * 60 * 1_000;
    const next = minutes < 0
      ? [...series.candles].reverse().find((candle) => Date.parse(candle.time) <= target)
      : series.candles.find((candle) => Date.parse(candle.time) >= target);
    if (!next) return;
    setReplayEndTime(next.time);
    // Preserve candle spacing and the viewport position from the last replay
    // frame. The normal live-edge revision would refit/zoom every hour.
    setPreserveViewportRevision((revision) => revision + 1);
  }, [replayEndTime, series.candles]);
  const replayAtLatest = replayEndIndex >= series.candles.length - 1;
  const exitReplay = useCallback(() => {
    setReplayEndTime(null);
    setScrollToLatestRevision((revision) => revision + 1);
  }, []);
  useEffect(() => {
    // A new pair, timeframe, or selected range creates a different history
    // series. Do not carry a stale replay cutoff into that series.
    setReplayEndTime(null);
  }, [instrument, range, timeframe]);
  const [binaryWatch, setBinaryWatch] = useState<BinaryWatchRow[]>([]);
  const [focusTradeId, setFocusTradeId] = useState<string | null>(initialFocusTradeId);
  const [predictionFocus, setPredictionFocus] = useState<BinaryPrediction | null>(initialPredictionFocus);
  const [predictionClock, setPredictionClock] = useState(() => Date.now());
  const [pendingEntries, setPendingEntries] = useState<PendingManualEntry[]>([]);
  const [allPendingEntries, setAllPendingEntries] = useState<PendingManualEntry[]>([]);
  const [pendingEntriesHydrated, setPendingEntriesHydrated] = useState(false);
  // The address names the pair. The iOS home-screen app can hand back a chart
  // that kept the pair it was first rendered with, so a link to another pair
  // must still switch to it.
  const urlInstrument = searchParams.get("instrument")?.toUpperCase() ?? null;
  const [followedUrlInstrument, setFollowedUrlInstrument] = useState(urlInstrument);
  if (urlInstrument !== followedUrlInstrument) {
    setFollowedUrlInstrument(urlInstrument);
    if (urlInstrument && isKnownInstrument(urlInstrument) && urlInstrument !== instrument) {
      const urlTrade = searchParams.get("trade");
      setLiveCandle(null);
      setFocusTradeId(urlTrade && /^[0-9a-f-]{36}$/i.test(urlTrade) ? urlTrade : null);
      setPaperTradesHydrated(false);
      setPendingEntriesHydrated(false);
      setScrollToLatestRevision((revision) => revision + 1);
      setSelectedInstrument(urlInstrument);
    }
  }
  // Which of the pair's trades the chart shows: a trade id, NEW_TRADE while
  // setting up another one, or null to follow the default (newest).
  const [pickedPairTrade, setPickedPairTrade] = useState<string | null>(null);
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
    /** Set when the plan holds the order until after high-impact news. */
    activateAt?: string | null;
    /** Saved with the order so forward-test trades can be scored by setup. */
    analysisContext?: Record<string, unknown>;
  } | null>(null);
  const openedManualProposalRef = useRef(false);

  function openPendingEntryManager(entry: PendingManualEntry | null = null) {
    if (!entry && replayActive) {
      setPendingEntryNotice("Exit chart replay before creating an entry.");
      return;
    }
    if (!entry && hasActivePosition) {
      setPendingEntryNotice("This pair already has an active position. Close it before creating another entry.");
      return;
    }
    setSelectedPendingEntry(entry);
    // The composer opens as a dialog on every size; the desktop side column
    // keeps the Analyze, Trade health and Watchlist cards.
    setPendingEntryDialogOpen(true);
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
    acceptProposal: acceptManualProposal,
  } = useManualProposal();
  /** Normal-mode market analysis (M15 structure; H1/H4 context). */
  const [trendPullbackResult, setTrendPullbackResult] = useState<MarketAnalysis | null>(null);
  /** Swing-mode analysis (H4 structure; D1 context; H1 entry refinement); null when it could not be built. */
  const [trendPullbackSwing, setTrendPullbackSwing] = useState<MarketAnalysis | null>(null);
  const [trendPullbackDialogOpen, setTrendPullbackDialogOpen] = useState(false);
  const [trendPullbackBusy, setTrendPullbackBusy] = useState(false);
  const [trendPullbackError, setTrendPullbackError] = useState<string | null>(null);
  const trendPullbackRequestRef = useRef(0);
  const trendPullbackAbortRef = useRef<AbortController | null>(null);
  const postTrendPullbackToNative = useCallback((message: Record<string, unknown>) => {
    if (!embeddedSurfaceOnly) return;
    (window as Window & { ReactNativeWebView?: { postMessage: (data: string) => void } }).ReactNativeWebView
      ?.postMessage(JSON.stringify(message));
  }, [embeddedSurfaceOnly]);
  useEffect(() => {
    trendPullbackRequestRef.current += 1;
    trendPullbackAbortRef.current?.abort();
    trendPullbackAbortRef.current = null;
    setTrendPullbackResult(null);
    setTrendPullbackSwing(null);
    setTrendPullbackDialogOpen(false);
    setTrendPullbackError(null);
    setTrendPullbackBusy(false);
  }, [instrument]);

  const runTrendPullback = useCallback(async () => {
    if (replayActive) {
      setTrendPullbackError("Exit chart replay before running live analysis.");
      return;
    }
    trendPullbackAbortRef.current?.abort();
    const controller = new AbortController();
    trendPullbackAbortRef.current = controller;
    const request = ++trendPullbackRequestRef.current;
    setTrendPullbackError(null);
    setTrendPullbackBusy(true);
    setTrendPullbackResult(null);
    setTrendPullbackSwing(null);
    setTrendPullbackDialogOpen(!embeddedSurfaceOnly);
    try {
      // Open trades and resting orders on every pair, for the same-currency warning.
      const exposure = allPendingEntries
        .filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING" || (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open"))
        .map((entry) => ({ instrument: entry.instrument, direction: entry.direction }));
      const { normal: result, swing } = await runMarketAnalysis({ instrument, signal: controller.signal, exposure });
      if (request !== trendPullbackRequestRef.current) return;
      setTrendPullbackResult(result);
      setTrendPullbackSwing(swing);
      setTrendPullbackDialogOpen(!embeddedSurfaceOnly);
      // The analysis reads its own M15 candles; the chart stays on whatever
      // timeframe the trader is looking at.
      postTrendPullbackToNative({ type: "gx-native-trend-pullback-result", result, swing });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (request === trendPullbackRequestRef.current) {
        const message = error instanceof Error ? error.message : "TrendPullbackV1 could not run.";
        setTrendPullbackError(message);
        postTrendPullbackToNative({ type: "gx-native-trend-pullback-error", error: message });
      }
    } finally {
      if (request === trendPullbackRequestRef.current) setTrendPullbackBusy(false);
      if (trendPullbackAbortRef.current === controller) trendPullbackAbortRef.current = null;
    }
  }, [allPendingEntries, embeddedSurfaceOnly, instrument, postTrendPullbackToNative, replayActive]);

  const planHandoffRef = useRef(false);
  useEffect(() => {
    if (!initialPlanHandoff || planHandoffRef.current) return;
    // Deferred so the entry-form state updates land outside the effect body.
    const timer = window.setTimeout(() => {
      planHandoffRef.current = true;
      // Drop ?plan so a refresh or Back does not reopen the form.
      const url = new URL(window.location.href);
      url.searchParams.delete("plan");
      window.history.replaceState(window.history.state, "", url);
      let handoff: AnalyzeHandoff | null = null;
      try {
        handoff = JSON.parse(window.sessionStorage.getItem(ANALYZE_HANDOFF_KEY) ?? "null") as AnalyzeHandoff | null;
        window.sessionStorage.removeItem(ANALYZE_HANDOFF_KEY);
      } catch {
        handoff = null;
      }
      if (!handoff || handoff.instrument !== instrument) return;
      setEntryDraftProposal(handoff.proposal);
      openPendingEntryManager(null);
      setEntryComposerRevision((revision) => revision + 1);
    }, 0);
    return () => window.clearTimeout(timer);
    // Runs once on arrival; the handlers it calls are stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlanHandoff]);
  const cancelTrendPullback = useCallback(() => {
    trendPullbackRequestRef.current += 1;
    trendPullbackAbortRef.current?.abort();
    trendPullbackAbortRef.current = null;
    setTrendPullbackBusy(false);
    setTrendPullbackDialogOpen(false);
  }, []);
  const reviewTrendPullback = (mode: AnalysisMode = "NORMAL") => {
    // Accept means review the planned entry in the drawer, never create an
    // order. A reference-only analysis still has a useful planned level, and
    // the drawer obtains/validates the executable quote when the user later
    // chooses to create the pending entry.
    // Only a LONG/SHORT decision carries a trade; NO TRADE has nothing to accept.
    const plan = mode === "SWING" ? trendPullbackSwing : trendPullbackResult;
    if (!plan?.trade || plan.decision === "NO TRADE") return;
    setEntryDraftProposal({
      direction: plan.decision === "LONG" ? "long" : "short",
      entry: plan.trade.entry,
      stop: plan.trade.stopLoss,
      target: plan.trade.takeProfit,
      confidence: null,
      rationale: plan.reason,
      preferredEntryTime: new Date().toISOString(),
      activateAt: plan.activateAfter,
      analysisContext: marketAnalysisContext(plan),
    });
    setTrendPullbackDialogOpen(false);
    openPendingEntryManager(null);
    setEntryComposerRevision((revision) => revision + 1);
  };

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
        // The focused trade is always included, even when it is older than the recent window.
        apiUrl(`/api/paper-cycle/trades?instrument=${instrument}${focusTradeId ? `&trade=${focusTradeId}` : ""}`),
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { trades: PaperChartTrade[] };
      setPaperTrades(payload.trades);
    } catch {
      // Markers are supplementary — the chart stays usable without them.
    } finally {
      // A direct chart link must wait for this first client-side read before
      // choosing between Trade and Close Trade.
      setPaperTradesHydrated(true);
    }
  }, [focusTradeId, instrument]);

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
    } finally {
      setPendingEntriesHydrated(true);
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
    // The primary action is derived from both the paper-trade and pending-entry
    // sources. Reset both gates before reading a different pair so its previous
    // Trade action cannot flash before a manual position resolves to Close.
    setPaperTradesHydrated(false);
    setPendingEntriesHydrated(false);
  }, [instrument]);

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

    // Reattach after preferences hydrate or the active layout changes; only
    // that layout's shell is mounted. Ignore transient empty measurements.
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
  }, [chartDesktopViewport, chartPreferencesReady, embeddedSurfaceOnly]);

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
          apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=${candleCountForChartViewport(timeframe, range)}`),
          { credentials: "include", cache: "no-store" },
        ),
        fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), {
          credentials: "include",
          cache: "no-store",
        }),
      ]);

      if (!candlesResponse.ok || !pricingResponse.ok) return false;

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
      ) return false;

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
      return true;
    } catch {
      // Keep the last loaded chart while the next resume refresh retries.
      return false;
    }
  }, [instrument, range, replaceSeries, timeframe]);

  const refreshChart = useCallback(async () => {
    setRefreshingChart(true);
    try {
      setLiveCandle(null);
      await refreshMarketQuietly();
      setScrollToLatestRevision((revision) => revision + 1);
    } finally {
      setRefreshingChart(false);
    }
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

  // Only this pair's own setup. Falling back to the first setup put another
  // pair's name (and levels) on charts without one, e.g. EUR/GBP on EUR/CAD.
  const activeSetup = strategySetups.find((setup) => setup.instrument === instrument) ?? null;
  const activeCandidate = activeSetup ? toDisplaySignal(activeSetup)[0] ?? null : null;
  const activePair = instrument.replace("_", "/");
  const selectedPlan = livePaperPlans.find((plan) => plan.instrument === instrument) ?? null;
  const paperPlan = selectedPlan?.openTradeId ? selectedPlan : null;
  // Memoised because this feeds the chart's `levels` prop through `active`.
  // A fresh object here on every render reached SetupChart as a changed
  // dependency and tore the chart down mid-gesture on each live tick.
  const openSignal: TradeSignal | null = useMemo(
    () => paperPlan?.direction && paperPlan.entry !== null && paperPlan.stop !== null && paperPlan.target !== null ? {
      instrument,
      pair: activePair,
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
    [paperPlan, instrument, activePair],
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
  // Every live trade on this pair, oldest first: resting or scheduled orders,
  // claims in flight, and filled entries whose trade is still open. Several can
  // run at once (one direction only; the account cannot hedge).
  const pairTrades = useMemo(
    () => pendingEntries
      .filter((entry) =>
        entry.status === "PENDING" ||
        entry.status === "TRIGGERING" ||
        (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [pendingEntries],
  );
  // A new trade appearing (or one finishing, or a pair change) drops the pick
  // back to the default, so a just-placed trade is the one shown.
  const pairTradesKey = `${instrument}:${pairTrades.length}`;
  const [pickedForKey, setPickedForKey] = useState(pairTradesKey);
  if (pickedForKey !== pairTradesKey) {
    setPickedForKey(pairTradesKey);
    setPickedPairTrade(null);
  }
  const selectedPairTrade = useMemo(() => {
    if (pickedPairTrade === NEW_PAIR_TRADE) return null;
    return pairTrades.find((entry) => entry.id === pickedPairTrade)
      // A journal link to one of this pair's trades opens on that trade.
      ?? pairTrades.find((entry) => focusTradeId !== null && entry.paperTradeId === focusTradeId)
      ?? pairTrades.at(-1)
      ?? null;
  }, [focusTradeId, pairTrades, pickedPairTrade]);
  const settingUpNewTrade = pickedPairTrade === NEW_PAIR_TRADE;
  const openPaperTrade = useMemo(() => {
    const open = paperTrades.filter(
      (trade) => trade.instrument === instrument && trade.status === "open" && trade.closedAt === null,
    );
    if (selectedPairTrade?.status === "TRIGGERED") {
      return open.find((trade) => trade.id === selectedPairTrade.paperTradeId) ?? null;
    }
    // A pending order or a new trade being set up owns the chart; otherwise
    // show the pair's open strategy or imported trade.
    if (selectedPairTrade || settingUpNewTrade) return null;
    return open[0] ?? null;
  }, [instrument, paperTrades, selectedPairTrade, settingUpNewTrade]);
  // A closed trade may remain selected so its historical entry/exit markers
  // and focused time range stay available. It is not an active plan though:
  // showing its Entry / SL / TP as live chart levels made completed positions
  // look as if they were still open.
  // An explicitly requested trade (a journal or recent-activity link) wins over
  // the pair's open trade, so tapping a past result never shows another trade.
  const displayedTrade = focusTrade ?? openPaperTrade;
  // The selected trade drives the Cancel / Close button and the chart levels.
  // A resting or scheduled order is cancellable; a filled (active) trade is
  // closeable; with none selected the pair is free to analyze.
  const pendingManualEntry =
    selectedPairTrade && (selectedPairTrade.status === "PENDING" || selectedPairTrade.status === "TRIGGERING")
      ? selectedPairTrade
      : null;
  const activeManualTrade = selectedPairTrade?.status === "TRIGGERED" ? selectedPairTrade : null;
  const triggeredManualEntry =
    activeManualTrade && activeManualTrade.stopPrice !== null && activeManualTrade.targetPrice !== null
      ? activeManualTrade
      : null;
  const manualTradeMode: "analyze" | "cancel" | "close" =
    activeManualTrade || openPaperTrade
      ? "close"
      : pendingManualEntry
        ? "cancel"
        : "analyze";
  const hasActivePosition = Boolean(openPaperTrade || activeManualTrade);
  /** Avoid flashing "Trade" while paper/pending reads disagree on open exposure. */
  const mobileTradeActionReady =
    pendingEntriesHydrated &&
    paperTradesHydrated &&
    !(
      pairMayHaveOpenManualTrade(instrument, paperTrades, livePaperPlans) &&
      manualTradeMode === "analyze" &&
      !settingUpNewTrade
    );

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
  // An open manual trade is not in the chart-trade list (the API returns
  // manual trades only once closed), so the chart gets one built from the
  // filled entry, just for its BUY / SELL arrow at the entry candle. It has no
  // exit, so no trade path is drawn, and Close Trade still reads the entry.
  const manualChartTrade = useMemo<PaperChartTrade | null>(() => {
    if (displayedTrade || !activeManualTrade) return null;
    const entry = activeManualTrade.triggerPrice ?? activeManualTrade.entryPrice;
    return {
      id: `manual-entry:${activeManualTrade.id}`,
      tradeSequence: "Manual",
      instrument,
      direction: activeManualTrade.direction,
      status: "open",
      outcome: "",
      entry,
      stop: activeManualTrade.stopPrice ?? entry,
      target: activeManualTrade.targetPrice ?? entry,
      exit: null,
      resultR: null,
      openedAt: activeManualTrade.triggeredAt ?? activeManualTrade.createdAt,
      closedAt: null,
      exitReason: null,
      batchNumber: null,
    };
  }, [activeManualTrade, displayedTrade, instrument]);
  const chartTrades = useMemo(
    () => (manualChartTrade ? [...paperTrades, manualChartTrade] : paperTrades),
    [manualChartTrade, paperTrades],
  );
  const chartFocusId = activeFocusId ?? manualChartTrade?.id ?? null;
  // A direct chart visit can arrive before the watchlist collector has
  // refreshed its `openTradeId`. Prefer the chart's own open-trade read so
  // Active Position never says "no open position" while that trade is live.
  const positionSignal = useMemo<TradeSignal | null>(() => {
    if (openPaperTrade) {
      const risk = Math.abs(openPaperTrade.entry - openPaperTrade.stop);
      return {
        instrument,
        pair: activePair,
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
        pair: activePair,
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
  }, [activePair, instrument, openPaperTrade, openSignal, triggeredManualEntry]);

  // Trade health also reads a filled manual trade placed without a stop or
  // target, which Active Position leaves out.
  const healthSignal = useMemo<ChartPositionCardSignal | null>(() => {
    if (positionSignal) return positionSignal;
    if (!activeManualTrade) return null;
    return {
      instrument,
      pair: activePair,
      direction: activeManualTrade.direction,
      entry: activeManualTrade.triggerPrice ?? activeManualTrade.entryPrice,
      stop: activeManualTrade.stopPrice,
      target: activeManualTrade.targetPrice,
      riskReward: 0,
      openedAt: activeManualTrade.triggeredAt ?? activeManualTrade.createdAt,
    };
  }, [activeManualTrade, activePair, instrument, positionSignal]);

  // Moving the stop / target of a manual trade: the card starts a draft, the
  // chart draws it as two draggable lines, and Save sends it to the trade
  // (OANDA's own SL/TP for a broker-backed trade).
  const [levelDraft, setLevelDraft] = useState<{ entryId: string; stop: number | null; target: number | null } | null>(null);
  const [levelSaving, setLevelSaving] = useState(false);
  const [levelError, setLevelError] = useState<string | null>(null);
  const levelTrade = !replayActive && !openPaperTrade ? activeManualTrade : null;
  const levelDraftEntryId = levelDraft && levelTrade && levelDraft.entryId === levelTrade.id ? levelDraft.entryId : null;
  const levelExitPrice = quote && levelTrade ? (levelTrade.direction === "long" ? quote.bid : quote.ask) : null;
  const levelEdit = useMemo<ChartLevelEdit | null>(() => {
    if (!levelTrade || !levelDraft || levelDraft.entryId !== levelTrade.id) return null;
    return {
      instrument,
      direction: levelTrade.direction,
      entry: levelTrade.triggerPrice ?? levelTrade.entryPrice,
      stop: levelDraft.stop,
      target: levelDraft.target,
      exitPrice: levelExitPrice,
    };
  }, [instrument, levelDraft, levelExitPrice, levelTrade]);
  const onLevelEditChange = useCallback((next: ChartLevelEdit) => {
    setLevelError(null);
    setLevelDraft((draft) => (draft ? { ...draft, stop: next.stop, target: next.target } : draft));
  }, []);
  /** A fresh line 15 pips (stop) or 30 pips (target) from where the trade would close. */
  const seedLevel = useCallback((key: "stop" | "target") => {
    if (!levelTrade) return null;
    const from = levelExitPrice ?? levelTrade.triggerPrice ?? levelTrade.entryPrice;
    const pips = key === "stop" ? -15 : 30;
    const sign = levelTrade.direction === "long" ? 1 : -1;
    return Number((from + sign * pips * pipSizeFor(instrument)).toFixed(precisionFor(instrument)));
  }, [instrument, levelExitPrice, levelTrade]);
  const saveLevels = useCallback(async () => {
    if (!levelTrade || !levelEdit) return;
    setLevelSaving(true);
    setLevelError(null);
    try {
      const res = await fetch(apiUrl(`/api/pending-entries/${levelTrade.id}/levels`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          ...(levelEdit.stop !== levelTrade.stopPrice ? { stopPrice: levelEdit.stop } : {}),
          ...(levelEdit.target !== levelTrade.targetPrice ? { targetPrice: levelEdit.target } : {}),
        }),
      });
      const payload = await res.json() as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not save the stop and target.");
      await refreshPendingEntries();
      setLevelDraft(null);
    } catch (error) {
      setLevelError(error instanceof Error ? error.message : "Could not save the stop and target.");
    } finally {
      setLevelSaving(false);
    }
  }, [instrument, levelEdit, levelTrade, refreshPendingEntries]);
  const healthLevels = useMemo<ChartHealthLevels | null>(() => {
    if (!levelTrade) return null;
    return {
      editing: levelEdit !== null,
      stop: levelEdit?.stop ?? null,
      target: levelEdit?.target ?? null,
      invalid: {
        stop: levelEdit ? chartLevelInvalid(levelEdit, "stop") : false,
        target: levelEdit ? chartLevelInvalid(levelEdit, "target") : false,
      },
      dirty: levelEdit !== null && (levelEdit.stop !== levelTrade.stopPrice || levelEdit.target !== levelTrade.targetPrice),
      saving: levelSaving,
      error: levelError,
      onStart: () => {
        setLevelError(null);
        const none = levelTrade.stopPrice === null && levelTrade.targetPrice === null;
        setLevelDraft({
          entryId: levelTrade.id,
          stop: none ? seedLevel("stop") : levelTrade.stopPrice,
          target: none ? seedLevel("target") : levelTrade.targetPrice,
        });
      },
      onCancel: () => {
        setLevelError(null);
        setLevelDraft(null);
      },
      onSave: () => void saveLevels(),
      onToggle: (key) => {
        setLevelError(null);
        setLevelDraft((draft) => (draft ? { ...draft, [key]: draft[key] === null ? seedLevel(key) : null } : draft));
      },
    };
  }, [levelEdit, levelError, levelSaving, levelTrade, saveLevels, seedLevel]);

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
    return pendingEntries.filter((entry) => entry.id === selectedPairTrade?.id).flatMap((entry) => {
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
      // Each level is drawn on its own (a trade can hold a stop without a
      // target), and while they are being dragged the editor draws them.
      if (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open" && entry.triggerPrice !== null) {
        const editing = levelDraftEntryId === entry.id;
        const lines: ChartReferenceLine[] = [
          { key: `manual-entry-${entry.id}`, price: entry.triggerPrice, label: `ENTRY ${formatChartPrice(entry.triggerPrice, instrument)}`, color: "#00a06a", textColor: "#ffffff", dashed: false, lineWidth: 2 as const, onSelect: () => openManager(entry) },
        ];
        const stopAtRisk = entry.stopPrice !== null && (entry.direction === "long" ? entry.stopPrice < entry.triggerPrice : entry.stopPrice > entry.triggerPrice);
        if (entry.stopPrice !== null && !editing) lines.push({ key: `manual-stop-${entry.id}`, price: entry.stopPrice, label: `SL ${formatChartPrice(entry.stopPrice, instrument)}${stopAtRisk ? " · -1R" : ""}`, color: "#e74c3c", textColor: "#ffffff", dashed: true, lineWidth: 1 as const, onSelect: () => openManager(entry) });
        if (entry.targetPrice !== null && !editing) lines.push({ key: `manual-target-${entry.id}`, price: entry.targetPrice, label: `TP ${formatChartPrice(entry.targetPrice, instrument)}${triggeredRewardR(entry)}`, color: "#00b377", textColor: "#ffffff", dashed: true, lineWidth: 1 as const, onSelect: () => openManager(entry) });
        return lines;
      }
      return [];
    });
  }, [instrument, levelDraftEntryId, pendingEntries, pendingEntryClock, selectedPairTrade?.id]);
  const supportResistanceReferenceLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "support-resistance")
      ? supportResistanceLines(chartIndicatorCandles, instrument)
      : [],
    [chartIndicatorCandles, enabledIndicators, instrument],
  );
  const fibonacciEnabled = isChartIndicatorEnabled(enabledIndicators, "fibonacci-retracement");
  const fibonacciGranularity = TIMEFRAME_TO_GRANULARITY[timeframe];
  const fibonacciSourceCandles = useMemo(() => {
    const source = fibonacciHistory?.instrument === instrument
      && fibonacciHistory.granularity === fibonacciGranularity
      && fibonacciHistory.candles.length >= 48
      ? fibonacciHistory.candles
      : chartIndicatorCandles;
    if (!replayActive || !replayEndTime) return source;
    const cutoff = Date.parse(replayEndTime);
    return Number.isFinite(cutoff)
      ? source.filter((candle) => Date.parse(candle.time) <= cutoff)
      : source;
  }, [chartIndicatorCandles, fibonacciGranularity, fibonacciHistory, instrument, replayActive, replayEndTime]);
  const fibonacciReferenceLines = useMemo(
    () => fibonacciEnabled
      ? fibonacciRetracementLines(fibonacciSourceCandles)
      : [],
    [fibonacciEnabled, fibonacciSourceCandles],
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
  const swingTrendEnabled = isChartIndicatorEnabled(enabledIndicators, "swing-trend-lines");
  const amdEnabled = isChartIndicatorEnabled(enabledIndicators, "amd");
  // On 1m/5m the chart's own S/R only covers the last hour or two, so the 15m
  // levels are drawn alongside as the bigger-picture reference.
  const supportResistance15mEnabled = isChartIndicatorEnabled(enabledIndicators, "support-resistance")
    && (TIMEFRAME_TO_GRANULARITY[timeframe] === "M1" || TIMEFRAME_TO_GRANULARITY[timeframe] === "M5");
  const m15OverlayEnabled = sessionSrEnabled || frozen4hSrEnabled || swingTrendEnabled || amdEnabled || supportResistance15mEnabled;
  // Prefer the dedicated M15 feed; when the chart is already on M15 and that
  // feed has not arrived yet, fall back so the overlay is not blank.
  const sessionSrSourceCandles = useMemo(() => {
    const source = sessionSrM15Candles.length >= 20
      ? sessionSrM15Candles
      : TIMEFRAME_TO_GRANULARITY[timeframe] === "M15"
        ? chartIndicatorCandles
        : sessionSrM15Candles;
    if (!replayActive || !replayEndTime) return source;
    const cutoff = Date.parse(replayEndTime);
    return Number.isFinite(cutoff)
      ? source.filter((candle) => Date.parse(candle.time) <= cutoff)
      : source;
  }, [chartIndicatorCandles, replayActive, replayEndTime, sessionSrM15Candles, timeframe]);
  // The legacy trendline always evaluates its confirmed pivots across the last
  // two M15 days when that background feed is available. On an M15 chart, use
  // the already rendered candles immediately rather than making the enabled
  // overlay appear broken while its larger background request is in flight.
  const swingTrendSourceCandles = useMemo(() => {
    const source = sessionSrM15Candles.length >= 96
      ? sessionSrM15Candles
      : TIMEFRAME_TO_GRANULARITY[timeframe] === "M15"
        ? chartIndicatorCandles
        : sessionSrM15Candles;
    if (!replayActive || !replayEndTime) return source;
    const cutoff = Date.parse(replayEndTime);
    return Number.isFinite(cutoff)
      ? source.filter((candle) => Date.parse(candle.time) <= cutoff)
      : source;
  }, [chartIndicatorCandles, replayActive, replayEndTime, sessionSrM15Candles, timeframe]);
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
  const supportResistance15mReferenceLines = useMemo(() => {
    if (!supportResistance15mEnabled || sessionSrM15Candles.length < 20) return [];
    // A 15m level sitting on one of the chart's own lines is the same level; keep one.
    const pip = pipSizeFor(instrument);
    return supportResistanceLines(sessionSrSourceCandles, instrument)
      .filter((line) => !supportResistanceReferenceLines.some((own) => Math.abs(own.price - line.price) < pip))
      .map((line) => ({ ...line, key: `m15-${line.key}`, label: `15m ${line.label}` }));
  }, [instrument, sessionSrM15Candles.length, sessionSrSourceCandles, supportResistance15mEnabled, supportResistanceReferenceLines]);
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
  // On a 15m chart the chart's own candles reach as far back as the user has
  // scrolled; the background M15 feed is only the last 500. Use both, so the
  // Asia boxes do not stop a few days back.
  const amdM15Candles = useMemo(() => {
    if (TIMEFRAME_TO_GRANULARITY[timeframe] !== "M15" || chartIndicatorCandles.length <= sessionSrSourceCandles.length) {
      return sessionSrSourceCandles;
    }
    const byTime = new Map(sessionSrSourceCandles.map((candle) => [Date.parse(candle.time), candle]));
    for (const candle of chartIndicatorCandles) byTime.set(Date.parse(candle.time), candle);
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
  }, [chartIndicatorCandles, sessionSrSourceCandles, timeframe]);
  // Fixed session shading uses the same M15 prices on every chart timeframe.
  const amdSessionBoxes = useMemo(
    () => amdEnabled ? computeAmdSessionBoxes(amdM15Candles) : [],
    [amdEnabled, amdM15Candles],
  );
  // "Any range" AMD runs on the chart's own timeframe, with the related pair's
  // candles on the same timeframe for the hint.
  const amdRangeEnabled = isChartIndicatorEnabled(enabledIndicators, "amd-range");
  const amdRelated = amdRangeEnabled ? amdRelatedPair(instrument) : null;
  const [amdRelatedCandles, setAmdRelatedCandles] = useState<{ key: string; candles: Candle[] }>({ key: "", candles: [] });
  const amdRelatedKey = amdRelated ? `${amdRelated.instrument}:${TIMEFRAME_TO_GRANULARITY[timeframe]}` : "";
  useEffect(() => {
    if (!amdRelatedKey) return;
    const [relatedInstrument, granularity] = amdRelatedKey.split(":");
    const controller = new AbortController();
    const load = () => fetch(
      apiUrl(`/api/oanda/candles?instrument=${relatedInstrument}&granularity=${granularity}&count=500`),
      { credentials: "include", cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => response.ok ? (await response.json() as { data?: CandleSeries }).data : undefined)
      .then((data) => {
        if (data?.instrument === relatedInstrument) setAmdRelatedCandles({ key: amdRelatedKey, candles: data.candles });
      })
      .catch(() => {
        // Keep the previous related snapshot on transient failures.
      });
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [amdRelatedKey]);
  const amdRanges = useMemo(
    () => amdRangeEnabled
      ? computeAmdRanges(
        chartIndicatorCandles,
        instrument,
        amdRelatedCandles.key === amdRelatedKey ? amdRelatedCandles.candles : [],
      )
      : [],
    [amdRangeEnabled, amdRelatedCandles, amdRelatedKey, chartIndicatorCandles, instrument],
  );
  // FVG boxes are their own toggle on top of either AMD overlay.
  const amdFvgEnabled = isChartIndicatorEnabled(enabledIndicators, "amd-fvg");
  // FVG remains price-confirmed; scheduled M/D windows do not imply a sweep.
  const amdDays = useMemo(
    () => amdEnabled && amdFvgEnabled ? computeAmdDays(amdM15Candles, instrument) : [],
    [amdEnabled, amdFvgEnabled, amdM15Candles, instrument],
  );
  const chartBoxes = useMemo(
    () => [
      ...amdSessionBoxes,
      ...amdDays.flatMap((day) => day.fvg ? [fvgBox(`amd-${day.day}-fvg`, day.fvg)] : []),
      ...amdRangeBoxes(amdRanges, amdFvgEnabled),
    ],
    [amdSessionBoxes, amdDays, amdFvgEnabled, amdRanges],
  );
  const lastDaySrReferenceLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "last-day-sr")
      ? lastDaySrLines(chartIndicatorCandles)
      : [],
    [chartIndicatorCandles, enabledIndicators],
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

  // Do not let a short selected visual range decide whether Fib exists. Fetch
  // sufficient native-timeframe history solely for the visual calculation;
  // its results are horizontal price lines, so this cannot change the x-axis.
  useEffect(() => {
    if (!fibonacciEnabled) {
      setFibonacciHistory(null);
      return;
    }

    const historyCount = fibonacciGranularity === "M1"
      ? 3000
      : fibonacciGranularity === "M5"
        ? 720
        : fibonacciGranularity === "M15"
          ? 288
          : fibonacciGranularity === "H1"
            ? 120
            : 96;
    const controller = new AbortController();

    async function loadFibonacciHistory() {
      try {
        const response = await fetch(
          apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${fibonacciGranularity}&count=${historyCount}`),
          { credentials: "include", cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: CandleSeries };
        if (
          payload.data?.instrument !== instrument
          || payload.data.granularity !== fibonacciGranularity
        ) return;
        setFibonacciHistory(payload.data);
      } catch {
        // Keep the prior compatible snapshot on a transient fetch failure.
      }
    }

    void loadFibonacciHistory();
    return () => controller.abort();
  }, [fibonacciEnabled, fibonacciGranularity, instrument]);

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
      ? breakoutLines(chartIndicatorCandles)
      : [],
    [chartIndicatorCandles, enabledIndicators],
  );
  const patternOverlay = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "breakout-patterns")
      ? breakoutPatternOverlay(chartIndicatorCandles)
      : { lines: [], tags: [] },
    [chartIndicatorCandles, enabledIndicators],
  );
  const swingTrendPatternLines = useMemo(
    () => isChartIndicatorEnabled(enabledIndicators, "swing-trend-lines")
      ? swingTrendLines(swingTrendSourceCandles)
      : [],
    [enabledIndicators, swingTrendSourceCandles],
  );
  const chartPatternLines = useMemo(
    () => [...patternOverlay.lines, ...swingTrendPatternLines, ...frozen4hHistoryLines],
    [frozen4hHistoryLines, patternOverlay.lines, swingTrendPatternLines],
  );
  const chartReferenceLines = useMemo(
    () => [
      // A pending order belongs to live trading and would reveal a current
      // decision in a historical replay. Technical indicators remain visible.
      ...(replayActive ? [] : pendingEntryReferenceLines),
      ...supportResistanceReferenceLines,
      ...supportResistance15mReferenceLines,
      ...fibonacciReferenceLines,
      ...sessionSrReferenceLines,
      ...lastDaySrReferenceLines,
      ...frozen4hReferenceLines,
      ...(patternOverlay.lines.length ? [] : breakoutReferenceLines),
    ],
    [breakoutReferenceLines, fibonacciReferenceLines, frozen4hReferenceLines, lastDaySrReferenceLines, patternOverlay.lines, pendingEntryReferenceLines, replayActive, sessionSrReferenceLines, supportResistance15mReferenceLines, supportResistanceReferenceLines],
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

  // The server-rendered series is reused for the opening view when it was
  // fetched for exactly that pair, timeframe and range. Consumed once.
  const reusableInitialSeriesRef = useRef(
    primarySeriesRange !== undefined &&
      primarySeries.candles.length > 0 &&
      primarySeries.instrument === initialInstrument &&
      primarySeriesRange === range &&
      primarySeries.granularity === TIMEFRAME_TO_GRANULARITY[timeframe],
  );

  useEffect(() => {
    const controller = new AbortController();

    if (reusableInitialSeriesRef.current) {
      reusableInitialSeriesRef.current = false;
      if (
        seriesRef.current.instrument === instrument &&
        seriesRef.current.granularity === TIMEFRAME_TO_GRANULARITY[timeframe] &&
        primarySeriesRange === range
      ) {
        // Reuse server candles, but reveal them only after the chart's initial
        // sizing and range have settled. Only the quote needs a network read.
        void settleChartLoad(Date.now()).then(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
        void fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), {
          credentials: "include",
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload: { data: PriceQuote[] } | null) => {
            const next = payload?.data.find((price) => price.instrument === instrument);
            if (next) setQuote(next);
          })
          .catch(() => {
            // The live stream fills the quote in shortly.
          });
        return () => controller.abort();
      }
    }

    async function loadMarketData() {
      const loadStartedAt = Date.now();
      setLoading(true);
      setQuote(null);
      setLiveCandle(null);
      setDataNotice(null);

      try {
        const [candlesResponse, pricingResponse] = await Promise.all([
          fetch(
            apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=${candleCountForChartViewport(timeframe, range)}`),
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
          // Mobile shows the chart the moment it is ready; the desktop minimum
          // spinner time exists to avoid a flash on fast desktop reloads.
          await settleChartLoad(loadStartedAt, embeddedSurfaceOnly ? 0 : undefined);
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        }
      }
    }

    loadMarketData();

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- primarySeriesRange is a mount-time value.
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

  // The embed has no URL to rewrite; native owns the focus, so tell it instead.
  const clearEmbeddedFocusTrade = useCallback(() => {
    setFocusTradeId(null);
    (window as Window & { ReactNativeWebView?: { postMessage: (data: string) => void } }).ReactNativeWebView
      ?.postMessage(JSON.stringify({ type: "gx-native-trade-focus-cleared" }));
  }, []);

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
    if (!hasExplicitRangeSelectionRef.current) {
      setRange(DEFAULT_RANGE_BY_TIMEFRAME[nextTimeframe]);
    }
    setTimeframe(nextTimeframe);
  }, [timeframe]);

  const selectRange = useCallback((nextRange: ChartRange) => {
    hasExplicitRangeSelectionRef.current = true;
    if (nextRange === range) return;
    setLiveCandle(null);
    setScrollToLatestRevision((revision) => revision + 1);
    setRange(nextRange);
  }, [range]);

  const priceStats = useMemo(() => {
    const lastClose = series.candles.at(-1)?.close ?? active?.entry ?? 0;
    const prevClose = series.candles.at(-2)?.close ?? lastClose;
    const displayPrice = liveCandle?.close ?? quote?.mid ?? lastClose;
    const change = displayPrice - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;

    return {
      displayPrice,
      change,
      changePercent,
      positive: change >= 0,
    };
  }, [active?.entry, liveCandle?.close, quote?.mid, series.candles]);

  // The native Chart tab owns the mobile controls while this component owns
  // the live chart instance. Keep the two deliberately small and explicit:
  // native sends an intent, and this surface applies it to the real chart
  // state. There is no embedded web workspace chrome to duplicate.
  // Read by the native command handler, which is registered once and must not
  // reset the view for a preferences push that changes nothing.
  const embeddedViewRef = useRef({ timeframe, range });
  useEffect(() => {
    embeddedViewRef.current = { timeframe, range };
  }, [range, timeframe]);

  useEffect(() => {
    if (!embeddedSurfaceOnly) return;

    const onNativeCommand = (event: MessageEvent) => {
      let command: { type?: string; action?: string; value?: string } | null = null;
      try {
        command = typeof event.data === "string" ? JSON.parse(event.data) : event.data as typeof command;
      } catch {
        return;
      }
      if (!command || command.type !== "gx-native-chart-command") return;

      if (command.action === "preferences" && command.value) {
        try {
          const parsed = JSON.parse(command.value) as {
            timeframe?: string;
            range?: string;
            variant?: string;
            indicators?: string[];
          };
          let viewChanged = false;
          if (parsed.timeframe) {
            const normalized = parsed.timeframe.toLowerCase() as ChartTimeframe;
            if (CHART_TIMEFRAMES.includes(normalized)) {
              viewChanged ||= normalized !== embeddedViewRef.current.timeframe;
              setTimeframe(normalized);
            }
          }
          if (parsed.range && CHART_RANGES.includes(parsed.range as ChartRange)) {
            viewChanged ||= parsed.range !== embeddedViewRef.current.range;
            hasExplicitRangeSelectionRef.current = true;
            setRange(parsed.range as ChartRange);
          }
          if (parsed.variant && CHART_VARIANTS.some((item) => item.value === parsed.variant)) {
            setChartVariant(parsed.variant as ChartVariant);
          }
          if (Array.isArray(parsed.indicators)) {
            setEnabledIndicators(
              parsed.indicators.filter((indicator): indicator is ChartIndicator =>
                CHART_INDICATORS.some((option) => option.value === indicator),
              ),
            );
          }
          if (viewChanged) {
            setLiveCandle(null);
            setScrollToLatestRevision((revision) => revision + 1);
          }
        } catch {
          // Ignore malformed native preference payloads.
        }
      } else if (command.action === "instrument" && command.value && isStrategyInstrument(command.value)) {
        if (command.value !== instrument) {
          setPaperTradesHydrated(false);
          setPendingEntriesHydrated(false);
          setSelectedInstrument(command.value);
          setLiveCandle(null);
          setScrollToLatestRevision((revision) => revision + 1);
        }
      } else if (command.action === "focus-trade") {
        // An empty value clears the focus; anything else must be a trade id.
        const id = command.value ?? "";
        if (id === "" || /^[0-9a-f-]{36}$/i.test(id)) setFocusTradeId(id || null);
      } else if (command.action === "timeframe") {
        const normalized = command.value?.toLowerCase() as ChartTimeframe | undefined;
        if (!normalized || !CHART_TIMEFRAMES.includes(normalized)) return;
        setLiveCandle(null);
        setScrollToLatestRevision((revision) => revision + 1);
        if (!hasExplicitRangeSelectionRef.current) {
          setRange(DEFAULT_RANGE_BY_TIMEFRAME[normalized]);
        }
        setTimeframe(normalized);
      } else if (command.action === "range" && CHART_RANGES.includes(command.value as ChartRange)) {
        hasExplicitRangeSelectionRef.current = true;
        setLiveCandle(null);
        setScrollToLatestRevision((revision) => revision + 1);
        setRange(command.value as ChartRange);
      } else if (command.action === "variant" && CHART_VARIANTS.some((variant) => variant.value === command.value)) {
        setChartVariant(command.value as ChartVariant);
      } else if (command.action === "indicator" && CHART_INDICATORS.some((indicator) => indicator.value === command.value)) {
        const indicator = command.value as ChartIndicator;
        setEnabledIndicators((enabled) => enabled.includes(indicator)
          ? enabled.filter((item) => item !== indicator)
          : [...enabled, indicator]);
      } else if (command.action === "position" && (command.value === "long" || command.value === "short")) {
        startPositionTool(command.value);
      } else if (command.action === "analyze") {
        void runTrendPullback();
      } else if (command.action === "cancel-analysis") {
        cancelTrendPullback();
      } else if (command.action === "trade") {
        openPendingEntryManager(null);
      } else if (command.action === "reset") {
        setScrollToLatestRevision((revision) => revision + 1);
      } else if (command.action === "refresh") {
        void refreshChart();
      } else if (command.action === "theme" && (command.value === "light" || command.value === "dark")) {
        setTheme(command.value);
      }
    };

    window.addEventListener("message", onNativeCommand);
    document.addEventListener("message", onNativeCommand as EventListener);
    // Preferences pushed before this listener exists are lost, and the chart
    // would sit on its own defaults. Tell native it can push them now.
    (window as Window & {
      ReactNativeWebView?: { postMessage: (message: string) => void };
    }).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: "gx-native-chart-ready" }),
    );
    return () => {
      window.removeEventListener("message", onNativeCommand);
      document.removeEventListener("message", onNativeCommand as EventListener);
    };
  }, [cancelTrendPullback, embeddedSurfaceOnly, instrument, openPendingEntryManager, refreshChart, runTrendPullback, setTheme, startPositionTool]);

  useEffect(() => {
    if (!embeddedSurfaceOnly) return;
    const nativeBridge = (window as Window & {
      ReactNativeWebView?: { postMessage: (message: string) => void };
    }).ReactNativeWebView;
    nativeBridge?.postMessage(JSON.stringify({
      type: "gx-native-chart-state",
      instrument,
      price: priceStats.displayPrice,
      priceLabel: formatChartPrice(priceStats.displayPrice, instrument),
      bid: quote?.instrument === instrument ? quote.bid : null,
      ask: quote?.instrument === instrument ? quote.ask : null,
      change: priceStats.change,
      changePercent: priceStats.changePercent,
      positive: priceStats.positive,
      timeframe,
      range,
      variant: chartVariant,
    }));
  }, [chartVariant, embeddedSurfaceOnly, instrument, priceStats, quote, range, timeframe]);

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
  // Cheap under 75% of the pair's spread ceiling, pricey up to it, expensive past it.
  const spreadTier = useMemo(() => {
    if (spreadPips === null || !Number.isFinite(spreadPips)) return "unknown";
    const ceiling = MAX_SPREAD_PIPS[instrument] ?? 1.5;
    if (spreadPips <= ceiling * 0.75) return "cheap";
    return spreadPips <= ceiling ? "pricey" : "expensive";
  }, [instrument, spreadPips]);

  function selectSearchResult(result: SearchResult) {
    setLiveCandle(null);
    setFocusTradeId(null);
    setPaperTradesHydrated(false);
    setPendingEntriesHydrated(false);
    // Clear the prior pair's pan/zoom immediately. The data loader also bumps
    // this once fresh candles arrive, covering both the transition and result.
    setScrollToLatestRevision((revision) => revision + 1);
    setSelectedInstrument(result.instrument);
    router.replace(`${workspacePath}?instrument=${encodeURIComponent(result.instrument)}`, { scroll: false });
    setSearchQuery("");
  }

  const sessionLabel = marketSessionCaption();
  const wideChart = chartDesktopViewport === true;
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
          disabled: false,
          title: undefined,
        };

  if (embeddedSurfaceOnly) {
    return (
      <>
        <div className="gx-native-chart-embed h-[100dvh] w-full overflow-hidden">
          <div
            ref={mobileChartShellRef}
            className={`relative h-full w-full overflow-hidden chart-data-shell${loading ? " chart-data-shell-loading" : ""}`}
          >
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
              trades={chartTrades}
              focusTradeId={chartFocusId}
              focusPrediction={focusedPrediction}
              focusRange={focusRange}
              referenceLine={predictionReferenceLine}
              referenceLines={chartReferenceLines}
              patternLines={chartPatternLines}
              boxes={chartBoxes}
              positionTool={positionTool}
              onPositionToolChange={setPositionTool}
              onPositionToolSubmit={submitPositionTool}
            />
            <ChartLoadingOverlay visible={chartLoadingVisible} />
            {focusTrade && focusTrade.closedAt !== null ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <TradeFocusBar trade={focusTrade} onClear={clearEmbeddedFocusTrade} />
              </div>
            ) : null}
          </div>
        </div>
        <ManualProposalModal
          proposal={manualProposal}
          currentPrice={manualProposal
            ? manualProposal.direction === "long" ? quote?.ask ?? null : quote?.bid ?? null
            : null}
          onDismiss={() => setManualProposal(null)}
          acceptLabel="Show setup on chart"
          onAccept={() => {
            if (!manualProposal) return;
            const lastIndex = Math.max(0, series.candles.length - 1);
            setPositionTool({
              direction: manualProposal.direction,
              entry: manualProposal.entry,
              stop: manualProposal.stop,
              target: manualProposal.target,
              fromLogical: Math.max(0, lastIndex - 36),
              toLogical: lastIndex,
            });
            setManualProposal(null);
          }}
        />
        {/* Phones get the Analyze result as a bottom sheet; desktop shows it as
          the first card in the chart's side column (see nl-chart-side). */}
      {wideChart ? null : (
        <AnalyzeSheet
          normal={trendPullbackDialogOpen ? trendPullbackResult : null}
          swing={trendPullbackDialogOpen ? trendPullbackSwing : null}
          analyzing={trendPullbackDialogOpen && trendPullbackBusy}
          instrument={instrument}
          onClose={() => setTrendPullbackDialogOpen(false)}
          onCancel={cancelTrendPullback}
          onReview={reviewTrendPullback}
        />
      )}
        {pendingEntryDialogOpen ? <PendingEntryDialog
          key={`${selectedPendingEntry?.id ?? "new-pending-entry"}:${entryComposerRevision}`}
          open={pendingEntryDialogOpen}
          instrument={instrument}
          bid={quote?.bid ?? null}
          ask={quote?.ask ?? null}
          selectedEntry={selectedPendingEntry}
          initialProposal={entryDraftProposal ?? initialManualProposal}
          onClose={() => setPendingEntryDialogOpen(false)}
          onChanged={(message) => {
            setPendingEntryNotice(message);
            void refreshPendingEntries();
          }}
        /> : null}
      </>
    );
  }

  if (chartDesktopViewport === null || !chartPreferencesReady) {
    return <ChartLoadingSkeleton />;
  }

  return (
    <div
      className={`signals-view signals-minimal grid w-full gap-5${
        fullscreen ? " signals-view-fullscreen" : ""
      }`}
    >
      <MarketObserverBubble key={instrument} instrument={instrument} replayActive={replayActive} />
      <div className="signals-chart-slot min-w-0">
        <section className="app-card signals-chart-card min-w-0 w-full">
        {!wideChart ? <div className="signals-chart-mobile lg:hidden">
          <div className="signals-mobile-content">
            {/* Phone header and quote, as the "Chart — Mobile" artboard. */}
            <div className="signals-mobile-actions nl-mhead">
              <div className="nl-pair nl-pair-sm">
                <PairAvatar key={instrument} instrument={instrument} size={30} horizontal />
                <SignalSearch
                  compact
                  pairLabel={activePair}
                  signals={signals}
                  activeInstrument={instrument}
                  tradingInstruments={tradingInstruments}
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  onSelect={selectSearchResult}
                  className="gx-pair-search"
                />
              </div>
              <div className="signals-mobile-header-actions nl-mhead-actions">
                <button type="button" className="nl-analyze nl-analyze-sm pressable" onClick={() => void runTrendPullback()} disabled={trendPullbackBusy || replayActive} title="Analyze the market and monitor its conditions">
                  <AnalyzeIcon className="size-4" />
                  {trendPullbackBusy ? "Analyzing…" : "Analyze"}
                </button>
                <NotificationBell compact className="signals-icon-btn signals-fullscreen-reserve nl-mbell" />
              </div>
            </div>

            <div className="gx-mobile-quote-row nl-mquote">
              <div className="nl-mquote-main">
                <span className="nl-mquote-price metric-number">
                  {formatChartPrice(priceStats.displayPrice, instrument)}
                </span>
                <span className="nl-mquote-meta">
                  <span className={`metric-number ${priceStats.positive ? "is-up" : "is-down"}`}>
                    {priceStats.positive ? "+" : "−"}
                    {Math.abs(priceStats.changePercent).toFixed(2)}%
                  </span>
                </span>
              </div>
              <span className="nl-mquote-session">{sessionLabel.replace(/ session$/, "")}</span>
              <dl className="nl-mquote-facts" aria-label="Live bid, ask and spread">
                <div>
                  <dt>Bid</dt>
                  <dd className="metric-number">{quote?.instrument === instrument && Number.isFinite(quote.bid) ? formatChartPrice(quote.bid, instrument) : "—"}</dd>
                </div>
                <div>
                  <dt>Ask</dt>
                  <dd className="metric-number">{quote?.instrument === instrument && Number.isFinite(quote.ask) ? formatChartPrice(quote.ask, instrument) : "—"}</dd>
                </div>
                <div>
                  <dt>Spread</dt>
                  <dd className={`metric-number nl-spread is-${spreadTier}`}>
                    {spreadPips !== null && Number.isFinite(spreadPips) ? `${spreadPips.toFixed(1)}p` : "—"}
                  </dd>
                </div>
              </dl>
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
              <MarketDataNotice message={dataNotice} demo={series.source === "mock"} />
            ) : null}
          </div>

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
              <span className="signals-fs-pair">{activePair}</span>
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
              series={replaySeries}
              levels={replayActive ? null : setupLevels}
              enabledIndicators={enabledIndicators}
              liveCandle={replayActive ? null : liveCandle}
              variant={chartVariant}
              range={range}
              height={mobileChartHeight}
              embedded
              scrollToLatestRevision={scrollToLatestRevision}
              preserveViewportRevision={preserveViewportRevision}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderCandles}
              trades={replayActive ? [] : chartTrades}
              showTradeMarkers={!replayActive}
              showTradePath={!replayActive}
              focusTradeId={replayActive ? null : chartFocusId}
              focusPrediction={replayActive ? null : focusedPrediction}
              focusRange={replayActive ? null : focusRange}
              referenceLine={replayActive ? null : predictionReferenceLine}
              referenceLines={chartReferenceLines}
              patternLines={chartPatternLines}
              boxes={chartBoxes}
              positionTool={replayActive ? null : positionTool}
              onPositionToolChange={setPositionTool}
              onPositionToolSubmit={submitPositionTool}
              levelEdit={replayActive ? null : levelEdit}
              onLevelEditChange={onLevelEditChange}
            />
            {focusTrade && focusTrade.closedAt !== null && !fullscreen ? (
              <div className="trade-focus-overlay">
                <TradeFocusBar trade={focusTrade} onClear={clearFocusTrade} />
              </div>
            ) : null}
            <ChartLoadingOverlay visible={chartLoadingVisible} />
          </div>

          <div className="gx-mobile-chart-toolbar">
            <IndicatorSheet enabled={enabledIndicators} onChange={setEnabledIndicators} />
            {fullscreen ? (
              <ChartOptionSheet
                title="Timeframe"
                icon={<Clock3 className="size-4 shrink-0" strokeWidth={2} />}
                options={CHART_TIMEFRAMES}
                value={timeframe}
                onChange={selectTimeframe}
              />
            ) : null}
            <ChartOptionSheet title="History range" icon={<CalendarRange className="size-4 shrink-0" strokeWidth={2} />} options={CHART_RANGES} value={range} onChange={selectRange} />
            <ChartTypeSheet value={chartVariant} onChange={setChartVariant} />
            <button
              type="button"
              className={`gx-mobile-tool-button pressable${replayActive ? " is-active" : ""}`}
              onClick={replayActive ? exitReplay : beginReplay}
              aria-label={replayActive ? "Exit replay" : "Replay"}
              aria-pressed={replayActive}
              title={replayActive ? "Exit replay" : "Replay candles step by step"}
            >
              <History className="size-3.5" strokeWidth={2} />
            </button>
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

          {replayActive ? (
            // Replay replaces the trade action: stepping through history is
            // not a moment to place orders. The lit toolbar button exits.
            <div className="gx-mobile-analyze-section gx-mobile-replay" role="group" aria-label="Replay controls">
              <div className="gx-mobile-replay-steps">
                <button type="button" className="gx-mobile-replay-step pressable" onClick={() => stepReplay(-60)} aria-label="Back one hour">‹ 1h</button>
                <button type="button" className="gx-mobile-replay-step pressable" onClick={() => stepReplay(-15)} aria-label="Back 15 minutes">‹ 15m</button>
                <button type="button" className="gx-mobile-replay-step pressable" onClick={() => stepReplay(15)} disabled={replayAtLatest} aria-label="Forward 15 minutes">15m ›</button>
                <button type="button" className="gx-mobile-replay-step pressable" onClick={() => stepReplay(60)} disabled={replayAtLatest} aria-label="Forward one hour">1h ›</button>
              </div>
            </div>
          ) : levelEdit && healthLevels && healthSignal ? (
            // Moving SL / TP: the lines are dragged on the chart above; this
            // is the same draft panel as the desktop Trade health card.
            <div className="gx-mobile-analyze-section nl-mlevels">
              <ChartLevelEditor levels={healthLevels} signal={healthSignal} />
            </div>
          ) : mobileTradeActionReady ? (
            <div className="gx-mobile-analyze-section">
              <PairTradePicker trades={pairTrades} selectedId={settingUpNewTrade ? NEW_PAIR_TRADE : selectedPairTrade?.id ?? null} instrument={instrument} onSelect={setPickedPairTrade} />
              <div className="nl-mtrade-row">
                {healthLevels && manualTradeMode === "close" ? (
                  <button type="button" className="nl-mlevels-start pressable" onClick={healthLevels.onStart} aria-label="Adjust stop loss and take profit">
                    <MoveVertical aria-hidden="true" />
                    SL / TP
                  </button>
                ) : null}
                <button
                  key={manualTradeMode}
                  type="button"
                  className={`gx-mobile-analyze pressable${mobileTradeAction.className}`}
                  onClick={mobileTradeAction.onClick}
                  disabled={mobileTradeAction.disabled}
                  title={mobileTradeAction.title}
                >
                  {mobileTradeAction.label}
                </button>
              </div>
              {(tradeActionError || trendPullbackError) ? (
                <p className="gx-mobile-analyze-error" role="alert">{tradeActionError ?? trendPullbackError}</p>
              ) : null}
            </div>
          ) : (
            <div className="gx-mobile-analyze-section" role="status" aria-label="Checking trade status">
              <div className="gx-mobile-trade-action-skeleton" aria-hidden="true" />
            </div>
          )}
        </div> : <div className="hidden lg:flex signals-chart-desktop gx-chart-terminal nl-terminal">
          <header className="nl-chart-head">
            <div className="nl-chart-head-main">
              <div className="nl-pair">
                <PairAvatar key={instrument} instrument={instrument} size={36} horizontal />
                <SignalSearch
                  compact
                  pairLabel={activePair}
                  signals={signals}
                  activeInstrument={instrument}
                  tradingInstruments={tradingInstruments}
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  onSelect={selectSearchResult}
                  className="gx-pair-search"
                />
              </div>
              <div className="nl-chart-quote">
                <span className="nl-chart-price metric-number">
                  {formatChartPrice(priceStats.displayPrice, instrument)}
                </span>
                <span className={`nl-chart-change metric-number ${priceStats.positive ? "is-up" : "is-down"}`}>
                  {priceStats.positive ? "+" : "−"}
                  {Math.abs(priceStats.changePercent).toFixed(2)}%
                </span>
              </div>
              <dl className="nl-chart-facts">
                <div>
                  <dt>Bid</dt>
                  <dd className="metric-number">{quote?.instrument === instrument ? formatChartPrice(quote.bid, instrument) : "—"}</dd>
                </div>
                <div>
                  <dt>Ask</dt>
                  <dd className="metric-number">{quote?.instrument === instrument ? formatChartPrice(quote.ask, instrument) : "—"}</dd>
                </div>
                <div>
                  <dt>Spread</dt>
                  <dd className="metric-number">
                    <span className={`nl-spread-dot is-${spreadTier}`} aria-hidden="true" />
                    {spreadPips !== null && Number.isFinite(spreadPips) ? `${spreadPips.toFixed(1)} pips` : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>{sessionLabel}</dd>
                </div>
              </dl>
            </div>
            <div className="nl-chart-head-actions">
              {!replayActive && manualTradeMode === "close" ? (
                <button type="button" className="signals-analyze-desktop pressable is-close nl-trade-action" onClick={() => setTradeConfirm("close")} disabled={tradeActionBusy}>
                  <CircleStop aria-hidden="true" />
                  {tradeActionBusy ? "Closing…" : "Close trade"}
                </button>
              ) : !replayActive && manualTradeMode === "cancel" ? (
                <button type="button" className="signals-analyze-desktop pressable is-cancel nl-trade-action" onClick={() => setTradeConfirm("cancel")} disabled={tradeActionBusy}>
                  <X aria-hidden="true" />
                  {tradeActionBusy ? "Cancelling…" : "Cancel order"}
                </button>
              ) : null}
              {/* Analyze lives in the side column card on desktop. */}
              <NotificationBell className="nl-chart-bell" />
            </div>
            {(tradeActionError || trendPullbackError) ? (
              <span className="signals-analyze-error nl-chart-error" role="alert">{tradeActionError ?? trendPullbackError}</span>
            ) : null}
          </header>

          <div className="nl-chart-body">
            <div className="nl-chart-main">
              <div className="nl-chart-toolbar" role="toolbar" aria-label="Chart controls">
                <SegmentControl
                  variant="tabs"
                  ariaLabel="Chart timeframe"
                  options={CHART_TIMEFRAMES}
                  labels={CHART_TIMEFRAME_LABELS}
                  value={timeframe}
                  onChange={selectTimeframe}
                />
                <RangeSelect value={range} onChange={selectRange} />
                <ChartTypeSelect toolbar value={chartVariant} onChange={setChartVariant} />
                <span className="nl-toolbar-rule" aria-hidden="true" />
                <IndicatorSelect toolbar enabled={enabledIndicators} onChange={setEnabledIndicators} />
                {replayActive ? null : (
                  <PairTradePicker trades={pairTrades} selectedId={settingUpNewTrade ? NEW_PAIR_TRADE : selectedPairTrade?.id ?? null} instrument={instrument} onSelect={setPickedPairTrade} />
                )}
                <div className="nl-toolbar-end">
                  {replayActive ? (
                    <>
                      <span className="nl-replay-tag" role="status">
                        Replay · {formatDayAndTime(replayEndTime!)}
                      </span>
                      <button type="button" className="gx-toolbar-btn pressable" onClick={() => stepReplay(-60)} title="Move replay back one hour">← 1h</button>
                      <button type="button" className="gx-toolbar-btn pressable" onClick={() => stepReplay(-15)} title="Move replay back 15 minutes">← 15m</button>
                      <button type="button" className="gx-toolbar-btn pressable" onClick={() => stepReplay(15)} disabled={replayAtLatest} title="Move replay forward 15 minutes">15m →</button>
                      <button type="button" className="gx-toolbar-btn pressable" onClick={() => stepReplay(60)} disabled={replayAtLatest} title="Move replay forward one hour">1h →</button>
                      <button type="button" className="gx-toolbar-btn pressable" onClick={exitReplay}>Exit replay</button>
                    </>
                  ) : (
                    <button type="button" className="gx-toolbar-icon-btn pressable" onClick={beginReplay} title="Replay candles one hour at a time" aria-label="Replay candles">
                      <Clock3 className="size-[18px]" strokeWidth={1.8} />
                    </button>
                  )}
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

              <div className="gx-chart-stage nl-chart-card">
                {dataNotice ? (
                  <MarketDataNotice message={dataNotice} demo={series.source === "mock"} className="signals-chart-notice" />
                ) : null}

                {focusTrade && focusTrade.closedAt !== null && !fullscreen ? (
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
                  <ChartOhlcReadout
                    instrument={instrument}
                    timeframe={CHART_TIMEFRAME_LABELS[timeframe]}
                    candle={replayActive ? replaySeries.candles.at(-1) : liveCandle ?? replaySeries.candles.at(-1)}
                  />
                  <SetupChart
                    key={`desktop-chart:${instrument}:${timeframe}:${range}`}
                    series={replaySeries}
                    levels={!replayActive && overlayPreferences.levels ? setupLevels : null}
                    enabledIndicators={enabledIndicators}
                    liveCandle={replayActive ? null : liveCandle}
                    variant={chartVariant}
                    range={range}
                    height={desktopChartHeight}
                    spreadPips={spreadPips}
                    scrollToLatestRevision={scrollToLatestRevision}
                    preserveViewportRevision={preserveViewportRevision}
                    loadingOlder={loadingOlder}
                    onLoadOlder={loadOlderCandles}
                    trades={replayActive ? [] : chartTrades}
                    showTradeMarkers={!replayActive && overlayPreferences.signalMarkers}
                    showTradePath={!replayActive && overlayPreferences.positionMarkers}
                    focusTradeId={replayActive ? null : chartFocusId}
                    focusPrediction={replayActive ? null : focusedPrediction}
                    focusRange={replayActive ? null : focusRange}
                    referenceLine={replayActive ? null : predictionReferenceLine}
                    referenceLines={chartReferenceLines}
                    patternLines={chartPatternLines}
                    boxes={chartBoxes}
                    positionTool={replayActive ? null : positionTool}
                    onPositionToolChange={setPositionTool}
                    onPositionToolSubmit={submitPositionTool}
                    levelEdit={replayActive ? null : levelEdit}
                    onLevelEditChange={onLevelEditChange}
                  />
                  <ChartLoadingOverlay visible={chartLoadingVisible} />
                </div>
              </div>
            </div>

            <div className="nl-chart-side">
              <AnalyzeCard
                normal={trendPullbackDialogOpen ? trendPullbackResult : null}
                swing={trendPullbackDialogOpen ? trendPullbackSwing : null}
                analyzing={trendPullbackDialogOpen && trendPullbackBusy}
                instrument={instrument}
                onClose={() => setTrendPullbackDialogOpen(false)}
                onCancel={cancelTrendPullback}
                onReview={reviewTrendPullback}
                onAnalyze={() => void runTrendPullback()}
                onNewEntry={() => {
                  setEntryDraftProposal(null);
                  openPendingEntryManager(null);
                  setEntryComposerRevision((revision) => revision + 1);
                }}
                analyzeDisabled={trendPullbackBusy || replayActive}
              />
              <ChartHealthCard
                signal={healthSignal}
                currentPrice={quote?.mid ?? null}
                pairLabel={activePair}
                levels={healthLevels}
              />
              <ChartNewsCard
                instrument={instrument}
                position={healthSignal ? { instrument, direction: healthSignal.direction, openedAt: healthSignal.openedAt ?? undefined } : null}
              />
            </div>
          </div>
        </div>}
        </section>
      </div>

      {pendingEntryDialogOpen ? <PendingEntryDialog
        key={`${selectedPendingEntry?.id ?? "new-pending-entry"}:${entryComposerRevision}`}
        open={pendingEntryDialogOpen}
        instrument={instrument}
        bid={quote?.bid ?? null}
        ask={quote?.ask ?? null}
        selectedEntry={selectedPendingEntry}
        initialProposal={entryDraftProposal ?? initialManualProposal}
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
      {wideChart ? null : (
        <AnalyzeSheet
          normal={trendPullbackDialogOpen ? trendPullbackResult : null}
          swing={trendPullbackDialogOpen ? trendPullbackSwing : null}
          analyzing={trendPullbackDialogOpen && trendPullbackBusy}
          instrument={instrument}
          onClose={() => setTrendPullbackDialogOpen(false)}
          onCancel={cancelTrendPullback}
          onReview={reviewTrendPullback}
        />
      )}

      <TradeConfirmDialog
        mode={tradeConfirm}
        pairLabel={instrument.replace("_", "/")}
        onDismiss={() => setTradeConfirm(null)}
        onConfirm={(action) => {
          void (action === "cancel" ? cancelManualTrade() : closeManualTrade());
        }}
      />

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
