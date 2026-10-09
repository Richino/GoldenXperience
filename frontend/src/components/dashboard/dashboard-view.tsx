"use client";

import { useCallback, useEffect, useState } from "react";
import type { HomeCurrentPosition } from "@/components/dashboard/home-rail";
import {
  LedgerHome,
  type LedgerPosition,
  type LedgerSetup,
  type LedgerToday,
} from "@/components/dashboard/ledger-home";
import { PendingCancelConfirmation } from "@/components/dashboard/pending-cancel-confirmation";
import {
  recentActivityFromTrades,
  todayClosedStats,
} from "@/lib/home/idle";
import { apiUrl } from "@/lib/api/url";
import { verifiedAccountSummary, ACCOUNT_UNAVAILABLE_MESSAGE } from "@/lib/account-summary";
import { tradingDayKey } from "@/lib/format/datetime";
import { pipSizeFor } from "@/lib/instruments/catalog";
import {
  currentTradeLevels,
  openRFromLevels,
  openTradeProgress,
  quoteToUsdRateFromQuotes,
  resolveOpenTradeQuote,
} from "@/lib/open-trade-progress";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills, type OpenPositionFill } from "@/lib/market-stream/use-open-positions";
import type { AccountBalanceHistoryPoint, AccountSummary, ConnectionStatus, JournalTrade, MajorInstrument } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

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

export type DashboardSavedSetup = {
  id: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  expiresAt: string;
  state: "setup";
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
  /** The stop / target the trade holds now (null = none); `stop` stays the 1R reference. */
  slPrice?: number | null;
  tpPrice?: number | null;
  nominalRiskAmount?: number | null;
  brokerTradeId?: string | null;
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

/**
 * Price an open row is marked against: the streamed bid/ask first, then the
 * broker's polled price, and only then the watchlist row. The watchlist is a
 * page-load snapshot, so preferring it over the broker left pairs the stream
 * does not tick (e.g. USD/CAD) showing an Open R minutes out of date.
 */
function openTradeQuote(
  trade: Trade,
  quotes: Record<string, { bid: number; ask: number }>,
  fill: OpenPositionFill | undefined,
  watchlist: DashboardWatchRow[],
) {
  return (
    resolveOpenTradeQuote(quotes[trade.instrument], fill) ??
    resolveOpenTradeQuote(watchlist.find((row) => row.instrument === trade.instrument))
  );
}

function liveOpenProgress(
  trade: Trade,
  quotes: Record<string, { bid: number; ask: number }>,
  fills: Record<string, OpenPositionFill>,
  watchlist: DashboardWatchRow[],
) {
  if (trade.entry == null || trade.stop == null || trade.target == null) {
    return null;
  }
  const fill = trade.brokerTradeId
    ? fills[`broker:${trade.brokerTradeId}`]
    : undefined;
  const quote = openTradeQuote(trade, quotes, fill, watchlist);
  return openTradeProgress({
    direction: trade.direction,
    instrument: trade.instrument,
    entry: trade.entry,
    stop: fill?.stopPrice ?? trade.stop,
    target: trade.target,
    bid: quote?.bid,
    ask: quote?.ask,
    riskAmount: trade.nominalRiskAmount,
    fill: fill ? { price: fill.price, units: fill.units } : null,
    quoteToUsdRate: quoteToUsdRateFromQuotes(trade.instrument, quotes),
  });
}

function markedOpenMoney(
  trade: Trade,
  quotes: Record<string, { bid: number; ask: number }>,
  fills: Record<string, OpenPositionFill>,
  watchlist: DashboardWatchRow[],
) {
  const fill = trade.brokerTradeId
    ? fills[`broker:${trade.brokerTradeId}`]
    : undefined;
  const live = liveOpenProgress(trade, quotes, fills, watchlist);
  // OANDA already reports this account-currency amount. A stored paper result
  // is only a fallback for a non-broker practice row, never the live value.
  return fill?.unrealizedPL ?? trade.paperPl ?? live?.money ?? null;
}

export function DashboardView({
  initialMorningPicks,
  initialAccount,
  initialAccountHistory,
  initialWatchlist,
  initialSavedSetups,
  initialOverview,
  initialJournal,
  initialPendingEntries,
  greeting,
  todayKey,
}: {
  initialMorningPicks: import("@/lib/strategy/morning-scan").MorningPicksSnapshot | null;
  initialAccount: AccountSummary | null;
  initialAccountHistory: AccountBalanceHistoryPoint[];
  initialWatchlist: DashboardWatchRow[];
  initialSavedSetups: DashboardSavedSetup[];
  initialOverview: DashboardOverview;
  initialJournal: DashboardJournal;
  initialPendingEntries: PendingManualEntry[];
  /** "Morning, Richie": worked out on the server from the ET hour. */
  greeting: string;
  todayKey: string;
}) {
  const [account, setAccount] = useState(() => verifiedAccountSummary({ data: initialAccount }));
  const [accountError, setAccountError] = useState<string | null>(() => verifiedAccountSummary({ data: initialAccount }) ? null : ACCOUNT_UNAVAILABLE_MESSAGE);
  const [accountHistory, setAccountHistory] = useState(initialAccountHistory);
  const [journalTrades, setJournalTrades] = useState(initialJournal.trades);
  const [journalSummary, setJournalSummary] = useState(initialJournal.summary ?? null);
  // Kept for the Open-trades quote fallback below; the Watchlist section now
  // renders from the multi-strategy engine instead.
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [savedSetups, setSavedSetups] = useState(initialSavedSetups ?? []);
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<PendingManualEntry[]>(() =>
    initialPendingEntries.filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING"),
  );
  const [pendingEntryError, setPendingEntryError] = useState<string | null>(null);
  const [cancellingPendingId, setCancellingPendingId] = useState<string | null>(null);
  const [pendingCancellation, setPendingCancellation] = useState<PendingManualEntry | null>(null);
  // Ticks rather than the 60s refresh below, so an open trade's value moves
  // with the market instead of jumping once a minute.
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
  const overviewOpen = overview.openTrades ?? overview.trades.filter((trade) => trade.status === "open");
  const overviewOpenIds = new Set(overviewOpen.map((trade) => trade.id));
  // Manual trades live in the journal, not the strategy overview, so their open
  // ones must be pulled in here too — otherwise a filled manual entry shows in
  // the journal but never in the home Open Positions section.
  const manualOpen: Trade[] = journalTrades
    .filter((trade) => trade.status === "open" && trade.origin === "manual" && !overviewOpenIds.has(trade.id))
    .map((trade) => ({
      id: trade.id,
      tradeSequence: trade.sequence ?? "",
      // `pair` is a display name ("EUR/USD"); the OANDA code ("EUR_USD") is what
      // joins to live quotes, so recover it when the row carries no instrument.
      instrument: trade.instrument ?? trade.pair.replace("/", "_"),
      direction: trade.direction,
      status: trade.status,
      outcome: trade.outcome ?? "",
      resultR: trade.resultR ?? null,
      paperPl: trade.paperPl ?? null,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      entry: trade.entry,
      stop: trade.stop,
      target: trade.target,
      slPrice: trade.slPrice,
      tpPrice: trade.tpPrice,
      // Paper manual trades carry no position size, so value them against a
      // nominal 1% risk to show a simulated live P&L that moves with price.
      // Real OANDA-backed trades ignore this — markedOpenMoney prefers the
      // broker position's actual unrealized P&L when a fill exists.
      nominalRiskAmount:
        trade.nominalRiskAmount ??
        (account && account.balance > 0 ? Number((account.balance * 0.01).toFixed(2)) : null),
      brokerTradeId: trade.brokerTradeId ?? null,
    }));
  const openTrades = [...overviewOpen, ...manualOpen];

  // Every broker position (tracked or not), plus paper-only open rows.
  let heroOpenPL: number = account?.unrealizedPL ?? 0;
  {
    let total = 0;
    let seen = false;
    for (const [key, fill] of Object.entries(fills)) {
      if (!key.startsWith("broker:")) continue;
      total += fill.unrealizedPL;
      seen = true;
    }
    for (const trade of openTrades) {
      if (trade.brokerTradeId && fills[`broker:${trade.brokerTradeId}`]) continue;
      if (trade.brokerTradeId) continue; // broker-backed but fill not loaded yet
      const money = markedOpenMoney(trade, quotes, fills, watchlist);
      if (money !== null) {
        total += money;
        seen = true;
      }
    }
    if (seen) heroOpenPL = total;
  }

  const refresh = useCallback(async () => {
    try {
      const [historyResponse, watchlistResponse, savedSetupsResponse, cycleResponse, journalResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-history"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/saved-setups"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/journal/trades?limit=50&filter=all"), { credentials: "include", cache: "no-store" }),
      ]);
      if (![historyResponse, watchlistResponse, savedSetupsResponse, cycleResponse].every((response) => response.ok)) {
        throw new Error("Dashboard data is temporarily unavailable.");
      }
      const [historyPayload, watchlistPayload, savedSetupsPayload, cyclePayload] = await Promise.all([
        historyResponse.json() as Promise<{ data: AccountBalanceHistoryPoint[] }>,
        watchlistResponse.json() as Promise<{ watchlist: DashboardWatchRow[] }>,
        savedSetupsResponse.json() as Promise<{ setups: DashboardSavedSetup[] }>,
        cycleResponse.json() as Promise<DashboardOverview>,
      ]);
      setAccountHistory(historyPayload.data);
      setWatchlist(watchlistPayload.watchlist);
      setSavedSetups(Array.isArray(savedSetupsPayload.setups) ? savedSetupsPayload.setups : []);
      setOverview(cyclePayload);
      if (journalResponse.ok) {
        const journalPayload = (await journalResponse.json()) as DashboardJournal;
        setJournalTrades(journalPayload.trades);
        if (journalPayload.summary) setJournalSummary(journalPayload.summary);
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
      if (!response.ok) throw new Error(ACCOUNT_UNAVAILABLE_MESSAGE);
      const payload = await response.json() as { data: AccountSummary; status?: ConnectionStatus };
      const verified = verifiedAccountSummary(payload);
      if (!verified) throw new Error(ACCOUNT_UNAVAILABLE_MESSAGE);
      setAccount(verified);
      setAccountError(null);
    } catch {
      // Preserve the verified snapshot; an outage must never replace it with demo money.
      setAccountError(ACCOUNT_UNAVAILABLE_MESSAGE);
    }
  }, []);

  const refreshPendingEntries = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/pending-entries"), { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { entries?: PendingManualEntry[] };
      setPendingEntries((payload.entries ?? []).filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING"));
      setPendingEntryError(null);
    } catch {
      // The rest of Home should remain available during a temporary API outage.
    }
  }, []);

  const cancelPendingEntry = useCallback(async (entry: PendingManualEntry): Promise<boolean> => {
    if (entry.status !== "PENDING") return false;
    setCancellingPendingId(entry.id);
    setPendingEntryError(null);
    try {
      const response = await fetch(apiUrl(`/api/pending-entries/${entry.id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not cancel the pending trade.");
      setPendingEntries((current) => current.filter((item) => item.id !== entry.id));
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not cancel the pending trade.";
      await refreshPendingEntries();
      setPendingEntryError(message);
      return false;
    } finally {
      setCancellingPendingId(null);
    }
  }, [refreshPendingEntries]);

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

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshPendingEntries(), 0);
    const timer = window.setInterval(() => void refreshPendingEntries(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshPendingEntries]);

  // Reopening the app after it was backgrounded lands on the last snapshot until
  // the next interval tick — up to a minute away. Pull everything fresh the
  // moment it returns to the foreground so it never opens on stale numbers.
  useForegroundRefresh(useCallback(async () => {
    await Promise.all([refreshAccount(), refresh(), refreshPendingEntries()]);
  }, [refreshAccount, refresh, refreshPendingEntries]));

  const signalRows = savedSetups.filter((setup) => setup.state === "setup");
  const currentPositions: HomeCurrentPosition[] = openTrades
    .filter((trade) => trade.entry != null && trade.stop != null && trade.target != null)
    .map((trade) => ({
      kind: "position",
      id: trade.id,
      instrument: trade.instrument as MajorInstrument,
      direction: trade.direction,
      entry: trade.entry as number,
      stop: trade.stop as number,
      target: trade.target as number,
      openedAt: trade.openedAt,
    }));

  // One finished row per open trade. The figures are the ones the old rows
  // showed (mark, Open R, P/L, lots); only the presentation moved.
  // OANDA's booked entry spread per trade, from the journal (which lists both
  // manual and strategy trades), so a row can show what the fill cost.
  const entrySpreadById = new Map(journalTrades.map((row) => [row.id, row.oandaEntryHalfSpreadCost ?? null]));
  const ledgerPositions: LedgerPosition[] = openTrades.slice(0, 6).map((trade) => {
    const shown = markedOpenMoney(trade, quotes, fills, watchlist);
    const live = liveOpenProgress(trade, quotes, fills, watchlist);
    const fill = trade.brokerTradeId ? fills[`broker:${trade.brokerTradeId}`] : undefined;
    const quote = openTradeQuote(trade, quotes, fill, watchlist);
    const mark = quote?.bid && quote?.ask ? (quote.bid + quote.ask) / 2 : null;
    const lots = fill && fill.units ? Math.abs(fill.units) / 100_000 : null;
    // Open R speaks the chart's language: planned entry and stop against the
    // mid. The fill/close-side figure is only a fallback.
    const rMultiple =
      openRFromLevels({ direction: trade.direction, entry: trade.entry, stop: trade.stop, current: mark }) ??
      live?.unrealizedR ??
      (shown !== null && trade.nominalRiskAmount ? shown / trade.nominalRiskAmount : null);
    const r = rMultiple === null ? null : Number(rMultiple.toFixed(2)) || 0;
    // Shown levels are the ones the trade holds now (a manual trade's can be
    // moved on the chart or be none); R above still runs off the 1R stop.
    const { sl, tp } = currentTradeLevels(trade);
    // Position on the stop → target line, 0–100%. For a short the span is
    // negative and the signs cancel, so one formula serves both sides.
    const span = sl != null && tp != null ? tp - sl : 0;
    const trackAt = (price: number | null | undefined) =>
      price == null || span === 0 || sl == null ? null : Math.min(100, Math.max(0, ((price - sl) / span) * 100));
    // Progress from entry toward the target, or how far price sits against it.
    let progress: string | null = null;
    if (mark !== null && trade.entry != null && tp != null && tp !== trade.entry) {
      const toward = (mark - trade.entry) / (tp - trade.entry);
      progress =
        toward >= 0
          ? `${Math.round(Math.min(1, toward) * 100)}% to target`
          : `${(Math.abs(mark - trade.entry) / pipSizeFor(trade.instrument)).toFixed(1)} pips against`;
    }
    return {
      id: trade.id,
      href: `/chart?instrument=${trade.instrument}&trade=${trade.id}`,
      instrument: trade.instrument,
      direction: trade.direction,
      openedAt: trade.openedAt,
      entry: trade.entry ?? null,
      mark,
      stop: sl,
      target: tp,
      entryAt: trackAt(trade.entry),
      markAt: trackAt(mark),
      r,
      money: shown,
      lots,
      progress,
      spreadCost: entrySpreadById.get(trade.id) ?? null,
    };
  });

  const ledgerSetups: LedgerSetup[] = signalRows.map((row) => ({
    id: row.id,
    href: `/chart?instrument=${row.instrument}&setup=${row.id}&entry=${row.entry}&stop=${row.stop}&target=${row.target}`,
    instrument: row.instrument,
    direction: row.direction,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
    decisionTime: row.decisionTime,
  }));

  const recentActivity = recentActivityFromTrades(journalTrades, 10);
  const todayFromList = todayClosedStats(journalTrades, todayKey);
  // The API summary is authoritative when present; the list-derived figures are
  // the fallback so the card still reports a day with no summary payload.
  const todayTrades = journalSummary?.today
    ? journalSummary.today.wins + journalSummary.today.losses
    : todayFromList.trades;
  const todayResults = journalTrades
    .filter(
      (trade) =>
        trade.status === "closed" &&
        trade.closedAt &&
        trade.resultR !== null &&
        tradingDayKey(trade.closedAt) === todayKey,
    )
    .sort((a, b) => Date.parse(a.closedAt ?? "") - Date.parse(b.closedAt ?? ""))
    .map((trade) => trade.resultR as number);
  const today: LedgerToday = {
    net: journalSummary?.today?.realizedPL ?? todayFromList.netMoney,
    r: todayFromList.netR,
    trades: todayTrades,
    wins: journalSummary?.today?.wins ?? todayFromList.wins,
    losses: journalSummary?.today?.losses ?? todayFromList.losses,
    results: todayResults,
  };
  // What each open trade loses if its stop is hit now: the broker fill's size
  // against the stop it holds (moved on the chart or not), in account dollars.
  // A stop past entry risks nothing. Trades without a fill or a stop fall back
  // to their nominal 1% risk.
  const tradeRisk = (trade: Trade) => {
    const fill = trade.brokerTradeId ? fills[`broker:${trade.brokerTradeId}`] : undefined;
    const sl = currentTradeLevels(trade).sl ?? fill?.stopPrice ?? null;
    const usdPerQuote = quoteToUsdRateFromQuotes(trade.instrument, quotes);
    if (fill && fill.units && sl !== null && usdPerQuote !== null) {
      const perUnit = trade.direction === "long" ? fill.price - sl : sl - fill.price;
      return Math.max(0, perUnit) * Math.abs(fill.units) * usdPerQuote;
    }
    return trade.nominalRiskAmount ?? null;
  };
  const tradeRisks = openTrades.map(tradeRisk).filter((risk): risk is number => risk !== null);
  const openRisk = tradeRisks.length ? tradeRisks.reduce((sum, risk) => sum + risk, 0) : null;

  return (
    <>
      <LedgerHome
        morningPicks={initialMorningPicks}
        account={account}
        accountError={accountError}
        history={accountHistory}
        todayKey={todayKey}
        // Built from the same per-position figures the rows show, so the hero
        // and the rows always add up. The account summary drifts; it is only
        // the fallback.
        openPL={heroOpenPL}
        openRisk={openRisk}
        greeting={greeting}
        positions={ledgerPositions}
        setups={ledgerSetups}
        newsPositions={currentPositions}
        today={today}
        pending={pendingEntries}
        cancellingPendingId={cancellingPendingId}
        pendingError={pendingEntryError}
        onCancelPending={setPendingCancellation}
        activity={recentActivity}
        error={error}
      />
      <PendingCancelConfirmation
        entry={pendingCancellation}
        confirming={Boolean(cancellingPendingId)}
        onDismiss={() => setPendingCancellation(null)}
        onConfirm={cancelPendingEntry}
      />
    </>
  );
}
