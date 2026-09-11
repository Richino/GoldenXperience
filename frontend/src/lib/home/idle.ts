import { formatClockTime, formatShortDay, startOfTradingDay, tradingDayKey } from "@/lib/format/datetime";
import { displayNameFor } from "@/lib/instruments/catalog";
import { STRATEGY_FAMILY_LABEL } from "@/lib/strategy/family-label";
import { nextEntryWindow } from "@/lib/strategy/strategy-engine";
import type { JournalTrade } from "@/types/forex";

export type UpcomingStrategyRow = {
  instrument: string;
  strategies: Array<{
    family: string;
    version: string;
    setupStatus: string;
    selected: boolean;
  }>;
};

export type HomeUpcomingItem = {
  instrument: string;
  pair: string;
  strategy: string;
  windowLabel: string;
};

export type HomeActivityKind = "tp" | "sl" | "exit" | "other";

export type HomeActivityItem = {
  id: string;
  pair: string;
  instrument: string | null;
  /** Strategy records have a chartable paper-strategy trade id. */
  chartTradeId: string | null;
  label: string;
  kind: HomeActivityKind;
  resultR: number | null;
  paperPl: number | null;
  at: string;
};

function strategyTitle(family: string, version: string) {
  const label = STRATEGY_FAMILY_LABEL[family] ?? family;
  const match = version.match(/v(\d+)/i);
  return match ? `${label} V${match[1]}` : label;
}

export function upcomingWindowLabel(now = new Date()) {
  const next = nextEntryWindow(now);
  if (next.open) return "Now";
  const today = tradingDayKey(now);
  const target = tradingDayKey(next.at);
  if (target === today) return formatClockTime(next.at);
  const tomorrow = tradingDayKey(startOfTradingDay(now).getTime() + 36 * 60 * 60_000);
  if (target === tomorrow) return "Tomorrow";
  return formatShortDay(next.at);
}

export function upcomingWindowCopy(now = new Date()) {
  const next = nextEntryWindow(now);
  if (next.open) return `Entry window open · ${next.label}`;
  return `Next window ${upcomingWindowLabel(now)} · ${next.label}`;
}

/**
 * Pairs that already have a developing or valid candidate, waiting on the
 * shared London/NY entry window. Skips instruments already shown as live
 * signals so the idle list does not repeat the active section.
 */
export function upcomingFromStrategies(
  rows: UpcomingStrategyRow[],
  excludeInstruments: Iterable<string>,
  now = new Date(),
): HomeUpcomingItem[] {
  const skip = new Set(excludeInstruments);
  const windowLabel = upcomingWindowLabel(now);
  const items: HomeUpcomingItem[] = [];

  for (const row of rows) {
    if (skip.has(row.instrument)) continue;
    const ready = row.strategies.filter(
      (strategy) => strategy.setupStatus === "developing" || strategy.setupStatus === "valid",
    );
    if (!ready.length) continue;
    const pick = ready.find((strategy) => strategy.selected) ?? ready[0];
    if (!pick) continue;
    items.push({
      instrument: row.instrument,
      pair: displayNameFor(row.instrument),
      strategy: strategyTitle(pick.family, pick.version),
      windowLabel,
    });
  }

  return items.slice(0, 5);
}

function activityKind(outcome: string | null | undefined, result: JournalTrade["result"]): HomeActivityKind {
  switch (outcome) {
    case "target_first":
      return "tp";
    case "stop_first":
      return "sl";
    case "forced_close":
    case "ambiguous":
      return "exit";
    default:
      break;
  }
  switch (result) {
    case "win":
      return "tp";
    case "loss":
      return "sl";
    case "breakeven":
    case "open":
      return "other";
    default: {
      const _never: never = result;
      return _never;
    }
  }
}

function activityLabel(outcome: string | null | undefined, kind: HomeActivityKind) {
  if (outcome === "target_first") return "TARGET FIRST";
  if (outcome === "stop_first") return "STOP FIRST";
  if (outcome === "forced_close") return "FORCED CLOSED";
  switch (kind) {
    case "tp":
      return "TARGET FIRST";
    case "sl":
      return "STOP FIRST";
    case "exit":
    case "other":
      return "CLOSED";
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

export function recentActivityFromTrades(trades: JournalTrade[], limit = 10): HomeActivityItem[] {
  return trades
    .filter((trade) => trade.status === "closed" && trade.closedAt)
    .slice()
    .sort((a, b) => new Date(b.closedAt ?? 0).getTime() - new Date(a.closedAt ?? 0).getTime())
    .slice(0, limit)
    .map((trade) => {
      if (trade.brokerExecutionStatus === "rejected") {
        return {
          id: trade.id,
          pair: trade.pair,
          instrument: trade.instrument ?? null,
          chartTradeId: trade.origin === "strategy" ? trade.id : null,
          label: "BROKER REJECTED",
          kind: "other",
          resultR: null,
          paperPl: null,
          at: trade.closedAt ?? trade.openedAt,
        };
      }
      const kind = activityKind(trade.outcome, trade.result);
      return {
        id: trade.id,
        pair: trade.pair,
        instrument: trade.instrument ?? null,
        chartTradeId: trade.origin === "strategy" ? trade.id : null,
        label: activityLabel(trade.outcome, kind),
        kind,
        resultR: trade.resultR,
        paperPl: trade.paperPl ?? null,
        at: trade.closedAt ?? trade.openedAt,
      };
    });
}

export function todayClosedStats(trades: JournalTrade[], todayKey: string) {
  const today = trades.filter(
    (trade) =>
      trade.status === "closed" &&
      trade.closedAt !== null &&
      tradingDayKey(trade.closedAt) === todayKey,
  );
  const withR = today.filter((trade) => trade.resultR !== null);
  const withPl = today.filter(
    (trade) => trade.paperPl !== null && trade.paperPl !== undefined,
  );
  return {
    trades: today.length,
    netR: withR.length ? withR.reduce((sum, trade) => sum + (trade.resultR ?? 0), 0) : null,
    wins: today.filter((trade) => trade.result === "win").length,
    losses: today.filter((trade) => trade.result === "loss").length,
    netMoney: withPl.length
      ? withPl.reduce((sum, trade) => sum + (trade.paperPl ?? 0), 0)
      : null,
  };
}
