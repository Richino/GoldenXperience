import type { JournalTrade } from "@/types/forex";

export const PAPER_JOURNAL_STORAGE_KEY =
  "goldenxperience.paper-journal.v1";
export const PAPER_JOURNAL_UPDATED_EVENT =
  "goldenxperience:paper-journal-updated";

export interface PaperJournalDaySummary {
  tradesTaken: number;
  losingR: number;
  consecutiveLosses: number;
}

export const EMPTY_PAPER_JOURNAL_DAY: PaperJournalDaySummary = {
  tradesTaken: 0,
  losingR: 0,
  consecutiveLosses: 0,
};

export function isJournalTrade(value: unknown): value is JournalTrade {
  if (!value || typeof value !== "object") return false;
  const trade = value as Partial<JournalTrade>;
  return (
    typeof trade.id === "string" &&
    (trade.origin === "demo" ||
      trade.origin === "manual" ||
      trade.origin === "strategy") &&
    typeof trade.pair === "string" &&
    (trade.direction === "long" || trade.direction === "short") &&
    typeof trade.entry === "number" &&
    typeof trade.stop === "number" &&
    typeof trade.target === "number"
  );
}

export function parseStoredJournal(value: string | null) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isJournalTrade);
  } catch {
    return null;
  }
}

export function summarizePaperJournalDay(
  trades: JournalTrade[],
  now = new Date(),
): PaperJournalDaySummary {
  const today = now.toDateString();
  const todayTrades = trades
    .filter(
      (trade) =>
        trade.origin === "manual" &&
        new Date(trade.openedAt).toDateString() === today,
    )
    .sort(
      (left, right) =>
        Date.parse(right.openedAt) - Date.parse(left.openedAt),
    );
  const losingR = todayTrades.reduce(
    (total, trade) =>
      trade.resultR !== null && trade.resultR < 0
        ? total + Math.abs(trade.resultR)
        : total,
    0,
  );
  let consecutiveLosses = 0;

  for (const trade of todayTrades) {
    if (trade.status !== "closed" || trade.resultR === null) continue;
    if (trade.resultR >= 0) break;
    consecutiveLosses += 1;
  }

  return {
    tradesTaken: todayTrades.length,
    losingR,
    consecutiveLosses,
  };
}
