"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AccountOverviewHero } from "@/components/dashboard/account-overview-hero";
import { RecentPredictions } from "@/components/dashboard/recent-predictions";
import { BinaryWatchlistCard } from "@/components/dashboard/binary-watchlist-card";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatDayAndTime } from "@/lib/format/datetime";
import {
  openTradeProgress,
  quoteToUsdRateFromQuotes,
  resolveOpenTradeQuote,
} from "@/lib/open-trade-progress";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills } from "@/lib/market-stream/use-open-positions";
import { getPaperTradingAvailability } from "@/lib/strategy/strategy-engine";
import { openTradeCloseOutlook } from "@/lib/strategy/close-outlook";
import { strategyTypeLabel } from "@/lib/strategy/family-label";
import type { AccountBalanceHistoryPoint, AccountSummary, ConnectionStatus } from "@/types/forex";

export type DashboardWatchRow = {
  instrument: string;
  evaluatedAt: string | null;
  dataStatus: "connected" | "unavailable" | "stale";
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
  conditions?: Array<{ name: string; passed: boolean; required: boolean }>;
  direction: "long" | "short" | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  openTradeId: string | null;
  batchNumber: number | null;
  tradeSequence: string | null;
};

/**
 * One instrument as the multi-strategy + adaptive engine sees it: the market
 * regime, each strategy family's candidate, and the adaptive engine's pick.
 * Mirrors the /api/multistrategy/watchlist row shape (multiStrategyWatchlist).
 */
export type DashboardStrategyRow = {
  instrument: string;
  session: string;
  dataStatus: string;
  regime: string | null;
  trendStrength: number | null;
  volatilityBucket: string | null;
  atrPips: number | null;
  updatedAt: string | null;
  strategies: Array<{
    family: "ema" | "breakout" | "momentum" | "meanrev";
    version: string;
    setupStatus: "valid" | "developing" | "invalid" | "no_setup";
    direction: "long" | "short" | null;
    riskReward: number | null;
    selected: boolean;
    openTradeId: string | null;
  }>;
  adaptive: {
    adaptiveState: string;
    reason: string;
    selected: { family: string; direction: string } | null;
  } | null;
};

const STRATEGY_FAMILY_LABEL: Record<string, string> = {
  ema: "EMA",
  breakout: "Breakout",
  momentum: "Momentum",
  meanrev: "Mean reversion",
};

/** The one line shown under each pair: the adaptive pick, else the regime. */
function strategyRowState(row: DashboardStrategyRow) {
  const pick = row.adaptive?.selected ?? null;
  if (pick) {
    const family = STRATEGY_FAMILY_LABEL[pick.family] ?? pick.family;
    return {
      active: true as const,
      label: `${family} · ${pick.direction.toUpperCase()}`,
      tone:
        pick.direction === "long"
          ? "text-[color:var(--success)]"
          : "text-[color:var(--danger)]",
    };
  }
  if (row.dataStatus !== "connected") {
    return { active: false as const, label: "Waiting for data", tone: "text-[color:var(--muted)]" };
  }
  const regime = row.regime
    ? row.regime.charAt(0).toUpperCase() + row.regime.slice(1)
    : "No signal";
  return { active: false as const, label: regime, tone: "text-[color:var(--muted)]" };
}

type Metrics = {
  assigned: number;
  open: number;
  resolved: number;
  wins: number;
  losses: number;
  /** A fraction, not a percentage: wins / resolved. */
  winRate: number | null;
  averageR: number | null;
  profitFactor: number | null;
  netR: number;
  maxDrawdownR: number;
};

type Batch = {
  id: string;
  batchNumber: number;
  status: "collecting" | "resolving" | "complete";
  assignedCount: number;
  liveSummary?: Metrics;
  remaining?: number;
};

type Trade = {
  id: string;
  tradeSequence: string;
  instrument: string;
  direction: "long" | "short";
  status: string;
  outcome: string;
  resultR: number | null;
  paperPl?: number | null;
  openedAt: string;
  closedAt?: string | null;
  // Already returned by the overview endpoint; declared here so an open trade
  // can be marked to the live quote instead of just reading "Open".
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  nominalRiskAmount?: number | null;
  strategyFamily?: string | null;
  batchNumber?: number | null;
};

export type DashboardOverview = {
  strategyVersion: string;
  batchSize: number;
  lifetimeSummary: Metrics;
  current: Batch | null;
  batches: Batch[];
  /** Current collecting/resolving batch trades (research forward view). */
  trades: Trade[];
  /** Still-open positions across batches (dashboard Open trades list). */
  openTrades?: Trade[];
  /** Closed trades across every batch, for the account chart. */
  accountTrades?: Array<{ tradeSequence?: number; paperPl: number | null; closedAt: string | null; openedAt: string; status: string }>;
};

export type DashboardExposure = {
  openTrades: number;
  totalNominalRiskPercent: number;
  totalNominalRiskAmount: number;
  currencyExposure: Array<{ code: string; nominalRiskPercent: number }>;
};

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function time(value: string | null) {
  if (!value) return "Waiting";
  return formatDayAndTime(value);
}

function DashboardStat({
  label,
  value,
  detail,
  tone = "",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="dashboard-stat min-w-0 px-3 first:pl-0 last:pr-0">
      <div className="dashboard-stat-label">{label}</div>
      <div
        className={`metric-number text-lg font-semibold tracking-[-0.04em] sm:text-xl ${tone}`}
      >
        {value}
      </div>
      <div className="truncate text-[0.6875rem] text-[color:var(--muted)] sm:text-xs">
        {detail}
      </div>
    </div>
  );
}

export function DashboardView({
  initialAccount,
  initialAccountHistory,
  initialWatchlist,
  initialStrategyWatchlist,
  initialOverview,
  userLabel,
  todayKey,
}: {
  initialAccount: AccountSummary;
  initialAccountHistory: AccountBalanceHistoryPoint[];
  initialStatus: ConnectionStatus;
  initialWatchlist: DashboardWatchRow[];
  initialStrategyWatchlist: DashboardStrategyRow[];
  initialOverview: DashboardOverview;
  initialExposure: DashboardExposure;
  userLabel: string;
  todayKey: string;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [accountHistory, setAccountHistory] = useState(initialAccountHistory);
  // Kept for the Open-trades quote fallback below; the Watchlist section now
  // renders from the multi-strategy engine instead.
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [strategyRows, setStrategyRows] = useState(initialStrategyWatchlist);
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState<Date | null>(null);
  // Ticks rather than the 60s refresh below, so an open trade's value moves
  // with the market instead of jumping once a minute.
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
  const availability = getPaperTradingAvailability();
  const openTrades = overview.openTrades ?? overview.trades.filter((trade) => trade.status === "open");

  const refresh = useCallback(async () => {
    try {
      const [accountResponse, historyResponse, watchlistResponse, strategyResponse, cycleResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/oanda/account-history"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/multistrategy/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" }),
      ]);
      if (![accountResponse, historyResponse, watchlistResponse, cycleResponse].every((response) => response.ok)) {
        throw new Error("Dashboard data is temporarily unavailable.");
      }
      const [accountPayload, historyPayload, watchlistPayload, cyclePayload] = await Promise.all([
        accountResponse.json() as Promise<{ data: AccountSummary; status: ConnectionStatus }>,
        historyResponse.json() as Promise<{ data: AccountBalanceHistoryPoint[] }>,
        watchlistResponse.json() as Promise<{ watchlist: DashboardWatchRow[] }>,
        cycleResponse.json() as Promise<DashboardOverview>,
      ]);
      setAccount(accountPayload.data);
      setAccountHistory(historyPayload.data);
      setWatchlist(watchlistPayload.watchlist);
      setOverview(cyclePayload);
      // The strategy watchlist is non-blocking: a hiccup there leaves the last
      // rows in place rather than tearing down the whole dashboard.
      if (strategyResponse.ok) {
        const strategyPayload = (await strategyResponse.json()) as { instruments?: DashboardStrategyRow[] };
        if (strategyPayload.instruments) setStrategyRows(strategyPayload.instruments);
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard data is temporarily unavailable.");
    }
  }, []);

  /**
   * The account moves with every tick on an open position, so it is polled on
   * its own short cycle. The watchlist and cycle payloads are heavier and only
   * change when a candle closes, so they keep the slow one.
   *
   * Both run once immediately: the effect previously installed the interval and
   * nothing else, which left the page showing its server-rendered snapshot —
   * including a day figure of +$0.00 — for a full minute after load.
   */
  const refreshAccount = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data: AccountSummary };
      setAccount(payload.data);
    } catch {
      // The slow refresh below reports the outage.
    }
  }, []);

  useEffect(() => {
    // Both fetches resolve before they set state, so the update lands in a
    // promise continuation rather than synchronously during the effect. The
    // rule cannot see through the async call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAccount();
    const timer = window.setInterval(() => void refreshAccount(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshAccount]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Clock for the "when does this close" labels. Client-only and deliberately
  // null on the first render, so the server-rendered markup and the first
  // client render match; a time-dependent label produced during SSR would
  // hydrate against a different minute. Ticks once a minute, which is the
  // resolution the labels are written at.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClockNow(new Date());
    const timer = window.setInterval(() => setClockNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Reopening the app after it was backgrounded lands on the last snapshot until
  // the next interval tick — up to a minute away. Pull everything fresh the
  // moment it returns to the foreground so it never opens on stale numbers.
  useForegroundRefresh(useCallback(() => {
    void refreshAccount();
    void refresh();
  }, [refreshAccount, refresh]));

  const assigned = overview.current?.assignedCount ?? 0;
  const lifetime = overview.lifetimeSummary;
  // Account history spans batches; the recent-trades list below stays scoped to
  // the batch that is collecting.
  return (
    <div className="dashboard-view dashboard-minimal space-y-8 lg:space-y-10">
      <AccountOverviewHero
        account={account}
        userLabel={userLabel}
        history={accountHistory}
        todayKey={todayKey}
      />

      {error ? <p className="research-error">{error}</p> : null}

      <section className="dashboard-minimal-section" aria-label="Strategy performance">
        <div className="grid grid-cols-3 divide-x divide-[color:var(--border)]">
          {/* The strategy's edge in R (sum of per-trade risk-multiples), not a
              money figure — the real-money truth lives in the account hero's
              all-time pill. Kept position-size-agnostic on purpose. */}
          <DashboardStat
            label="Net"
            value={`${lifetime.netR >= 0 ? "+" : ""}${lifetime.netR.toFixed(2)}R`}
            detail={`${lifetime.resolved} closed`}
            tone={
              lifetime.resolved === 0
                ? ""
                : lifetime.netR >= 0
                  ? "text-[color:var(--success)]"
                  : "text-[color:var(--danger)]"
            }
          />
          {/* winRate arrives as a fraction (wins / resolved), like every other
              rate from /api/paper-cycle — the research views scale it the same
              way. Formatting it directly rendered 0.5 as "1%". */}
          <DashboardStat
            label="Win rate"
            value={lifetime.winRate === null ? "—" : `${(lifetime.winRate * 100).toFixed(0)}%`}
            detail={
              lifetime.resolved === 0
                ? "No closed trades"
                : `${lifetime.wins}W · ${lifetime.resolved - lifetime.wins}L`
            }
          />
          <DashboardStat
            label="Batch"
            value={`${assigned}/${overview.batchSize}`}
            detail={
              overview.current
                ? `Batch ${overview.current.batchNumber} · ${lifetime.open} open`
                : `${lifetime.open} open`
            }
          />
        </div>
      </section>

      <section className="dashboard-minimal-section" aria-label="Watchlist">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Watchlist</h2>
            {/* Said once here rather than under every pair. */}
            {availability.state !== "entry_window_open" ? (
              <span className="truncate text-xs text-[color:var(--muted)]">
                {availability.label}
              </span>
            ) : null}
          </div>
          <Link href="/watchlist?tab=strategies" className="link-quiet pressable text-xs">
            View all
          </Link>
        </div>
        <div className="dashboard-watchlist-grid mt-3">
          {strategyRows.map((row) => {
            const state = strategyRowState(row);
            const validCount = row.strategies.filter((strategy) => strategy.setupStatus === "valid").length;
            const shownBid = quotes[row.instrument]?.bid ?? null;
            return (
              <Link
                key={row.instrument}
                href={`/watchlist?tab=strategies&instrument=${row.instrument}`}
                data-state={state.active ? "open" : undefined}
                className="dashboard-minimal-row pressable block py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{displayNameFor(row.instrument)}</p>
                    <p className={`watchlist-status-label mt-0.5 text-xs ${state.tone}`}>
                      {state.label}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="dashboard-watchlist-price metric-number text-sm">
                      {shownBid === null ? "—" : formatChartPrice(shownBid, row.instrument)}
                    </p>
                    {/* Not the adaptive pick, but a hint of activity: how many of
                        the four families currently see a valid setup. */}
                    {!state.active && validCount > 0 ? (
                      <p className="mt-0.5 text-xs font-medium text-[color:var(--muted-strong)]">
                        {validCount}/4 valid
                      </p>
                    ) : null}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <BinaryWatchlistCard />

      <div className="dashboard-minimal-grid dashboard-trades-grid">
        <section className="dashboard-minimal-section" aria-label="Open forex trades">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Open forex trades</h2>
            <Link href="/journal" className="link-quiet pressable text-xs">
              View all
            </Link>
          </div>
          {openTrades.length ? (
            <div className="dash-trade-list mt-3">
              <div className="dash-trade-table-head" aria-hidden="true">
                <span>Trade</span>
                <span>Opened</span>
                <span>Result</span>
              </div>
              {openTrades.slice(0, 6).map((trade) => {
                const settled = trade.paperPl !== null && trade.paperPl !== undefined;
                // An open trade is marked against the live quote for its pair,
                // so the row reports what it is worth now rather than "Open".
                const streamed = quotes[trade.instrument];
                const fill = fills[trade.instrument];
                const quote =
                  resolveOpenTradeQuote(
                    streamed ??
                      watchlist.find((row) => row.instrument === trade.instrument),
                    fill?.currentPrice,
                  );
                const live =
                  settled ||
                  trade.entry == null ||
                  trade.stop == null ||
                  trade.target == null
                    ? null
                    : openTradeProgress({
                        direction: trade.direction,
                        instrument: trade.instrument,
                        entry: trade.entry,
                        stop: trade.stop,
                        target: trade.target,
                        bid: quote?.bid,
                        ask: quote?.ask,
                        riskAmount: trade.nominalRiskAmount,
                        fill: fill
                          ? { price: fill.price, units: fill.units }
                          : null,
                        quoteToUsdRate: quoteToUsdRateFromQuotes(
                          trade.instrument,
                          quotes,
                        ),
                      });
                const shown = settled
                  ? trade.paperPl!
                  : (fill?.unrealizedPL ?? live?.money ?? null);
                const plTone =
                  shown === null ? "is-open" : shown >= 0 ? "is-win" : "is-loss";
                const typeLabel = strategyTypeLabel(trade);
                // Null until the client clock starts, so the server and the
                // first client render agree. A time-dependent label rendered
                // during SSR would hydrate against a different minute.
                const outlook = clockNow ? openTradeCloseOutlook(trade, clockNow) : null;
                return (
                  <Link
                    key={trade.id}
                    href={`/signals?instrument=${trade.instrument}&trade=${trade.id}`}
                    className="dash-trade-card pressable"
                  >
                    <div className="dash-trade-main min-w-0">
                      {/* Direction stays neutral: in this row green and red mean
                          profit and loss, and a green "long" beside a red result
                          made one colour say two things. */}
                      <p className="dash-trade-title">
                        <span className="dash-trade-pair">
                          {displayNameFor(trade.instrument)}
                        </span>
                        <span className="dash-trade-dir">{trade.direction}</span>
                        <span className="dash-trade-type">{typeLabel}</span>
                      </p>
                    </div>
                    <p className="dash-trade-time">
                      {time(trade.openedAt)}
                      {outlook ? (
                        <span className={`dash-trade-close is-${outlook.tone}`} title={outlook.detail}>
                          {outlook.label}
                        </span>
                      ) : null}
                    </p>
                    <div className="dash-trade-aside">
                      <p className={`dash-trade-pl metric-number ${plTone}`}>
                        {shown === null ? "Open" : money(shown, account.currency)}
                      </p>
                      {trade.resultR !== null ? (
                        <p className="dash-trade-r metric-number">
                          {trade.resultR >= 0 ? "+" : ""}
                          {trade.resultR.toFixed(2)}R
                        </p>
                      ) : live ? (
                        <p className="dash-trade-r metric-number">
                          {Math.round(live.percent)}%{" "}
                          {live.towards === "stop" ? "to SL" : "to TP"}
                        </p>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[color:var(--muted)]">No open forex trades.</p>
          )}
        </section>
      </div>

      <RecentPredictions />
    </div>
  );
}
