"use client";

import { useEffect, useMemo, useRef } from "react";
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
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesType,
  type DeepPartial,
  type TimeChartOptions,
} from "lightweight-charts";
import {
  calculateAtr,
  calculateEma,
  calculateRsi,
  compactAxisPricePrecision,
  countPrependedCandles,
  getVisibleRangeFromCandles,
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
} from "@/lib/chart-utils";
import { ChartHistoryLoader } from "@/components/charts/chart-loading-overlay";
import { precisionFor } from "@/lib/instruments/catalog";
import type { Candle, CandleSeries } from "@/types/forex";

interface SetupLevels {
  entry: number;
  stop: number;
  target: number;
}

// Lightweight Charts reserves space for the desktop time scale via minimumHeight.
function chartTheme(
  isDark: boolean,
  embedded = false,
): DeepPartial<TimeChartOptions> {
  const background = embedded
    ? isDark
      ? "#09090b"
      : "#ffffff"
    : isDark
      ? "#131315"
      : "#ffffff";
  const scaleText = isDark ? "#71717a" : "#8e8e93";
  const accent = isDark ? "#00e59b" : "#00b377";
  const gridLine = embedded
    ? "transparent"
    : isDark
      ? "rgba(255,255,255,0.04)"
      : "rgba(0,0,0,0.04)";

  return {
    layout: {
      background: { type: ColorType.Solid, color: background },
      textColor: scaleText,
      fontFamily:
        '"Geist Mono", "Geist Mono Fallback", ui-monospace, monospace',
      fontSize: 9,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: gridLine },
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
      borderVisible: false,
      borderColor: "transparent",
      textColor: scaleText,
      scaleMargins: {
        top: embedded ? 0.14 : 0.1,
        bottom: embedded ? 0.1 : 0.06,
      },
      minimumWidth: embedded ? 40 : 68,
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
      fixLeftEdge: true,
      rightOffset: embedded ? 4 : 6,
      ticksVisible: false,
      minimumHeight: embedded ? 28 : 46,
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

  const visibleRange = getVisibleRangeFromCandles(series.candles, range);
  if (visibleRange) {
    chart.timeScale().setVisibleRange(visibleRange);
  } else {
    chart.timeScale().fitContent();
  }

  chart.timeScale().scrollToRealTime();
}

function addSetupLevels(
  mainSeries: ISeriesApi<SeriesType>,
  levels: SetupLevels,
  isDark: boolean,
  showAxisLabels: boolean,
) {
  mainSeries.createPriceLine({
    price: levels.entry,
    color: isDark ? "rgba(255,255,255,0.42)" : "rgba(28,28,30,0.5)",
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    axisLabelVisible: showAxisLabels,
    title: "Entry",
  });
  mainSeries.createPriceLine({
    price: levels.stop,
    color: isDark ? "rgba(248,113,113,0.72)" : "rgba(231,76,60,0.72)",
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    axisLabelVisible: showAxisLabels,
    title: "Stop",
  });
  mainSeries.createPriceLine({
    price: levels.target,
    color: isDark ? "rgba(0,229,155,0.72)" : "rgba(0,179,119,0.72)",
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    axisLabelVisible: showAxisLabels,
    title: "Target",
  });
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
) {
  return {
    priceFormat,
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineColor: "",
    priceLineWidth: 1 as const,
    priceLineStyle: LineStyle.Dotted,
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
}: {
  series: CandleSeries;
  levels: SetupLevels;
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const latestChartTimeRef = useRef<number | null>(
    latestCandleChartTime(series.candles),
  );
  const loadingOlderRef = useRef(loadingOlder);
  const onLoadOlderRef = useRef(onLoadOlder);
  const prevFirstCandleTimeRef = useRef(series.candles[0]?.time ?? null);
  const lastScrollRevisionRef = useRef(0);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const upColor = isDark ? "#00e59b" : "#00b377";
  const downColor = isDark ? "#f87171" : "#e74c3c";
  const wickUpColor = isDark ? "#00c488" : "#009966";
  const wickDownColor = isDark ? "#e85d6a" : "#d64545";
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
  const priceFormat = useMemo(
    () => ({
      type: "price" as const,
      precision: axisPrecision,
      minMove: 10 ** -precisionFor(series.instrument),
    }),
    [axisPrecision, series.instrument],
  );

  useEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  }, [onLoadOlder]);

  const chartHeight = height;
  const shellHeight = height;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !series.candles.length) return;

    const chart = createChart(container, {
      ...chartTheme(isDark, embedded),
      width: container.clientWidth,
      height: chartHeight,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    chartRef.current = chart;
    mainSeriesRef.current = null;
    const chartData = toChartCandles(series.candles);
    latestChartTimeRef.current = chartTimeValue(chartData.at(-1));
    prevFirstCandleTimeRef.current = series.candles[0]?.time ?? null;
    const displayOptions = mainSeriesDisplayOptions(priceFormat);

    let mainSeries: ISeriesApi<SeriesType>;

    switch (variant) {
      case "candle": {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor,
          downColor,
          borderVisible: false,
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
          borderVisible: false,
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
          color: upColor,
          lineWidth: 2,
          ...displayOptions,
        });
        mainSeries.setData(toCloseLine(series.candles));
        mainSeriesRef.current = mainSeries;
        break;
      }
      case "area": {
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: upColor,
          topColor: isDark ? "rgba(0,214,143,0.28)" : "rgba(0,179,119,0.24)",
          bottomColor: isDark ? "rgba(0,214,143,0)" : "rgba(0,179,119,0)",
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

    addSetupLevels(mainSeries, levels, isDark, !embedded);

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

    scrollChartToLatest(chart, series, range);

    const handleVisibleRangeChange = (logicalRange: LogicalRange | null) => {
      if (
        shouldLoadOlderHistory(logicalRange) &&
        !loadingOlderRef.current
      ) {
        onLoadOlderRef.current?.();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({
        width: entry.contentRect.width,
        height: chartHeight,
      });
    });
    resizeObserver.observe(container);

    return () => {
      chart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
      latestChartTimeRef.current = null;
    };
  // The chart instance is intentionally not recreated for every candle update.
  // Candle data is pushed through the data effect below so live ticks stay cheap.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.instrument, levels, enabledIndicators, variant, isDark, chartHeight, priceFormat, upColor, downColor, wickUpColor, wickDownColor, surfaceColor, embedded]);

  useEffect(() => {
    const chart = chartRef.current;
    const mainSeries = mainSeriesRef.current;
    if (!mainSeries || !series.candles.length) return;

    const prevFirstTime = prevFirstCandleTimeRef.current;
    const nextFirstTime = series.candles[0]?.time ?? null;
    const prependedCount =
      nextFirstTime !== prevFirstTime
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

    if (prependedCount > 0 && logicalRange && chart) {
      // Preserve the exact candles currently under the user's pointer. Older
      // data is requested well before the edge, so this anchor does not make
      // panning feel blocked while a history page is appended.
      chart
        .timeScale()
        .setVisibleLogicalRange(
          anchorRangeAfterPrepend(logicalRange, prependedCount),
        );
    } else if (
      scrollToLatestRevision > lastScrollRevisionRef.current &&
      chart
    ) {
      lastScrollRevisionRef.current = scrollToLatestRevision;
      requestAnimationFrame(() => {
        scrollChartToLatest(chart, series, range);
      });
    }

    prevFirstCandleTimeRef.current = nextFirstTime;
    latestChartTimeRef.current = nextLatestTime;
  }, [range, scrollToLatestRevision, series, variant]);

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
  }, [liveCandle, series.candles, variant]);

  useEffect(() => {
    chartRef.current?.applyOptions(chartTheme(isDark, embedded));
  }, [embedded, isDark]);

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

  return (
    <div
      className="setup-chart-root relative w-full overflow-visible"
      style={{ height: shellHeight }}
    >
      <div
        ref={containerRef}
        className={`w-full overflow-visible ${
          embedded
            ? "bg-[color:var(--signals-mobile-page-bg)] dark:bg-[#09090b] lg:bg-[color:var(--background)]"
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
