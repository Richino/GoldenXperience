"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AccountOverviewHero } from "@/components/dashboard/account-overview-hero";
import { GxStatus, buildGxStatus } from "@/components/dashboard/gx-status";
import { HomeRail, type HomeAvailableSignal, type HomeCurrentPosition } from "@/components/dashboard/home-rail";
import { HomeRecentActivity } from "@/components/dashboard/home-recent-activity";
import { HomeUpcoming } from "@/components/dashboard/home-upcoming";
import { RecentPredictions } from "@/components/dashboard/recent-predictions";
import { RelativeTime } from "@/components/dashboard/relative-time";
import {
  recentActivityFromTrades,
  todayClosedStats,
  upcomingFromStrategies,
} from "@/lib/home/idle";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import {
  openTradeProgress,
  quoteToUsdRateFromQuotes,
  resolveOpenTradeQuote,
} from "@/lib/open-trade-progress";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills, type OpenPositionFill } from "@/lib/market-stream/use-open-positions";
import type { AccountBalanceHistoryPoint, AccountSummary, ConnectionStatus, JournalTrade, MajorInstrument } from "@/types/forex";

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

export type DashboardJournal = {
  trades: JournalTrade[];
  summary?: {
    total: number;
    winRate: number | null;
    avgR: number;
    today?: { wins: number; losses: number; realizedPL: number | null };
  };
};

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function markedOpenMoney(
  trade: Trade,
  quotes: Record<string, { bid: number; ask: number }>,
  fills: Record<string, OpenPositionFill>,
  watchlist: DashboardWatchRow[],
) {
  if (trade.paperPl !== null && trade.paperPl !== undefined) return trade.paperPl;
  if (trade.entry == null || trade.stop == null || trade.target == null) {
    return fills[trade.instrument]?.unrealizedPL ?? null;
  }
  const streamed = quotes[trade.instrument];
  const fill = fills[trade.instrument];
  const quote = resolveOpenTradeQuote(
    streamed ?? watchlist.find((row) => row.instrument === trade.instrument),
    fill?.currentPrice,
  );
  const live = openTradeProgress({
    direction: trade.direction,
    instrument: trade.instrument,
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    bid: quote?.bid,
    ask: quote?.ask,
    riskAmount: trade.nominalRiskAmount,
    fill: fill ? { price: fill.price, units: fill.units } : null,
    quoteToUsdRate: quoteToUsdRateFromQuotes(trade.instrument, quotes),
  });
  return fill?.unrealizedPL ?? live?.money ?? null;
}

export function DashboardView({
  initialAccount,
  initialAccountHistory,
  initialStatus,
  initialWatchlist,
  initialStrategyWatchlist,
  initialOverview,
  initialJournal,
  userLabel,
  todayKey,
}: {
  initialAccount: AccountSummary;
  initialAccountHistory: AccountBalanceHistoryPoint[];
  initialStatus: ConnectionStatus;
  initialWatchlist: DashboardWatchRow[];
  initialStrategyWatchlist: DashboardStrategyRow[];
  initialOverview: DashboardOverview;
  initialJournal: DashboardJournal;
  userLabel: string;
  todayKey: string;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [accountHistory, setAccountHistory] = useState(initialAccountHistory);
  const [connection, setConnection] = useState(initialStatus);
  const [journalTrades, setJournalTrades] = useState(initialJournal.trades);
  const [journalSummary, setJournalSummary] = useState(initialJournal.summary ?? null);
  // Kept for the Open-trades quote fallback below; the Watchlist section now
  // renders from the multi-strategy engine instead.
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [strategyRows, setStrategyRows] = useState(initialStrategyWatchlist);
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  // Ticks rather than the 60s refresh below, so an open trade's value moves
  // with the market instead of jumping once a minute.
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
  const openTrades = overview.openTrades ?? overview.trades.filter((trade) => trade.status === "open");

  const refresh = useCallback(async () => {
    try {
      const [accountResponse, historyResponse, watchlistResponse, strategyResponse, cycleResponse, journalResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/oanda/account-history"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/multistrategy/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/journal/trades?limit=50&filter=all"), { credentials: "include", cache: "no-store" }),
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
      setConnection(accountPayload.status);
      setAccountHistory(historyPayload.data);
      setWatchlist(watchlistPayload.watchlist);
      setOverview(cyclePayload);
      if (journalResponse.ok) {
        const journalPayload = (await journalResponse.json()) as DashboardJournal;
        setJournalTrades(journalPayload.trades);
        if (journalPayload.summary) setJournalSummary(journalPayload.summary);
      }
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

  // Reopening the app after it was backgrounded lands on the last snapshot until
  // the next interval tick — up to a minute away. Pull everything fresh the
  // moment it returns to the foreground so it never opens on stale numbers.
  useForegroundRefresh(useCallback(async () => {
    await Promise.all([refreshAccount(), refresh()]);
  }, [refreshAccount, refresh]));

  const signalRows = watchlist
    .filter((row) => row.entry !== null && row.stop !== null && row.target !== null && row.direction)
    .slice(0, 2);
  const availableSignals: HomeAvailableSignal[] = signalRows.map((row) => ({
    instrument: row.instrument as MajorInstrument,
    direction: row.direction as "long" | "short",
    entry: row.entry as number,
    stop: row.stop as number,
    target: row.target as number,
    evaluatedAt: row.evaluatedAt,
  }));
  const currentPositions: HomeCurrentPosition[] = openTrades
    .filter((trade) => trade.entry !== null && trade.entry !== undefined && trade.stop !== null && trade.stop !== undefined && trade.target !== null && trade.target !== undefined)
    .map((trade) => ({
      id: trade.id,
      instrument: trade.instrument as MajorInstrument,
      direction: trade.direction,
      entry: trade.entry as number,
      stop: trade.stop as number,
      target: trade.target as number,
      openedAt: trade.openedAt,
    }));
  const hasOpenPositions = openTrades.length > 0;
  const hasActiveSignals = signalRows.length > 0;
  const showIdleContext = !hasOpenPositions || !hasActiveSignals;
  const gxStatus = buildGxStatus(connection);
  const upcoming = upcomingFromStrategies(
    strategyRows,
    signalRows.map((row) => row.instrument),
  );
  const recentActivity = recentActivityFromTrades(journalTrades, 10);
  const todayFromList = todayClosedStats(journalTrades, todayKey);
  // The API summary is authoritative when present; the list-derived figures are
  // the fallback so the rail still reports a day with no summary payload.
  const todayTrades = journalSummary?.today
    ? journalSummary.today.wins + journalSummary.today.losses
    : todayFromList.trades;
  const todayWins = journalSummary?.today?.wins ?? todayFromList.wins;
  const todayLosses = journalSummary?.today?.losses ?? todayFromList.losses;
  const todayNet = journalSummary?.today?.realizedPL ?? todayFromList.netMoney;
  const openPL = openTrades.reduce((sum, trade) => {
    const marked = markedOpenMoney(trade, quotes, fills, watchlist);
    return marked === null ? sum : sum + marked;
  }, 0);

  return (
    <div className="dashboard-view dashboard-minimal home-shell">
      <div className="home-main">
      <AccountOverviewHero
        account={account}
        userLabel={userLabel}
        history={accountHistory}
        todayKey={todayKey}
        openPL={openPL}
      />

      {error ? <p className="research-error">{error}</p> : null}

      {Math.abs(account.balance - account.nav) >= 0.01 ? (
        <p className="home-balance-note">
          Balance {money(account.balance, account.currency)}
        </p>
      ) : null}

      {hasOpenPositions ? (
      <div className="dashboard-minimal-grid dashboard-trades-grid">
        <section className="home-section" aria-label="Open positions">
          <div className="home-section-head">
            <h2>Open positions</h2>
            <Link href="/journal" className="home-section-link">
              View all
            </Link>
          </div>
            <div className="home-position-list">
              <div className="home-position-head" aria-hidden="true">
                <span>Symbol</span>
                <span>Entry</span>
                <span>Price</span>
                <span className="home-position-size">Size</span>
                <span className="home-position-r">R</span>
                <span className="home-position-pl">P/L</span>
              </div>
              {openTrades.slice(0, 6).map((trade) => {
                const shown = markedOpenMoney(trade, quotes, fills, watchlist);
                const streamed = quotes[trade.instrument];
                const fill = fills[trade.instrument];
                const quote =
                  resolveOpenTradeQuote(
                    streamed ??
                      watchlist.find((row) => row.instrument === trade.instrument),
                    fill?.currentPrice,
                  );
                const mark = quote?.bid && quote?.ask
                  ? (quote.bid + quote.ask) / 2
                  : null;
                const plTone =
                  shown === null ? "is-open" : shown >= 0 ? "is-win" : "is-loss";
                // Standard lots from the broker fill; R multiple is the live
                // money over the cash that was risked between entry and stop.
                const lots =
                  fill && fill.units ? Math.abs(fill.units) / 100_000 : null;
                const rMultiple =
                  shown !== null && trade.nominalRiskAmount
                    ? shown / trade.nominalRiskAmount
                    : null;
                const rTone =
                  rMultiple === null ? "" : rMultiple >= 0 ? "is-win" : "is-loss";
                return (
                  <Link
                    key={trade.id}
                    href={`/chart?instrument=${trade.instrument}&trade=${trade.id}`}
                    className="home-position-row"
                  >
                    <span className="home-position-symbol">
                      <span>{displayNameFor(trade.instrument)}</span>
                      <span className={`home-side is-${trade.direction}`}>
                        {trade.direction === "long" ? "LONG" : "SHORT"}
                      </span>
                    </span>
                    <span className="home-position-entry metric-number">
                      {trade.entry == null ? "—" : formatChartPrice(trade.entry, trade.instrument)}
                    </span>
                    <span className="home-position-price metric-number">
                      {mark === null ? "—" : formatChartPrice(mark, trade.instrument)}
                      {lots !== null ? (
                        <span className="home-position-lot"> · {lots.toFixed(2)} lot</span>
                      ) : null}
                    </span>
                    <span className="home-position-size metric-number">
                      {lots === null ? "—" : lots.toFixed(2)}
                    </span>
                    <span className={`home-position-r metric-number ${rTone}`}>
                      {rMultiple === null
                        ? "—"
                        : `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R`}
                    </span>
                    <span className={`home-position-pl metric-number ${plTone}`}>
                      {shown === null ? "Open" : money(shown, account.currency)}
                    </span>
                  </Link>
                );
              })}
            </div>
        </section>
      </div>
      ) : null}

      {hasActiveSignals ? (
      <section className="home-section" aria-label="Active signals">
        <div className="home-section-head">
          <h2>Active signals</h2>
          <Link href="/watchlist?tab=strategies" className="home-section-link">
            See all
          </Link>
        </div>
          <div className="home-signal-grid">
            {signalRows.map((row) => {
              const risk = Math.abs(row.entry! - row.stop!);
              const reward = Math.abs(row.target! - row.entry!);
              const ratio = risk > 0 ? Math.round((reward / risk) * 10) / 10 : null;
              const rrLabel =
                ratio === null
                  ? null
                  : `1:${Number.isInteger(ratio) ? ratio.toFixed(0) : ratio.toFixed(1)}`;
              return (
              <Link
                key={row.instrument}
                href={`/chart?instrument=${row.instrument}`}
                className="home-signal-card"
              >
                <div className="home-signal-top">
                  <span className="home-signal-ident">
                    <span>{displayNameFor(row.instrument)}</span>
                    <span className={`home-side is-${row.direction}`}>
                      {row.direction === "long" ? "LONG" : "SHORT"}
                    </span>
                  </span>
                  <span className="home-signal-time">
                    <RelativeTime at={row.evaluatedAt} />
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Entry</dt>
                    <dd className="metric-number">{formatChartPrice(row.entry!, row.instrument)}</dd>
                  </div>
                  <div>
                    <dt>SL</dt>
                    <dd className="metric-number">{formatChartPrice(row.stop!, row.instrument)}</dd>
                  </div>
                  <div>
                    <dt>TP</dt>
                    <dd className="metric-number">{formatChartPrice(row.target!, row.instrument)}</dd>
                  </div>
                </dl>
                {rrLabel ? (
                  <div className="home-signal-foot">
                    <span>R:R</span>
                    <span className="metric-number">{rrLabel}</span>
                  </div>
                ) : null}
              </Link>
              );
            })}
          </div>
      </section>
      ) : null}

      {showIdleContext ? <GxStatus status={gxStatus} hasActiveSetups={hasActiveSignals} /> : null}
      {upcoming.length ? <HomeUpcoming items={upcoming} /> : null}

      <HomeRecentActivity items={recentActivity} currency={account.currency} />

      <div className="home-extra lg:hidden">
        <RecentPredictions />
      </div>
      </div>

      <HomeRail
        quotes={quotes}
        availableSignals={availableSignals}
        currentPositions={currentPositions}
        currency={account.currency}
        todayNet={todayNet}
        todayR={todayFromList.netR}
        todayTrades={todayTrades}
        todayWins={todayWins}
        todayLosses={todayLosses}
      />
    </div>
  );
}
