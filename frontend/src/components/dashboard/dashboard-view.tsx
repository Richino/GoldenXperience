"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeCurrentPosition } from "@/components/dashboard/home-rail";
import {
  LedgerHome,
  type LedgerPosition,
  type LedgerSetup,
  type LedgerToday,
  type DashboardLoadState,
} from "@/components/dashboard/ledger-home";
import { PendingCancelConfirmation } from "@/components/dashboard/pending-cancel-confirmation";
import { HomeLoadingBoundary } from "@/components/dashboard/home-loading-boundary";
import { PendingLevelsDialog } from "@/components/dashboard/pending-levels-dialog";
import {
  recentActivityFromTrades,
  todayClosedStats,
} from "@/lib/home/idle";
import { apiUrl } from "@/lib/api/url";
import { brokerHistoryNotice, type BrokerHistorySync } from "@/lib/home/broker-sync";
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
import type { OpenPositionFill } from "@/lib/market-stream/use-open-positions";
import { snapshotFills, type HomeFinancialSnapshot } from "@/lib/home/financial-snapshot";
import type { AccountBalanceHistoryPoint, AccountSummary, JournalTrade, MajorInstrument } from "@/types/forex";
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
  brokerSync?: BrokerHistorySync;
  summary?: {
    total: number;
    winRate: number | null;
    avgR: number;
    today?: { wins: number; losses: number; realizedPL: number | null };
  };
};

async function dashboardData<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("Dashboard data is temporarily unavailable.");
  return response.json() as Promise<T>;
}

/** Broker rows use the financial frame's pricing; paper rows may use ticks. */
function openTradeQuote(
  trade: Trade,
  quotes: Record<string, { bid: number; ask: number }>,
  fill: OpenPositionFill | undefined,
  watchlist: DashboardWatchRow[],
) {
  return (
    (trade.brokerTradeId ? resolveOpenTradeQuote(undefined, fill) : resolveOpenTradeQuote(quotes[trade.instrument], fill)) ??
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
  if (trade.brokerTradeId) return fill?.unrealizedPL ?? null;
  const live = liveOpenProgress(trade, quotes, fills, watchlist);
  // OANDA already reports this account-currency amount. A stored paper result
  // is only a fallback for a non-broker practice row, never the live value.
  return fill?.unrealizedPL ?? trade.paperPl ?? live?.money ?? null;
}

export function DashboardView({
  initialAccount,
  initialAccountHistory,
  initialWatchlist,
  initialSavedSetups,
  initialOverview,
  initialJournal,
  initialPendingEntries,
  initialLoading = false,
  greeting,
  todayKey,
}: {
  initialAccount: AccountSummary | null;
  initialAccountHistory: AccountBalanceHistoryPoint[];
  initialWatchlist: DashboardWatchRow[];
  initialSavedSetups: DashboardSavedSetup[];
  initialOverview: DashboardOverview | null;
  initialJournal: DashboardJournal;
  initialPendingEntries: PendingManualEntry[];
  initialLoading?: boolean;
  /** "Morning, Richie": worked out on the server from the ET hour. */
  greeting: string;
  todayKey: string;
}) {
  const [financial, setFinancial] = useState(() => ({
    account: verifiedAccountSummary({ data: initialAccount }), history: initialAccountHistory,
    fills: {} as Record<string, OpenPositionFill>, checkedAt: null as string | null,
  }));
  const { account, history: accountHistory, fills } = financial;
  const [accountError, setAccountError] = useState<string | null>(() => initialLoading || verifiedAccountSummary({ data: initialAccount }) ? null : ACCOUNT_UNAVAILABLE_MESSAGE);
  const [journalTrades, setJournalTrades] = useState(initialJournal.trades);
  const [journalSummary, setJournalSummary] = useState(initialJournal.summary ?? null);
  const [journalSync, setJournalSync] = useState(initialJournal.brokerSync ?? null);
  // Kept for the Open-trades quote fallback below; the Watchlist section now
  // renders from the multi-strategy engine instead.
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [watchlistReady, setWatchlistReady] = useState(!initialLoading);
  const [savedSetups, setSavedSetups] = useState(initialSavedSetups ?? []);
  const [overviewOpen, setOverviewOpen] = useState(() => initialOverview?.openTrades ?? initialOverview?.trades.filter(trade => trade.status === "open") ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<DashboardLoadState>(() => {
    const state = initialLoading ? "loading" : "ready";
    return { account: state, history: state, positions: state, setups: state, journal: state, pending: state };
  });
  const loading = useRef(new Set<string>());
  const finishLoad = useCallback((key: keyof DashboardLoadState, failed = false) => {
    setLoadState(current => ({ ...current, [key]: failed
      ? current[key] === "ready" || current[key] === "stale" ? "stale" : "error"
      : "ready" }));
  }, []);
  const [pendingEntries, setPendingEntries] = useState<PendingManualEntry[]>(() =>
    initialPendingEntries.filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING"),
  );
  const [pendingEntryError, setPendingEntryError] = useState<string | null>(null);
  const [cancellingPendingId, setCancellingPendingId] = useState<string | null>(null);
  const [pendingCancellation, setPendingCancellation] = useState<PendingManualEntry | null>(null);
  const [pendingLevelsEntry, setPendingLevelsEntry] = useState<PendingManualEntry | null>(null);
  const [savingPendingLevels, setSavingPendingLevels] = useState(false);
  // Streamed prices are used only for paper estimates and currency conversions.
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fillsLoading = loadState.account === "loading";
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
  const openTrades = [...overviewOpen, ...manualOpen].filter(trade =>
    !financial.checkedAt || !trade.brokerTradeId || Boolean(fills[`broker:${trade.brokerTradeId}`]),
  );

  // Account cash never includes the separate paper-only simulation estimates.
  const heroOpenPL = account?.unrealizedPL ?? 0;

  const refreshJournal = useCallback(async () => {
    if (loading.current.has("journal")) return;
    loading.current.add("journal");
    try {
      const payload = await dashboardData<DashboardJournal>("/api/journal/trades?limit=50&filter=all&sync=background");
      setJournalTrades(payload.trades); setJournalSummary(payload.summary ?? null);
      setJournalSync(payload.brokerSync ?? null); finishLoad("journal");
    } catch (reason) { finishLoad("journal", true); throw reason; }
    finally { loading.current.delete("journal"); }
  }, [finishLoad]);

  const refresh = useCallback(async () => {
    if (loading.current.has("overview")) return;
    loading.current.add("overview");
    try {
      // Fetch in parallel behind Home's first-load boundary. Later refreshes
      // keep the visible page and its previously verified snapshots in place.
      const results = await Promise.allSettled([
        dashboardData<{ watchlist: DashboardWatchRow[] }>("/api/watchlist").then(payload => setWatchlist(payload.watchlist)).finally(() => setWatchlistReady(true)),
        dashboardData<{ setups: DashboardSavedSetup[] }>("/api/saved-setups").then(payload => {
          setSavedSetups(payload.setups ?? []); finishLoad("setups");
        }).catch(reason => { finishLoad("setups", true); throw reason; }),
        dashboardData<{ trades: Trade[] }>("/api/paper-cycle/open-trades").then(payload => {
          setOverviewOpen(payload.trades); finishLoad("positions");
        }).catch(reason => { finishLoad("positions", true); throw reason; }),
        refreshJournal(),
      ]);
      setError(results.some(result => result.status === "rejected") ? "Some dashboard sections could not refresh. Previously loaded data may be outdated." : null);
    } finally { loading.current.delete("overview"); }
  }, [finishLoad, refreshJournal]);

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
    if (loading.current.has("account")) return;
    loading.current.add("account");
    try {
      const payload = await dashboardData<HomeFinancialSnapshot>("/api/oanda/account-snapshot", 25_000);
      const verified = verifiedAccountSummary(payload);
      if (!verified) throw new Error(ACCOUNT_UNAVAILABLE_MESSAGE);
      const nextFills = snapshotFills(payload);
      setFinancial({ account: verified, history: payload.history, fills: nextFills, checkedAt: payload.checkedAt });
      setAccountError(null);
      finishLoad("account");
      finishLoad("history");
    } catch {
      // Preserve the verified snapshot; an outage must never replace it with demo money.
      setAccountError(ACCOUNT_UNAVAILABLE_MESSAGE);
      finishLoad("account", true);
      finishLoad("history", true);
    } finally { loading.current.delete("account"); }
  }, [finishLoad]);

  const refreshPendingEntries = useCallback(async () => {
    if (loading.current.has("pending")) return;
    loading.current.add("pending");
    try {
      const payload = await dashboardData<{ entries?: PendingManualEntry[] }>("/api/pending-entries?scope=active");
      setPendingEntries((payload.entries ?? []).filter((entry) => entry.status === "PENDING" || entry.status === "TRIGGERING"));
      setPendingEntryError(null);
      finishLoad("pending");
    } catch {
      finishLoad("pending", true);
      setPendingEntryError("Waiting orders could not refresh. Previously loaded orders may be outdated.");
    } finally { loading.current.delete("pending"); }
  }, [finishLoad]);

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

  /** Returns an error to show in the dialog, or null once saved. */
  const savePendingLevels = useCallback(async (
    entry: PendingManualEntry,
    levels: { stopPrice: number | null; targetPrice: number | null },
  ): Promise<string | null> => {
    setSavingPendingLevels(true);
    try {
      const response = await fetch(apiUrl(`/api/pending-entries/${entry.id}/levels`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: entry.instrument, pending: true, ...levels }),
      });
      const payload = await response.json() as { entry?: PendingManualEntry; error?: string };
      if (!response.ok || !payload.entry) throw new Error(payload.error ?? "Could not change the stop and target.");
      const updated = payload.entry;
      setPendingEntries((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      return null;
    } catch (reason) {
      await refreshPendingEntries();
      return reason instanceof Error ? reason.message : "Could not change the stop and target.";
    } finally {
      setSavingPendingLevels(false);
    }
  }, [refreshPendingEntries]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshAccount(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshAccount(); }, 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshAccount]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!journalSync || journalSync.status === "ready") return;
    // Failed imports used to stop polling until the minute-long dashboard refresh.
    // Follow the server's backoff, including while web/API deployments differ.
    const delay = journalSync.retryAfterMs ?? (journalSync.status === "running" ? 3_000 : 15_000);
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void refreshJournal().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [journalSync, refreshJournal]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshPendingEntries(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshPendingEntries(); }, 5_000);
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
    // The spread in R, against the same 1R (planned entry to stop) that Open R
    // uses, in account dollars; nominal 1% risk when there is no fill.
    const spreadCost = entrySpreadById.get(trade.id) ?? null;
    const usdPerQuote = quoteToUsdRateFromQuotes(trade.instrument, quotes);
    const oneR = fill?.units && trade.entry != null && trade.stop != null && usdPerQuote !== null
      ? Math.abs(trade.entry - trade.stop) * Math.abs(fill.units) * usdPerQuote
      : trade.nominalRiskAmount ?? null;
    const spreadR = spreadCost !== null && oneR ? -Math.abs(spreadCost) / oneR : null;
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
      spreadCost,
      spreadR,
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

  return (
    <>
      <HomeLoadingBoundary ready={watchlistReady && !fillsLoading && Object.values(loadState).every(state => state !== "loading")}>
      <LedgerHome
        account={account}
        accountError={accountError}
        history={accountHistory}
        todayKey={todayKey}
        financialUpdatedAt={financial.checkedAt}
        openPL={heroOpenPL}
        greeting={greeting}
        positions={ledgerPositions}
        setups={ledgerSetups}
        newsPositions={currentPositions}
        today={today}
        pending={pendingEntries}
        cancellingPendingId={cancellingPendingId}
        pendingError={pendingEntryError}
        onCancelPending={setPendingCancellation}
        onEditPending={setPendingLevelsEntry}
        activity={recentActivity}
        error={[error, brokerHistoryNotice(journalSync)].filter(Boolean).join(" ") || null}
        loadState={loadState}
      />
      </HomeLoadingBoundary>
      <PendingCancelConfirmation
        entry={pendingCancellation}
        confirming={Boolean(cancellingPendingId)}
        onDismiss={() => setPendingCancellation(null)}
        onConfirm={cancelPendingEntry}
      />
      <PendingLevelsDialog
        entry={pendingLevelsEntry}
        saving={savingPendingLevels}
        onDismiss={() => setPendingLevelsEntry(null)}
        onSave={savePendingLevels}
      />
    </>
  );
}
