import type { AccountSummary, ConnectionStatus } from "@/types/forex";

/** Reject demo balances and unsuccessful broker snapshots, including HTTP 200 fallbacks. */
export function verifiedAccountSummary(payload: {
  data?: AccountSummary | null;
  status?: ConnectionStatus;
}): AccountSummary | null {
  const account = payload.data;
  if (!account || account.source !== "oanda" || (payload.status && payload.status.state !== "connected")) return null;
  if (![account.balance, account.nav, account.unrealizedPL, account.marginUsed, account.marginAvailable].every(Number.isFinite)) return null;
  return account;
}

export const ACCOUNT_UNAVAILABLE_MESSAGE = "OANDA balance unavailable. Any displayed amount is the last verified value and may be outdated.";
