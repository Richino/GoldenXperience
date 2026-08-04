import type {
  CandlestickData,
  LineData,
  SeriesMarker,
  UTCTimestamp,
} from "lightweight-charts";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { Candle, MajorInstrument, PaperChartTrade } from "@/types/forex";

export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const;

export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

export const CHART_RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y", "All"] as const;

export const MOBILE_CHART_RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y"] as const;

export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_VARIANTS = [
  { value: "candle", label: "Candles" },
  { value: "hollow", label: "Hollow candles" },
  { value: "heikin", label: "Heikin Ashi" },
  { value: "bar", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "baseline", label: "Baseline" },
] as const;

export type ChartVariant = (typeof CHART_VARIANTS)[number]["value"];

export const CHART_INDICATORS = [
  { value: "ema21", label: "EMA 21", group: "overlay" },
  { value: "ema50", label: "EMA 50", group: "overlay" },
  { value: "ema200", label: "EMA 200", group: "overlay" },
  { value: "atr14", label: "ATR 14", group: "overlay" },
  { value: "rsi14", label: "RSI 14", group: "overlay" },
  { value: "spread-filter", label: "Spread filter", group: "filter" },
  { value: "session-filter", label: "Session filter", group: "filter" },
  { value: "news-filter", label: "News filter", group: "filter" },
] as const;

export type ChartIndicator = (typeof CHART_INDICATORS)[number]["value"];

export const DEFAULT_CHART_INDICATORS: ChartIndicator[] = [];

export function isChartIndicatorEnabled(
  enabled: ChartIndicator[],
  indicator: ChartIndicator,
) {
  return enabled.includes(indicator);
}

export function toggleChartIndicator(
  enabled: ChartIndicator[],
  indicator: ChartIndicator,
) {
  return enabled.includes(indicator)
    ? enabled.filter((item) => item !== indicator)
    : [...enabled, indicator];
}

export const TIMEFRAME_TO_GRANULARITY: Record<ChartTimeframe, string> = {
  "1m": "M1",
  "5m": "M5",
  "15m": "M15",
  "1h": "H1",
  "4h": "H4",
};

export function mapSignalTimeframe(timeframe: string): ChartTimeframe {
  if (timeframe === "1h") return "1h";
  if (timeframe === "4h") return "4h";
  if (timeframe === "5m") return "5m";
  if (timeframe === "1m") return "1m";
  return "15m";
}

export function candleTime(time: string): number {
  return Math.floor(Date.parse(time) / 1000);
}

/**
 * How close to the oldest loaded candle the viewport must get before the chart
 * requests another page of history.
 */
export const HISTORY_LOAD_THRESHOLD = 150;
export const HISTORY_MAX_PREFETCH_BARS = 400;

export function historyPrefetchThreshold(range: { from: number; to: number }) {
  const visibleBars = Math.max(0, range.to - range.from);
  return Math.min(
    HISTORY_MAX_PREFETCH_BARS,
    Math.max(HISTORY_LOAD_THRESHOLD, visibleBars * 0.5),
  );
}

export function shouldLoadOlderHistory(
  range: { from: number; to: number } | null,
) {
  return range !== null && range.from < historyPrefetchThreshold(range);
}

/**
 * Prepending candles shifts every existing bar right by `prependedCount`, so
 * the viewport has to shift with them to stay on the same bars.
 *
 * Returning to the pre-load range instead is what made the chart walk backwards
 * through history on its own: that range is by definition below
 * HISTORY_LOAD_THRESHOLD, so restoring it immediately requests the next page.
 */
export function anchorRangeAfterPrepend(
  range: { from: number; to: number },
  prependedCount: number,
) {
  return {
    from: range.from + prependedCount,
    to: range.to + prependedCount,
  };
}

/**
 * How many bars were inserted before the previously-oldest bar.
 *
 * Derived from timestamps rather than array length on purpose: a live tick can
 * append a candle in the same update that prepends history, and comparing
 * lengths would then count that append as part of the prepend and shift the
 * viewport one bar too far.
 */
export function countPrependedCandles(
  candles: readonly { time: string }[],
  previousFirstTime: string | null,
) {
  if (!previousFirstTime) return 0;

  const previousMs = Date.parse(previousFirstTime);
  if (!Number.isFinite(previousMs)) return 0;

  const index = candles.findIndex(
    (candle) => Date.parse(candle.time) >= previousMs,
  );

  // -1 means the old anchor is gone entirely (the instrument changed), and 0
  // means nothing was inserted ahead of it.
  return index > 0 ? index : 0;
}

export function calculateEma(closes: number[], period: number): (number | null)[] {
  const ema: (number | null)[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;

  for (let index = 0; index < closes.length; index += 1) {
    if (index < period - 1) {
      ema.push(null);
      continue;
    }

    if (previous === null) {
      const seed = closes.slice(0, period).reduce((sum, value) => sum + value, 0);
      previous = seed / period;
    } else {
      previous = closes[index] * multiplier + previous * (1 - multiplier);
    }

    ema.push(previous);
  }

  return ema;
}

export function calculateAtr(
  candles: Candle[],
  period: number,
): (number | null)[] {
  const atr: (number | null)[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = index > 0 ? candles[index - 1]!.close : candle.close;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );

    if (index < period - 1) {
      atr.push(null);
      continue;
    }

    if (index === period - 1) {
      let seed = 0;
      for (let seedIndex = 0; seedIndex < period; seedIndex += 1) {
        const seedCandle = candles[seedIndex]!;
        const seedPreviousClose =
          seedIndex > 0 ? candles[seedIndex - 1]!.close : seedCandle.close;
        seed += Math.max(
          seedCandle.high - seedCandle.low,
          Math.abs(seedCandle.high - seedPreviousClose),
          Math.abs(seedCandle.low - seedPreviousClose),
        );
      }
      atr.push(seed / period);
      continue;
    }

    const previousAtr = atr[index - 1]!;
    atr.push((previousAtr * (period - 1) + trueRange) / period);
  }

  return atr;
}

export function calculateRsi(
  closes: number[],
  period: number,
): (number | null)[] {
  const rsi: (number | null)[] = [];
  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 0; index < closes.length; index += 1) {
    if (index === 0) {
      rsi.push(null);
      continue;
    }

    const change = closes[index]! - closes[index - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    if (index < period) {
      averageGain += gain;
      averageLoss += loss;
      rsi.push(null);
      continue;
    }

    if (index === period) {
      averageGain = (averageGain + gain) / period;
      averageLoss = (averageLoss + loss) / period;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }

    if (averageLoss === 0) {
      rsi.push(100);
      continue;
    }

    const rs = averageGain / averageLoss;
    rsi.push(100 - 100 / (1 + rs));
  }

  return rsi;
}

export function toChartCandles(
  candles: Candle[],
): CandlestickData<UTCTimestamp>[] {
  const candlesByTime = new Map<number, CandlestickData<UTCTimestamp>>();

  for (const candle of candles) {
    const time = candleTime(candle.time);
    const prices = [candle.open, candle.high, candle.low, candle.close];

    if (
      !Number.isFinite(time) ||
      !prices.every(Number.isFinite) ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close)
    ) {
      continue;
    }

    candlesByTime.set(time, {
      time: time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
  }

  return [...candlesByTime.values()].sort(
    (left, right) => Number(left.time) - Number(right.time),
  );
}

export function toHeikinAshiCandles(candles: Candle[]) {
  const transformed: Candle[] = [];
  let previous: Pick<Candle, "open" | "close"> | null = null;

  for (const candle of candles) {
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open: number = previous
      ? (previous.open + previous.close) / 2
      : (candle.open + candle.close) / 2;
    const high = Math.max(candle.high, open, close);
    const low = Math.min(candle.low, open, close);

    transformed.push({
      ...candle,
      open,
      high,
      low,
      close,
    });
    previous = { open, close };
  }

  return toChartCandles(transformed);
}

export function toCloseLine(candles: Candle[]): LineData<UTCTimestamp>[] {
  return toChartCandles(candles).map((candle) => ({
    time: candle.time,
    value: candle.close,
  }));
}

export function toLinePoints(
  candles: CandlestickData<UTCTimestamp>[],
  values: (number | null)[],
): LineData<UTCTimestamp>[] {
  return candles.flatMap((candle, index) => {
    const value = values[index];
    return value === null ? [] : [{ time: candle.time, value }];
  });
}

export function spreadInPips(
  instrument: MajorInstrument,
  bid: number,
  ask: number,
) {
  return ((ask - bid) / pipSizeFor(instrument)).toFixed(1);
}

export function pricePrecision(instrument: MajorInstrument) {
  return precisionFor(instrument);
}

export function compactAxisPricePrecision(instrument: MajorInstrument) {
  // One digit coarser than full precision keeps the axis readable.
  return Math.max(0, precisionFor(instrument) - 1);
}

export function formatChartPrice(value: number, instrument: MajorInstrument) {
  return value.toFixed(pricePrecision(instrument));
}

const TIMEFRAME_MINUTES: Record<ChartTimeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
};

function rangeToMs(range: ChartRange) {
  const day = 24 * 60 * 60 * 1000;

  switch (range) {
    case "1D":
      return day;
    case "1W":
      return 7 * day;
    case "1M":
      return 30 * day;
    case "3M":
      return 90 * day;
    case "6M":
      return 180 * day;
    case "1Y":
      return 365 * day;
    default:
      return null;
  }
}

export function candleCountForRange(
  timeframe: ChartTimeframe,
  range: ChartRange,
) {
  if (range === "All") {
    return 5_000;
  }

  const rangeMs = rangeToMs(range);
  if (!rangeMs) {
    return 5_000;
  }

  const minutesPerCandle = TIMEFRAME_MINUTES[timeframe];
  const count = Math.ceil(rangeMs / (minutesPerCandle * 60 * 1000));
  return Math.min(5_000, Math.max(40, count));
}

export interface TradeMarkerPalette {
  long: string;
  short: string;
  win: string;
  loss: string;
  muted: string;
}

export function chartTimesOf(candles: CandlestickData<UTCTimestamp>[]) {
  return candles.map((candle) => Number(candle.time));
}

/**
 * Markers only render on times the series actually holds, so a decision or exit
 * timestamp is pulled back to the candle that contains it. Returns null when the
 * moment sits before the loaded history.
 */
export function snapToCandleTime(candleTimes: number[], target: number) {
  if (!candleTimes.length || !Number.isFinite(target)) return null;

  let low = 0;
  let high = candleTimes.length - 1;
  let match: number | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = candleTimes[middle]!;

    if (value <= target) {
      match = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return match;
}

function unixSeconds(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function tradeEntryTime(candleTimes: number[], trade: PaperChartTrade) {
  const opened = unixSeconds(trade.openedAt);
  return opened === null ? null : snapToCandleTime(candleTimes, opened);
}

function tradeExitTime(candleTimes: number[], trade: PaperChartTrade) {
  const closed = unixSeconds(trade.closedAt);
  return closed === null || trade.exit === null
    ? null
    : snapToCandleTime(candleTimes, closed);
}

export function formatResultR(resultR: number | null) {
  return resultR === null
    ? "—"
    : `${resultR >= 0 ? "+" : ""}${resultR.toFixed(2)}R`;
}

/**
 * Entry and exit arrows for every paper trade on the pair. The focused trade —
 * the one the user opened from the dashboard — is drawn full size and labelled;
 * the rest stay small and grey so they read as history.
 */
export function buildTradeMarkers(
  candleTimes: number[],
  trades: PaperChartTrade[],
  focusTradeId: string | null,
  palette: TradeMarkerPalette,
): SeriesMarker<UTCTimestamp>[] {
  const markers = trades.flatMap<SeriesMarker<UTCTimestamp>>((trade) => {
    const focused = trade.id === focusTradeId;
    const long = trade.direction === "long";
    const entryTime = tradeEntryTime(candleTimes, trade);
    const exitTime = tradeExitTime(candleTimes, trade);
    const built: SeriesMarker<UTCTimestamp>[] = [];

    if (entryTime !== null) {
      built.push({
        id: `entry:${trade.id}`,
        time: entryTime as UTCTimestamp,
        position: long ? "belowBar" : "aboveBar",
        shape: long ? "arrowUp" : "arrowDown",
        color: focused ? (long ? palette.long : palette.short) : palette.muted,
        size: focused ? 2 : 1,
        text: focused
          ? `#${trade.tradeSequence} ${long ? "BUY" : "SELL"} ${formatChartPrice(trade.entry, trade.instrument)}`
          : undefined,
      });
    }

    if (exitTime !== null && trade.exit !== null) {
      const won = (trade.resultR ?? 0) >= 0;
      built.push({
        id: `exit:${trade.id}`,
        time: exitTime as UTCTimestamp,
        position: long ? "aboveBar" : "belowBar",
        shape: long ? "arrowDown" : "arrowUp",
        color: focused ? (won ? palette.win : palette.loss) : palette.muted,
        size: focused ? 2 : 1,
        text: focused
          ? `EXIT ${formatChartPrice(trade.exit, trade.instrument)} · ${formatResultR(trade.resultR)}`
          : undefined,
      });
    }

    return built;
  });

  return markers.sort((left, right) => Number(left.time) - Number(right.time));
}

/** The entry-to-exit segment drawn across the focused trade. */
export function buildTradePath(
  candleTimes: number[],
  trade: PaperChartTrade | null,
): LineData<UTCTimestamp>[] {
  if (!trade || trade.exit === null) return [];

  const entryTime = tradeEntryTime(candleTimes, trade);
  const exitTime = tradeExitTime(candleTimes, trade);
  if (entryTime === null || exitTime === null || exitTime <= entryTime) return [];

  return [
    { time: entryTime as UTCTimestamp, value: trade.entry },
    { time: exitTime as UTCTimestamp, value: trade.exit },
  ];
}

export function getVisibleRangeFromCandles(
  candles: Candle[],
  range: ChartRange,
) {
  if (!candles.length || range === "All") {
    return null;
  }

  const rangeMs = rangeToMs(range);
  if (!rangeMs) {
    return null;
  }

  const end = candleTime(candles.at(-1)!.time);
  const start = end - rangeMs / 1000;
  const fromCandle =
    candles.find((candle) => candleTime(candle.time) >= start) ?? candles[0];

  return {
    from: candleTime(fromCandle.time) as UTCTimestamp,
    to: end as UTCTimestamp,
  };
}
