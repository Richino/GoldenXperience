export type BrokerHistorySync = {
  status: "running" | "ready" | "unavailable" | "failed";
  completedAt: string | null;
  retryAfterMs?: number;
};

/** A routine background refresh is not a failure of the broker connection. */
export function brokerHistoryNotice(sync: BrokerHistorySync | null | undefined): string | null {
  if (!sync || sync.status === "ready" || sync.status === "running") return null;
  return "Closed-trade history could not refresh. Retrying automatically; showing saved journal data.";
}
