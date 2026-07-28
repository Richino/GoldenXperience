"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ChevronLeft,
  Clock3,
  Search,
  X,
} from "lucide-react";
import { ChartTypeSelect } from "@/components/charts/chart-type-select";
import {
  ChartLoadingOverlay,
  settleChartLoad,
} from "@/components/charts/chart-loading-overlay";
import { IndicatorSelect } from "@/components/charts/indicator-select";
import { SetupChart } from "@/components/charts/setup-chart";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { apiUrl } from "@/lib/api/url";
import { SectionLabel } from "@/components/ui/section-label";
import {
  CHART_RANGES,
  CHART_TIMEFRAMES,
  DEFAULT_CHART_INDICATORS,
  MOBILE_CHART_RANGES,
  TIMEFRAME_TO_GRANULARITY,
  candleCountForRange,
  formatChartPrice,
  mapSignalTimeframe,
  spreadInPips,
  type ChartIndicator,
  type ChartRange,
  type ChartVariant,
} from "@/lib/chart-utils";
import {
  INSTRUMENT_CATALOG,
  currenciesOf,
  pipSizeFor,
  precisionFor,
} from "@/lib/instruments/catalog";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import type { MarketPriceTick } from "@/types/market-stream";
import type {
  Candle,
  CandleSeries,
  ConnectionStatus,
  MajorInstrument,
  PriceQuote,
  TradeSignal,
} from "@/types/forex";

const MOBILE_TABS = ["Overview", "Setup"] as const;
type MobileTab = (typeof MOBILE_TABS)[number];

const ENTRY_CHECKLIST = [
  "Structure confirms the directional bias",
  "Entry is inside the planned zone",
  "Risk is 1% or less",
  "No high-impact news inside 30 minutes",
] as const;

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

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = "segment",
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  variant?: "segment" | "tabs";
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
            {option}
          </button>
        );
      })}
    </div>
  );
}

function SignalSearch({
  signals,
  activeInstrument,
  query,
  onQueryChange,
  onSelect,
  className = "",
  compact = false,
}: {
  signals: TradeSignal[];
  activeInstrument: MajorInstrument;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (result: SearchResult) => void;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = normalizeSearchValue(query);
  const index = useMemo(() => buildSearchIndex(signals), [signals]);
  const matches = useMemo(() => {
    if (!normalizedQuery) {
      // Lead with the pairs that actually have a setup to act on.
      return [...index].sort(
        (left, right) => Number(!!right.signal) - Number(!!left.signal),
      );
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
  const showResults = open;

  useEffect(() => {
    if (!open || !compact) return;

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
  }, [compact, open]);

  if (compact) {
    return (
      <div ref={rootRef} className={`relative ${className}`}>
        <button
          type="button"
          aria-label="Search pairs"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`signals-tool-btn pressable ${open ? "is-active" : ""}`}
        >
          <Search className="size-4" strokeWidth={2} />
        </button>

        {open ? (
          <div className="signals-search-popover menu-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-2">
            <div className="signals-search">
              <Search
                className="size-3.5 shrink-0 text-[color:var(--muted)]"
                strokeWidth={2}
              />
              <input
                autoFocus
                aria-label="Search all forex pairs"
                className="min-w-0 flex-1 bg-transparent text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)]"
                placeholder="Search pairs"
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpen(false);
                    event.currentTarget.blur();
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
                  className="signals-icon-btn pressable !size-6 shrink-0"
                  type="button"
                  onClick={() => onQueryChange("")}
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              ) : null}
            </div>
            <div className="mt-1 max-h-[min(16rem,50vh)] overflow-y-auto overscroll-contain">
              {matches.length ? (
                matches.map((result) => {
                  const active = result.instrument === activeInstrument;

                  return (
                    <button
                      key={result.instrument}
                      type="button"
                      onClick={() => {
                        onSelect(result);
                        setOpen(false);
                      }}
                      className={`signals-search-result pressable flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left ${
                        active ? "is-active" : ""
                      }`}
                    >
                      <PairAvatar instrument={result.instrument} size={26} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.02em]">
                        {result.displayName}
                      </span>
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
        ) : null}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <div className="signals-search">
        <Search className="size-3.5 shrink-0 text-[color:var(--muted)]" strokeWidth={2} />
        <input
          aria-label="Search all forex pairs"
          className="min-w-0 flex-1 bg-transparent text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)]"
          placeholder="Search pairs"
          type="search"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              event.currentTarget.blur();
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
            className="signals-icon-btn pressable !size-6 shrink-0"
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onQueryChange("");
              setOpen(true);
            }}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {showResults ? (
        <div className="menu-popover absolute left-0 right-0 top-[calc(100%+0.375rem)] z-50 max-h-[min(20rem,55vh)] overflow-y-auto overscroll-contain rounded-xl py-1">
          {matches.length ? (
            matches.map((result) => {
              const active = result.instrument === activeInstrument;

              return (
                <button
                  key={result.instrument}
                  type="button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    onSelect(result);
                    setOpen(false);
                  }}
                  onClick={() => {
                    onSelect(result);
                    setOpen(false);
                  }}
                  className={`signals-search-result pressable flex w-full items-center gap-2.5 px-3 py-2 text-left ${
                    active ? "is-active" : ""
                  }`}
                >
                  <PairAvatar instrument={result.instrument} size={26} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.02em]">
                    {result.displayName}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="px-3 py-3 text-center text-xs text-[color:var(--muted)]">
              No matching pair
            </div>
          )}
        </div>
      ) : null}
    </div>
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
        1:{active.riskReward.toFixed(1)}
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
    <div className="mt-5">
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
  return (
    <p className="text-sm leading-relaxed text-[color:var(--muted)]">
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

function SignalSidebar({
  active,
  riskDistance,
}: {
  active: TradeSignal;
  riskDistance: number;
}) {
  return (
    <section className="app-card flex h-full flex-col gap-5 p-5 md:p-6">
      <div>
        <SectionLabel title="Setup" variant="minimal" />
        <p className="mt-2 text-sm font-medium tracking-[-0.02em]">
          {active.pair}{" "}
          <span
            className={
              active.direction === "long"
                ? "text-[color:var(--success)]"
                : "text-[color:var(--danger)]"
            }
          >
            {active.direction}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-[color:var(--muted)]">
          {active.strategy} · {active.timeframe} · {active.bias}
        </p>
      </div>

      <SetupStats active={active} />
      <SetupRangeBar active={active} />
      <SetupNote active={active} />
      <SetupMeta active={active} riskDistance={riskDistance} />

      <div>
        <SectionLabel title="Before entry" variant="minimal" />
        <div className="mt-3">
          <EntryChecklist />
        </div>
      </div>

      <p className="mt-auto text-xs leading-relaxed text-[color:var(--muted)]">
        Decision support only — confirm price and spread before execution.
      </p>
    </section>
  );
}

export function SignalWorkspace({
  signals,
  primarySeries,
  initialStatus,
}: {
  signals: TradeSignal[];
  primarySeries: CandleSeries;
  initialStatus: ConnectionStatus;
}) {
  const [selectedInstrument, setSelectedInstrument] = useState(
    primarySeries.instrument,
  );
  const instrument = selectedInstrument;
  const initialSignal =
    signals.find((signal) => signal.instrument === instrument) ?? signals[0];

  const [timeframe, setTimeframe] = useState(
    mapSignalTimeframe(initialSignal.timeframe),
  );
  const [range, setRange] = useState<ChartRange>("6M");
  const [chartVariant, setChartVariant] = useState<ChartVariant>("candle");
  const [enabledIndicators, setEnabledIndicators] = useState<ChartIndicator[]>(
    DEFAULT_CHART_INDICATORS,
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>("Overview");
  const [series, setSeries] = useState(primarySeries);
  const seriesRef = useRef(primarySeries);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [dataNotice, setDataNotice] = useState<string | null>(
    initialStatus.state === "connected" ? null : initialStatus.message,
  );
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollToLatestRevision, setScrollToLatestRevision] = useState(0);
  const olderRequestInFlightRef = useRef(false);
  const pendingTickRef = useRef<MarketPriceTick | null>(null);
  const marketFrameRef = useRef<number | null>(null);
  const replaceSeries = useCallback((nextSeries: CandleSeries) => {
    seriesRef.current = nextSeries;
    setSeries(nextSeries);
  }, []);
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

  const active =
    signals.find((signal) => signal.instrument === instrument) ?? signals[0];
  const riskDistance = Math.abs(active.entry - active.stop);
  const setupLevels = useMemo(
    () => ({
      entry: active.entry,
      stop: active.stop,
      target: active.target,
    }),
    [active.entry, active.stop, active.target],
  );

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
            { signal: controller.signal },
          ),
          fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), {
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

  const priceStats = useMemo(() => {
    const lastClose = series.candles.at(-1)?.close ?? active.entry;
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
  }, [active.entry, quote, series.candles]);

  const spreadPips = useMemo(() => {
    if (!quote || quote.instrument !== instrument) return null;
    return Number(spreadInPips(instrument, quote.bid, quote.ask));
  }, [instrument, quote]);

  function selectSearchResult(result: SearchResult) {
    setLiveCandle(null);
    setSelectedInstrument(result.instrument);
    // Pairs without a setup keep the timeframe the user is already on.
    if (result.signal) {
      setTimeframe(mapSignalTimeframe(result.signal.timeframe));
    }
    setSearchQuery("");
  }

  return (
    <div className="signals-view grid w-full gap-5 xl:grid-cols-[minmax(0,1fr)_272px]">
      <section className="app-card signals-chart-card min-w-0 w-full">
        <div className="signals-chart-mobile lg:hidden">
          <div className="signals-mobile-content px-4 pb-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="signals-mobile-actions flex items-center justify-between">
              <Link
                href="/"
                className="signals-icon-btn pressable text-[color:var(--foreground)]"
                aria-label="Back to home"
              >
                <ChevronLeft className="size-5" strokeWidth={2} />
              </Link>
              <button
                type="button"
                aria-label="Notifications"
                className="signals-icon-btn pressable relative"
              >
                <Bell className="size-[18px]" strokeWidth={1.9} />
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-[color:var(--danger)]" />
              </button>
            </div>

            <div className="mt-3 flex items-end justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <PairAvatar instrument={instrument} size={36} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold tracking-[-0.03em]">
                    {active.pair}
                  </div>
                  <div className="text-xs text-[color:var(--muted)]">
                    {active.strategy}
                  </div>
                </div>
              </div>
              <div className="metric-number text-right text-lg font-semibold tracking-[-0.04em]">
                {formatChartPrice(priceStats.displayPrice, instrument)}
              </div>
            </div>

            <SignalSearch
              signals={signals}
              activeInstrument={instrument}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onSelect={selectSearchResult}
              className="mt-3"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SegmentControl
                ariaLabel="Chart timeframe"
                options={CHART_TIMEFRAMES}
                value={timeframe}
                onChange={(option) => {
                  setLiveCandle(null);
                  setTimeframe(option);
                }}
              />
              <IndicatorSelect
                enabled={enabledIndicators}
                onChange={setEnabledIndicators}
              />
            </div>
            {dataNotice ? (
              <p className="signals-notice mt-2">
                {series.source === "mock" ? "Demo data · " : ""}
                {dataNotice}
              </p>
            ) : null}
          </div>

          <div
            className={`relative overflow-hidden chart-data-shell${loading ? " chart-data-shell-loading" : ""}`}
          >
            <SetupChart
              series={series}
              levels={setupLevels}
              enabledIndicators={enabledIndicators}
              liveCandle={liveCandle}
              variant={chartVariant}
              range={range}
              height={320}
              embedded
              scrollToLatestRevision={scrollToLatestRevision}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderCandles}
            />
            <ChartLoadingOverlay visible={loading} />
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <SegmentControl
              ariaLabel="Chart range"
              options={MOBILE_CHART_RANGES}
              value={range}
              onChange={(option) => {
                setLiveCandle(null);
                setRange(option);
              }}
            />
            <ChartTypeSelect
              compact
              value={chartVariant}
              onChange={setChartVariant}
            />
          </div>

          <div className="flex gap-4 px-4">
            {MOBILE_TABS.map((tab) => {
              const isActive = mobileTab === tab;

              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMobileTab(tab)}
                  className={`signals-mobile-tab pressable ${
                    isActive ? "is-active" : ""
                  }`}
                >
                  {tab}
                </button>
              );
            })}
          </div>

          <div className="space-y-5 px-4 py-5 pb-8">
            {mobileTab === "Overview" ? (
              <>
                <SetupStats active={active} />
                <SetupRangeBar active={active} />
                <SetupNote active={active} />
                <SetupMeta active={active} riskDistance={riskDistance} />
              </>
            ) : (
              <>
                <EntryChecklist />
                <p className="text-xs leading-relaxed text-[color:var(--muted)]">
                  Decision support only — confirm price and spread before execution.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="hidden lg:flex signals-chart-desktop">
          <div className="signals-chart-head">
            <div className="signals-chart-head-main">
              <PairAvatar instrument={instrument} size={38} />
              <div className="min-w-0">
                <div className="signals-chart-pair">{active.pair}</div>
                <div className="signals-chart-strategy">{active.strategy}</div>
              </div>
              <div className="signals-chart-quote">
                <span className="signals-chart-price metric-number">
                  {formatChartPrice(priceStats.displayPrice, instrument)}
                </span>
                {spreadPips !== null ? (
                  <span className="signals-chart-spread">
                    {spreadPips.toFixed(1)} pip spread
                  </span>
                ) : null}
              </div>
            </div>

            <div className="signals-chart-head-tools">
              <SignalSearch
                compact
                signals={signals}
                activeInstrument={instrument}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onSelect={selectSearchResult}
              />
              <ChartTypeSelect
                compact
                value={chartVariant}
                onChange={setChartVariant}
              />
              <IndicatorSelect
                compact
                enabled={enabledIndicators}
                onChange={setEnabledIndicators}
              />
            </div>
          </div>

          <div className="signals-chart-strip">
            <SegmentControl
              variant="tabs"
              ariaLabel="Chart timeframe"
              options={CHART_TIMEFRAMES}
              value={timeframe}
              onChange={(option) => {
                setLiveCandle(null);
                setTimeframe(option);
              }}
            />
            <span className="signals-chart-strip-divider" aria-hidden />
            <SegmentControl
              variant="tabs"
              ariaLabel="Chart range"
              options={CHART_RANGES}
              value={range}
              onChange={(option) => {
                setLiveCandle(null);
                setRange(option);
              }}
            />
          </div>

          {dataNotice ? (
            <p className="signals-notice signals-chart-notice">
              {series.source === "mock" ? "Demo data · " : ""}
              {dataNotice}
            </p>
          ) : null}

          <div
            className={`signals-chart-canvas chart-data-shell${loading ? " chart-data-shell-loading" : ""}`}
          >
            <SetupChart
              series={series}
              levels={setupLevels}
              enabledIndicators={enabledIndicators}
              liveCandle={liveCandle}
              variant={chartVariant}
              range={range}
              height={568}
              spreadPips={spreadPips}
              scrollToLatestRevision={scrollToLatestRevision}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderCandles}
            />
            <ChartLoadingOverlay visible={loading} />
          </div>
        </div>
      </section>

      <aside className="hidden xl:block">
        <SignalSidebar active={active} riskDistance={riskDistance} />
      </aside>
    </div>
  );
}
