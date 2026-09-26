import type { JournalTrade } from '@/types/api';
import { tradingDayKey } from '@/lib/time';
import { dedupeClosedTrades, resolvedPaperPl } from '@/lib/trades/merge-duplicates';

export type ActivityKind = 'tp' | 'sl' | 'exit' | 'other';

export type ActivityItem = {
  id: string;
  pair: string;
  instrument: string | null;
  /** The id the chart knows this trade by; null when only the broker has it. */
  chartTradeId: string | null;
  label: string;
  kind: ActivityKind;
  resultR: number | null;
  paperPl: number | null;
  at: string;
};

function activityKind(outcome: string | null, result: JournalTrade['result']): ActivityKind {
  switch (outcome) {
    case 'target_first':
      return 'tp';
    case 'stop_first':
      return 'sl';
    case 'forced_close':
    case 'ambiguous':
      return 'exit';
    default:
      break;
  }
  switch (result) {
    case 'win':
      return 'tp';
    case 'loss':
      return 'sl';
    default:
      return 'other';
  }
}

function activityLabel(outcome: string | null, kind: ActivityKind) {
  if (outcome === 'target_first') return 'TARGET FIRST';
  if (outcome === 'stop_first') return 'STOP FIRST';
  if (outcome === 'forced_close') return 'FORCED CLOSED';
  switch (kind) {
    case 'tp':
      return 'TARGET FIRST';
    case 'sl':
      return 'STOP FIRST';
    default:
      return 'CLOSED';
  }
}

function toActivityItem(trade: JournalTrade): ActivityItem {
  if (trade.brokerExecutionStatus === 'rejected') {
    return {
      id: trade.id,
      pair: trade.pair,
      instrument: trade.instrument,
      chartTradeId: trade.chartTradeId,
      label: 'BROKER REJECTED',
      kind: 'other',
      resultR: null,
      paperPl: null,
      at: trade.closedAt ?? trade.openedAt,
    };
  }
  const kind = activityKind(trade.outcome, trade.result);
  return {
    id: trade.id,
    pair: trade.pair,
    instrument: trade.instrument,
    chartTradeId: trade.chartTradeId,
    label: activityLabel(trade.outcome, kind),
    kind,
    resultR: trade.resultR,
    paperPl: resolvedPaperPl(trade),
    at: trade.closedAt ?? trade.openedAt,
  };
}

export function recentActivityFromTrades(trades: JournalTrade[], limit = 10): ActivityItem[] {
  const closed = trades.filter((trade) => trade.status === 'closed' && trade.closedAt);
  return dedupeClosedTrades(closed)
    .map(toActivityItem)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

export function todayClosedStats(trades: JournalTrade[], todayKey: string) {
  const today = dedupeClosedTrades(
    trades.filter((trade) => trade.status === 'closed' && trade.closedAt !== null && tradingDayKey(trade.closedAt) === todayKey),
  );
  const withR = today.filter((trade) => trade.resultR !== null);
  const withPl = today.filter((trade) => trade.paperPl !== null && trade.paperPl !== undefined);
  return {
    trades: today.length,
    netR: withR.length ? withR.reduce((sum, trade) => sum + (trade.resultR ?? 0), 0) : null,
    wins: today.filter((trade) => trade.result === 'win').length,
    losses: today.filter((trade) => trade.result === 'loss').length,
    netMoney: withPl.length ? withPl.reduce((sum, trade) => sum + (trade.paperPl ?? 0), 0) : null,
  };
}
