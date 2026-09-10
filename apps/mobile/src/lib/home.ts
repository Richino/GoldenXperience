/**
 * Home idle-state helpers. Ported from the web's `lib/home/idle.ts` for the
 * two sections that need no server-side session engine: Recent Activity and the
 * Today rollup. "Upcoming" is derived from the strategy watchlist's forming
 * setups — but WITHOUT a fabricated entry-window time, since the precise window
 * comes from a server session model the mobile client does not yet have. The
 * brief is explicit: show a truthful state rather than invent one.
 */
import { displayNameFor } from "@/lib/instruments";
import { tradingDayKey } from "@/lib/format";
import type { StrategyRow } from "@/types/api";
import type { JournalTrade } from "@/types/forex";

export type HomeActivityKind = "tp" | "sl" | "exit" | "other";

export interface HomeActivityItem {
  id: string;
  pair: string;
  instrument: string | null;
  label: string;
  kind: HomeActivityKind;
  resultR: number | null;
  paperPl: number | null;
  at: string;
}

export interface HomeUpcomingItem {
  instrument: string;
  pair: string;
  strategy: string;
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
    default:
      return "other";
  }
}

function activityLabel(outcome: string | null | undefined, kind: HomeActivityKind): string {
  if (outcome === "target_first") return "TARGET FIRST";
  if (outcome === "stop_first") return "STOP FIRST";
  if (outcome === "forced_close") return "FORCED CLOSED";
  if (kind === "tp") return "TARGET FIRST";
  if (kind === "sl") return "STOP FIRST";
  return "CLOSED";
}

export function recentActivityFromTrades(trades: JournalTrade[], limit = 10): HomeActivityItem[] {
  return trades
    .filter((trade) => trade.status === "closed" && trade.closedAt)
    .slice()
    .sort((a, b) => new Date(b.closedAt ?? 0).getTime() - new Date(a.closedAt ?? 0).getTime())
    .slice(0, limit)
    .map((trade) => {
      const kind = activityKind(trade.outcome, trade.result);
      return {
        id: trade.id,
        pair: trade.pair,
        instrument: trade.instrument ?? null,
        label: activityLabel(trade.outcome, kind),
        kind,
        resultR: trade.resultR,
        paperPl: trade.paperPl ?? null,
        at: trade.closedAt ?? trade.openedAt,
      };
    });
}

export interface TodayStats {
  trades: number;
  netR: number | null;
  wins: number;
  losses: number;
  netMoney: number | null;
}

export function todayClosedStats(trades: JournalTrade[], todayKey: string): TodayStats {
  const today = trades.filter(
    (trade) =>
      trade.status === "closed" && trade.closedAt !== null && tradingDayKey(trade.closedAt) === todayKey,
  );
  const withR = today.filter((trade) => trade.resultR !== null);
  const withPl = today.filter((trade) => trade.paperPl !== null && trade.paperPl !== undefined);
  return {
    trades: today.length,
    netR: withR.length ? withR.reduce((sum, trade) => sum + (trade.resultR ?? 0), 0) : null,
    wins: today.filter((trade) => trade.result === "win").length,
    losses: today.filter((trade) => trade.result === "loss").length,
    netMoney: withPl.length ? withPl.reduce((sum, trade) => sum + (trade.paperPl ?? 0), 0) : null,
  };
}

/**
 * Pairs with a forming (developing/valid) candidate that are not already shown
 * as live signals. No window time is attached — that data isn't available to
 * the client yet, so the Home "Upcoming" section labels these as forming.
 */
export function upcomingFromStrategies(
  rows: StrategyRow[],
  excludeInstruments: Iterable<string>,
): HomeUpcomingItem[] {
  const skip = new Set(excludeInstruments);
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
      strategy: `${pick.family.toUpperCase()} ${pick.version}`,
    });
  }
  return items.slice(0, 5);
}
