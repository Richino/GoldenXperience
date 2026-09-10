/** Typed wrappers over the GX read endpoints Phase 1 consumes. */
import { apiGet } from "@/api/client";
import type {
  AccountBalanceHistoryPoint,
  AccountSummary,
  JournalResponse,
  OandaEnvelope,
  OpenPosition,
  OverviewTrade,
  PaperCycleOverview,
  PriceQuote,
  StrategyRow,
  StrategySnapshot,
  WatchRow,
} from "@/types/api";

export function getAccountSummary(signal?: AbortSignal) {
  return apiGet<OandaEnvelope<AccountSummary>>("/api/oanda/account-summary", signal);
}

export function getAccountHistory(signal?: AbortSignal) {
  return apiGet<OandaEnvelope<AccountBalanceHistoryPoint[]>>("/api/oanda/account-history", signal);
}

export function getOpenPositions(signal?: AbortSignal) {
  return apiGet<OandaEnvelope<OpenPosition[]>>("/api/oanda/open-positions", signal);
}

export function getPricing(instruments: string[], signal?: AbortSignal) {
  const query = instruments.length ? `?instruments=${instruments.join(",")}` : "";
  return apiGet<OandaEnvelope<PriceQuote[]>>(`/api/oanda/pricing${query}`, signal);
}

export function getWatchlist(signal?: AbortSignal) {
  return apiGet<{ watchlist: WatchRow[] }>("/api/watchlist", signal);
}

export function getStrategyWatchlist(signal?: AbortSignal) {
  return apiGet<{ instruments: StrategyRow[] }>("/api/multistrategy/watchlist", signal);
}

export function getPaperCycle(signal?: AbortSignal) {
  return apiGet<PaperCycleOverview>("/api/paper-cycle", signal);
}

export function getStrategySnapshot(signal?: AbortSignal) {
  return apiGet<StrategySnapshot>("/api/strategy", signal);
}

export function getJournalTrades(
  params: { limit?: number; offset?: number; filter?: "all" | "wins" | "losses" | "active" } = {},
  signal?: AbortSignal,
) {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 50));
  if (params.offset) search.set("offset", String(params.offset));
  search.set("filter", params.filter ?? "all");
  return apiGet<JournalResponse>(`/api/journal/trades?${search.toString()}`, signal);
}

export type { OverviewTrade };
