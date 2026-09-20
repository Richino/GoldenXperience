"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTheme } from "next-themes";
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type AutoscaleInfo,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Logical,
  type LogicalRange,
  type SeriesType,
  type DeepPartial,
  type Time,
  type TimeChartOptions,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  buildPredictionMarkers,
  buildPredictionPath,
  buildTradeMarkers,
  buildTradePath,
  calculateAtr,
  calculateEma,
  calculateRsi,
  chartTimesOf,
  detectFalseBreakouts,
  compactAxisPricePrecision,
  countPrependedCandles,
  formatChartPrice,
  getLatestVisibleLogicalRange,
  isChartIndicatorEnabled,
  pricePrecision,
  anchorRangeAfterPrepend,
  shouldLoadOlderHistory,
  toChartCandles,
  toCloseLine,
  toHeikinAshiCandles,
  toLinePoints,
  type ChartIndicator,
  type ChartRange,
  type ChartVariant,
  type TradeMarkerPalette,
} from "@/lib/chart-utils";
import { ChartHistoryLoader } from "@/components/charts/chart-loading-overlay";
import { useChartTouchGestures } from "@/components/charts/use-chart-touch-gestures";
import { formatClockTime } from "@/lib/format/datetime";
import { pipSizeFor } from "@/lib/instruments/catalog";
import type { BinaryPrediction } from "@/types/binary";
import type { Candle, CandleSeries, PaperChartTrade } from "@/types/forex";

/**
 * How many pages of older candles the chart will pull in on its own to bring a
 * focused trade into view before it stops chasing it.
 */
const MAX_FOCUS_HISTORY_PAGES = 8;

function formatChartAxisTime(time: Time, tickMarkType: TickMarkType): string | null {
  // Leave day/month/year dividers to Lightweight Charts' default formatter;
  // only intraday ticks need the requested 12-hour display. Use the same
  // trading-zone clock as entry/exit labels so axis ticks match real session time.
  if (tickMarkType !== TickMarkType.Time && tickMarkType !== TickMarkType.TimeWithSeconds) {
    return null;
  }

  if (typeof time === "number") {
    return formatClockTime(time * 1_000);
  }

  if (typeof time === "string") {
    return formatClockTime(time);
  }

  return formatClockTime(Date.UTC(time.year, time.month - 1, time.day));
}

interface SetupLevels {
  entry: number;
  stop: number;
  target: number;
  exit?: number | null;
  /**
   * How the trade closed, as the paper cycle recorded it: `stop_first`,
   * `target_first` or `forced_close`. This is what decides whether the exit is
   * a level already on the chart — never a comparison of the two prices, which
   * a broker fill misses by a tenth of a pip often enough to matter.
   */
  outcome?: string | null;
}

/** The time window a focused paper trade occupies, in chart seconds. */
export interface ChartFocusRange {
  from: number;
  to: number;
}

/** A draft long/short risk-reward box drawn on the chart (TradingView-style). */
export interface ChartPositionTool {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  /** Left edge of the box, in chart logical indices. */
  fromLogical: number;
  /** Right edge of the box, in chart logical indices. */
  toLogical: number;
}

/** Build a fixed 1:2 geometry around an entry price with a finite bar span. */
export function createOneToTwoSetup(
  direction: "long" | "short",
  entry: number,
  risk: number,
  fromLogical: number,
  toLogical: number,
): ChartPositionTool {
  const r = Math.abs(risk);
  const left = Math.min(fromLogical, toLogical);
  const right = Math.max(fromLogical, toLogical);
  if (direction === "long") {
    return {
      direction,
      entry,
      stop: entry - r,
      target: entry + 2 * r,
      fromLogical: left,
      toLogical: right,
    };
  }
  return {
    direction,
    entry,
    stop: entry + r,
    target: entry - 2 * r,
    fromLogical: left,
    toLogical: right,
  };
}

/** A single externally focused price, such as an active binary prediction entry. */
export interface ChartReferenceLine {
  key?: string;
  price: number;
  label: string;
  color: string;
  textColor: string;
  dashed?: boolean;
  lineWidth?: 1 | 2;
  onSelect?: () => void;
}

/** A finite diagonal or horizontal segment used by visual chart indicators. */
export interface ChartPatternLine {
  key: string;
  color: string;
  dashed?: boolean;
  lineWidth?: 1 | 2;
  points: Array<{ time: string; price: number }>;
}

/**
 * A narrow right-side touch rail for scaling the price range without moving
 * the chart itself. Dragging down widens the range (shorter candles); dragging
 * up narrows it (taller candles).
 */
function ChartPriceScaleRail({
  chartRef,
  onViewChange,
}: {
  chartRef: { current: IChartApi | null };
  onViewChange: () => void;
}) {
  const startYRef = useRef<number | null>(null);
  const baseRangeRef = useRef<{ from: number; to: number } | null>(null);

  const begin = (y: number) => {
    const range = chartRef.current?.priceScale("right").getVisibleRange();
    if (!range || range.to <= range.from) return;
    startYRef.current = y;
    baseRangeRef.current = range;
  };

  const scaleAt = (y: number) => {
    const startY = startYRef.current;
    const base = baseRangeRef.current;
    const chart = chartRef.current;
    if (startY === null || !base || !chart) return;
    const zoom = Math.min(Math.max(Math.exp(-(y - startY) / 160), 0.25), 4);
    const span = (base.to - base.from) / zoom;
    const midpoint = (base.to + base.from) / 2;
    const priceScale = chart.priceScale("right");
    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({
      from: midpoint - span / 2,
      to: midpoint + span / 2,
    });
    onViewChange();
  };

  const clear = () => {
    startYRef.current = null;
    baseRangeRef.current = null;
  };

  return (
    <div
      className="setup-chart-price-scale-rail"
      role="presentation"
      onPointerDown={(event) => {
        begin(event.clientY);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Touch capture is best-effort; touch handlers below provide backup.
        }
        event.stopPropagation();
      }}
      onPointerMove={(event) => {
        scaleAt(event.clientY);
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        clear();
        event.stopPropagation();
      }}
      onPointerCancel={clear}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (touch) begin(touch.clientY);
        event.stopPropagation();
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (touch) scaleAt(touch.clientY);
        event.stopPropagation();
      }}
      onTouchEnd={(event) => {
        clear();
        event.stopPropagation();
      }}
      onTouchCancel={clear}
    />
  );
}

type PositionHandle = "move" | "entry" | "stop" | "target" | "left" | "right";

function PositionToolOverlay({
  chartRef,
  mainSeriesRef,
  chartEpoch,
  tool,
  onChange,
  onClear,
  onSubmit,
}: {
  chartRef: { current: IChartApi | null };
  mainSeriesRef: { current: ISeriesApi<SeriesType> | null };
  chartEpoch: number;
  tool: ChartPositionTool;
  onChange: (next: ChartPositionTool) => void;
  onClear: () => void;
  onSubmit?: (tool: ChartPositionTool) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const rewardRef = useRef<HTMLDivElement>(null);
  const riskRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLButtonElement>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    handle: PositionHandle;
    start: ChartPositionTool;
    pointerPrice: number;
    pointerLogical: number;
  } | null>(null);
  const toolRef = useRef(tool);
  const onChangeRef = useRef(onChange);
  toolRef.current = tool;
  onChangeRef.current = onChange;

  const paint = useCallback(() => {
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    const root = rootRef.current;
    const box = boxRef.current;
    if (!chart || !series || !root || !box) return;

    const current = toolRef.current;
    const entryY = series.priceToCoordinate(current.entry);
    const stopY = series.priceToCoordinate(current.stop);
    const targetY = series.priceToCoordinate(current.target);
    const leftX = chart.timeScale().logicalToCoordinate(current.fromLogical as Logical);
    const rightX = chart.timeScale().logicalToCoordinate(current.toLogical as Logical);
    if (
      entryY === null ||
      stopY === null ||
      targetY === null ||
      leftX === null ||
      rightX === null
    ) {
      root.hidden = true;
      return;
    }
    root.hidden = false;

    const left = Math.min(leftX, rightX);
    const width = Math.max(Math.abs(rightX - leftX), 24);
    const top = Math.min(entryY, stopY, targetY);
    const bottom = Math.max(entryY, stopY, targetY);
    const height = Math.max(bottom - top, 1);

    box.style.left = `${left}px`;
    box.style.width = `${width}px`;
    box.style.top = `${top}px`;
    box.style.height = `${height}px`;

    const rewardTop = Math.min(entryY, targetY) - top;
    const rewardHeight = Math.abs(targetY - entryY);
    const riskTop = Math.min(entryY, stopY) - top;
    const riskHeight = Math.abs(stopY - entryY);

    if (rewardRef.current) {
      rewardRef.current.style.top = `${rewardTop}px`;
      rewardRef.current.style.height = `${Math.max(rewardHeight, 1)}px`;
    }
    if (riskRef.current) {
      riskRef.current.style.top = `${riskTop}px`;
      riskRef.current.style.height = `${Math.max(riskHeight, 1)}px`;
    }
    if (entryRef.current) entryRef.current.style.top = `${entryY - top}px`;
    if (stopRef.current) stopRef.current.style.top = `${stopY - top}px`;
    if (targetRef.current) targetRef.current.style.top = `${targetY - top}px`;
    if (metaRef.current) metaRef.current.style.top = `-28px`;
  }, [chartRef, mainSeriesRef]);

  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    paint();
    const chart = chartRef.current;
    if (!chart) return;
    const onView = () => paint();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onView);
    chart.subscribeCrosshairMove(onView);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onView);
      chart.unsubscribeCrosshairMove(onView);
    };
  }, [chartEpoch, chartRef, paint]);

  useLayoutEffect(() => {
    paint();
  }, [paint, tool.entry, tool.stop, tool.target, tool.fromLogical, tool.toLogical]);

  useEffect(() => {
    const readPointer = (clientX: number, clientY: number) => {
      const chart = chartRef.current;
      const series = mainSeriesRef.current;
      const root = rootRef.current;
      if (!chart || !series || !root) return null;
      const rect = root.getBoundingClientRect();
      const price = series.coordinateToPrice(clientY - rect.top);
      const logical = chart.timeScale().coordinateToLogical(clientX - rect.left);
      if (
        price === null ||
        !Number.isFinite(price) ||
        logical === null ||
        !Number.isFinite(logical)
      ) {
        return null;
      }
      return { price, logical };
    };

    const apply = (next: ChartPositionTool) => {
      toolRef.current = next;
      onChangeRef.current(next);
      paintRef.current();
    };

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      const pointer = readPointer(event.clientX, event.clientY);
      if (!pointer) return;

      const { handle, start, pointerPrice, pointerLogical } = drag;
      const minSpan = 2;

      if (handle === "left" || handle === "right") {
        if (handle === "left") {
          apply({
            ...start,
            fromLogical: Math.min(pointer.logical, start.toLogical - minSpan),
            toLogical: start.toLogical,
          });
          return;
        }
        apply({
          ...start,
          fromLogical: start.fromLogical,
          toLogical: Math.max(pointer.logical, start.fromLogical + minSpan),
        });
        return;
      }

      if (handle === "move") {
        const deltaPrice = pointer.price - pointerPrice;
        const deltaLogical = pointer.logical - pointerLogical;
        apply({
          direction: start.direction,
          entry: start.entry + deltaPrice,
          stop: start.stop + deltaPrice,
          target: start.target + deltaPrice,
          fromLogical: start.fromLogical + deltaLogical,
          toLogical: start.toLogical + deltaLogical,
        });
        return;
      }

      if (handle === "entry") {
        const deltaPrice = pointer.price - pointerPrice;
        apply({
          ...start,
          entry: start.entry + deltaPrice,
          stop: start.stop + deltaPrice,
          target: start.target + deltaPrice,
        });
        return;
      }

      // Scale keeps a true 1:2: risk = R, reward = 2R. Dragging either outer
      // edge only changes R; the opposite edge mirrors it around entry.
      let risk: number;
      if (handle === "stop") {
        risk =
          start.direction === "long"
            ? start.entry - pointer.price
            : pointer.price - start.entry;
      } else {
        const reward =
          start.direction === "long"
            ? pointer.price - start.entry
            : start.entry - pointer.price;
        risk = reward / 2;
      }
      risk = Math.max(risk, Number.EPSILON);

      if (start.direction === "long") {
        apply({
          ...start,
          stop: start.entry - risk,
          target: start.entry + 2 * risk,
        });
        return;
      }
      apply({
        ...start,
        stop: start.entry + risk,
        target: start.entry - 2 * risk,
      });
    };

    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove("is-dragging-position-tool");
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-dragging-position-tool");
    };
  }, [chartRef, mainSeriesRef]);

  const beginDrag = (handle: PositionHandle) => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    const root = rootRef.current;
    if (!chart || !series || !root) return;
    const rect = root.getBoundingClientRect();
    const price = series.coordinateToPrice(event.clientY - rect.top);
    const logical = chart.timeScale().coordinateToLogical(event.clientX - rect.left);
    if (
      price === null ||
      !Number.isFinite(price) ||
      logical === null ||
      !Number.isFinite(logical)
    ) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; window listeners still drive the drag.
    }
    document.body.classList.add("is-dragging-position-tool");
    dragRef.current = {
      handle,
      start: { ...toolRef.current },
      pointerPrice: price,
      pointerLogical: logical,
    };
  };

  const risk = Math.abs(tool.entry - tool.stop);
  const reward = Math.abs(tool.target - tool.entry);
  const rr = risk > 0 ? reward / risk : 0;

  return (
    <div ref={rootRef} className="setup-chart-position-tool">
      <div ref={boxRef} className="setup-chart-position-box">
        <div
          ref={rewardRef}
          className="setup-chart-position-band is-reward"
          onPointerDown={beginDrag("move")}
        />
        <div
          ref={riskRef}
          className="setup-chart-position-band is-risk"
          onPointerDown={beginDrag("move")}
        />
        <div ref={metaRef} className="setup-chart-position-meta">
          <span>
            {tool.direction === "long" ? "Long" : "Short"} · 1:{rr >= 10 ? rr.toFixed(0) : rr.toFixed(1)}
          </span>
          {onSubmit ? (
            <button
              type="button"
              className="setup-chart-position-submit"
              onClick={() => onSubmit(toolRef.current)}
            >
              Submit
            </button>
          ) : null}
          <button type="button" className="setup-chart-position-clear" onClick={onClear}>
            Clear
          </button>
        </div>
        <button
          type="button"
          className="setup-chart-position-edge is-left"
          aria-label="Drag left edge"
          onPointerDown={beginDrag("left")}
        />
        <button
          type="button"
          className="setup-chart-position-edge is-right"
          aria-label="Drag right edge"
          onPointerDown={beginDrag("right")}
        />
        <button
          type="button"
          ref={targetRef}
          className="setup-chart-position-handle is-target"
          aria-label="Scale take profit"
          onPointerDown={beginDrag("target")}
        >
          <span>Take Profit</span>
        </button>
        <button
          type="button"
          ref={entryRef}
          className="setup-chart-position-handle is-entry"
          aria-label="Move entry"
          onPointerDown={beginDrag("entry")}
        >
          <span>Entry</span>
        </button>
        <button
          type="button"
          ref={stopRef}
          className="setup-chart-position-handle is-stop"
          aria-label="Scale stop loss"
          onPointerDown={beginDrag("stop")}
        >
          <span>Stop Loss</span>
        </button>
      </div>
    </div>
  );
}

// Lightweight Charts reserves space for the desktop time scale via minimumHeight.
function chartTheme(
  isDark: boolean,
  embedded = false,
): DeepPartial<TimeChartOptions> {
  const background = embedded
    ? isDark
      ? "#0b0b0d"
      : "#ffffff"
    : isDark
      ? "#080A0B"
      : "#f1f5f9";
  const scaleText = isDark ? "#9a9aa3" : "#6e6e73";
  const accent = isDark ? "#00e59b" : "#00b377";
  // Horizontal-emphasis grid: price rows read clearly while the time lines
  // recede, the way a refined trading terminal frames its candles.
  const horzGrid = isDark ? "rgba(255,255,255,0.05)" : "rgba(28,28,30,0.06)";
  const vertGrid = isDark ? "rgba(255,255,255,0.028)" : "rgba(28,28,30,0.035)";

  return {
    layout: {
      background: { type: ColorType.Solid, color: background },
      textColor: scaleText,
      fontFamily:
        '"Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif',
      fontSize: embedded ? 10 : 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: vertGrid, style: LineStyle.Solid, visible: !embedded },
      horzLines: { color: horzGrid, style: LineStyle.Solid, visible: !embedded },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: isDark ? "rgba(0,229,155,0.22)" : "rgba(0,179,119,0.28)",
        width: 1 as const,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: accent,
      },
      horzLine: {
        color: isDark ? "rgba(0,229,155,0.22)" : "rgba(0,179,119,0.28)",
        width: 1 as const,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: accent,
      },
    },
    rightPriceScale: {
      // Mobile hides the price axis entirely: the numbers on the right eat into
      // a narrow screen, and the level tags (Entry/SL/TP) already carry the
      // prices that matter. The candles get the full width instead.
      visible: !embedded,
      borderVisible: false,
      borderColor: "transparent",
      textColor: scaleText,
      scaleMargins: {
        top: embedded ? 0.08 : 0.1,
        bottom: embedded ? 0.08 : 0.06,
      },
      // Wide enough on mobile to be a comfortable drag target for scaling.
      minimumWidth: embedded ? 56 : 68,
      alignLabels: true,
      tickMarkDensity: embedded ? 5.5 : 3.5,
      entireTextOnly: embedded,
      ticksVisible: false,
    },
    timeScale: {
      borderVisible: false,
      borderColor: "transparent",
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: formatChartAxisTime,
      fixLeftEdge: true,
      rightOffset: embedded ? 4 : 6,
      ticksVisible: false,
      minimumHeight: embedded ? 28 : 22,
      allowBoldLabels: false,
    },
  };
}

function scrollChartToLatest(
  chart: IChartApi,
  series: CandleSeries,
  range: ChartRange,
) {
  if (!series.candles.length) return;

  // Bar-index range rather than a time window: it always frames a readable
  // number of the most recent candles and pins the newest one near the right,
  // whatever timeframe just loaded. A time window sized to the range selector
  // dropped the whole (capped) history onto the screen, compressed edge to
  // edge, and any leftover width threw the candles against the far-left side.
  const rightOffset = chart.timeScale().options().rightOffset ?? 6;
  const logicalRange = getLatestVisibleLogicalRange(
    series.candles,
    range,
    rightOffset,
  );
  if (logicalRange) {
    chart.timeScale().setVisibleLogicalRange(logicalRange);
  } else {
    chart.timeScale().fitContent();
  }
}

/**
 * A focused trade wins over the "jump to the latest candle" behaviour: opening
 * one from the dashboard is a request to look at where it was taken.
 *
 * Returns false when the trade starts before the loaded history. The view then
 * sits on the oldest bars, which is what makes the chart page more history in.
 */
function scrollChartToFocus(
  chart: IChartApi,
  series: CandleSeries,
  range: ChartRange,
  focusRange: ChartFocusRange | null,
) {
  const candleTimes = chartTimesOf(toChartCandles(series.candles));
  const first = candleTimes[0];
  const last = candleTimes.at(-1);

  if (!focusRange || first === undefined || last === undefined) {
    scrollChartToLatest(chart, series, range);
    return true;
  }

  const width = Math.max(focusRange.to - focusRange.from, 60);
  const from = Math.max(first, Math.min(focusRange.from, last - width));
  const to = Math.min(last, from + width);

  if (to <= from) {
    scrollChartToLatest(chart, series, range);
    return true;
  }

  chart
    .timeScale()
    .setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });

  return first <= focusRange.from;
}

interface LevelTag {
  key: string;
  /** Short name shown in the tag next to the price scale. */
  label: string;
  price: number;
  color: string;
  /** Text drawn on the coloured pill, picked for contrast against `color`. */
  textColor: string;
  dashed: boolean;
  lineWidth?: 1 | 2;
  onSelect?: () => void;
}

/**
 * Two levels are the same line on screen well before they are the same float:
 * an exit copied from a stop can still differ in the last bits.
 */
function samePrice(left: number, right: number) {
  return Math.abs(left - right) < 1e-7;
}

/**
 * Entry, stop, target and exit, in the order they are drawn and tagged. Every
 * level keeps one colour across the price line, its axis label and its tag so
 * the three always read as the same thing.
 */
/**
 * Moves a level from the price it executes at onto the price this chart draws.
 *
 * The candles are mid (`price: "M"` on the OANDA request) but nothing executes
 * at the mid. A long is entered on the ask and closed on the bid; a short is
 * the reverse. Drawn raw, a short's target sits half a spread above where the
 * ask can actually reach it, so the wick crosses the line while the order is
 * still short of triggering — which is exactly how a USD/CHF short looked
 * filled while the broker still held it 0.3 pips away.
 *
 * Positive `side` for levels that execute on the bid, negative on the ask.
 */
function toChartPrice(price: number, side: 1 | -1, halfSpread: number) {
  return price + side * halfSpread;
}

/**
 * Which planned level the trade closed on, or null for a trade still open or
 * closed away from both. The recorded outcome answers this; the prices only
 * stand in for trades stored before it was kept, where an exit was copied from
 * the level itself and does compare equal.
 */
function closingLevel(levels: SetupLevels): "stop" | "target" | null {
  if (levels.exit == null) return null;
  if (levels.outcome === "stop_first") return "stop";
  if (levels.outcome === "target_first") return "target";
  if (levels.outcome) return null;
  if (samePrice(levels.exit, levels.stop)) return "stop";
  if (samePrice(levels.exit, levels.target)) return "target";
  return null;
}

function plannedRewardR(levels: SetupLevels) {
  const risk = Math.abs(levels.entry - levels.stop);
  if (risk <= 0) return 0;
  return Math.abs(levels.target - levels.entry) / risk;
}

function setupLevelTags(
  levels: SetupLevels,
  isDark: boolean,
  halfSpread: number,
  instrument: string,
  compactLabels: boolean,
): LevelTag[] {
  // Long when the target sits above entry. The levels carry no direction of
  // their own, and this cannot be ambiguous: a stop and a target always
  // straddle the entry.
  const isLong = levels.target > levels.entry;
  // Entry executes on the opposite side to the exits.
  const entrySide: 1 | -1 = isLong ? -1 : 1;
  const exitSide: 1 | -1 = isLong ? 1 : -1;
  const rewardR = plannedRewardR(levels);
  const entryPrice = formatChartPrice(levels.entry, instrument);
  const stopPrice = formatChartPrice(levels.stop, instrument);
  const targetPrice = formatChartPrice(levels.target, instrument);
  const tags: LevelTag[] = [
    {
      key: "entry",
      label: compactLabels ? `Entry ${entryPrice} · R:R ${rewardR.toFixed(rewardR >= 10 ? 0 : 1)}` : `ENTRY ${entryPrice}`,
      price: toChartPrice(levels.entry, entrySide, halfSpread),
      color: isDark ? "rgba(0, 229, 155, 0.82)" : "#00a06a",
      textColor: isDark ? "#06281f" : "#ffffff",
      dashed: false,
    },
    {
      key: "stop",
      label: compactLabels ? `SL ${stopPrice} · -1R` : `STOP LOSS ${stopPrice} · -1R`,
      price: toChartPrice(levels.stop, exitSide, halfSpread),
      color: isDark ? "rgba(255, 99, 112, 0.88)" : "#e74c3c",
      textColor: "#ffffff",
      dashed: true,
    },
    {
      key: "target",
      label: compactLabels
        ? `TP ${targetPrice} · +${rewardR.toFixed(rewardR >= 10 ? 0 : 1)}R`
        : `TAKE PROFIT ${targetPrice} · +${rewardR.toFixed(rewardR >= 10 ? 0 : 1)}R`,
      price: toChartPrice(levels.target, exitSide, halfSpread),
      color: isDark ? "#00e59b" : "#00b377",
      textColor: isDark ? "#06281f" : "#ffffff",
      dashed: true,
    },
  ];

  // A stop_first or target_first trade left *on* one of those levels, and a fill
  // a tenth of a pip off the requested price is still that level being hit — an
  // Exit line of its own there is a second line the eye cannot separate from the
  // first. The level it left on is renamed instead and moved onto the fill, so
  // the tag reads what the header reads. The colour it already carries says how
  // it went: red on the stop, green on the target.
  const closedOn = closingLevel(levels);
  if (closedOn) {
    const hit = tags.find((tag) => tag.key === closedOn)!;
    hit.label = "Exit";
    if (levels.exit != null) hit.price = toChartPrice(levels.exit, exitSide, halfSpread);
  }

  // Only a close somewhere else — a session forced-close — earns its own level.
  if (levels.exit != null && !closedOn) {
    tags.push({
      key: "exit",
      label: "Exit",
      price: toChartPrice(levels.exit, exitSide, halfSpread),
      color: isDark ? "#64d2ff" : "#007aff",
      textColor: isDark ? "#09090b" : "#ffffff",
      dashed: true,
    });
  }

  return tags;
}

/**
 * Named overlays drawn on the pane: planned levels plus an optional binary
 * entry marker. Kept as one list so they share the same left-edge stacking.
 */
function overlayLevelTags(
  levels: SetupLevels | null,
  referenceLine: ChartReferenceLine | null,
  referenceLines: ChartReferenceLine[],
  isDark: boolean,
  halfSpread: number,
  instrument: string,
  compactLabels: boolean,
): LevelTag[] {
  const tags = levels
    ? setupLevelTags(levels, isDark, halfSpread, instrument, compactLabels)
    : [];
  for (const line of [referenceLine, ...referenceLines].filter((item): item is ChartReferenceLine => Boolean(item))) {
    tags.push({
      key: line.key ?? `reference-${tags.length}`,
      label: line.label,
      price: line.price,
      color: line.color,
      textColor: line.textColor,
      dashed: line.dashed ?? true,
      lineWidth: line.lineWidth ?? 2,
      onSelect: line.onSelect,
    });
  }
  return tags;
}

/** A level tag resolved to a pixel row, ready to be positioned. */
interface PlacedLevelTag extends LevelTag {
  y: number;
  /** The horizontal side where this tag is anchored. */
  edge: "left" | "right";
  /** Distance from the selected chart edge. */
  offset: number;
}

/** Flag chip height including padding — used to unstack overlapping levels. */
const LEVEL_TAG_HEIGHT = 18;
const LEVEL_TAG_STACK_GAP = 2;

/**
 * Nudge overlapping left-edge flags apart so Entry / SL / TP stay readable
 * when their prices sit on the same pixel row.
 */
function stackLevelTagYs(tags: PlacedLevelTag[], paneHeight: number): PlacedLevelTag[] {
  if (tags.length < 2) return tags;

  const sorted = [...tags].sort(
    (left, right) => left.y - right.y || left.key.localeCompare(right.key),
  );
  const minGap = LEVEL_TAG_HEIGHT + LEVEL_TAG_STACK_GAP;
  const half = LEVEL_TAG_HEIGHT / 2;
  const minY = half;
  const maxY = Math.max(minY, paneHeight - half);

  for (let i = 1; i < sorted.length; i++) {
    const floor = sorted[i - 1]!.y + minGap;
    if (sorted[i]!.y < floor) {
      sorted[i] = { ...sorted[i]!, y: floor };
    }
  }

  if (sorted[sorted.length - 1]!.y > maxY) {
    sorted[sorted.length - 1] = { ...sorted[sorted.length - 1]!, y: maxY };
    for (let i = sorted.length - 2; i >= 0; i--) {
      const ceiling = sorted[i + 1]!.y - minGap;
      if (sorted[i]!.y > ceiling) {
        sorted[i] = { ...sorted[i]!, y: ceiling };
      }
    }
  }

  if (sorted[0]!.y < minY) {
    sorted[0] = { ...sorted[0]!, y: minY };
    for (let i = 1; i < sorted.length; i++) {
      const floor = sorted[i - 1]!.y + minGap;
      if (sorted[i]!.y < floor) {
        sorted[i] = { ...sorted[i]!, y: floor };
      }
    }
  }

  return sorted;
}

function addSetupLevels(
  mainSeries: ISeriesApi<SeriesType>,
  tags: LevelTag[],
  axisLabels: boolean,
) {
  for (const tag of tags) {
    mainSeries.createPriceLine({
      price: tag.price,
      color: tag.color,
      lineWidth: tag.lineWidth ?? 1,
      lineStyle: tag.dashed ? LineStyle.Dashed : LineStyle.Solid,
      // Desktop: the price sits on the scale and the named flag sits on the
      // plot's right edge. Mobile hides the scale, so library axis chips would
      // float on the pane; the overlay flag is the name instead.
      //
      // No `title`: the library would paint the same word onto the pane, which
      // read as two tags on the wider labels. The short ones only looked
      // correct because the pair landed on top of each other.
      axisLabelVisible: axisLabels,
      axisLabelColor: tag.color,
      axisLabelTextColor: tag.textColor,
    });
  }
}

function addOverlayLine(
  chart: IChartApi,
  chartData: ReturnType<typeof toChartCandles>,
  values: (number | null)[],
  color: string,
  priceFormat: {
    type: "price";
    precision: number;
    minMove: number;
  },
) {
  const lineSeries = chart.addSeries(LineSeries, {
    color,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    priceFormat,
  });
  lineSeries.setData(toLinePoints(chartData, values));
}

function addPatternLines(
  chart: IChartApi,
  lines: ChartPatternLine[],
  priceFormat: {
    type: "price";
    precision: number;
    minMove: number;
  },
) {
  for (const line of lines) {
    const points = line.points.flatMap((point) => {
      const time = chartTimeValue(point);
      return time === null || !Number.isFinite(point.price)
        ? []
        : [{ time: time as UTCTimestamp, value: point.price }];
    });
    if (points.length < 2) continue;

    const series = chart.addSeries(LineSeries, {
      color: line.color,
      lineWidth: line.lineWidth ?? 1,
      lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat,
    });
    series.setData(points);
  }
}

function addOscillatorPane(
  chart: IChartApi,
  paneIndex: number,
  chartData: ReturnType<typeof toChartCandles>,
  values: (number | null)[],
  color: string,
  paneHeight: number,
  levels?: number[],
) {
  const pane = chart.panes()[paneIndex];
  pane?.setHeight(paneHeight);

  const lineSeries = chart.addSeries(
    LineSeries,
    {
      color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    },
    paneIndex,
  );
  lineSeries.setData(toLinePoints(chartData, values));

  levels?.forEach((level) => {
    lineSeries.createPriceLine({
      price: level,
      color: "rgba(113,113,122,0.35)",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
    });
  });
}

function mainSeriesDisplayOptions(
  priceFormat: {
    type: "price";
    precision: number;
    minMove: number;
  },
  levels: SetupLevels | null,
  embedded: boolean,
) {
  const plannedPrices = levels
    ? [levels.entry, levels.stop, levels.target, levels.exit]
        .filter((value): value is number => value !== null && value !== undefined)
    : [];

  return {
    priceFormat,
    // The mobile chart drops the last-price dot and the horizontal price line
    // that trailed it: with the right axis gone the line points at nothing, and
    // for line/area charts a pulsing beacon marks the latest price instead.
    lastValueVisible: !embedded,
    priceLineVisible: !embedded,
    priceLineColor: "",
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.Dotted,
    autoscaleInfoProvider: plannedPrices.length
      ? (original: () => AutoscaleInfo | null) => {
          const info = original();
          if (!info?.priceRange) return info;
          return {
            ...info,
            priceRange: {
              minValue: Math.min(info.priceRange.minValue, ...plannedPrices),
              maxValue: Math.max(info.priceRange.maxValue, ...plannedPrices),
            },
          };
        }
      : undefined,
  };
}

function chartTimeValue(point: { time?: unknown } | undefined) {
  const time = point?.time;

  if (typeof time === "number" && Number.isFinite(time)) {
    return time;
  }

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }

  if (
    time &&
    typeof time === "object" &&
    "year" in time &&
    "month" in time &&
    "day" in time
  ) {
    const businessDay = time as { year: number; month: number; day: number };
    return Math.floor(
      Date.UTC(businessDay.year, businessDay.month - 1, businessDay.day) /
        1000,
    );
  }

  return null;
}

function latestCandleChartTime(candles: Candle[]) {
  return chartTimeValue(toChartCandles(candles).at(-1));
}

/** Glue the last-bar endpoint dot to the latest candle in the same turn as a chart move. */
function paintLastPriceOverlay(args: {
  chart: IChartApi;
  mainSeries: ISeriesApi<SeriesType>;
  candles: Candle[];
  latestClose: number | null;
  width: number;
  height: number;
  host: HTMLElement;
  dot: HTMLElement;
}) {
  const { chart, mainSeries, candles, latestClose, width, height, host, dot } =
    args;

  if (!candles.length || width <= 0 || height <= 0) {
    host.hidden = true;
    return;
  }

  const lastIndex = candles.length - 1;
  const close = latestClose ?? candles[lastIndex]!.close;
  const rawX = chart.timeScale().logicalToCoordinate(lastIndex as Logical);
  const rawY = mainSeries.priceToCoordinate(close);
  const onScreen =
    rawX !== null && rawY !== null && rawX >= 0 && rawX <= width && rawY >= 0 && rawY <= height;
  if (!onScreen) {
    host.hidden = true;
    return;
  }

  host.hidden = false;
  dot.style.transform = `translate3d(${rawX}px, ${rawY}px, 0) translate(-50%, -50%)`;
}

export function SetupChart({
  series,
  levels,
  enabledIndicators,
  liveCandle,
  variant = "candle",
  range = "1M",
  height = 480,
  embedded = false,
  spreadPips,
  loadingOlder = false,
  onLoadOlder,
  scrollToLatestRevision,
  trades,
  focusTradeId = null,
  focusPrediction = null,
  focusRange = null,
  referenceLine = null,
  referenceLines = [],
  patternLines = [],
  showTradeMarkers = true,
  showTradePath = true,
  positionTool = null,
  onPositionToolChange,
  onPositionToolSubmit,
}: {
  series: CandleSeries;
  levels: SetupLevels | null;
  enabledIndicators: ChartIndicator[];
  liveCandle?: Candle | null;
  variant?: ChartVariant;
  range?: ChartRange;
  height?: number;
  embedded?: boolean;
  spreadPips?: number | null;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  scrollToLatestRevision: number;
  trades?: PaperChartTrade[];
  focusTradeId?: string | null;
  focusPrediction?: BinaryPrediction | null;
  focusRange?: ChartFocusRange | null;
  referenceLine?: ChartReferenceLine | null;
  referenceLines?: ChartReferenceLine[];
  patternLines?: ChartPatternLine[];
  showTradeMarkers?: boolean;
  showTradePath?: boolean;
  positionTool?: ChartPositionTool | null;
  onPositionToolChange?: (next: ChartPositionTool | null) => void;
  onPositionToolSubmit?: (tool: ChartPositionTool) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markerOutlinesRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const falseBreakoutMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const tradePathRef = useRef<ISeriesApi<"Line"> | null>(null);
  // Survives chart teardown so toggling indicators / redrawing price lines does
  // not throw the user back to the latest bars. Cleared after a successful
  // restore; left null on first mount so the chart still opens on the live edge.
  const preservedViewRef = useRef<{
    logical: LogicalRange | null;
    price: { from: number; to: number } | null;
  } | null>(null);
  const focusCoveredRef = useRef(true);
  const focusPagesRef = useRef(0);
  const hadFocusRef = useRef(false);
  const [chartEpoch, setChartEpoch] = useState(0);
  const [placedTags, setPlacedTags] = useState<PlacedLevelTag[]>([]);
  const lastPriceHostRef = useRef<HTMLDivElement>(null);
  const lastPriceDotRef = useRef<HTMLSpanElement>(null);
  const paintLastPriceRef = useRef<() => void>(() => {});
  const latestChartTimeRef = useRef<number | null>(
    latestCandleChartTime(series.candles),
  );
  // The price the beacon rides on. Tracked in a ref so the per-frame position
  // read never copies the whole series, and kept current by the live-tick and
  // data effects that already advance `latestChartTimeRef`.
  const latestCloseRef = useRef<number | null>(
    series.candles.at(-1)?.close ?? null,
  );
  // Chart width in pixels, kept current by the resize observer so the last-bar
  // beacon stays glued to the latest candle.
  const containerWidthRef = useRef(0);
  // True once a mobile gesture has taken manual control of the price scale
  // (auto-scaling off). Cleared when the view is reset to the latest candles,
  // which restores automatic price framing.
  /**
   * Half the live spread, in price. Held in a ref because the spread changes on
   * every tick and the level lines are built inside the chart-creation effect —
   * depending on it there would tear the chart down continuously. The lines are
   * placed with the spread current when they are drawn, which is close enough
   * for a sub-pip offset, and they are redrawn whenever the levels change.
   */
  const halfSpread =
    spreadPips === null || spreadPips === undefined || !Number.isFinite(spreadPips)
      ? 0
      : (spreadPips * pipSizeFor(series.instrument)) / 2;
  const halfSpreadRef = useRef(halfSpread);
  const loadingOlderRef = useRef(loadingOlder);
  const onLoadOlderRef = useRef(onLoadOlder);
  // The visible-range callback is registered once per chart, so it cannot read
  // candles through the closure without going stale as live data streams in.
  const candlesRef = useRef(series.candles);
  const prevFirstCandleTimeRef = useRef(series.candles[0]?.time ?? null);
  // Tracks the loaded granularity so a timeframe swap can be told apart from an
  // older-history prepend: they both change the first candle, but only a
  // prepend keeps the granularity, and only a prepend should anchor the view.
  const prevGranularityRef = useRef(series.granularity);
  const lastScrollRevisionRef = useRef(0);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  // Solid opaque candles: body, border, and wick share one hue so bars read
  // crisp against the dark chart (same treatment as the home mini-chart).
  const upColor = isDark ? "#00e59b" : "#00b377";
  const downColor = isDark ? "#ff5252" : "#e74c3c";
  const winPathColor = isDark ? "#a7f3d0" : "#047857";
  const lossPathColor = isDark ? "#ff3b5c" : "#a61b3d";
  const wickUpColor = upColor;
  const wickDownColor = downColor;
  /**
   * Area and line charts express the direction of the complete selected
   * period—not the bars currently in view. Panning must not change whether a
   * bearish chart is red or a bullish chart is green.
   */
  const isBearish =
    series.candles.length > 1 &&
    series.candles.at(-1)!.close < series.candles[0]!.close;
  const trendColor = isBearish ? downColor : upColor;
  const areaFill = isBearish
    ? {
        top: isDark ? "rgba(248,113,113,0.28)" : "rgba(231,76,60,0.24)",
        bottom: isDark ? "rgba(248,113,113,0)" : "rgba(231,76,60,0)",
      }
    : {
        top: isDark ? "rgba(0,214,143,0.28)" : "rgba(0,179,119,0.24)",
        bottom: isDark ? "rgba(0,214,143,0)" : "rgba(0,179,119,0)",
      };
  const surfaceColor = embedded
    ? isDark
      ? "#09090b"
      : "#ffffff"
    : isDark
      ? "#131315"
      : "#ffffff";
  const precision = pricePrecision(series.instrument);
  const axisPrecision = embedded
    ? compactAxisPricePrecision(series.instrument)
    : precision;
  // minMove tracks the precision actually in use, not the instrument's full
  // precision. The compact mobile axis drops a digit, and the mismatched pair
  // made the formatter emit prices like "1.0002" and "1.43.7" on the level and
  // crosshair labels while the axis ticks stayed correct.
  const priceFormat = useMemo(
    () => ({
      type: "price" as const,
      precision: axisPrecision,
      minMove: 10 ** -axisPrecision,
    }),
    [axisPrecision],
  );

  useEffect(() => {
    halfSpreadRef.current = halfSpread;
  }, [halfSpread]);

  useEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  }, [onLoadOlder]);

  useEffect(() => {
    candlesRef.current = series.candles;
  }, [series.candles]);

  const chartHeight = height;
  const shellHeight = height;
  // Recreate price-line primitives only when their identity or geometry changes.
  // Countdown text updates ride through the DOM overlay without resetting zoom.
  const referenceLinesShapeFingerprint = referenceLines
    .map((line) => `${line.key ?? ""}:${line.price}:${line.color}:${line.dashed ?? true}:${line.lineWidth ?? 2}`)
    .join("|");
  const patternLinesFingerprint = patternLines
    .map((line) => `${line.key}:${line.color}:${line.dashed ?? false}:${line.lineWidth ?? 1}:${line.points.map((point) => `${point.time}:${point.price}`).join(",")}`)
    .join("|");
  // Height is applied to the live chart rather than being a creation dependency:
  // rebuilding on a height change would reset the visible range.
  const chartHeightRef = useRef(chartHeight);

  useEffect(() => {
    chartHeightRef.current = chartHeight;
    chartRef.current?.applyOptions({ height: chartHeight });
  }, [chartHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !series.candles.length) return;

    // Pair / timeframe / range loads bump scrollToLatestRevision. Drop any
    // preserved viewport from the previous series so we open on the live edge
    // instead of restoring bar indices that belong to another dataset.
    if (scrollToLatestRevision > lastScrollRevisionRef.current) {
      preservedViewRef.current = null;
    }

    const chart = createChart(container, {
      ...chartTheme(isDark, embedded),
      width: container.clientWidth,
      height: chartHeightRef.current,
      handleScroll: embedded
        ? {
            // The mobile chart runs its own touch gesture layer
            // (`useChartTouchGestures`), so the library's touch panning is off;
            // mouse scrolling stays on for touch-laptop edge cases.
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: false,
            vertTouchDrag: false,
          }
        : {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            // Flipped on per gesture for drags that start on the price axis, so
            // the page still scrolls when a finger drags across the candles.
            vertTouchDrag: false,
          },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        // Native pinch only scales time and would fight the custom two-finger
        // price scaling, so it is disabled on mobile and handled by the hook.
        pinch: !embedded,
      },
    });

    chartRef.current = chart;
    mainSeriesRef.current = null;
    containerWidthRef.current = container.clientWidth;
    const chartData = toChartCandles(series.candles);
    latestChartTimeRef.current = chartTimeValue(chartData.at(-1));
    latestCloseRef.current = series.candles.at(-1)?.close ?? null;
    prevFirstCandleTimeRef.current = series.candles[0]?.time ?? null;
    const displayOptions = mainSeriesDisplayOptions(priceFormat, levels, embedded);

    let mainSeries: ISeriesApi<SeriesType>;

    switch (variant) {
      case "candle": {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor,
          downColor,
          borderVisible: true,
          borderUpColor: upColor,
          borderDownColor: downColor,
          wickUpColor,
          wickDownColor,
          ...displayOptions,
        });
        mainSeries.setData(chartData);
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "hollow": {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: surfaceColor,
          downColor: surfaceColor,
          borderVisible: true,
          borderUpColor: upColor,
          borderDownColor: downColor,
          wickUpColor,
          wickDownColor,
          ...displayOptions,
        });
        mainSeries.setData(chartData);
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "heikin": {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor,
          downColor,
          borderVisible: true,
          borderUpColor: upColor,
          borderDownColor: downColor,
          wickUpColor,
          wickDownColor,
          ...displayOptions,
        });
        mainSeries.setData(toHeikinAshiCandles(series.candles));
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "bar": {
        mainSeries = chart.addSeries(BarSeries, {
          upColor,
          downColor,
          ...displayOptions,
        });
        mainSeries.setData(chartData);
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "line": {
        mainSeries = chart.addSeries(LineSeries, {
          color: trendColor,
          lineWidth: 2,
          ...displayOptions,
        });
        mainSeries.setData(toCloseLine(series.candles));
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "area": {
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: trendColor,
          topColor: areaFill.top,
          bottomColor: areaFill.bottom,
          lineWidth: 2,
          ...displayOptions,
        });
        mainSeries.setData(toCloseLine(series.candles));
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "baseline": {
        mainSeries = chart.addSeries(BaselineSeries, {
          baseValue: { type: "price", price: series.candles[0]?.close ?? 0 },
          topLineColor: upColor,
          bottomLineColor: downColor,
          topFillColor1: isDark ? "rgba(0,214,143,0.28)" : "rgba(0,179,119,0.24)",
          topFillColor2: isDark ? "rgba(0,214,143,0.05)" : "rgba(0,179,119,0.05)",
          bottomFillColor1: isDark ? "rgba(255,71,87,0.24)" : "rgba(231,76,60,0.2)",
          bottomFillColor2: isDark ? "rgba(255,71,87,0.05)" : "rgba(231,76,60,0.05)",
          lineWidth: 2,
          ...displayOptions,
        });
        mainSeries.setData(toCloseLine(series.candles));
        mainSeriesRef.current = mainSeries;
        break;
      }
      default: {
        const unhandledVariant: never = variant;
        throw new Error(`Unsupported chart variant: ${unhandledVariant}`);
      }
    }

    const levelTags = overlayLevelTags(
      levels,
      referenceLine,
      referenceLines,
      isDark,
      halfSpreadRef.current,
      series.instrument,
      embedded,
    );
    if (levelTags.length) {
      addSetupLevels(mainSeries, levelTags, !embedded);
    }
    if (patternLines.length) {
      addPatternLines(chart, patternLines, priceFormat);
    }

    // The entry-to-exit segment is created with the chart, even when there is no
    // focused trade to draw yet. Adding a series later — after the candles have
    // been laid out — leaves the candlestick pane view resolving bar indices
    // that no longer exist, which throws "Value is null" on the next paint.
    // Only its data changes afterwards.
    const tradePath = chart.addSeries(LineSeries, {
      color: upColor,
      lineWidth: 3,
      lineStyle: LineStyle.LargeDashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: true,
      priceFormat,
    });
    const initialCandleTimes = chartTimesOf(chartData);
    const initialFocusTrade =
      trades?.find((trade) => trade.id === focusTradeId) ?? null;
    tradePath.setData(
      focusPrediction
        ? buildPredictionPath(initialCandleTimes, focusPrediction)
        : buildTradePath(initialCandleTimes, initialFocusTrade),
    );
    tradePathRef.current = tradePath;

    const closes = series.candles.map((candle) => candle.close);

    if (isChartIndicatorEnabled(enabledIndicators, "ema21")) {
      addOverlayLine(
        chart,
        chartData,
        calculateEma(closes, 21),
        upColor,
        priceFormat,
      );
    }
    if (isChartIndicatorEnabled(enabledIndicators, "ema50")) {
      addOverlayLine(
        chart,
        chartData,
        calculateEma(closes, 50),
        isDark ? "#c9a227" : "#b8860b",
        priceFormat,
      );
    }
    if (isChartIndicatorEnabled(enabledIndicators, "ema200")) {
      addOverlayLine(
        chart,
        chartData,
        calculateEma(closes, 200),
        isDark ? "#5e5ce6" : "#5856d6",
        priceFormat,
      );
    }

    if (isChartIndicatorEnabled(enabledIndicators, "breakout")) {
      // Part of the Breakout overlay: alongside the ceiling/floor levels, flag
      // failed breaks. A failed break up is bearish (down colour); a failed
      // break down is bullish (up colour). Detect on the real OHLC so
      // heikin/line variants still flag genuine fakeouts, and anchor arrows to
      // the trap candle. The plugin is kept in a ref (created even when empty)
      // so the live-candle effect can re-detect on every tick without a rebuild.
      const falseBreakoutMarkers = detectFalseBreakouts(chartData, {
        bullTrapColor: downColor,
        bearTrapColor: upColor,
      });
      falseBreakoutMarkersRef.current = createSeriesMarkers(
        mainSeries,
        falseBreakoutMarkers,
      );
    }

    let nextPaneIndex = 1;

    if (isChartIndicatorEnabled(enabledIndicators, "atr14")) {
      chart.addPane();
      addOscillatorPane(
        chart,
        nextPaneIndex,
        chartData,
        calculateAtr(series.candles, 14),
        isDark ? "#64d2ff" : "#007aff",
        64,
      );
      nextPaneIndex += 1;
    }

    if (isChartIndicatorEnabled(enabledIndicators, "rsi14")) {
      chart.addPane();
      addOscillatorPane(
        chart,
        nextPaneIndex,
        chartData,
        calculateRsi(closes, 14),
        isDark ? "#bf5af2" : "#af52de",
        72,
        [30, 70],
      );
    }

    // Prefer the pre-teardown viewport when this run is a soft rebuild (indicator
    // toggle, level redraw, theme). Fresh mounts and intentional "go to latest"
    // navigations leave preservedViewRef empty and fall through to focus scroll.
    const preserved = preservedViewRef.current;
    preservedViewRef.current = null;
    if (preserved?.logical) {
      try {
        chart.timeScale().setVisibleLogicalRange(preserved.logical);
        if (
          preserved.price
          && Number.isFinite(preserved.price.from)
          && Number.isFinite(preserved.price.to)
          && preserved.price.to > preserved.price.from
        ) {
          chart.priceScale("right").applyOptions({ autoScale: false });
          chart.priceScale("right").setVisibleRange(preserved.price);
        }
        focusCoveredRef.current = true;
      } catch {
        focusCoveredRef.current = scrollChartToFocus(chart, series, range, focusRange);
      }
    } else {
      focusCoveredRef.current = scrollChartToFocus(chart, series, range, focusRange);
    }
    setChartEpoch((value) => value + 1);

    const handleVisibleRangeChange = (logicalRange: LogicalRange | null) => {
      if (
        shouldLoadOlderHistory(logicalRange) &&
        !loadingOlderRef.current
      ) {
        onLoadOlderRef.current?.();
      }

    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    // Lightweight Charts gates price-axis touch scaling on the same
    // `vertTouchDrag` flag that decides whether a vertical drag anywhere on the
    // chart swallows the page scroll. The page has to keep scrolling, so the
    // flag is turned on only while a gesture that began on the axis is running.
    // The flag is read during touchmove, so setting it on touchstart is in time.
    const enableAxisDragIfOnAxis = (event: TouchEvent) => {
      // Two fingers is a pinch/scale gesture the chart handles natively. Arming
      // the price-axis vertical drag underneath it makes the pinch fight a
      // simultaneous price rescale, so the axis drag is only ever armed for a
      // single finger and is released the moment a second one lands.
      if (event.touches.length !== 1) {
        chart.applyOptions({ handleScroll: { vertTouchDrag: false } });
        return;
      }

      const touch = event.touches[0];
      if (!touch) return;

      const onAxis =
        touch.clientX >=
        container.getBoundingClientRect().right -
          chart.priceScale("right").width();

      chart.applyOptions({ handleScroll: { vertTouchDrag: onAxis } });
    };
    const disableAxisDrag = () => {
      chart.applyOptions({ handleScroll: { vertTouchDrag: false } });
    };

    // Desktop / touch-laptop only: on mobile the gesture hook handles price
    // scaling, so this axis-drag arming is skipped there.
    if (!embedded) {
      container.addEventListener("touchstart", enableAxisDragIfOnAxis, {
        capture: true,
        passive: true,
      });
      container.addEventListener("touchend", disableAxisDrag, { capture: true });
      container.addEventListener("touchcancel", disableAxisDrag, {
        capture: true,
      });
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      containerWidthRef.current = entry.contentRect.width;
      chart.applyOptions({
        width: entry.contentRect.width,
        height: chartHeightRef.current,
      });
    });
    resizeObserver.observe(container);

    return () => {
      // Snapshot the view before destroy so the next create can restore it.
      // Indicator toggles rebuild this effect; without this, the chart always
      // re-opens on the live edge and feels like it "reset".
      preservedViewRef.current = {
        logical: chart.timeScale().getVisibleLogicalRange(),
        price: chart.priceScale("right").getVisibleRange(),
      };
      chart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      container.removeEventListener("touchstart", enableAxisDragIfOnAxis, {
        capture: true,
      });
      container.removeEventListener("touchend", disableAxisDrag, {
        capture: true,
      });
      container.removeEventListener("touchcancel", disableAxisDrag, {
        capture: true,
      });
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      // Both are owned by the removed chart, so they only need to be forgotten.
      markerOutlinesRef.current = null;
      markersRef.current = null;
      falseBreakoutMarkersRef.current = null;
      tradePathRef.current = null;
      latestChartTimeRef.current = null;
    };
  // The chart instance is intentionally not recreated for every candle update.
  // Candle data is pushed through the data effect below so live ticks stay cheap.
  //
  // `levels` is depended on by value rather than by identity. Callers rebuild
  // that object whenever polled data arrives, and an identity dependency tore
  // the whole chart down on every tick for any instrument holding an open
  // trade, throwing away the user's zoom and scroll position mid-gesture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.instrument, levels?.entry, levels?.stop, levels?.target, levels?.exit, levels?.outcome, referenceLine?.price, referenceLine?.label, referenceLine?.color, referenceLine?.textColor, referenceLinesShapeFingerprint, patternLinesFingerprint, enabledIndicators, variant, isDark, priceFormat, upColor, downColor, wickUpColor, wickDownColor, surfaceColor, embedded]);

  useEffect(() => {
    const chart = chartRef.current;
    const mainSeries = mainSeriesRef.current;
    if (!mainSeries || !series.candles.length) return;

    const prevFirstTime = prevFirstCandleTimeRef.current;
    const nextFirstTime = series.candles[0]?.time ?? null;
    const granularityChanged = series.granularity !== prevGranularityRef.current;
    const scrolledToLatest =
      scrollToLatestRevision > lastScrollRevisionRef.current;
    // Only a same-timeframe older-history page is a real prepend. A timeframe or
    // range switch replaces the whole dataset (new granularity, and the parent
    // bumps the scroll revision), and counting its unfamiliar bars as
    // "prepended" is what anchored the viewport off the end and threw the
    // candles to the far left. Those swaps fall through to the scroll-to-latest
    // branch below instead.
    const isHistoryPrepend =
      !granularityChanged &&
      !scrolledToLatest &&
      nextFirstTime !== prevFirstTime;
    const prependedCount = isHistoryPrepend
      ? countPrependedCandles(series.candles, prevFirstTime)
      : 0;
    const logicalRange =
      prependedCount > 0
        ? chart?.timeScale().getVisibleLogicalRange()
        : null;
    const nextLatestTime = latestCandleChartTime(series.candles);

    switch (variant) {
      case "candle":
      case "hollow":
      case "bar":
        mainSeries.setData(toChartCandles(series.candles));
        break;
      case "heikin":
        mainSeries.setData(toHeikinAshiCandles(series.candles));
        break;
      case "line":
      case "area":
      case "baseline":
        mainSeries.setData(toCloseLine(series.candles));
        break;
      default: {
        const unhandledVariant: never = variant;
        throw new Error(`Unsupported chart variant: ${unhandledVariant}`);
      }
    }

    if (
      prependedCount > 0 &&
      chart &&
      focusRange &&
      !focusCoveredRef.current &&
      focusPagesRef.current < MAX_FOCUS_HISTORY_PAGES
    ) {
      // The focused trade is still older than the first loaded candle, so keep
      // walking the viewport back through each new page until it comes into view.
      focusPagesRef.current += 1;
      focusCoveredRef.current = scrollChartToFocus(
        chart,
        series,
        range,
        focusRange,
      );
    } else if (prependedCount > 0 && logicalRange && chart) {
      // Preserve the exact candles currently under the user's pointer. Older
      // data is requested well before the edge, so this anchor does not make
      // panning feel blocked while a history page is appended.
      chart
        .timeScale()
        .setVisibleLogicalRange(
          anchorRangeAfterPrepend(logicalRange, prependedCount),
        );
    } else if (scrolledToLatest && chart) {
      lastScrollRevisionRef.current = scrollToLatestRevision;
      requestAnimationFrame(() => {
        focusCoveredRef.current = scrollChartToFocus(
          chart,
          series,
          range,
          focusRange,
        );
      });
    }

    prevFirstCandleTimeRef.current = nextFirstTime;
    prevGranularityRef.current = series.granularity;
    latestChartTimeRef.current = nextLatestTime;
    latestCloseRef.current = series.candles.at(-1)?.close ?? null;
  }, [focusRange, range, scrollToLatestRevision, series, variant]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !series.candles.length) return;

    if (!focusRange) {
      // Clearing the focused trade hands the chart back to the live view.
      if (hadFocusRef.current) {
        hadFocusRef.current = false;
        scrollChartToLatest(chart, series, range);
      }
      return;
    }

    hadFocusRef.current = true;
    focusPagesRef.current = 0;
    focusCoveredRef.current = scrollChartToFocus(chart, series, range, focusRange);
  // Candles are deliberately excluded: re-running this on every new bar would
  // drag the viewport back while the user is panning.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, focusRange]);

  useEffect(() => {
    const chart = chartRef.current;
    const mainSeries = mainSeriesRef.current;
    const tradePath = tradePathRef.current;
    if (!chart || !mainSeries || !tradePath) return;

    const candleTimes = chartTimesOf(toChartCandles(series.candles));
    const palette: TradeMarkerPalette = {
      long: upColor,
      short: downColor,
      win: upColor,
      loss: downColor,
      // Translucent so the candles read through the arrow rather than the
      // arrow competing with them.
      muted: isDark ? "rgba(161,161,170,0.45)" : "rgba(142,142,147,0.5)",
    };
    // Prediction focus owns the markers when present; otherwise the focused
    // paper trade. Both reuse the same path series so arrows sit on exact
    // entry/exit prices rather than candle highs/lows.
    const markers = !showTradeMarkers
      ? []
      : focusPrediction
      ? buildPredictionMarkers(candleTimes, focusPrediction, palette)
      : buildTradeMarkers(
          candleTimes,
          trades ?? [],
          focusTradeId,
          palette,
        );
    const markerOutlines = markers.map((marker) => ({
      ...marker,
      id: marker.id ? `outline:${marker.id}` : undefined,
      color: surfaceColor,
      size: (marker.size ?? 1) + 0.5,
      text: undefined,
    }));

    if (markerOutlinesRef.current) {
      markerOutlinesRef.current.setMarkers(markerOutlines);
    } else {
      // Lightweight Charts has no marker stroke option. A slightly larger
      // surface-coloured marker under the fill creates a crisp, thin outline.
      markerOutlinesRef.current = createSeriesMarkers(tradePath, markerOutlines);
    }

    if (markersRef.current) {
      markersRef.current.setMarkers(markers);
    } else {
      // Anchor the arrows to the trade's exact entry/exit prices. Attaching
      // them to the candle series makes aboveBar/belowBar use candle extremes,
      // so price-scale zoom can leave an arrow floating far from the fill.
      markersRef.current = createSeriesMarkers(tradePath, markers);
    }

    const focusTrade =
      trades?.find((trade) => trade.id === focusTradeId) ?? null;
    const pathWon = focusPrediction
      ? focusPrediction.result !== "lost"
      : (focusTrade?.resultR ?? 0) >= 0;

    tradePath.applyOptions({
      color: pathWon ? winPathColor : lossPathColor,
    });
    tradePath.setData(
      !showTradePath
        ? []
        : focusPrediction
        ? buildPredictionPath(candleTimes, focusPrediction)
        : buildTradePath(candleTimes, focusTrade),
    );
  }, [chartEpoch, downColor, focusPrediction, focusTradeId, isDark, lossPathColor, series.candles, showTradeMarkers, showTradePath, surfaceColor, trades, upColor, winPathColor]);

  useEffect(() => {
    const mainSeries = mainSeriesRef.current;
    if (!mainSeries || !liveCandle) return;

    const updateIfCurrent = (
      point: { time?: unknown } | undefined,
      update: () => void,
    ) => {
      const pointTime = chartTimeValue(point);
      const latestTime = latestChartTimeRef.current;

      if (pointTime === null) return;
      if (latestTime !== null && pointTime < latestTime) return;

      try {
        update();
        latestChartTimeRef.current =
          latestTime === null ? pointTime : Math.max(latestTime, pointTime);
        latestCloseRef.current = liveCandle.close;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Cannot update oldest data")
        ) {
          return;
        }

        throw error;
      }
    };

    switch (variant) {
      case "candle":
      case "hollow": {
        const [point] = toChartCandles([liveCandle]);
        updateIfCurrent(point, () => {
          (mainSeries as ISeriesApi<"Candlestick">).update(point);
        });
        break;
      }
      case "bar": {
        const [point] = toChartCandles([liveCandle]);
        updateIfCurrent(point, () => {
          (mainSeries as ISeriesApi<"Bar">).update(point);
        });
        break;
      }
      case "heikin": {
        const [point] = toChartCandles([liveCandle]);
        const candles =
          series.candles.at(-1)?.time === liveCandle.time
            ? [...series.candles.slice(0, -1), liveCandle]
            : [...series.candles, liveCandle];
        updateIfCurrent(point, () => {
          mainSeries.setData(toHeikinAshiCandles(candles));
        });
        break;
      }
      case "line":
      case "area": {
        const [point] = toCloseLine([liveCandle]);
        updateIfCurrent(point, () => {
          (mainSeries as ISeriesApi<"Line" | "Area">).update(point);
        });
        break;
      }
      case "baseline": {
        const [point] = toCloseLine([liveCandle]);
        updateIfCurrent(point, () => {
          (mainSeries as ISeriesApi<"Baseline">).update(point);
        });
        break;
      }
      default: {
        const unhandledVariant: never = variant;
        throw new Error(`Unsupported chart variant: ${unhandledVariant}`);
      }
    }

    if (
      isChartIndicatorEnabled(enabledIndicators, "breakout") &&
      falseBreakoutMarkersRef.current
    ) {
      // Real-time detection: re-run on every live tick so a fakeout is flagged
      // the instant the forming candle closes back inside the range — and
      // cleared again if price pushes back through before the bar closes. Uses
      // the real OHLC with the live candle merged onto the last bar.
      const merged =
        series.candles.at(-1)?.time === liveCandle.time
          ? [...series.candles.slice(0, -1), liveCandle]
          : [...series.candles, liveCandle];
      falseBreakoutMarkersRef.current.setMarkers(
        detectFalseBreakouts(toChartCandles(merged), {
          bullTrapColor: downColor,
          bearTrapColor: upColor,
        }),
      );
    }
  }, [enabledIndicators, liveCandle, series.candles, variant, downColor, upColor]);

  useEffect(() => {
    chartRef.current?.applyOptions(chartTheme(isDark, embedded));
  }, [embedded, isDark]);

  /** Keep the overall trend color current without rebuilding the chart. */
  useEffect(() => {
    if (variant === "line") {
      mainSeriesRef.current?.applyOptions({ color: trendColor });
    } else if (variant === "area") {
      mainSeriesRef.current?.applyOptions({
        lineColor: trendColor,
        topColor: areaFill.top,
        bottomColor: areaFill.bottom,
      });
    }
  }, [variant, trendColor, areaFill.top, areaFill.bottom]);

  // Last-bar marker for mobile line/area charts: a ringed endpoint on the
  // latest candle. The numeric right-edge price flag is gone; SL / Entry / TP
  // flags own that edge.
  const showBeacon =
    embedded &&
    (variant === "line" || variant === "area" || variant === "baseline");

  // Fingerprint only — never spread levels or optional referenceLine fields into
  // the effect deps. Optional slots change the array length (5 vs 8) and React
  // throws. The loop still reads `levels` / `referenceLine` from this render.
  const overlayTagFingerprint = [
    series.instrument,
    embedded ? "compact" : "full",
    levels?.entry ?? "",
    levels?.stop ?? "",
    levels?.target ?? "",
    levels?.exit ?? "",
    levels?.outcome ?? "",
    referenceLine?.price ?? "",
    referenceLine?.label ?? "",
    referenceLine?.color ?? "",
    referenceLine?.textColor ?? "",
    ...referenceLines.flatMap((line) => [line.key ?? "", line.price, line.label, line.color, line.textColor]),
  ].join("\0");

  // The named level tags ride along with the price scale, which the user can
  // now drag and pinch. The library exposes no "price scale changed" event, so
  // their positions are re-read each frame and only written back to React when
  // something actually moved.
  useEffect(() => {
    const tags = overlayLevelTags(
      levels,
      referenceLine,
      referenceLines,
      isDark,
      halfSpreadRef.current,
      series.instrument,
      embedded,
    );
    let frame = 0;
    let previous = "";

    const readPositions = () => {
      frame = requestAnimationFrame(readPositions);

      const chart = chartRef.current;
      const mainSeries = mainSeriesRef.current;
      if (!chart || !mainSeries) return;

      const paneHeight = chartHeightRef.current;
      const priceRange = chart.priceScale("right").getVisibleRange();
      const minTagY = LEVEL_TAG_HEIGHT / 2;
      const maxTagY = Math.max(minTagY, paneHeight - minTagY);
      const placed = tags.flatMap<PlacedLevelTag>((tag) => {
        let y: number | null = mainSeries.priceToCoordinate(tag.price);
        if (y === null && priceRange && priceRange.to > priceRange.from) {
          // Lightweight Charts only returns a coordinate for a visible price.
          // Project an off-screen level onto the pane so its flag can remain
          // visible, clamped to the nearest vertical boundary.
          y = ((priceRange.to - tag.price) / (priceRange.to - priceRange.from)) * paneHeight;
        }
        if (y === null) return [];
        // Keep an off-screen level visible at the top/bottom rather than
        // dropping it or allowing a corner keepout to shift it inward.
        return [{
          ...tag,
          y: Math.min(Math.max(y, minTagY), maxTagY),
          edge: "left",
          offset: 8,
        }];
      });

      const stacked = stackLevelTagYs(placed, paneHeight);
      const signature = JSON.stringify(stacked);
      if (signature === previous) return;
      previous = signature;
      setPlacedTags(stacked);
    };

    frame = requestAnimationFrame(readPositions);
    return () => cancelAnimationFrame(frame);
    // overlayTagFingerprint stands in for levels + referenceLine field values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartEpoch, isDark, overlayTagFingerprint]);

  // Positions are written straight to the DOM — React setState lagged a frame
  // behind the canvas whenever the user panned.
  useEffect(() => {
    const paint = () => {
      const chart = chartRef.current;
      const mainSeries = mainSeriesRef.current;
      const host = lastPriceHostRef.current;
      const dot = lastPriceDotRef.current;
      if (!showBeacon || !chart || !mainSeries || !host || !dot) {
        if (host) host.hidden = true;
        return;
      }

      paintLastPriceOverlay({
        chart,
        mainSeries,
        candles: candlesRef.current,
        latestClose: latestCloseRef.current,
        width: containerWidthRef.current,
        height: chartHeightRef.current,
        host,
        dot,
      });
    };

    paintLastPriceRef.current = paint;
    if (!showBeacon) {
      paint();
      return;
    }

    paint();

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      paint();
    };
    frame = requestAnimationFrame(loop);

    const timeScale = chartRef.current?.timeScale();
    timeScale?.subscribeVisibleLogicalRangeChange(paint);

    const container = containerRef.current;
    const resizeObserver =
      container &&
      new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) containerWidthRef.current = entry.contentRect.width;
        paint();
      });
    if (container && resizeObserver) resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      timeScale?.unsubscribeVisibleLogicalRangeChange(paint);
      resizeObserver?.disconnect();
    };
  }, [chartEpoch, showBeacon]);

  // Mobile supports only history panning and pinch-to-zoom. Desktop input is
  // untouched. Re-binds to the freshly built chart via `chartEpoch`.
  useChartTouchGestures({
    containerRef,
    chartRef,
    enabled: embedded,
    epoch: chartEpoch,
    onViewChange: () => paintLastPriceRef.current(),
  });

  if (!series.candles.length) {
    return (
      <div
        className="grid place-items-center bg-[color:var(--surface)] text-sm text-[color:var(--muted)]"
        style={{ height }}
      >
        No candle data available.
      </div>
    );
  }

  const showSpreadWarning =
    isChartIndicatorEnabled(enabledIndicators, "spread-filter") &&
    spreadPips !== null &&
    spreadPips !== undefined &&
    spreadPips > 2;
  const activeFilters = [
    isChartIndicatorEnabled(enabledIndicators, "spread-filter") && {
      label: showSpreadWarning ? "Spread wide" : "Spread filter",
      tone: showSpreadWarning ? "danger" : "neutral",
    },
    isChartIndicatorEnabled(enabledIndicators, "session-filter") && {
      label: "Session filter",
      tone: "accent",
    },
    isChartIndicatorEnabled(enabledIndicators, "news-filter") && {
      label: "News filter",
      tone: "accent",
    },
  ].filter(Boolean) as Array<{ label: string; tone: "neutral" | "accent" | "danger" }>;

  const lastPriceRing = isDark ? "#09090b" : "#ffffff";

  return (
    <div
      className="setup-chart-root relative w-full overflow-visible"
      style={{ height: shellHeight }}
      /*
       * The chart owns direct touch input so horizontal panning and pinch zoom
       * cannot trigger pull-to-refresh or browser navigation mid-gesture.
       */
      data-pull-to-refresh-ignore="true"
    >
      <div
        ref={containerRef}
        className={`w-full overflow-visible ${
          embedded
            ? "setup-chart-touch bg-[color:var(--signals-mobile-page-bg)] dark:bg-[#0b0b0d] lg:bg-[color:var(--background)]"
            : "bg-transparent"
        }`}
        style={{ height: chartHeight }}
        aria-label={`${series.instrument.replace("_", "/")} setup chart`}
        data-candle-count={series.candles.length}
        data-latest-candle-time={
          liveCandle?.time ?? series.candles.at(-1)?.time
        }
        data-latest-candle-close={
          liveCandle?.close ?? series.candles.at(-1)?.close
        }
      />
      {showBeacon ? (
        <div
          ref={lastPriceHostRef}
          className="setup-chart-last-price"
          hidden
          style={
            {
              "--beacon-color": trendColor,
              "--beacon-ring": lastPriceRing,
            } as CSSProperties
          }
        >
          <span ref={lastPriceDotRef} className="setup-chart-beacon" />
        </div>
      ) : null}
      {placedTags.map((tag) => (
        <button
          type="button"
          key={tag.key}
          className={`setup-chart-level-tag is-${tag.edge}`}
          style={{
            top: tag.y,
            ...(tag.edge === "left" ? { left: tag.offset } : { right: tag.offset }),
            color: tag.color,
          }}
          onClick={tag.onSelect}
          disabled={!tag.onSelect}
        >
          {tag.label}
        </button>
      ))}
      {positionTool && onPositionToolChange ? (
        <PositionToolOverlay
          chartRef={chartRef}
          mainSeriesRef={mainSeriesRef}
          chartEpoch={chartEpoch}
          tool={positionTool}
          onChange={onPositionToolChange}
          onClear={() => onPositionToolChange(null)}
          onSubmit={onPositionToolSubmit}
        />
      ) : null}
      <ChartPriceScaleRail
        chartRef={chartRef}
        onViewChange={() => paintLastPriceRef.current()}
      />
      {activeFilters.length > 0 ? (
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">
          {activeFilters.map((filter) => (
            <span
              key={filter.label}
              className={`rounded-full px-2.5 py-1 text-xs font-semibold backdrop-blur-sm ${
                filter.tone === "danger"
                  ? "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
                  : filter.tone === "accent"
                    ? "badge-accent"
                    : "bg-[color:var(--surface-raised)]/90 text-[color:var(--muted-strong)]"
              }`}
            >
              {filter.label}
            </span>
          ))}
        </div>
      ) : null}
      <ChartHistoryLoader visible={loadingOlder} />
    </div>
  );
}
