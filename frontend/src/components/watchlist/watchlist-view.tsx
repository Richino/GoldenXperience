"use client";

import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManualProposalModal, type ManualProposal } from "@/components/analysis/manual-proposal";
import { WatchlistPairsSkeleton } from "@/components/ui/page-skeletons";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { INSTRUMENT_CATALOG, displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import type { WatchlistCondition } from "@/lib/watchlist-status";
import type { CandleSeries } from "@/types/forex";

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
type Day = { change: number | null; high: number | null; low: number | null; close: number | null };
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
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ManualProposal | null>(null);
  const [analyzingInstrument, setAnalyzingInstrument] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const quotes = useLiveQuotes();
  useEffect(() => {
    if (!proposal) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousHtmlHeight = document.documentElement.style.height;
    const previousBodyMinHeight = document.body.style.minHeight;
    const scrollY = window.scrollY;
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      if (touchStartY === null || currentY === undefined) return;
      const modal = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".manual-proposal")
        : null;
      if (!modal) {
        event.preventDefault();
        return;
      }
      const delta = currentY - touchStartY;
      const atTop = modal.scrollTop <= 0;
      const atBottom = modal.scrollTop + modal.clientHeight >= modal.scrollHeight - 1;
      if ((atTop && delta > 0) || (atBottom && delta < 0)) event.preventDefault();
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    // On iOS a position:fixed body with no explicit height leaves fixed
    // descendants (the portaled modal) short of the physical screen, so the
    // centered dialog rides up and the bare page shows below. Pinning html/body
    // to the dynamic viewport height gives the modal the full screen to center in.
    document.documentElement.style.height = "100dvh";
    document.body.style.minHeight = "100dvh";
    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.width = previousBodyWidth;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.documentElement.style.height = previousHtmlHeight;
      document.body.style.minHeight = previousBodyMinHeight;
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      window.scrollTo(0, scrollY);
    };
  }, [proposal]);
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
      setSelected((current) =>
        current && watchlist.some((row) => row.instrument === current)
          ? current
          : null,
      );
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
  const matched = rows
    .filter((row) => {
      const matches = `${row.instrument} ${description(row.instrument)}`
        .toLowerCase()
        .includes(query.toLowerCase());
      return matches;
    })
    .sort(
      (left, right) =>
        // Valid setups first, then pairs the backend actually evaluates
        // (the featured ones), then the rest of the catalog alphabetically.
        Number(right.setupStatus === "valid") -
          Number(left.setupStatus === "valid") ||
        Number(right.dataStatus !== "unavailable") -
          Number(left.dataStatus !== "unavailable") ||
        left.instrument.localeCompare(right.instrument),
    );
  const [visibleCount, setVisibleCount] = useState(WATCHLIST_PAGE_SIZE);
  // A new search resets paging so results start from the top of the filtered set.
  useEffect(() => {
    setVisibleCount(WATCHLIST_PAGE_SIZE);
  }, [query]);
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
  }, [hasMore]);
  // Lazily pull daily price + change for whatever pairs are currently on screen,
  // once per pair, so scrolling reveals data for the non-featured pairs too
  // without loading all 68 up front.
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
          const candleResponse = await fetch(
            apiUrl(
              `/api/oanda/candles?instrument=${instrument}&granularity=D&count=2`,
            ),
            { credentials: "include", cache: "no-store" },
          );
          const candlePayload = (await candleResponse.json()) as {
            data?: CandleSeries;
          };
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
            },
          ] as const;
        } catch {
          // Let it retry the next time this pair scrolls into view.
          dailyRequestedRef.current.delete(instrument);
          return [
            instrument,
            { change: null, high: null, low: null, close: null },
          ] as const;
        }
      }),
    ).then((entries) => {
      setDaily((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
  }, [shownInstrumentsKey]);
  const analyze = useCallback(async (instrument: string) => {
    setAnalysisError(null);
    setAnalyzingInstrument(instrument);
    try {
      const response = await fetch(apiUrl("/api/manual-analysis"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument }),
      });
      const payload = await response.json() as { proposal?: ManualProposal; error?: string };
      if (!response.ok || !payload.proposal) throw new Error(payload.error ?? "Analysis could not produce a proposal.");
      setProposal(payload.proposal);
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "Analysis could not run.");
    } finally {
      setAnalyzingInstrument(null);
    }
  }, []);

  const acceptProposal = useCallback(() => {
    if (!proposal) return;
    const parameters = new URLSearchParams({
      instrument: proposal.instrument,
      entry: String(proposal.entry),
      stop: String(proposal.stop),
      target: String(proposal.target),
      direction: proposal.direction,
      confidence: String(proposal.confidence),
      preferredEntryTime: proposal.preferredEntryTime,
      rationale: proposal.rationale,
      proposal: "manual-analysis",
    });
    const timeout = window.setTimeout(() => {
      router.push(`/chart?${parameters.toString()}`);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [proposal, router]);
  return (
    <div className="markets-workspace">
      <header className="markets-header">
        <div>
          <h1>Markets</h1>
        </div>
      </header>
      {error ? <p className="research-error">{error}</p> : null}
      {loading && !rows.length ? (
        <WatchlistPairsSkeleton />
      ) : (
        <div className="markets-terminal">
          <section className="markets-scanner">
            <div className="markets-toolbar">
              <label>
                <Search />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search markets..."
                />
              </label>
            </div>
            <div className="markets-table">
              {shown.map((row) => {
                const change = finiteOrNull(daily[row.instrument]?.change);
                // Fall back to the daily close when this pair has no live quote
                // (only the featured pairs stream), so every row shows a price.
                const price = mid(row) ?? finiteOrNull(daily[row.instrument]?.close);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={row.instrument}
                    className={`markets-row ${selected === row.instrument ? "is-selected" : ""}`}
                    onClick={() => {
                      setSelected(row.instrument);
                      router.push(`/chart?instrument=${row.instrument}`);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelected(row.instrument);
                      router.push(`/chart?instrument=${row.instrument}`);
                    }}
                    aria-label={`View ${displayNameFor(row.instrument)} chart and setup`}
                  >
                    <span className="markets-pair">
                      <span>
                        <b>{displayNameFor(row.instrument)}</b>
                        <small>{description(row.instrument)}</small>
                      </span>
                    </span>
                    <b className="metric-number">
                      {price === null
                        ? "—"
                        : formatChartPrice(price, row.instrument)}
                    </b>
                    <b
                      className={`metric-number ${change === null ? "" : `is-${change >= 0 ? "positive" : "negative"}`}`}
                    >
                      {change === null
                        ? "—"
                        : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                    </b>
                    <span className="markets-row-plan">
                      <button
                        type="button"
                        className="markets-row-analyze pressable"
                        disabled={analyzingInstrument === row.instrument}
                        onClick={(event) => {
                          event.stopPropagation();
                          void analyze(row.instrument);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {analyzingInstrument === row.instrument ? "Analyzing…" : "Analyze"}
                      </button>
                    </span>
                  </div>
                );
              })}
              {hasMore ? (
                <div
                  ref={loadMoreRef}
                  className="markets-load-more"
                  aria-hidden
                >
                  Loading more pairs…
                </div>
              ) : null}
            </div>
          </section>
        </div>
      )}
      <ManualProposalModal
        proposal={proposal}
        currentPrice={proposal
          ? proposal.direction === "long"
            ? quotes[proposal.instrument]?.ask ?? null
            : quotes[proposal.instrument]?.bid ?? null
          : null}
        onDismiss={() => setProposal(null)}
        onAccept={acceptProposal}
      />
      {analysisError ? <div className="manual-analysis-error" role="alert">{analysisError}</div> : null}
    </div>
  );
}
