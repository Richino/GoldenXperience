"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import type { ConnectionStatus, JournalTrade } from "@/types/forex";
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
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

type Tab = "open" | "closed" | "all";
type ClosedFilter = "all" | "wins" | "losses";

type Quote = { bid: number; ask: number } | undefined;
type Quotes = Record<string, { bid: number; ask: number } | undefined>;

type Summary = {
  total: number;
  winRate: number | null;
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

/** Live open-trade figures: current price, Open R, unrealised P&L, level fill. */
function liveMetrics(trade: JournalTrade, quote: Quote, quotes: Quotes, fill: OpenPositionFill | undefined) {
  const mark = resolveOpenTradeQuote(quote, fill?.currentPrice);
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
  const money = trade.paperPl ?? fill?.unrealizedPL ?? progress?.money ?? null;
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

function activityLabel(trade: JournalTrade) {
  if (trade.brokerExecutionStatus === "rejected") return "BROKER REJECTED";
  switch (trade.outcome) {
    case "target_first":
      return "TARGET FIRST";
    case "stop_first":
      return "STOP FIRST";
    case "forced_close":
      return "FORCED CLOSED";
    default:
      return "CLOSED";
  }
}

function chartHrefForTrade(trade: JournalTrade) {
  // Only strategy trades exist in the chart's trade-marker dataset. Direct
  // broker imports can still be inspected in the journal, but must not claim
  // to focus a chart trade that does not exist there.
  return trade.origin === "strategy" && trade.instrument
    ? `/chart?instrument=${trade.instrument}&trade=${trade.id}`
    : null;
}

/* ---------------------------------------------------------------- primitives */

function SideBadge({ direction }: { direction: "long" | "short" }) {
  return (
    <span className={`trade-side is-${direction}`}>{direction === "long" ? "LONG" : "SHORT"}</span>
  );
}

function ResultBadge({ trade }: { trade: JournalTrade }) {
  if (trade.brokerExecutionStatus === "rejected") {
    return <span className="trade-result is-be">NOT EXECUTED</span>;
  }
  const map = { win: "WIN", loss: "LOSS", breakeven: "BE", open: "OPEN" } as const;
  const tone = trade.result === "win" ? "is-win" : trade.result === "loss" ? "is-loss" : "is-be";
  return <span className={`trade-result ${tone}`}>{map[trade.result]}</span>;
}

/* ------------------------------------------------------------ summary strips */

function OpenSummary({
  count,
  pnl,
  realized,
}: {
  count: number;
  pnl: number | null;
  realized: number | null;
}) {
  const pnlTone = pnl === null ? "" : pnl >= 0 ? "is-positive" : "is-negative";
  const realizedTone = realized === null ? "" : realized >= 0 ? "is-positive" : "is-negative";
  return (
    <div className="trades-summary" role="group" aria-label="Open trades summary">
      <span className="trades-summary-item">
        <b>{count}</b> <i>open {count === 1 ? "trade" : "trades"}</i>
      </span>
      <span className="trades-summary-item">
        <b className={pnlTone}>{fmtMoney(pnl, true) ?? "—"}</b> <i>unrealized P&amp;L</i>
      </span>
      <span className="trades-summary-item">
        <b className={realizedTone}>{fmtMoney(realized, true) ?? "—"}</b> <i>realized P&amp;L</i>
      </span>
    </div>
  );
}

function ClosedSummary({
  closed,
  wins,
  losses,
  winRate,
}: {
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
}) {
  return (
    <div className="trades-summary" role="group" aria-label="Closed trades summary">
      <span className="trades-summary-item">
        <b>{closed}</b> <i>closed {closed === 1 ? "trade" : "trades"}</i>
      </span>
      <span className="trades-summary-item">
        <b className="is-positive">{wins}</b> <i>wins</i>
      </span>
      <span className="trades-summary-item">
        <b className="is-negative">{losses}</b> <i>losses</i>
      </span>
      <span className="trades-summary-item">
        <b>{winRate === null ? "—" : `${Math.round(winRate * 100)}%`}</b> <i>win rate</i>
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- level graph */

function LevelProgress({
  trade,
  current,
}: {
  trade: JournalTrade;
  current: number | null;
}) {
  const span = trade.target - trade.stop;
  const frac = (v: number) => {
    if (!span) return 0;
    return Math.min(1, Math.max(0, (v - trade.stop) / span));
  };
  const entryF = frac(trade.entry);
  const nowF = current === null ? entryF : frac(current);
  return (
    <div className="trade-level">
      <div className="trade-level-marks">
        <span className="trade-level-mark is-start">
          <i>SL</i>
          <b className="metric-number">{fmtPrice(trade.stop, trade.pair)}</b>
        </span>
        <span className="trade-level-mark is-mid">
          <i>ENTRY</i>
          <b className="metric-number">{fmtPrice(trade.entry, trade.pair)}</b>
        </span>
        <span className="trade-level-mark is-end">
          <i>TP</i>
          <b className="metric-number">{fmtPrice(trade.target, trade.pair)}</b>
        </span>
      </div>
      <div className="trade-level-track">
        <span className="trade-level-fill" style={{ width: `${nowF * 100}%` }} />
        <span className="trade-level-tick" style={{ left: `${entryF * 100}%` }} />
        <span className="trade-level-knob" style={{ left: `${nowF * 100}%` }} />
      </div>
      {current !== null ? (
        <p className="trade-level-current" style={{ left: `${nowF * 100}%` }}>
          <i>CURRENT</i>
          <b className="metric-number">{fmtPrice(current, trade.pair)}</b>
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- detail panel */

function DetailRow({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="trade-detail-cell">
      <dt>{label}</dt>
      <dd className={`metric-number ${className ?? ""}`}>{value}</dd>
    </div>
  );
}

function SelectedTradePanel({
  trade,
  live,
}: {
  trade: JournalTrade;
  live: ReturnType<typeof liveMetrics> | null;
}) {
  const isOpen = trade.status === "open";
  const money = isOpen ? live?.money ?? null : trade.paperPl ?? null;
  const rValue = isOpen ? live?.openR ?? null : trade.resultR;
  const moneyTone = money === null ? "" : money >= 0 ? "is-positive" : "is-negative";
  const notes = trade.notes?.trim();
  const exitReason = trade.brokerFailureReason?.trim() || trade.reason?.trim() || (trade.outcome ? trade.outcome.replace(/_/g, " ") : null);
  const lots = isOpen ? live?.lots ?? null : null;

  return (
    <aside className="trades-panel" aria-label="Selected trade">
      <div className="trades-panel-head">
        <div className="trades-panel-ident">
          <span className="trades-panel-pair">{trade.pair}</span>
          <SideBadge direction={trade.direction} />
        </div>
        {isOpen ? (
          <span className="trades-panel-tag">OPEN POSITION</span>
        ) : (
          <ResultBadge trade={trade} />
        )}
      </div>

      <p className={`trades-panel-pnl metric-number ${moneyTone}`}>
        {money === null ? "—" : fmtMoney(money, true)}
        <span className="trades-panel-r">{fmtR(rValue)}</span>
      </p>

      {isOpen ? <LevelProgress trade={trade} current={live?.current ?? null} /> : null}

      <dl className="trade-detail-grid">
        <DetailRow label="Entry" value={fmtPrice(trade.entry, trade.pair)} />
        <DetailRow
          label={isOpen ? "Current" : "Exit"}
          value={fmtPrice(isOpen ? live?.current ?? null : trade.exit, trade.pair)}
        />
        <DetailRow label="Stop loss" value={fmtPrice(trade.stop, trade.pair)} className="is-negative" />
        <DetailRow label="Take profit" value={fmtPrice(trade.target, trade.pair)} className="is-positive" />
        <DetailRow label="R:R" value={rrLabel(trade)} />
        <DetailRow label="Size" value={lots === null ? "—" : `${lots.toFixed(2)} lot`} />
        <DetailRow label="Opened" value={dayAndTime(trade.openedAt)} />
        <DetailRow
          label={isOpen ? "Duration" : "Closed"}
          value={isOpen ? durationLabel(trade.openedAt, null) : dayAndTime(trade.closedAt)}
        />
      </dl>

      {!isOpen && exitReason ? (
        <section className="trade-panel-section trade-panel-exit">
          <p className="trade-panel-label">Exit reason</p>
          <p className="trade-panel-exit-value">
            {exitReason}
            <span> · {durationLabel(trade.openedAt, trade.closedAt)}</span>
          </p>
        </section>
      ) : null}

      {!isOpen ? (
        <section className="trade-panel-section">
          <p className="trade-panel-label">Trade notes</p>
          <p className="trade-panel-notes">{notes ? notes : "No trade notes."}</p>
        </section>
      ) : null}

      <div className="trades-panel-actions">
        {trade.instrument ? (
          <Link href={`/chart?instrument=${trade.instrument}&trade=${trade.id}`} className="trade-btn-primary">
            Open Chart <ArrowRight aria-hidden />
          </Link>
        ) : (
          <span className="trade-btn-primary is-disabled">No chart</span>
        )}
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------------- table rows */

function OpenRow({
  trade,
  live,
  selected,
  onSelect,
}: {
  trade: JournalTrade;
  live: ReturnType<typeof liveMetrics>;
  selected: boolean;
  onSelect: () => void;
}) {
  const rTone = live.openR === null ? "" : live.openR >= 0 ? "is-positive" : "is-negative";
  const pnlTone = live.money === null ? "" : live.money >= 0 ? "is-positive" : "is-negative";
  const strategy = strategyLabel(trade);
  const href = chartHrefForTrade(trade);
  const body = (
    <>
      <span className="trades-cell-pair">
        <b>{trade.pair}</b>
        {strategy ? <small>{strategy}</small> : null}
      </span>
      <span><SideBadge direction={trade.direction} /></span>
      <span className="metric-number">{fmtPrice(trade.entry, trade.pair)}</span>
      <span className="metric-number">{fmtPrice(live.current, trade.pair)}</span>
      <span className="metric-number is-negative">{fmtPrice(trade.stop, trade.pair)}</span>
      <span className="metric-number is-positive">{fmtPrice(trade.target, trade.pair)}</span>
      <span className="metric-number trades-hide-md">{rrLabel(trade)}</span>
      <span className="metric-number trades-hide-md">{live.lots === null ? "—" : live.lots.toFixed(2)}</span>
      <span className={`metric-number ${rTone}`}>{fmtR(live.openR)}</span>
      <span className={`metric-number ${pnlTone}`}>{fmtMoney(live.money, true) ?? "—"}</span>
      <span className="metric-number trades-muted trades-hide-sm">{durationLabel(trade.openedAt, null)}</span>
    </>
  );
  return href ? (
    <Link href={href} className="trades-row is-open">
      {body}
    </Link>
  ) : (
    <button type="button" className={`trades-row is-open ${selected ? "is-selected" : ""}`} onClick={onSelect}>
      {body}
    </button>
  );
}

function ClosedRow({
  trade,
  selected,
  onSelect,
}: {
  trade: JournalTrade;
  selected: boolean;
  onSelect: () => void;
}) {
  const rTone = trade.resultR === null ? "" : trade.resultR >= 0 ? "is-positive" : "is-negative";
  const pnlTone = trade.paperPl == null ? "" : trade.paperPl >= 0 ? "is-positive" : "is-negative";
  const strategy = strategyLabel(trade) ?? "—";
  const href = chartHrefForTrade(trade);
  const body = (
    <>
      <span className="trades-cell-pair">
        <b>{trade.pair}</b>
      </span>
      <span><SideBadge direction={trade.direction} /></span>
      <span className="trades-muted trades-hide-md">{strategy}</span>
      <span className="metric-number">{fmtPrice(trade.entry, trade.pair)}</span>
      <span className="metric-number">{fmtPrice(trade.exit, trade.pair)}</span>
      <span><ResultBadge trade={trade} /></span>
      <span className={`metric-number ${rTone}`}>{fmtR(trade.resultR)}</span>
      <span className={`metric-number ${pnlTone} trades-hide-sm`}>{fmtMoney(trade.paperPl, true) ?? "—"}</span>
      <span className="metric-number trades-muted trades-hide-md">
        {durationLabel(trade.openedAt, trade.closedAt)}
      </span>
      <span className="metric-number trades-muted trades-hide-sm">{dayAndTime(trade.closedAt)}</span>
    </>
  );
  return href ? (
    <Link href={href} className="trades-row is-closed">
      {body}
    </Link>
  ) : (
    <button type="button" className={`trades-row is-closed ${selected ? "is-selected" : ""}`} onClick={onSelect}>
      {body}
    </button>
  );
}

/* Phone-friendly stacked card (shown below 768px in place of the table). Each
   card is self-contained — it carries every figure the row's columns would, so
   the list reads without a drill-down. Selecting it still drives the detail
   panel for anyone on a wider split. */
function MobileTradeCard({
  trade,
  live,
  selected,
  onSelect,
}: {
  trade: JournalTrade;
  live: ReturnType<typeof liveMetrics> | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const isOpen = trade.status === "open";
  const strategy = strategyLabel(trade);
  const rValue = isOpen ? live?.openR ?? null : trade.resultR;
  const money = isOpen ? live?.money ?? null : trade.paperPl ?? null;
  const rTone = rValue === null ? "" : rValue >= 0 ? "is-positive" : "is-negative";
  const pnlTone = money === null ? "" : money >= 0 ? "is-positive" : "is-negative";
  const accent = isOpen
    ? money != null && money < 0
      ? "is-down"
      : "is-up"
    : `is-${trade.result}`;
  const href = chartHrefForTrade(trade);
  const body = (
    <>
      <div className="trade-card-top">
        <span className="trade-card-pair">{trade.pair}</span>
        <span className={`trade-card-r metric-number ${rTone}`}>{fmtR(rValue)}</span>
      </div>
      <div className="trade-card-sub">
        {isOpen ? (
          <SideBadge direction={trade.direction} />
        ) : (
          <span className="trade-card-meta">
            <span className={`trade-card-side is-${trade.direction}`}>
              {trade.direction === "long" ? "LONG" : "SHORT"}
            </span>
            {` · ${activityLabel(trade)}`}
          </span>
        )}
        {isOpen ? (
          <span className={`trade-card-money metric-number ${pnlTone}`}>
            {fmtMoney(money, true) ?? "—"}
          </span>
        ) : (
          <ResultBadge trade={trade} />
        )}
      </div>

      {isOpen ? (
        <dl className="trade-card-levels">
          <div>
            <dt>Entry</dt>
            <dd>{fmtPrice(trade.entry, trade.pair)}</dd>
          </div>
          <div>
            <dt>Current</dt>
            <dd>{fmtPrice(live?.current ?? null, trade.pair)}</dd>
          </div>
          <div>
            <dt>SL</dt>
            <dd className="is-negative">{fmtPrice(trade.stop, trade.pair)}</dd>
          </div>
          <div>
            <dt>TP</dt>
            <dd className="is-positive">{fmtPrice(trade.target, trade.pair)}</dd>
          </div>
        </dl>
      ) : (
        <p className="trade-card-flow metric-number">
          {fmtPrice(trade.entry, trade.pair)} → {fmtPrice(trade.exit, trade.pair)}
        </p>
      )}

      <div className="trade-card-foot">
        {isOpen ? (
          <>
            <span>{strategy ?? ""}</span>
            <span>{durationLabel(trade.openedAt, null)}</span>
          </>
        ) : (
          <>
            <span>
              {trade.closedAt ? formatShortDay(trade.closedAt) : "—"} ·{" "}
              {durationLabel(trade.openedAt, trade.closedAt)}
            </span>
            <span className={`trade-card-money metric-number ${pnlTone}`}>
              {fmtMoney(money, true) ?? "—"}
            </span>
          </>
        )}
      </div>
    </>
  );

  return href ? (
    <Link
      href={href}
      className={`trade-card ${isOpen ? "is-open" : "is-closed"} ${accent}`}
      aria-label={`Open ${trade.pair} trade on chart`}
    >
      {body}
    </Link>
  ) : (
    <button
      type="button"
      className={`trade-card ${isOpen ? "is-open" : "is-closed"} ${accent} ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}

function TradesSkeleton() {
  return (
    <div className="trades-skeleton" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="trades-skeleton-row" />
      ))}
    </div>
  );
}

function TradesSummarySkeleton() {
  return (
    <div className="trades-summary trades-summary-skeleton" aria-hidden>
      {Array.from({ length: 4 }).map((_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

function TradesToolbarSkeleton() {
  return (
    <div className="trades-toolbar-skeleton" aria-hidden>
      <span className="trades-toolbar-skeleton-tabs" />
      <span className="trades-toolbar-skeleton-search" />
    </div>
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
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
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
    // Kick the first load and the one-time connection probe. Both settle their
    // state inside async callbacks, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll();
    fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { status?: ConnectionStatus } | null) => {
        if (p?.status) setConnection(p.status);
      })
      .catch(() => {});
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshAll(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAll]);
  useForegroundRefresh(refreshAll);

  const openTrades = useMemo(() => summary?.openTrades ?? [], [summary?.openTrades]);
  const closedTrades = useMemo(() => records.filter((t) => t.status === "closed"), [records]);

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
        t.instrument ? fills[t.instrument] : undefined,
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
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((t) => t.pair.toLowerCase().includes(q));
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
      selected.instrument ? fills[selected.instrument] : undefined,
    );
  }, [selected, quotes, fills]);

  const oandaConnected = connection
    ? connection.state === "connected" && connection.source === "oanda"
    : null;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: openCount },
    { id: "closed", label: "Closed", count: closedCount },
    { id: "all", label: "All", count: allCount },
  ];
  const initialTabLoading = loading && summary === null;

  return (
    <div className="trades-view">
      <header className="trades-header">
        <div className="trades-header-title">
          <h1>Trades</h1>
        </div>
        {oandaConnected !== null ? (
          <span className={`trades-connection ${oandaConnected ? "is-connected" : "is-off"}`}>
            <i aria-hidden />
            OANDA {connection?.environment === "live" ? "LIVE" : "PRACTICE"} ·{" "}
            {oandaConnected ? "CONNECTED" : (connection?.label ?? "OFFLINE")}
          </span>
        ) : null}
      </header>

      {initialTabLoading ? <TradesSummarySkeleton /> : tab === "open" ? (
        <OpenSummary count={openCount} pnl={openAgg.pnl} realized={summary?.today?.realizedPL ?? null} />
      ) : (
        <ClosedSummary
          closed={closedCount}
          wins={closedAgg.wins}
          losses={closedAgg.losses}
          winRate={closedAgg.winRate}
        />
      )}

      <div className="trades-body">
        <div className="trades-workspace">
          {initialTabLoading ? <TradesToolbarSkeleton /> : <>
          <div className="trades-toolbar">
            <nav className="trades-tabs" aria-label="Trade state">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tab === t.id ? "is-active" : ""}
                  onClick={() => setTab(t.id)}
                >
                  {t.label} <span className="trades-tab-count">{t.count}</span>
                </button>
              ))}
            </nav>

            <label className="trades-search">
              <Search aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search trades..."
                aria-label="Search trades"
              />
            </label>

            {tab === "closed" ? (
              <nav className="trades-subfilter" aria-label="Result filter">
                {(["all", "wins", "losses"] as ClosedFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={closedFilter === f ? "is-active" : ""}
                    onClick={() => setClosedFilter(f)}
                  >
                    {f === "all" ? "All" : f === "wins" ? "Wins" : "Losses"}
                  </button>
                ))}
              </nav>
            ) : null}

          </div>
          </>}

          {loading ? (
            <TradesSkeleton />
          ) : rows.length ? (
            <>
            <div className={`trades-table ${tab === "closed" ? "is-closed" : "is-open"}`}>
              <div className="trades-head" aria-hidden>
                {tab === "closed" ? (
                  <>
                    <span>Pair</span>
                    <span>Side</span>
                    <span className="trades-hide-md">Strategy</span>
                    <span>Entry</span>
                    <span>Exit</span>
                    <span>Result</span>
                    <span>R</span>
                    <span className="trades-hide-sm">P&amp;L</span>
                    <span className="trades-hide-md">Duration</span>
                    <span className="trades-hide-sm">Closed</span>
                  </>
                ) : (
                  <>
                    <span>Pair</span>
                    <span>Side</span>
                    <span>Entry</span>
                    <span>Current</span>
                    <span>SL</span>
                    <span>TP</span>
                    <span className="trades-hide-md">R:R</span>
                    <span className="trades-hide-md">Size</span>
                    <span>Open R</span>
                    <span>P&amp;L</span>
                    <span className="trades-hide-sm">Age</span>
                  </>
                )}
              </div>

              {rows.map((trade) =>
                tab === "closed" || (tab === "all" && trade.status === "closed") ? (
                  <ClosedRow
                    key={trade.id}
                    trade={trade}
                    selected={trade.id === selectedId}
                    onSelect={() => setSelectedId(trade.id)}
                  />
                ) : (
                  <OpenRow
                    key={trade.id}
                    trade={trade}
                    live={liveMetrics(
                      trade,
                      trade.instrument ? quotes[trade.instrument] : undefined,
                      quotes,
                      trade.instrument ? fills[trade.instrument] : undefined,
                    )}
                    selected={trade.id === selectedId}
                    onSelect={() => setSelectedId(trade.id)}
                  />
                ),
              )}

              {tab !== "open" && hasMore ? (
                <button
                  type="button"
                  className="trades-load-more"
                  onClick={() => void loadPage(false)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </div>

            <div className="trades-cards">
              {rows.map((trade) => (
                <MobileTradeCard
                  key={trade.id}
                  trade={trade}
                  live={
                    trade.status === "open"
                      ? liveMetrics(
                          trade,
                          trade.instrument ? quotes[trade.instrument] : undefined,
                          quotes,
                          trade.instrument ? fills[trade.instrument] : undefined,
                        )
                      : null
                  }
                  selected={trade.id === selectedId}
                  onSelect={() => setSelectedId(trade.id)}
                />
              ))}
              {tab !== "open" && hasMore ? (
                <button
                  type="button"
                  className="trades-load-more"
                  onClick={() => void loadPage(false)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </div>
            </>
          ) : (
            <p className="trades-empty">
              {tab === "open" ? "No open positions right now." : "No trades in this view."}
            </p>
          )}
        </div>

        {selected ? (
          <SelectedTradePanel trade={selected} live={selectedLive} />
        ) : (
          <aside className="trades-panel is-empty" aria-label="Selected trade">
            <p className="trades-empty">Select a trade to see its details.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
