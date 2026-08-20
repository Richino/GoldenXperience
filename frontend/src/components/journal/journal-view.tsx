"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { JournalTrade } from "@/types/forex";
import { apiUrl } from "@/lib/api/url";
import { formatClockTime, formatDayAndTime, formatShortDay } from "@/lib/format/datetime";
import { openTradeProgress } from "@/lib/open-trade-progress";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills } from "@/lib/market-stream/use-open-positions";
import { useInfiniteScroll } from "@/lib/use-infinite-scroll";
import { JournalEntriesSkeleton } from "@/components/ui/page-skeletons";
import Link from "next/link";

const FILTERS = ["All", "Wins", "Losses", "Active"] as const;
type JournalFilter = (typeof FILTERS)[number];

function decimalsForPair(pair: string) {
  return pair.endsWith("/JPY") ? 3 : 5;
}

function outcomeLabel(outcome: string | null | undefined) {
  if (!outcome || outcome === "open") return null;
  return outcome.replace(/_/g, " ");
}

function formatPrice(value: number | null, pair: string) {
  return value === null ? "—" : value.toFixed(decimalsForPair(pair));
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTradeWindow(openedAt: string, closedAt: string | null) {
  if (!closedAt) {
    return `${formatDayAndTime(openedAt)} → Open`;
  }
  if (formatShortDay(openedAt) === formatShortDay(closedAt)) {
    return `${formatShortDay(openedAt)}, ${formatClockTime(openedAt)} → ${formatClockTime(closedAt)}`;
  }
  return `${formatDayAndTime(openedAt)} → ${formatDayAndTime(closedAt)}`;
}

function JournalTradeRow({
  trade,
  quote,
  fill,
}: {
  trade: JournalTrade;
  quote?: { bid: number | null; ask: number | null };
  fill?: { price: number; units: number };
}) {
  // An unresolved trade reports what it is worth right now and how far it has
  // come towards its target, rather than only that it is open. Without a live
  // quote — a manual trade, or the snapshot not loaded — it falls back to
  // "Open" rather than inventing a value.
  const live =
    trade.resultR === null
      ? openTradeProgress({
          direction: trade.direction,
          entry: trade.entry,
          stop: trade.stop,
          target: trade.target,
          bid: quote?.bid,
          ask: quote?.ask,
          riskAmount: trade.nominalRiskAmount,
          fill,
        })
      : null;

  const positive = (trade.resultR ?? live?.unrealizedR ?? 0) >= 0;
  const resultTone =
    trade.resultR === null && !live
      ? "is-open"
      : positive
        ? "is-win"
        : "is-loss";
  const resultLabel =
    trade.resultR !== null
      ? `${positive ? "+" : ""}${trade.resultR.toFixed(2)}`
      : live
        ? `${Math.round(live.percent)}% ${live.towards === "stop" ? "to SL" : "to TP"}`
        : "Open";
  const moneyValue = trade.paperPl ?? live?.money ?? null;
  const money = formatMoney(moneyValue);
  const moneyTone =
    moneyValue == null ? null : moneyValue >= 0 ? "is-win" : "is-loss";
  const outcome = outcomeLabel(trade.outcome);

  // Strategy trades open on the chart they were taken from. A manually entered
  // trade has no instrument code to route with, so it stays unlinked rather
  // than pointing at a pair the chart cannot resolve.
  const href = trade.instrument
    ? `/signals?instrument=${trade.instrument}&trade=${trade.id}`
    : null;

  const body = (
    <>
      <div className="journal-entry-head">
        <div className="journal-entry-main min-w-0">
          <p className="journal-entry-title">
            <span className="journal-entry-pair">{trade.pair}</span>
            <span
              className={
                trade.direction === "long"
                  ? "journal-entry-dir is-long"
                  : "journal-entry-dir is-short"
              }
            >
              {trade.direction}
            </span>
            {trade.origin === "strategy" ? (
              <span className="journal-entry-auto">
                Auto{trade.sequence ? ` #${trade.sequence}` : ""}
              </span>
            ) : null}
          </p>
          <p className="journal-entry-window metric-number">
            <time dateTime={trade.openedAt}>{formatTradeWindow(trade.openedAt, trade.closedAt)}</time>
            {outcome ? (
              <span className="journal-entry-outcome"> · {outcome}</span>
            ) : null}
          </p>
        </div>
        <div className="journal-entry-aside">
          <p className={`journal-entry-result metric-number ${resultTone}`}>
            <span className="journal-entry-r">
              {resultLabel}
              {trade.resultR !== null ? (
                <span className="journal-entry-r-unit">R</span>
              ) : null}
            </span>
            {money ? (
              <span className={`journal-entry-money ${moneyTone ?? ""}`}>{money}</span>
            ) : null}
          </p>
        </div>
      </div>

      <dl className="journal-entry-levels">
        <div className="journal-entry-level">
          <dt>Entry</dt>
          <dd className="metric-number">
            {formatPrice(trade.entry, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Exit</dt>
          <dd className="metric-number">
            {formatPrice(trade.exit, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Stop</dt>
          <dd className="metric-number">
            {formatPrice(trade.stop, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Target</dt>
          <dd className="metric-number">
            {formatPrice(trade.target, trade.pair)}
          </dd>
        </div>
      </dl>
    </>
  );

  return (
    <article className="journal-entry">
      {href ? (
        <Link href={href} className="journal-entry-open pressable">
          {body}
        </Link>
      ) : (
        body
      )}
    </article>
  );
}

const PAGE_SIZE = 20;

type TradeSummary = { total: number; winRate: number | null; avgR: number };

function filterParamFor(filter: JournalFilter): "all" | "wins" | "losses" | "active" {
  switch (filter) {
    case "Wins":
      return "wins";
    case "Losses":
      return "losses";
    case "Active":
      return "active";
    case "All":
      return "all";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

function dedupeById(trades: JournalTrade[]): JournalTrade[] {
  const seen = new Set<string>();
  return trades.filter((trade) =>
    seen.has(trade.id) ? false : (seen.add(trade.id), true),
  );
}

export function JournalView({ embedded = false }: { embedded?: boolean } = {}) {
  const [activeFilter, setActiveFilter] = useState<JournalFilter>("All");
  const [records, setRecords] = useState<JournalTrade[]>([]);
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const requestSeqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Live bid/ask per pair, so an unresolved row is marked to market on every
  // tick. A dropped socket leaves the last known figure rather than a wrong
  // one, and rows without a quote fall back to "Open".
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
  const reducedMotion = useReducedMotion();

  const filterParam = filterParamFor(activeFilter);

  // Loads one page. `reset` restarts at the first page for a filter change (the
  // server also returns the whole-journal summary then); otherwise it appends
  // the next page. A per-call sequence guards against a slower earlier request
  // landing after a newer one on a rapid filter switch.
  const loadPage = useCallback(
    async (reset: boolean) => {
      const seq = ++requestSeqRef.current;
      const offset = reset ? 0 : offsetRef.current;
      if (!reset) setLoadingMore(true);
      try {
        const response = await fetch(
          apiUrl(`/api/journal/trades?limit=${PAGE_SIZE}&offset=${offset}&filter=${filterParam}`),
          { credentials: "include", cache: "no-store" },
        );
        const payload = (await response.json()) as {
          trades?: JournalTrade[];
          hasMore?: boolean;
          summary?: TradeSummary;
        };
        if (!response.ok) throw new Error("Journal records are unavailable.");
        if (seq !== requestSeqRef.current) return;
        const batch = payload.trades ?? [];
        offsetRef.current = offset + batch.length;
        setRecords((prev) => (reset ? batch : dedupeById([...prev, ...batch])));
        setHasMore(Boolean(payload.hasMore));
        if (reset && payload.summary) setSummary(payload.summary);
        setLoadError(null);
      } catch {
        if (seq === requestSeqRef.current) {
          setLoadError("Could not load your journal records.");
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filterParam],
  );

  // Refresh page one of the current filter and merge by id, so open trades
  // flip to closed (and brand-new ones appear at the top) without resetting
  // the loaded list or the user's scroll position.
  const refreshOpen = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/journal/trades?limit=${PAGE_SIZE}&offset=0&filter=${filterParam}`),
        { credentials: "include", cache: "no-store" },
      );
      const payload = (await response.json()) as {
        trades?: JournalTrade[];
        summary?: TradeSummary;
      };
      if (response.ok && payload.trades) {
        const page = payload.trades;
        setRecords((prev) => {
          const known = new Set(prev.map((trade) => trade.id));
          const fresh = page.filter((trade) => !known.has(trade.id));
          const updated = prev.map((trade) => page.find((next) => next.id === trade.id) ?? trade);
          return [...fresh, ...updated];
        });
        if (payload.summary) setSummary(payload.summary);
      }
    } catch {
      // Left as-is until the next tick.
    }
  }, [filterParam]);

  // A filter change (and the first mount) resets to page one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void loadPage(true);
  }, [loadPage]);

  // Periodic refresh keeps open trades current without a full reload.
  useEffect(() => {
    const timer = window.setInterval(() => void refreshOpen(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshOpen]);

  const loadMore = useCallback(() => {
    void loadPage(false);
  }, [loadPage]);
  useInfiniteScroll({
    sentinelRef,
    hasMore,
    loading: loading || loadingMore,
    onLoadMore: loadMore,
  });

  const totalTrades = summary?.total ?? records.length;
  const hasClosed = summary ? summary.winRate !== null : false;
  const winRateLabel = summary
    ? summary.winRate === null
      ? "0%"
      : `${(summary.winRate * 100).toFixed(0)}%`
    : "—";
  const avgR = summary?.avgR ?? 0;

  return (
    <div className="journal-view journal-minimal space-y-8 lg:space-y-10">
      {embedded ? (
        loadError ? <p className="text-xs text-[color:var(--danger)]">{loadError}</p> : null
      ) : (
        <header>
          <h1 className="text-display">Journal</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">Paper trades in R</p>
          {loadError ? <p className="mt-2 text-xs text-[color:var(--danger)]">{loadError}</p> : null}
        </header>
      )}

      <section
        className="journal-stats-card grid grid-cols-3"
        aria-label="Journal summary"
      >
        {(
          [
            ["Trades", totalTrades.toString()],
            ["Win rate", winRateLabel],
            ["Avg R", `${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R`],
          ] as const
        ).map(([label, value], index) => (
          <div key={label} className="journal-stat min-w-0">
            <p className="text-xs text-[color:var(--muted)]">{label}</p>
            <p
              className={`metric-number mt-1 text-xl font-semibold tracking-[-0.03em] ${
                index === 2 && hasClosed
                  ? avgR >= 0
                    ? "text-[color:var(--success)]"
                    : "text-[color:var(--danger)]"
                  : ""
              }`}
            >
              {value}
            </p>
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section" aria-label="Trade log">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Trade log</h2>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={`check-chip pressable ${
                  activeFilter === filter ? "check-chip-active" : ""
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <JournalEntriesSkeleton />
        ) : records.length ? (
          <>
            <div className="journal-entry-list mt-3">
              <AnimatePresence mode="popLayout" initial={false}>
                {records.map((trade) => (
                  <motion.div
                    layout
                    key={trade.id}
                    className="journal-entry-wrap"
                    initial={reducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <JournalTradeRow
                      trade={trade}
                      quote={trade.instrument ? quotes[trade.instrument] : undefined}
                      fill={trade.instrument ? fills[trade.instrument] : undefined}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {loadingMore ? (
              <p className="mt-4 text-center text-sm text-[color:var(--muted)]">
                Loading more…
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-6 text-sm text-[color:var(--muted)]">No trades in this view.</p>
        )}
      </section>
    </div>
  );
}
