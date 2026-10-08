"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WatchlistPairsSkeleton } from "@/components/ui/page-skeletons";
import { MarketRowSkeleton } from "@/components/ui/ledger-loading-skeletons";
import { AnalyzeSheet } from "@/components/analysis/analyze-card";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { SessionStrip } from "@/components/watchlist/session-strip";
import { TradabilityTag, useNyTradability } from "@/components/signals/tradability-tag";
import { tradabilitySortKey } from "@/lib/strategy/ny-tradability";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { INSTRUMENT_CATALOG, displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import type { WatchlistCondition } from "@/lib/watchlist-status";
import { marketAnalysisContext, type AnalysisMode, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import { ANALYZE_HANDOFF_KEY, runMarketAnalysis, type AnalyzeHandoff } from "@/lib/strategy/run-market-analysis";
import type { CandleSeries, MajorInstrument } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

type Row = {
  instrument: string;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  session: string;
  conditions: WatchlistCondition[];
  openTradeId: string | null;
  tradeSequence: string | null;
};
/** A placeholder row for a catalog pair the backend hasn't evaluated yet: it is
 * browsable and can be charted or Analyzed on demand, it just carries no live
 * setup data until then. */
const EMPTY_ROW: Omit<Row, "instrument"> = {
  dataStatus: "unavailable",
  setupStatus: "no_setup",
  direction: null,
  bid: null,
  ask: null,
  spreadPips: null,
  entry: null,
  stop: null,
  target: null,
  session: "",
  conditions: [],
  openTradeId: null,
  tradeSequence: null,
};
/** How many rows to reveal per infinite-scroll page. */
const WATCHLIST_PAGE_SIZE = 20;
type Day = { change: number | null; high: number | null; low: number | null; close: number | null; spark: number[] | null };
const names: Record<string, string> = {
  AUD: "Australian Dollar",
  CAD: "Canadian Dollar",
  CHF: "Swiss Franc",
  EUR: "Euro",
  GBP: "British Pound",
  JPY: "Japanese Yen",
  NZD: "New Zealand Dollar",
  USD: "US Dollar",
};
const finiteOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const mid = (row: Row) => {
  const bid = finiteOrNull(row.bid),
    ask = finiteOrNull(row.ask);
  return bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
};
const description = (instrument: string) => {
  const [base, quote] = instrument.split("_");
  return `${names[base ?? ""] ?? base} / ${names[quote ?? ""] ?? quote}`;
};
export function WatchlistView() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Row[]>([]);
  const [daily, setDaily] = useState<Record<string, Day>>({});
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<PairGroup>("all");
  const [sort, setSort] = useState<PairSort>("setups");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Analyze runs here; normal is null while it is still reading.
  const [analysis, setAnalysis] = useState<{
    instrument: MajorInstrument;
    normal: MarketAnalysis | null;
    swing: MarketAnalysis | null;
  } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const quotes = useLiveQuotes();
  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/watchlist"), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        watchlist?: Row[];
        error?: string;
      };
      if (!response.ok || !payload.watchlist)
        throw new Error(payload.error ?? "Markets are unavailable.");
      const watchlist = payload.watchlist;
      setSnapshot(watchlist);
      // Per-pair daily data (price + change) is fetched lazily for whatever rows
      // are on screen — see the effect below — so opening the full 68-pair
      // catalog doesn't fire dozens of candle requests at once.
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Markets are unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0),
      timer = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);
  useForegroundRefresh(load);
  const snapshotByInstrument = useMemo(
    () => new Map(snapshot.map((row) => [row.instrument, row])),
    [snapshot],
  );
  // Every tradeable OANDA pair from the static catalog, with the backend's live
  // setup data merged in for the ones it evaluates. Pairs it hasn't evaluated
  // still list (browse / chart / Analyze on demand) with empty fields.
  const rows = useMemo(
    () =>
      INSTRUMENT_CATALOG.map(({ name: instrument }) => {
        const row = snapshotByInstrument.get(instrument) ?? { instrument, ...EMPTY_ROW };
        const quote = quotes[instrument],
          bid = finiteOrNull(quote?.bid ?? row.bid),
          ask = finiteOrNull(quote?.ask ?? row.ask);
        return {
          ...row,
          instrument,
          bid,
          ask,
          spreadPips:
            bid !== null && ask !== null
              ? (ask - bid) / pipSizeFor(instrument)
              : finiteOrNull(row.spreadPips),
          entry: finiteOrNull(row.entry),
          stop: finiteOrNull(row.stop),
          target: finiteOrNull(row.target),
        };
      }),
    [snapshotByInstrument, quotes],
  );
  // "eurusd", "eur/usd" and "EUR_USD" all match the pair; names ("euro", "yen") still match too.
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const needle = compact(query);
  // Absolute daily move; -1 for pairs whose daily data has not loaded yet.
  const changeOf = (instrument: string) => {
    const change = finiteOrNull(daily[instrument]?.change);
    return change === null ? -1 : Math.abs(change);
  };
  const filtered = rows
    .filter((row) =>
      !needle
      || compact(row.instrument).includes(needle)
      || description(row.instrument).toLowerCase().includes(query.trim().toLowerCase()))
    .filter((row) => group === "all" || groupOf(row.instrument) === group);
  // Valid setups first, then pairs the backend actually evaluates
  // (the featured ones), then the rest of the catalog alphabetically.
  const bySetups = (left: (typeof rows)[number], right: (typeof rows)[number]) =>
    Number(right.setupStatus === "valid") -
      Number(left.setupStatus === "valid") ||
    Number(right.dataStatus !== "unavailable") -
      Number(left.dataStatus !== "unavailable") ||
    left.instrument.localeCompare(right.instrument);
  const byChosenSort = (left: (typeof rows)[number], right: (typeof rows)[number]) =>
    sort === "name"
      ? left.instrument.localeCompare(right.instrument)
      : sort === "move"
        ? // Pairs without daily data yet sort last.
          changeOf(right.instrument) - changeOf(left.instrument) || left.instrument.localeCompare(right.instrument)
        : bySetups(left, right);
  const [visibleCount, setVisibleCount] = useState(WATCHLIST_PAGE_SIZE);
  // NY session tradability for the rows on screen, in batched requests. Sorting
  // by it needs every filtered pair scored, so that sort asks for all of them.
  const tradability = useNyTradability(
    (sort === "tradability" ? filtered : [...filtered].sort(byChosenSort).slice(0, visibleCount)).map((row) => row.instrument),
    !loading,
  );
  const matched = [...filtered].sort(
    sort === "tradability"
      ? (left, right) => {
          // Scored pairs by score, then blocked, then unavailable; ties keep
          // the default order.
          const a = tradabilitySortKey(tradability.get(left.instrument));
          const b = tradabilitySortKey(tradability.get(right.instrument));
          return a.group - b.group || b.score - a.score || bySetups(left, right);
        }
      : byChosenSort,
  );
  // A new search resets paging so results start from the top of the filtered set.
  useEffect(() => {
    setVisibleCount(WATCHLIST_PAGE_SIZE);
  }, [query, group, sort]);
  const shown = matched.slice(0, visibleCount);
  const hasMore = matched.length > shown.length;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => count + WATCHLIST_PAGE_SIZE);
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading]);
  // Lazily pull daily price + change for whatever pairs are currently on screen,
  // once per pair, so scrolling reveals data for the non-featured pairs too
  // without loading all 68 up front.
  // Ranked only among pairs whose daily data has arrived; the header says so.
  const loadedDailyCount = rows.filter((row) => finiteOrNull(daily[row.instrument]?.change) !== null).length;
  const movers = rows
    .map((row) => {
      const day = daily[row.instrument];
      const change = finiteOrNull(day?.change);
      const price = mid(row) ?? finiteOrNull(day?.close);
      const high = finiteOrNull(day?.high);
      const low = finiteOrNull(day?.low);
      const rangePosition =
        price !== null && high !== null && low !== null && high > low
          ? Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100))
          : null;
      return change === null || price === null
        ? null
        : { instrument: row.instrument, change, price, rangePosition, spark: day?.spark ?? null };
    })
    .filter((mover): mover is NonNullable<typeof mover> => mover !== null)
    .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
    .slice(0, 4);
  const shownInstrumentsKey = shown.map((row) => row.instrument).join(",");
  const dailyRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const instruments = shownInstrumentsKey ? shownInstrumentsKey.split(",") : [];
    const missing = instruments.filter(
      (instrument) => !dailyRequestedRef.current.has(instrument),
    );
    if (!missing.length) return;
    missing.forEach((instrument) => dailyRequestedRef.current.add(instrument));
    void Promise.all(
      missing.map(async (instrument) => {
        try {
          const [candleResponse, hourlyResponse] = await Promise.all([
            fetch(
              apiUrl(
                `/api/oanda/candles?instrument=${instrument}&granularity=D&count=2`,
              ),
              { credentials: "include", cache: "no-store" },
            ),
            // The row's sparkline: the last 24 hourly closes.
            fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=H1&count=24`), {
              credentials: "include",
              cache: "no-store",
            }).catch(() => null),
          ]);
          const candlePayload = (await candleResponse.json()) as {
            data?: CandleSeries;
          };
          const hourlyPayload = hourlyResponse?.ok
            ? ((await hourlyResponse.json()) as { data?: CandleSeries })
            : null;
          const spark = hourlyPayload?.data?.candles.map((candle) => candle.close) ?? null;
          const current = candlePayload.data?.candles.at(-1),
            previous = candlePayload.data?.candles.at(-2);
          return [
            instrument,
            {
              change:
                current && previous
                  ? ((current.close - previous.close) / previous.close) * 100
                  : null,
              high: current?.high ?? null,
              low: current?.low ?? null,
              close: current?.close ?? null,
              spark,
            },
          ] as const;
        } catch {
          // Let it retry the next time this pair scrolls into view.
          dailyRequestedRef.current.delete(instrument);
          return [
            instrument,
            { change: null, high: null, low: null, close: null, spark: null },
          ] as const;
        }
      }),
    ).then((entries) => {
      setDaily((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
  }, [shownInstrumentsKey]);
  // Analyze reads the pair in place (the same Normal/Swing plan as the
  // chart). Only accepting the plan leaves Markets: the chart opens with the
  // entry form filled in for review.
  const analyze = useCallback(async (instrument: MajorInstrument) => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalysisError(null);
    setAnalysis({ instrument, normal: null, swing: null });
    try {
      // Open trades and resting orders, for the same-currency warning.
      const exposure = await fetch(apiUrl("/api/pending-entries"), { credentials: "include", cache: "no-store", signal: controller.signal })
        .then(async (response) => response.ok ? ((await response.json()) as { entries?: PendingManualEntry[] }).entries ?? [] : [])
        .then((entries) => entries
          .filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING" || (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open"))
          .map((entry) => ({ instrument: entry.instrument, direction: entry.direction })))
        .catch(() => []);
      const { normal, swing } = await runMarketAnalysis({ instrument, signal: controller.signal, exposure });
      if (analysisAbortRef.current !== controller) return;
      setAnalysis({ instrument, normal, swing });
    } catch (reason) {
      if (controller.signal.aborted) return;
      setAnalysis(null);
      setAnalysisError(reason instanceof Error ? reason.message : "Analysis could not run.");
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null;
    }
  }, []);
  const closeAnalysis = useCallback(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setAnalysis(null);
  }, []);
  const reviewPlan = useCallback((mode: AnalysisMode) => {
    if (!analysis?.normal) return;
    const plan = mode === "SWING" && analysis.swing ? analysis.swing : analysis.normal;
    if (!plan.trade || plan.decision === "NO TRADE") return;
    const handoff: AnalyzeHandoff = {
      instrument: analysis.instrument,
      proposal: {
        direction: plan.decision === "LONG" ? "long" : "short",
        entry: plan.trade.entry,
        stop: plan.trade.stopLoss,
        target: plan.trade.takeProfit,
        confidence: null,
        rationale: plan.reason,
        preferredEntryTime: new Date().toISOString(),
        activateAt: plan.activateAfter,
        analysisContext: marketAnalysisContext(plan),
      },
    };
    try {
      window.sessionStorage.setItem(ANALYZE_HANDOFF_KEY, JSON.stringify(handoff));
    } catch {
      setAnalysisError("Could not hand the plan to the chart.");
      return;
    }
    setAnalysis(null);
    router.push(`/chart?instrument=${analysis.instrument}&plan=analyze`);
  }, [analysis, router]);
  const groups: Array<{ id: PairGroup; label: string }> = [
    { id: "all", label: "All" },
    { id: "major", label: "Majors" },
    { id: "yen", label: "Yen crosses" },
    { id: "cross", label: "Other crosses" },
  ];
  const sorts: Array<{ id: PairSort; label: string }> = [
    { id: "setups", label: "Setups first" },
    { id: "move", label: "Biggest move" },
    { id: "name", label: "A–Z" },
    { id: "tradability", label: "Most tradable" },
  ];

  return (
    <div className="nl-mk">
      <header className="nl-mk-head">
        <div className="nl-mk-title">
          <span className="nl-overline">{INSTRUMENT_CATALOG.length} pairs · live</span>
          <h1>Markets</h1>
        </div>
        <NotificationBell compact className="nl-mk-bell" />
        <SessionStrip />
      </header>
      {error ? <p className="nl-mk-error">{error}</p> : null}

      {movers.length && !needle ? (
        <section className="nl-mk-movers" aria-labelledby="nl-mk-movers-title">
          <div className="nl-mk-sec-head">
            <h2 id="nl-mk-movers-title">Biggest moves today</h2>
            {/* Daily data loads per page of rows, so say what was ranked. */}
            <span>of {loadedDailyCount} pairs loaded</span>
          </div>
          <div className="nl-mk-movers-grid">
            {movers.map((mover) => (
              <Link
                key={mover.instrument}
                href={`/chart?instrument=${mover.instrument}`}
                className="nl-mk-mover"
                aria-label={`View ${displayNameFor(mover.instrument)} chart`}
              >
                <span className="nl-mk-mover-top">
                  <b>{displayNameFor(mover.instrument)}</b>
                  <ChangePill change={mover.change} />
                </span>
                <Spark points={mover.spark} up={mover.change >= 0} className="nl-mk-mover-spark" />
                <span className="nl-mk-mover-price metric-number">{formatChartPrice(mover.price, mover.instrument)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="nl-mk-all" aria-labelledby="nl-mk-all-title">
        <div className="nl-mk-toolbar">
          <h2 id="nl-mk-all-title">All pairs</h2>
          <div className="nl-mk-groups" role="group" aria-label="Pair group">
            {groups.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={group === option.id}
                className={group === option.id ? "is-active" : ""}
                onClick={() => setGroup(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="nl-mk-sorts" role="group" aria-label="Sort">
            {sorts.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={sort === option.id}
                className={`${sort === option.id ? "is-active" : ""}${option.id === "move" || option.id === "name" ? " nl-mk-sort-wide" : ""}`}
                onClick={() => setSort(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="nl-mk-search">
            <Search aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search markets"
              aria-label="Search markets"
            />
          </label>
        </div>

        {loading ? (
          <WatchlistPairsSkeleton />
        ) : (
          <>
            <div className="nl-mk-rowhead" aria-hidden="true">
              <span>Pair</span>
              <span className="nl-mk-hide-md">Today</span>
              <span className="is-end">Price</span>
              <span className="is-end nl-mk-hide-sm">Change</span>
              <span className="nl-mk-hide-sm">Day range</span>
              <span className="is-end nl-mk-hide-md">Spread</span>
              <span />
            </div>
            <div className="nl-mk-rows">
              {shown.map((row) => {
                const day = daily[row.instrument];
                // Reveal the pair and its market fields together after both
                // daily candles and the sparkline request have settled.
                if (!day) return <MarketRowSkeleton key={row.instrument} />;
                const change = finiteOrNull(day?.change);
                // Fall back to the daily close when this pair has no live quote
                // (only the featured pairs stream), so every row shows a price.
                const price = mid(row) ?? finiteOrNull(day?.close);
                const high = finiteOrNull(day?.high);
                const low = finiteOrNull(day?.low);
                const rangeAt =
                  price !== null && high !== null && low !== null && high > low
                    ? Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100))
                    : null;
                const name = displayNameFor(row.instrument);
                const busy = analysis?.instrument === row.instrument && analysis.normal === null;
                return (
                  <div key={row.instrument} className="nl-mk-row">
                    <Link href={`/chart?instrument=${row.instrument}`} className="nl-mk-pair" aria-label={`View ${name} chart`}>
                      <Coins instrument={row.instrument} />
                      <span className="nl-mk-pair-copy">
                        <b>{name}</b>
                        <small>{description(row.instrument)}</small>
                        <TradabilityTag item={tradability.get(row.instrument)} />
                      </span>
                    </Link>
                    <Spark points={day?.spark ?? null} up={(change ?? 0) >= 0} className="nl-mk-row-spark nl-mk-hide-md" />
                    <span className="nl-mk-price metric-number">
                      {price === null ? "—" : formatChartPrice(price, row.instrument)}
                      <span className="nl-mk-narrow-change">
                        <ChangePill change={change} />
                      </span>
                    </span>
                    <span className="nl-mk-hide-sm nl-mk-change-cell">
                      <ChangePill change={change} />
                    </span>
                    <span className="nl-mk-range nl-mk-hide-sm">
                      {rangeAt !== null && high !== null && low !== null ? (
                        <>
                          <span className="nl-mk-range-bar" aria-hidden="true">
                            <span style={{ left: `${rangeAt}%` }} />
                          </span>
                          <span className="nl-mk-range-ends metric-number">
                            <span>{formatChartPrice(low, row.instrument)}</span>
                            <span>{formatChartPrice(high, row.instrument)}</span>
                          </span>
                        </>
                      ) : (
                        <span className="nl-mk-muted">—</span>
                      )}
                    </span>
                    <span className="nl-mk-spread metric-number nl-mk-hide-md">
                      {row.spreadPips === null ? "—" : row.spreadPips.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      className="nl-mk-analyze pressable"
                      disabled={busy}
                      onClick={() => void analyze(row.instrument as MajorInstrument)}
                      aria-label={`Analyze ${name}`}
                    >
                      <AnalyzeIcon className="size-[14px]" />
                      <span className="nl-mk-analyze-label">{busy ? "Analyzing…" : "Analyze"}</span>
                    </button>
                  </div>
                );
              })}
              {!shown.length ? <p className="nl-mk-empty">No pairs match that search.</p> : null}
              {hasMore ? (
                <div ref={loadMoreRef} className="nl-mk-more" aria-hidden>
                  Loading more pairs…
                </div>
              ) : null}
            </div>
          </>
        )}
      </section>

      <AnalyzeSheet
        normal={analysis?.normal ?? null}
        swing={analysis?.swing ?? null}
        analyzing={analysis !== null && analysis.normal === null}
        instrument={analysis?.instrument ?? "EUR_USD"}
        onClose={closeAnalysis}
        onCancel={closeAnalysis}
        onReview={reviewPlan}
      />
      {analysisError ? <div className="manual-analysis-error" role="alert">{analysisError}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- night ledger */

type PairGroup = "all" | "major" | "yen" | "cross";
type PairSort = "setups" | "move" | "name" | "tradability";

const MAJOR_CURRENCIES = new Set(["EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "JPY"]);

/** Majors: USD against another G8 currency. Yen crosses: non-USD vs JPY. */
function groupOf(instrument: string): Exclude<PairGroup, "all"> {
  const [base = "", quote = ""] = instrument.split("_");
  if ((base === "USD" && MAJOR_CURRENCIES.has(quote)) || (quote === "USD" && MAJOR_CURRENCIES.has(base))) return "major";
  if (quote === "JPY") return "yen";
  return "cross";
}

function Coins({ instrument }: { instrument: string }) {
  const [base = "", quote = ""] = instrument.split("_");
  return (
    <span className="nl-mk-coins" aria-hidden="true">
      <span>{base}</span>
      <span>{quote}</span>
    </span>
  );
}

function ChangePill({ change }: { change: number | null }) {
  if (change === null) return <span className="nl-mk-muted">—</span>;
  return (
    <span className={`nl-mk-pill metric-number ${change >= 0 ? "is-up" : "is-down"}`}>
      {change >= 0 ? "+" : "−"}
      {Math.abs(change).toFixed(2)}%
    </span>
  );
}

/** The last 24 hourly closes as a line; empty until the candles arrive. */
function Spark({ points, up, className }: { points: number[] | null; up: boolean; className: string }) {
  if (!points || points.length < 2) return <span className={className} aria-hidden="true" />;
  const high = Math.max(...points);
  const low = Math.min(...points);
  const span = high - low || 1;
  const path = points
    .map((value, index) => `${((index / (points.length - 1)) * 100).toFixed(2)},${(30 - ((value - low) / span) * 28).toFixed(2)}`)
    .join(" ");
  return (
    <svg className={className} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={path}
        fill="none"
        className={up ? "is-up" : "is-down"}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
