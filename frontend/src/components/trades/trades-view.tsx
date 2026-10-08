"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowRight, Search, X } from "lucide-react";
import type { JournalTrade } from "@/types/forex";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { apiUrl } from "@/lib/api/url";
import { formatClockTime, formatShortDay } from "@/lib/format/datetime";
import {
  openTradeProgress,
  quoteToUsdRateFromQuotes,
  resolveOpenTradeQuote,
} from "@/lib/open-trade-progress";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import {
  useOpenPositionFills,
  type OpenPositionFill,
} from "@/lib/market-stream/use-open-positions";
import { useSupplementalQuotes } from "@/lib/market-stream/use-supplemental-quotes";
import { strategyTypeLabel } from "@/lib/strategy/family-label";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { TradesSkeleton, TradesSummarySkeleton, TradesToolbarSkeleton } from "@/components/ui/phone-skeletons";

type Tab = "open" | "closed" | "all";
type ClosedFilter = "all" | "wins" | "losses";

type Quote = { bid: number; ask: number } | undefined;
type Quotes = Record<string, { bid: number; ask: number } | undefined>;

type Summary = {
  total: number;
  winRate: number | null;
  avgR?: number;
  today?: { wins: number; losses: number; realizedPL: number | null };
  openTrades?: JournalTrade[];
};

const PAGE_SIZE = 60;

/* ------------------------------------------------------------------ helpers */

function decimalsForPair(pair: string) {
  return pair.endsWith("/JPY") || pair.endsWith("JPY") ? 3 : 5;
}

function fmtPrice(value: number | null | undefined, pair: string) {
  return value === null || value === undefined ? "—" : value.toFixed(decimalsForPair(pair));
}

function fmtMoney(value: number | null | undefined, withSign = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const body = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  const sign = value < 0 ? "-" : withSign ? "+" : "";
  return `${sign}${body}`;
}

function fmtR(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

/** R:R as `1:2` from the trade's own geometry. */
function rrLabel(trade: JournalTrade) {
  const risk = Math.abs(trade.entry - trade.stop);
  const reward = Math.abs(trade.target - trade.entry);
  if (!risk || !Number.isFinite(risk) || !Number.isFinite(reward)) return "—";
  const ratio = reward / risk;
  const rounded = Math.round(ratio * 10) / 10;
  return `1:${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`;
}

/** Whole-minute duration between two instants, e.g. `3h 18m` / `12m`. */
function durationLabel(from: string, to: string | number | null) {
  const start = new Date(from).getTime();
  const end = to === null ? Date.now() : new Date(to).getTime();
  const mins = Math.max(0, Math.floor((end - start) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function dayAndTime(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${formatShortDay(value)} · ${formatClockTime(value)}`;
}

function lotsFromFill(fill: OpenPositionFill | undefined) {
  if (!fill || !Number.isFinite(fill.units)) return null;
  return Math.abs(fill.units) / 100_000;
}

function fillForTrade(trade: JournalTrade, fills: Record<string, OpenPositionFill>) {
  // The OANDA id is unambiguous; instrument fallback only supports legacy rows
  // that predate persisted broker ids.
  return trade.brokerTradeId
    ? fills[`broker:${trade.brokerTradeId}`]
    : trade.instrument
      ? fills[trade.instrument]
      : undefined;
}

/** Live open-trade figures: current price, Open R, unrealised P&L, level fill. */
function liveMetrics(trade: JournalTrade, quote: Quote, quotes: Quotes, fill: OpenPositionFill | undefined) {
  const mark = resolveOpenTradeQuote(quote, fill);
  const progress = openTradeProgress({
    direction: trade.direction,
    instrument: trade.instrument ?? undefined,
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    bid: mark?.bid,
    ask: mark?.ask,
    riskAmount: trade.nominalRiskAmount,
    fill: fill ? { price: fill.price, units: fill.units } : null,
    quoteToUsdRate: trade.instrument ? quoteToUsdRateFromQuotes(trade.instrument, quotes) : null,
  });
  const current =
    mark && Number.isFinite(mark.bid) && Number.isFinite(mark.ask)
      ? ((mark.bid as number) + (mark.ask as number)) / 2
      : (fill?.currentPrice ?? null);
  const money = fill?.unrealizedPL ?? trade.paperPl ?? progress?.money ?? null;
  return {
    current: current === null || !Number.isFinite(current) ? null : current,
    openR: progress?.unrealizedR ?? null,
    money,
    lots: lotsFromFill(fill),
  };
}

function strategyLabel(trade: JournalTrade) {
  // A missing family is not an "Other" strategy. It is simply unavailable
  // metadata, and calling it Other made real recent trades look mislabeled.
  return trade.origin === "strategy" && trade.strategyFamily
    ? strategyTypeLabel(trade)
    : null;
}

function chartHrefForTrade(trade: JournalTrade) {
  if (!trade.instrument) return null;
  const focusId = trade.chartTradeId ?? trade.id;
  return `/chart?instrument=${trade.instrument}&trade=${focusId}`;
}

/* ---------------------------------------------------------------- primitives */

/* ----------------------------------------------------------- night ledger */
/*
 * Trades, 1:1 with the canvas artboards "Trades — Desktop / Mobile / Mobile,
 * trade detail". Layout lives in night-ledger.css (`nl-tr-*`). Rows select a
 * trade into the detail panel (desktop) or a bottom sheet (phone); the chart
 * is one tap further, from the panel's Open chart.
 */

type Live = ReturnType<typeof liveMetrics>;

function toneOf(value: number | null | undefined, flat = 0.005) {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) < flat) return "";
  return value > 0 ? "is-up" : "is-down";
}

/** Plain words for how a closed trade ended. */
function exitLabel(trade: JournalTrade) {
  if (trade.brokerExecutionStatus === "rejected") return "Not executed";
  switch (trade.outcome) {
    case "target_first":
      return "Take profit";
    case "stop_first":
      return "Stop loss";
    case "forced_close":
      return "Forced close";
    default:
      return "Closed";
  }
}

function SideChip({ direction }: { direction: "long" | "short" }) {
  return (
    <span className={`nl-tr-side ${direction === "long" ? "is-up" : "is-down"}`}>
      {direction === "long" ? "Long" : "Short"}
    </span>
  );
}

function RPill({ value }: { value: number | null | undefined }) {
  return <span className={`nl-tr-rpill metric-number ${toneOf(value)}`}>{fmtR(value)}</span>;
}

/** Bars for recent closed trades in R, oldest to newest, from a midline. */
function RBars({ results, compact = false }: { results: number[]; compact?: boolean }) {
  const wins = results.filter((r) => r > 0).length;
  const losses = results.filter((r) => r < 0).length;
  return (
    <span
      className={`nl-tr-bars${compact ? " is-compact" : ""}`}
      role="img"
      aria-label={`Last ${results.length} closed trades in R: ${wins} wins, ${losses} losses`}
    >
      {results.map((r, index) => (
        <span
          key={index}
          className={r >= 0 ? "is-win" : "is-loss"}
          style={{ "--r": Math.min(Math.abs(r), 2.2) } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

function TradesSummaryRow({
  tab,
  openCount,
  openPnl,
  realizedToday,
  closedCount,
  wins,
  losses,
  winRate,
  avgR,
  recentClosed,
  recentR,
}: {
  tab: Tab;
  openCount: number;
  openPnl: number | null;
  realizedToday: number | null;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  /** Loaded closed trades, newest first: the page on screen, not all history. */
  recentClosed: JournalTrade[];
  recentR: number[];
}) {
  const withPl = recentClosed.filter((t) => t.paperPl !== null && t.paperPl !== undefined);
  const net = withPl.reduce((sum, t) => sum + (t.paperPl ?? 0), 0);
  const withR = recentClosed.filter((t) => t.resultR !== null && Number.isFinite(t.resultR));
  const netR = withR.reduce((sum, t) => sum + (t.resultR ?? 0), 0);
  const hero =
    tab === "open"
      ? {
          label: `Unrealized P&L · ${openCount} open`,
          value: openPnl,
          sub: realizedToday === null ? "Nothing realized today" : `Realized today ${fmtMoney(realizedToday, true)}`,
        }
      : {
          // Only the loaded page is known here, so the label says how many.
          label: `Net realized · last ${withPl.length} closed`,
          value: withPl.length ? net : null,
          sub: withR.length ? `${fmtR(netR)} across ${withR.length} trades` : "No closed trades yet",
        };

  return (
    <section className="nl-tr-summary" aria-label="Summary">
      <div className="nl-tr-hero">
        <span className="nl-tr-hero-label">{hero.label}</span>
        <span className={`nl-tr-hero-value ${toneOf(hero.value)}`}>{fmtMoney(hero.value, true) ?? "—"}</span>
        <span className="nl-tr-hero-sub metric-number">{hero.sub}</span>
        {recentR.length ? (
          <span className="nl-tr-hero-bars">
            <RBars results={recentR.slice(-10)} compact />
          </span>
        ) : null}
      </div>
      {recentR.length ? (
        <div className="nl-tr-barcard">
          <div className="nl-tr-barcard-head">
            <span>R per closed trade, oldest to newest · last {recentR.length}</span>
            <span className={`metric-number ${toneOf(recentR.reduce((a, b) => a + b, 0))}`}>
              {fmtR(recentR.reduce((a, b) => a + b, 0))}
            </span>
          </div>
          <RBars results={recentR} />
        </div>
      ) : null}
      <dl className="nl-tr-stats">
        <div>
          <dt>Wins</dt>
          <dd className="metric-number is-up">{wins}</dd>
        </div>
        <div>
          <dt>Losses</dt>
          <dd className="metric-number is-down">{losses}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd className="metric-number">{winRate === null ? "—" : `${Math.round(winRate * 100)}%`}</dd>
        </div>
        <div>
          <dt>{avgR === null ? "Closed" : "Avg R"}</dt>
          <dd className="metric-number">{avgR === null ? closedCount : fmtR(avgR)}</dd>
        </div>
      </dl>
    </section>
  );
}

function TradeRow({
  trade,
  live,
  selected,
  onSelect,
}: {
  trade: JournalTrade;
  live: Live | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const isOpen = trade.status === "open";
  const r = isOpen ? live?.openR ?? null : trade.resultR;
  const money = isOpen ? live?.money ?? null : trade.paperPl ?? null;
  return (
    <button
      type="button"
      className={`nl-tr-row${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="nl-tr-pair">
        <b>{trade.pair}</b>
        <SideChip direction={trade.direction} />
      </span>
      <span className="nl-tr-muted nl-tr-hide-md">{strategyLabel(trade) ?? (trade.origin === "manual" ? "Manual" : "—")}</span>
      <span className="metric-number nl-tr-hide-sm">{fmtPrice(trade.entry, trade.pair)}</span>
      <span className="metric-number nl-tr-hide-sm">{fmtPrice(isOpen ? live?.current ?? null : trade.exit, trade.pair)}</span>
      <RPill value={r} />
      <span className={`nl-tr-money metric-number ${toneOf(money)}`}>{fmtMoney(money, true) ?? "—"}</span>
      <span className="nl-tr-muted metric-number nl-tr-hide-md">
        {durationLabel(trade.openedAt, isOpen ? null : trade.closedAt)}
      </span>
      <span className="nl-tr-muted nl-tr-hide-md nl-tr-hide-sm">{dayAndTime(isOpen ? trade.openedAt : trade.closedAt)}</span>
    </button>
  );
}

function TradeCard({
  trade,
  live,
  onSelect,
}: {
  trade: JournalTrade;
  live: Live | null;
  onSelect: () => void;
}) {
  const isOpen = trade.status === "open";
  const r = isOpen ? live?.openR ?? null : trade.resultR;
  const money = isOpen ? live?.money ?? null : trade.paperPl ?? null;
  const strategy = strategyLabel(trade) ?? (trade.origin === "manual" ? "Manual" : null);
  const when = isOpen ? `opened ${dayAndTime(trade.openedAt)}` : dayAndTime(trade.closedAt);
  return (
    <button type="button" className="nl-tr-card" onClick={onSelect} aria-label={`${trade.pair} trade details`}>
      <span className="nl-tr-card-top">
        <span className="nl-tr-pair">
          <b>{trade.pair}</b>
          <SideChip direction={trade.direction} />
        </span>
        <span className={`nl-tr-money metric-number ${toneOf(money)}`}>{fmtMoney(money, true) ?? "—"}</span>
      </span>
      <span className="nl-tr-card-meta">
        <span>{strategy ? `${strategy} · ${when}` : when}</span>
        <RPill value={r} />
      </span>
    </button>
  );
}

function TradeDetail({
  trade,
  live,
  variant,
  onClose,
}: {
  trade: JournalTrade;
  live: Live | null;
  variant: "panel" | "sheet";
  onClose?: () => void;
}) {
  const isOpen = trade.status === "open";
  const money = isOpen ? live?.money ?? null : trade.paperPl ?? null;
  const r = isOpen ? live?.openR ?? null : trade.resultR;
  const shownExit = isOpen ? live?.current ?? null : trade.exit;
  const notes = trade.notes?.trim();
  const reason = trade.brokerFailureReason?.trim() || trade.reason?.trim() || null;
  const lots = isOpen ? live?.lots ?? null : null;
  const href = chartHrefForTrade(trade);
  // Position on the stop → target line, 0–100. A short's span is negative,
  // so the same formula serves both sides.
  const span = trade.target - trade.stop;
  const at = (value: number | null | undefined) =>
    value === null || value === undefined || !span ? null : Math.min(100, Math.max(0, ((value - trade.stop) / span) * 100));
  const entryAt = at(trade.entry);
  const exitAt = at(shownExit);
  const tone = toneOf(r);
  const badge = isOpen ? "Open position" : exitLabel(trade);

  return (
    <div className={`nl-tr-detail is-${variant}`}>
      <div className="nl-tr-detail-head">
        <span className="nl-tr-detail-ident">
          <b>{trade.pair}</b>
          <SideChip direction={trade.direction} />
        </span>
        {variant === "sheet" && onClose ? (
          <button type="button" className="nl-tr-close" onClick={onClose} aria-label="Close trade details">
            <X aria-hidden="true" />
          </button>
        ) : (
          <span className="nl-tr-badge">{badge}</span>
        )}
      </div>

      <div className={`nl-tr-result ${tone}`}>
        {variant === "sheet" ? (
          <span className="nl-tr-result-label">
            {badge}
            {isOpen ? "" : ` · held ${durationLabel(trade.openedAt, trade.closedAt)}`}
          </span>
        ) : null}
        <span className="nl-tr-result-row">
          <span className="nl-tr-result-money">{fmtMoney(money, true) ?? "—"}</span>
          <span className="nl-tr-result-r metric-number">{fmtR(r)}</span>
        </span>
      </div>

      <div className="nl-tr-track-wrap">
        <span className="nl-tr-track" aria-hidden="true">
          {entryAt !== null && exitAt !== null ? (
            <span
              className={`nl-tr-track-fill ${tone}`}
              style={{ left: `${Math.min(entryAt, exitAt)}%`, width: `${Math.abs(exitAt - entryAt)}%` }}
            />
          ) : null}
          {entryAt !== null ? <span className="nl-tr-track-entry" style={{ left: `${entryAt}%` }} /> : null}
          {exitAt !== null ? <span className={`nl-tr-track-mark ${tone}`} style={{ left: `${exitAt}%` }} /> : null}
        </span>
        <span className="nl-tr-track-labels metric-number">
          <span className="is-down">SL {fmtPrice(trade.stop, trade.pair)}</span>
          <span className="nl-tr-muted">
            {isOpen ? "now" : "exit"} {fmtPrice(shownExit, trade.pair)}
          </span>
          <span className="is-up">TP {fmtPrice(trade.target, trade.pair)}</span>
        </span>
      </div>

      <dl className="nl-tr-grid">
        <div>
          <dt>Entry</dt>
          <dd className="metric-number">{fmtPrice(trade.entry, trade.pair)}</dd>
        </div>
        <div>
          <dt>{isOpen ? "Current" : "Exit"}</dt>
          <dd className="metric-number">{fmtPrice(shownExit, trade.pair)}</dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd className="metric-number is-down">{fmtPrice(trade.stop, trade.pair)}</dd>
        </div>
        <div>
          <dt>Take profit</dt>
          <dd className="metric-number is-up">{fmtPrice(trade.target, trade.pair)}</dd>
        </div>
        <div>
          <dt>R:R</dt>
          <dd className="metric-number">{rrLabel(trade)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd className="metric-number">{lots === null ? "—" : `${lots.toFixed(2)} lot`}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd className="metric-number">{dayAndTime(trade.openedAt)}</dd>
        </div>
        <div>
          <dt>{isOpen ? "Held" : "Closed"}</dt>
          <dd className="metric-number">{isOpen ? durationLabel(trade.openedAt, null) : dayAndTime(trade.closedAt)}</dd>
        </div>
        {trade.brokerTradeId ? (
          <div className="is-wide">
            <dt>OANDA entry spread</dt>
            <dd className="metric-number">
              {trade.oandaEntryHalfSpreadCost !== null && trade.oandaEntryHalfSpreadCost !== undefined
                ? fmtMoney(-Math.abs(trade.oandaEntryHalfSpreadCost))
                : "Waiting for OANDA"}
            </dd>
          </div>
        ) : null}
      </dl>

      {!isOpen ? (
        <div className="nl-tr-notes">
          <div>
            <span className="nl-tr-notes-label">Exit reason</span>
            <span className="nl-tr-notes-value">
              {reason ?? exitLabel(trade)} · held {durationLabel(trade.openedAt, trade.closedAt)}
            </span>
          </div>
          <div>
            <span className="nl-tr-notes-label">Trade notes</span>
            <span className={`nl-tr-notes-text${notes ? "" : " is-empty"}`}>{notes ? notes : "No trade notes."}</span>
          </div>
        </div>
      ) : null}

      <div className="nl-tr-actions">
        {href ? (
          <Link href={href} className="nl-tr-primary">
            Open chart <ArrowRight aria-hidden="true" />
          </Link>
        ) : (
          <span className="nl-tr-primary is-disabled">No chart for this trade</span>
        )}
      </div>
    </div>
  );
}

/** Phone: the selected trade as a bottom sheet (the "trade detail" artboard). */
function TradeDetailSheet({
  trade,
  live,
  onClose,
}: {
  trade: JournalTrade | null;
  live: Live | null;
  onClose: () => void;
}) {
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({
    open: trade !== null,
    onDismiss: onClose,
    handleSelector: ".nl-tr-grip, .nl-tr-detail-head",
  });
  if (!trade) return null;
  return createPortal(
    <div
      ref={setBackdrop}
      className="nl-tr-backdrop"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section ref={setSheet} className="nl-tr-sheet" role="dialog" aria-modal="true" aria-label={`${trade.pair} trade`} {...handlers}>
        <div className="nl-tr-grip" aria-hidden="true" />
        <TradeDetail trade={trade} live={live} variant="sheet" onClose={requestClose} />
      </section>
    </div>,
    document.body,
  );
}

function useWideLayout() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(min-width: 1024px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
}

/* --------------------------------------------------------------------- shell */

export function TradesView() {
  const [tab, setTab] = useState<Tab>("open");
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("all");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<JournalTrade[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phone only: the selected trade opens as a sheet when a card is tapped.
  const [sheetOpen, setSheetOpen] = useState(false);
  const wide = useWideLayout();
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const seqRef = useRef(0);
  const initialTabResolvedRef = useRef(false);

  const liveQuotes = useLiveQuotes();
  const openInstruments = useMemo(
    () => [
      ...new Set(
        (summary?.openTrades ?? [])
          .filter((t) => t.instrument)
          .map((t) => t.instrument as string),
      ),
    ],
    [summary?.openTrades],
  );
  const quotes = useSupplementalQuotes(openInstruments, liveQuotes);
  const fills = useOpenPositionFills();

  // Whole-journal aggregates + the full open-trade set (server computes both).
  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/journal/trades?limit=1&offset=0&filter=all"), {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { summary?: Summary };
      if (payload.summary) setSummary(payload.summary);
    } catch {
      /* keep the last good summary */
    }
  }, []);

  // The closed/all table is paged from the log; open trades come from summary.
  const loadPage = useCallback(
    async (reset: boolean) => {
      const seq = ++seqRef.current;
      const offset = reset ? 0 : offsetRef.current;
      if (!reset) setLoadingMore(true);
      try {
        const res = await fetch(
          apiUrl(`/api/journal/trades?limit=${PAGE_SIZE}&offset=${offset}&filter=all`),
          { credentials: "include", cache: "no-store" },
        );
        if (!res.ok) throw new Error("unavailable");
        const payload = (await res.json()) as { trades?: JournalTrade[]; hasMore?: boolean };
        if (seq !== seqRef.current) return;
        const batch = payload.trades ?? [];
        offsetRef.current = offset + batch.length;
        setRecords((prev) => {
          if (reset) return batch;
          const seen = new Set(prev.map((t) => t.id));
          return [...prev, ...batch.filter((t) => !seen.has(t.id))];
        });
        setHasMore(Boolean(payload.hasMore));
      } catch {
        /* leave the last page on screen */
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadPage(true)]);
  }, [loadSummary, loadPage]);

  useEffect(() => {
    // The first load settles its state inside async callbacks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshAll(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAll]);
  useForegroundRefresh(refreshAll);

  const openTrades = useMemo(() => summary?.openTrades ?? [], [summary?.openTrades]);
  const closedTrades = useMemo(() => records.filter((t) => t.status === "closed"), [records]);
  // Newest-first from the API; the strip reads left to right, oldest to newest.
  const recentR = useMemo(
    () =>
      closedTrades
        .slice(0, 20)
        .map((t) => t.resultR)
        .filter((r): r is number => r !== null && Number.isFinite(r))
        .reverse(),
    [closedTrades],
  );

  // A link can ask for a tab (Home's Recent activity opens ?tab=closed). It
  // wins over the no-open-position default below, which then never runs.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested !== "open" && requested !== "closed" && requested !== "all") return;
    initialTabResolvedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab(requested);
  }, []);

  // The first render cannot know whether an open position exists. Once the
  // journal summary arrives, make a no-open-position launch useful by showing
  // the latest closed trades. This runs once only, so a person's later tab
  // choice is never overwritten by a background refresh.
  useEffect(() => {
    if (!summary || initialTabResolvedRef.current) return;
    initialTabResolvedRef.current = true;
    // The API response is the external source that resolves the otherwise
    // unknown initial tab; later user choices are guarded by the ref above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!(summary.openTrades?.length ?? 0)) setTab("closed");
  }, [summary]);

  const openCount = openTrades.length;
  const closedCount = Math.max(0, (summary?.total ?? 0) - openCount);
  const allCount = summary?.total ?? openCount + closedTrades.length;

  // Live open aggregates for the summary strip.
  const openAgg = useMemo(() => {
    let openR = 0;
    let pnl = 0;
    let risk = 0;
    let rSeen = false;
    let pnlSeen = false;
    for (const t of openTrades) {
      const m = liveMetrics(
        t,
        t.instrument ? quotes[t.instrument] : undefined,
        quotes,
        fillForTrade(t, fills),
      );
      if (m.openR !== null) {
        openR += m.openR;
        rSeen = true;
      }
      if (m.money !== null) {
        pnl += m.money;
        pnlSeen = true;
      }
      if (t.nominalRiskAmount != null) risk += t.nominalRiskAmount;
    }
    return {
      openR: rSeen ? openR : null,
      pnl: pnlSeen ? pnl : null,
      risk: risk || null,
    };
  }, [openTrades, quotes, fills]);

  // Closed aggregates derived exactly from the server summary (no fabrication).
  const closedAgg = useMemo(() => {
    const winRate = summary?.winRate ?? null;
    const wins = winRate === null ? 0 : Math.round(winRate * closedCount);
    const losses = Math.max(0, closedCount - wins);
    return { winRate, wins, losses };
  }, [summary, closedCount]);

  // The API already returns closed trades by their actual close time (and open
  // trades by open time), so a client-only sort control cannot hide a newly
  // closed position behind a page boundary.
  const rows = useMemo(() => {
    let list: JournalTrade[] =
      tab === "open" ? openTrades : tab === "closed" ? closedTrades : records;
    // "eurusd", "eur/usd" and "EUR_USD" all match: compare letters and digits only.
    const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const q = compact(query);
    if (q) list = list.filter((t) => compact(t.pair).includes(q));
    if (tab === "closed" && closedFilter !== "all") {
      list = list.filter((t) => (closedFilter === "wins" ? t.result === "win" : t.result === "loss"));
    }
    return list;
  }, [tab, openTrades, closedTrades, records, query, closedFilter]);

  // Keep a valid selection as the visible set changes (follows the list rather
  // than syncing an external system, so the direct setState is intentional).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId((prev) => {
      if (!rows.length) return null;
      return prev && rows.some((t) => t.id === prev) ? prev : rows[0].id;
    });
  }, [rows]);

  const selected = useMemo(() => {
    const all = [...openTrades, ...records];
    return all.find((t) => t.id === selectedId) ?? null;
  }, [selectedId, openTrades, records]);

  const selectedLive = useMemo(() => {
    if (!selected || selected.status !== "open") return null;
    return liveMetrics(
      selected,
      selected.instrument ? quotes[selected.instrument] : undefined,
      quotes,
      fillForTrade(selected, fills),
    );
  }, [selected, quotes, fills]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: openCount },
    { id: "closed", label: "Closed", count: closedCount },
    { id: "all", label: "All", count: allCount },
  ];
  const initialTabLoading = loading && summary === null;

  const liveFor = (trade: JournalTrade) =>
    trade.status === "open"
      ? liveMetrics(trade, trade.instrument ? quotes[trade.instrument] : undefined, quotes, fillForTrade(trade, fills))
      : null;

  return (
    <div className="nl-tr">
      <header className="nl-tr-head">
        <div className="nl-tr-title">
          <span className="nl-overline">
            {openCount} open · {closedCount} closed
          </span>
          <h1>Trades</h1>
        </div>
        <NotificationBell compact={!wide} className="nl-tr-bell" />
      </header>

      {initialTabLoading ? (
        <TradesSummarySkeleton />
      ) : (
        <TradesSummaryRow
          tab={tab}
          openCount={openCount}
          openPnl={openAgg.pnl}
          realizedToday={summary?.today?.realizedPL ?? null}
          closedCount={closedCount}
          wins={closedAgg.wins}
          losses={closedAgg.losses}
          winRate={closedAgg.winRate}
          avgR={summary?.avgR ?? null}
          recentClosed={closedTrades}
          recentR={recentR}
        />
      )}

      {initialTabLoading ? (
        <TradesToolbarSkeleton showFilters={tab !== "open"} />
      ) : (
        <div className="nl-tr-toolbar">
          <div className="nl-tr-tabs" role="tablist" aria-label="Trade state">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "is-active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label} <span className="metric-number">{t.count}</span>
              </button>
            ))}
          </div>
          {tab !== "open" ? (
            <div className="nl-tr-filters" role="group" aria-label="Result filter">
              {(["all", "wins", "losses"] as ClosedFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={closedFilter === f}
                  className={closedFilter === f ? "is-active" : ""}
                  onClick={() => setClosedFilter(f)}
                >
                  {f === "all" ? "All" : f === "wins" ? "Wins" : "Losses"}
                </button>
              ))}
            </div>
          ) : null}
          <label className="nl-tr-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pair" aria-label="Search trades" />
          </label>
        </div>
      )}

      <div className="nl-tr-body">
        <section className="nl-tr-list" aria-label="Trade list">
          {loading ? (
            <TradesSkeleton />
          ) : rows.length ? (
            <>
              <div className="nl-tr-rowhead" aria-hidden="true">
                <span>Pair</span>
                <span className="nl-tr-hide-md">Strategy</span>
                <span className="nl-tr-hide-sm">Entry</span>
                <span className="nl-tr-hide-sm">{tab === "open" ? "Current" : "Exit"}</span>
                <span className="is-end">R</span>
                <span className="is-end">P/L</span>
                <span className="is-end nl-tr-hide-md">Held</span>
                <span className="is-end nl-tr-hide-md nl-tr-hide-sm">{tab === "open" ? "Opened" : "Closed"}</span>
              </div>
              <div className="nl-tr-rows">
                {rows.map((trade) => (
                  <TradeRow
                    key={trade.id}
                    trade={trade}
                    live={liveFor(trade)}
                    selected={trade.id === selectedId}
                    onSelect={() => setSelectedId(trade.id)}
                  />
                ))}
              </div>
              <div className="nl-tr-cards">
                {rows.map((trade) => (
                  <TradeCard
                    key={trade.id}
                    trade={trade}
                    live={liveFor(trade)}
                    onSelect={() => {
                      setSelectedId(trade.id);
                      setSheetOpen(true);
                    }}
                  />
                ))}
              </div>
              {tab !== "open" && hasMore ? (
                <button type="button" className="nl-tr-more" onClick={() => void loadPage(false)} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </>
          ) : (
            <p className="nl-tr-empty">{tab === "open" ? "No open positions right now." : "No trades in this view."}</p>
          )}
        </section>

        <aside className="nl-tr-panel" aria-label="Selected trade">
          {selected ? (
            <TradeDetail trade={selected} live={selectedLive} variant="panel" />
          ) : (
            <p className="nl-tr-empty">Select a trade to see its details.</p>
          )}
        </aside>
      </div>

      {wide ? null : (
        <TradeDetailSheet
          trade={sheetOpen ? selected : null}
          live={selectedLive}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}
