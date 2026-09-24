import type { JournalTrade } from '@/types/api';

/**
 * Broker-history-synced closes (`syncPracticeBrokerHistory`, api-server)
 * historically never populated a structured `paperPl` — the realized amount
 * only ever landed in this free-text note ("Broker realized P&L: 154.10
 * USD."). The api-server writes `paper_pl` directly now, but old rows synced
 * before that fix still carry the amount only here, so this stays as a
 * fallback.
 */
function parseBrokerRealizedPl(notes: string | null): number | null {
  if (!notes) return null;
  const match = notes.match(/Broker realized P&L:\s*(-?[\d,]+\.?\d*)\s*USD/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function resolvedPaperPl(trade: JournalTrade): number | null {
  return trade.paperPl ?? parseBrokerRealizedPl(trade.notes);
}

/**
 * The journal API can carry two rows for one real-world close: a
 * strategy/manual decision record (has resultR and real entry/stop/target
 * levels, no broker P&L) and a broker reconciliation record (has paperPl,
 * degenerate entry=stop=target, no resultR), synced separately and
 * sometimes well apart in time — one pair was observed over 4 hours apart,
 * so a tight closedAt time bucket alone missed it. Both rows always share
 * the same entry and exit price (the actual broker fill), which is a far
 * more reliable match than timing; a generous same-day window just guards
 * against two unrelated trades coincidentally closing at the same level.
 * Anywhere closed trades are listed or summed, group and merge these so a
 * single trade never shows up twice with half its numbers missing.
 */
function groupKey(trade: JournalTrade) {
  const at = trade.closedAt ?? trade.openedAt;
  const dayBucket = Math.floor(new Date(at).getTime() / (24 * 60 * 60_000));
  const entryKey = trade.entry.toFixed(5);
  const exitKey = trade.exit === null ? 'null' : trade.exit.toFixed(5);
  return `${trade.pair}|${trade.direction}|${entryKey}|${exitKey}|${dayBucket}`;
}

function mergeGroup(group: JournalTrade[]): JournalTrade {
  if (group.length === 1) return group[0];
  // The decision record (resultR set) carries the real levels; the
  // broker-only row exists just to carry the realized P&L, so it's never the
  // one shown — only borrowed from.
  const primary = group.find((trade) => trade.resultR !== null) ?? group.find((trade) => trade.outcome !== null) ?? group[0];
  return {
    ...primary,
    resultR: group.find((trade) => trade.resultR !== null)?.resultR ?? null,
    paperPl: group.map(resolvedPaperPl).find((value) => value !== null) ?? null,
  };
}

/** For a closed-only list (e.g. a "Closed" tab, or a day's closed trades). */
export function dedupeClosedTrades(trades: JournalTrade[]): JournalTrade[] {
  const groups = new Map<string, JournalTrade[]>();
  for (const trade of trades) {
    const key = groupKey(trade);
    const existing = groups.get(key);
    if (existing) existing.push(trade);
    else groups.set(key, [trade]);
  }
  return Array.from(groups.values()).map(mergeGroup);
}

/**
 * For a mixed open+closed list (e.g. an "All" tab). Open trades pass through
 * untouched; closed duplicates are merged in place at the first row's
 * position, preserving the list's original ordering.
 */
export function dedupeTrades(trades: JournalTrade[]): JournalTrade[] {
  const closedGroups = new Map<string, JournalTrade[]>();
  for (const trade of trades) {
    if (trade.status !== 'closed') continue;
    const key = groupKey(trade);
    const existing = closedGroups.get(key);
    if (existing) existing.push(trade);
    else closedGroups.set(key, [trade]);
  }
  const merged = new Map<string, JournalTrade>();
  for (const [key, group] of closedGroups) merged.set(key, mergeGroup(group));

  const seen = new Set<string>();
  const result: JournalTrade[] = [];
  for (const trade of trades) {
    if (trade.status !== 'closed') {
      result.push(trade);
      continue;
    }
    const key = groupKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(merged.get(key)!);
  }
  return result;
}
