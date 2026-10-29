import type { JournalTrade } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

/** Keep unmatched fills visible for reconciliation; never dedupe by pair/side. */
export function activeEntryOrders(entries: PendingManualEntry[], openTrades: JournalTrade[]) {
  const trades = openTrades.filter(t => t.status === "open");
  const ids = new Set(trades.flatMap(t => [t.id, t.chartTradeId].filter(Boolean)));
  const brokerIds = new Set(trades.map(t => t.brokerTradeId).filter(Boolean).map(String));
  const unique = new Map<string, PendingManualEntry>();
  for (const entry of entries) {
    const previous = unique.get(entry.id);
    if (!previous || Date.parse(entry.updatedAt) >= Date.parse(previous.updatedAt)) unique.set(entry.id, entry);
  }
  return [...unique.values()].filter(entry => {
    if (!["PENDING", "TRIGGERING", "TRIGGERED"].includes(entry.status) || entry.paperTradeStatus === "closed") return false;
    if (entry.paperTradeId && ids.has(entry.paperTradeId)) return false;
    const brokerId = entry.metadata.brokerTradeId;
    if ((typeof brokerId === "string" || typeof brokerId === "number") && brokerIds.has(String(brokerId))) return false;
    return true;
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

export function orderMatchesPair(instrument: string, search: string) {
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact(instrument).includes(compact(search));
}

export function entryOrderStatus(entry: PendingManualEntry, now = Date.now()) {
  if (entry.status === "TRIGGERED") return "Filled · syncing";
  if (entry.status === "TRIGGERING") return "Checking broker";
  if (entry.metadata.execution === "submitting") return "Submitting";
  return entry.activateAt && Date.parse(entry.activateAt) > now ? "Scheduled" : "Pending";
}

export function entryOrderHref(entry: Pick<PendingManualEntry, "id" | "instrument">) {
  return `/chart?instrument=${encodeURIComponent(entry.instrument)}&order=${encodeURIComponent(entry.id)}`;
}
