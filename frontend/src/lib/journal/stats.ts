import type { JournalTrade } from "@/types/forex";

export interface JournalEquityPoint {
  tradeId: string;
  closedAt: string;
  cumulativeR: number;
}

export interface JournalStats {
  closedCount: number;
  winRate: number;
  averageR: number;
  netR: number;
  maxDrawdownR: number;
  equityCurve: JournalEquityPoint[];
}

export const EMPTY_JOURNAL_STATS: JournalStats = {
  closedCount: 0,
  winRate: 0,
  averageR: 0,
  netR: 0,
  maxDrawdownR: 0,
  equityCurve: [],
};

export function computeJournalStats(trades: JournalTrade[]): JournalStats {
  const closedTrades = trades
    .filter(
      (
        trade,
      ): trade is JournalTrade & { resultR: number; closedAt: string } =>
        trade.status === "closed" &&
        trade.resultR !== null &&
        trade.closedAt !== null,
    )
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));

  if (closedTrades.length === 0) {
    return EMPTY_JOURNAL_STATS;
  }

  const wins = closedTrades.filter((trade) => trade.resultR > 0);
  const netR = closedTrades.reduce((sum, trade) => sum + trade.resultR, 0);

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  const equityCurve: JournalEquityPoint[] = closedTrades.map((trade) => {
    cumulative += trade.resultR;
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);

    return {
      tradeId: trade.id,
      closedAt: trade.closedAt,
      cumulativeR: cumulative,
    };
  });

  return {
    closedCount: closedTrades.length,
    winRate: (wins.length / closedTrades.length) * 100,
    averageR: netR / closedTrades.length,
    netR,
    maxDrawdownR,
    equityCurve,
  };
}
