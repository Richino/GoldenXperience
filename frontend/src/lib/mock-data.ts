import type {
  AccountSummary,
  Candle,
  CandleSeries,
  JournalTrade,
  MajorInstrument,
  OpenPosition,
  PriceQuote,
  TradeSignal,
} from "@/types/forex";

const displayNames: Record<MajorInstrument, string> = {
  EUR_USD: "EUR/USD",
  GBP_USD: "GBP/USD",
  USD_JPY: "USD/JPY",
};

export const mockAccount: AccountSummary = {
  id: "practice-demo",
  alias: "Golden practice",
  currency: "USD",
  balance: 25_430,
  nav: 25_518.42,
  unrealizedPL: 88.42,
  marginAvailable: 24_806.11,
  openTradeCount: 1,
  source: "mock",
};

export const mockPrices: PriceQuote[] = [
  {
    instrument: "EUR_USD",
    displayName: "EUR/USD",
    bid: 1.08968,
    ask: 1.08976,
    mid: 1.08972,
    changePercent: 0.32,
    status: "tradeable",
    time: new Date().toISOString(),
    source: "mock",
  },
  {
    instrument: "GBP_USD",
    displayName: "GBP/USD",
    bid: 1.27339,
    ask: 1.27351,
    mid: 1.27345,
    changePercent: -0.15,
    status: "tradeable",
    time: new Date().toISOString(),
    source: "mock",
  },
  {
    instrument: "USD_JPY",
    displayName: "USD/JPY",
    bid: 156.775,
    ask: 156.789,
    mid: 156.782,
    changePercent: 0.21,
    status: "tradeable",
    time: new Date().toISOString(),
    source: "mock",
  },
];

export const mockOpenPositions: OpenPosition[] = [
  {
    id: "mock-position-1",
    instrument: "EUR_USD",
    pair: "EUR/USD",
    direction: "long",
    units: 10_000,
    entryPrice: 1.0861,
    currentPrice: 1.08972,
    unrealizedPL: 36.2,
    openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    source: "mock",
  },
];

const granularityInMinutes: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D: 1_440,
};

export function createMockCandles(
  instrument: MajorInstrument,
  count = 64,
  granularity = "M15",
  to?: string,
): CandleSeries {
  const anchor =
    mockPrices.find((price) => price.instrument === instrument)?.mid ?? 1;
  const precision = instrument === "USD_JPY" ? 3 : 5;
  const intervalMinutes = granularityInMinutes[granularity] ?? 15;
  const intervalMs = intervalMinutes * 60 * 1000;
  const baseScale = instrument === "USD_JPY" ? 0.035 : 0.00028;
  const scale = baseScale * Math.sqrt(intervalMinutes / 15);
  const requestedEnd = to ? Date.parse(to) : Date.now();
  const safeEnd = Number.isFinite(requestedEnd) ? requestedEnd : Date.now();
  const end = Math.floor(safeEnd / intervalMs) * intervalMs;
  const start = end - (count - 1) * intervalMs;
  let previousClose = 0;

  const rawCandles = Array.from({ length: count }, (_, index) => {
    const wave = Math.sin(index * 0.72) * scale * 0.58;
    const body =
      wave +
      Math.sin(index * 1.91) * scale * 0.32 +
      Math.cos(index * 0.17) * scale * 0.12;
    const open = previousClose;
    const close = open + body;
    const wick = scale * (0.38 + (index % 4) * 0.11);
    previousClose = close;

    return {
      time: new Date(start + index * intervalMs).toISOString(),
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick * 0.82,
      close,
      volume: 140 + ((index * 37) % 260),
      complete: index < count - 1,
    };
  });
  const offset = anchor - rawCandles[rawCandles.length - 1].close;
  const candles: Candle[] = rawCandles.map((candle) => ({
    ...candle,
    open: Number((candle.open + offset).toFixed(precision)),
    high: Number((candle.high + offset).toFixed(precision)),
    low: Number((candle.low + offset).toFixed(precision)),
    close: Number((candle.close + offset).toFixed(precision)),
  }));

  return {
    instrument,
    granularity,
    candles,
    source: "mock",
  };
}

export const signals: TradeSignal[] = [
  {
    instrument: "EUR_USD",
    pair: displayNames.EUR_USD,
    timeframe: "15m",
    direction: "long",
    bias: "Bullish",
    entry: 1.0885,
    stop: 1.085,
    target: 1.0925,
    riskReward: 2,
    strategy: "EMA continuation",
    note: "Break of structure above the 21/50 EMA stack.",
    freshness: "18 min ago",
  },
  {
    instrument: "GBP_USD",
    pair: displayNames.GBP_USD,
    timeframe: "1h",
    direction: "short",
    bias: "Bearish",
    entry: 1.2731,
    stop: 1.2772,
    target: 1.265,
    riskReward: 1.98,
    strategy: "Supply rejection",
    note: "Lower high formed beneath weekly resistance.",
    freshness: "42 min ago",
  },
  {
    instrument: "USD_JPY",
    pair: displayNames.USD_JPY,
    timeframe: "4h",
    direction: "long",
    bias: "Bullish",
    entry: 156.2,
    stop: 155.72,
    target: 157.16,
    riskReward: 2,
    strategy: "Trend continuation",
    note: "Pullback held the rising 50 EMA and prior breakout.",
    freshness: "1 hr ago",
  },
];

export const journalTrades: JournalTrade[] = [
  {
    id: "trade-1",
    origin: "demo",
    pair: "EUR/USD",
    direction: "long",
    status: "closed",
    result: "win",
    openedAt: "2026-07-23T13:15:00.000Z",
    closedAt: "2026-07-23T15:45:00.000Z",
    resultR: 1.62,
    entry: 1.0861,
    stop: 1.08338,
    target: 1.09154,
    exit: 1.0905,
    reason: "Breakout + EMA",
    notes: "Waited for the retest and kept risk at 1%.",
  },
  {
    id: "trade-2",
    origin: "demo",
    pair: "GBP/USD",
    direction: "short",
    status: "closed",
    result: "loss",
    openedAt: "2026-07-22T12:30:00.000Z",
    closedAt: "2026-07-22T14:20:00.000Z",
    resultR: -0.75,
    entry: 1.2752,
    stop: 1.27893,
    target: 1.26774,
    exit: 1.278,
    reason: "Supply rejection",
    notes: "Entered before the lower-timeframe rejection fully closed.",
  },
  {
    id: "trade-3",
    origin: "demo",
    pair: "EUR/USD",
    direction: "long",
    status: "closed",
    result: "win",
    openedAt: "2026-07-21T14:05:00.000Z",
    closedAt: "2026-07-21T17:10:00.000Z",
    resultR: 1.24,
    entry: 1.0824,
    stop: 1.07845,
    target: 1.0903,
    exit: 1.0873,
    reason: "Trend continuation",
    notes: "Clean pullback into the rising EMA stack.",
  },
  {
    id: "trade-4",
    origin: "demo",
    pair: "USD/JPY",
    direction: "short",
    status: "closed",
    result: "loss",
    openedAt: "2026-07-20T15:20:00.000Z",
    closedAt: "2026-07-20T16:40:00.000Z",
    resultR: -1.05,
    entry: 156.82,
    stop: 157.287,
    target: 155.886,
    exit: 157.31,
    reason: "Structure reversal",
    notes: "The reversal failed while the higher-timeframe trend stayed intact.",
  },
  {
    id: "trade-5",
    origin: "demo",
    pair: "EUR/USD",
    direction: "long",
    status: "closed",
    result: "win",
    openedAt: "2026-07-19T12:10:00.000Z",
    closedAt: "2026-07-19T15:05:00.000Z",
    resultR: 0.88,
    entry: 1.0789,
    stop: 1.0747,
    target: 1.0873,
    exit: 1.0826,
    reason: "Break of structure",
    notes: "Reduced the target as New York liquidity faded.",
  },
];

export const formatPair = (instrument: MajorInstrument) =>
  displayNames[instrument];

export const dashboardState = {
  dailyRisk: {
    riskPerTrade: 1,
    maxDailyLoss: 2,
    maxTrades: 3,
  },
  watchlistNotes: [
    {
      instrument: "EUR_USD" as MajorInstrument,
      pair: "EUR/USD",
      note: "Pullback forming",
      tone: "accent" as const,
    },
    {
      instrument: "GBP_USD" as MajorInstrument,
      pair: "GBP/USD",
      note: "No setup",
      tone: "muted" as const,
    },
    {
      instrument: "USD_JPY" as MajorInstrument,
      pair: "USD/JPY",
      note: "Spread high",
      tone: "danger" as const,
    },
  ],
  recentTradesR: [1.2, -1, 2],
};
