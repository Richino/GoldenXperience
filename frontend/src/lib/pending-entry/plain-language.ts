import { formatChartPrice } from "@/lib/chart-utils";
import { formatDayAndTime } from "@/lib/format/datetime";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry, PendingManualEntryStatus } from "@/types/pending-entry";

/** Screen-reader / link label: full trigger description. */
export function pendingTriggerSummary(entry: PendingManualEntry): string {
  const pair = displayNameFor(entry.instrument);
  const price = formatChartPrice(entry.entryPrice, entry.instrument);
  const limit = entry.entryOrderType.includes("limit");

  if (entry.direction === "long") {
    return limit
      ? `Will buy ${pair} if the price dips to ${price}.`
      : `Will buy ${pair} if the price climbs to ${price}.`;
  }

  return limit
    ? `Will sell ${pair} if the price climbs to ${price}.`
    : `Will sell ${pair} if the price falls to ${price}.`;
}

export function pendingStatusLabel(status: PendingManualEntryStatus): string {
  switch (status) {
    case "PENDING":
      return "Waiting";
    case "TRIGGERING":
      return "Opening…";
    case "TRIGGERED":
      return "Filled";
    case "EXPIRED":
      return "Expired";
    case "INVALIDATED":
      return "Cancelled (price moved away)";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Could not place";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function pendingLevelPrice(
  price: number | null,
  instrument: string,
): { text: string; unset: boolean } {
  if (price === null || !Number.isFinite(price)) {
    return { text: "Not set", unset: true };
  }
  return { text: formatChartPrice(price, instrument), unset: false };
}

/** Scheduling and auto-cancel rules in everyday language. */
export function pendingTimingNote(entry: PendingManualEntry, now = Date.now()): string | null {
  const parts: string[] = [];

  if (entry.activateAt && Date.parse(entry.activateAt) > now) {
    parts.push(`Starts watching ${formatDayAndTime(entry.activateAt)}`);
  }

  if (entry.expiresAt && Date.parse(entry.expiresAt) > now) {
    parts.push(`Removes itself ${formatDayAndTime(entry.expiresAt)} if still waiting`);
  }

  if (entry.invalidationPrice !== null) {
    parts.push(
      `Removes itself if price hits ${formatChartPrice(entry.invalidationPrice, entry.instrument)} first`,
    );
  }

  return parts.length ? parts.join(" · ") : null;
}
