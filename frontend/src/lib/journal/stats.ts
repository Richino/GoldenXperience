import type { JournalTrade } from "@/types/forex";
import { verifiedRStatistics } from "@/lib/risk-metrics";
export interface JournalEquityPoint { tradeId: string; closedAt: string; cumulativeR: number }
export interface JournalStats {
  closedCount: number; winRate: number; averageR: number | null;
  netR: number | null; maxDrawdownR: number | null; equityCurve: JournalEquityPoint[];
  included: number; excluded: number; coveragePct: number; exclusionReason: string; insufficientData: boolean;
}
export const EMPTY_JOURNAL_STATS: JournalStats = { closedCount: 0, winRate: 0, averageR: null, netR: null, maxDrawdownR: null, equityCurve: [], included: 0, excluded: 0, coveragePct: 0, exclusionReason: "Initial risk or net P/L not verified", insufficientData: true };
export function computeJournalStats(trades: JournalTrade[]): JournalStats {
  const closed = trades.filter(t => t.status === "closed" && t.closedAt !== null);
  const stats = verifiedRStatistics(closed);
  const eligible = closed.filter(t => t.riskDataQuality === "verified" && typeof t.resultR === "number" && Number.isFinite(t.resultR)).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!));
  let cumulative = 0, peak = 0, drawdown = 0;
  const curve = eligible.map(trade => { cumulative += trade.resultR!; peak = Math.max(peak, cumulative); drawdown = Math.max(drawdown, peak - cumulative); return { tradeId: trade.id, closedAt: trade.closedAt!, cumulativeR: cumulative }; });
  return { closedCount: closed.length, winRate: (stats.winRate ?? 0) * 100,
    averageR: stats.expectancyR, netR: stats.sumIndependentUnitR, maxDrawdownR: stats.insufficientData ? null : drawdown,
    equityCurve: stats.insufficientData ? [] : curve, included: stats.included, excluded: stats.excluded, coveragePct: stats.coveragePct,
    exclusionReason: stats.exclusionReason, insufficientData: stats.insufficientData };
}
