import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import {
  monitorTrade,
  type FrozenTradeContext,
  type MonitorEvent,
  type TradeHealth,
} from "../../frontend/src/lib/strategy/trade-monitor.js";
import { profileFor } from "../../frontend/src/lib/strategy/timeframe-profiles.js";
import type { MajorInstrument } from "./market-stream-types.js";
import { query } from "./database.js";
import { queueNotification, displayPair } from "./notifications.js";

/** Alert types worth a push notification (item 9). */
const NOTIFIABLE = new Set([
  "WARNING",
  "EXIT_SUGGESTED",
  "NEW_SUPPORT",
  "NEW_RESISTANCE",
  "STRUCTURE_FAILURE",
]);

type StoredAlert = {
  dedupeKey: string;
  type: string;
  at: string;
  level: number | null;
  reason: string;
};

export type TradeMonitorResult =
  | { monitored: false; reason: string }
  | { monitored: true; tradeId: string | null; health: TradeHealth; newEvents: MonitorEvent[] };

/**
 * Run the Stage 5 monitor for the user's active trade on `instrument`. Loads the
 * frozen Analyze context stored with the entry, re-runs the deterministic
 * engine on current completed candles, and persists deduplicated alert events
 * into the entry's metadata. Never closes or modifies the position (item 14).
 */
export async function runTradeMonitor(userId: string, instrument: MajorInstrument): Promise<TradeMonitorResult> {
  const row = await query<{ id: string; paper_trade_id: string | null; metadata: Record<string, unknown> }>(
    `SELECT id, paper_trade_id, metadata FROM pending_manual_entries
      WHERE user_id=$1 AND instrument=$2 AND status='TRIGGERED'
      ORDER BY created_at DESC LIMIT 1`,
    [userId, instrument],
  );
  const entry = row.rows[0];
  if (!entry) return { monitored: false, reason: "No active trade on this pair." };

  const metadata = entry.metadata ?? {};
  const context = metadata.frozenContext as FrozenTradeContext | undefined;
  if (!context || context.version !== 1) {
    return { monitored: false, reason: "This trade has no frozen analysis context, so structural monitoring is unavailable." };
  }

  // Item 15: monitor on the timeframe the trade was FROZEN to, regardless of
  // whatever chart the user is currently viewing.
  const profile = profileFor(context.timeframe);
  const [candles, pricing] = await Promise.all([
    getCandles(instrument, profile.timeframe, profile.historyCount),
    getPricing([instrument]),
  ]);
  const quote = pricing.data[0];
  if (candles.status.state !== "connected" || !quote || !(quote.bid > 0) || !(quote.ask >= quote.bid)) {
    return { monitored: false, reason: "Fresh OANDA data is required to monitor this trade." };
  }

  const health = monitorTrade({
    context,
    candles: candles.data.candles,
    quote: { bid: quote.bid, ask: quote.ask, mid: quote.mid },
    tradeId: entry.paper_trade_id,
  });

  // Deduplicate against alerts already stored on this trade (item 8/9).
  const priorAlerts: StoredAlert[] = Array.isArray(metadata.alerts) ? (metadata.alerts as StoredAlert[]) : [];
  const seen = new Set(priorAlerts.map((alert) => alert.dedupeKey));
  const newEvents = health.events.filter((event) => !seen.has(event.dedupeKey));

  if (newEvents.length) {
    const appended = [
      ...priorAlerts,
      ...newEvents.map((event) => ({
        dedupeKey: event.dedupeKey,
        type: event.type,
        at: event.timestamp,
        level: event.level,
        reason: event.reason,
      })),
    ].slice(-100);
    await query(
      `UPDATE pending_manual_entries SET metadata = jsonb_set(metadata, '{alerts}', $2::jsonb), updated_at=now() WHERE id=$1`,
      [entry.id, JSON.stringify(appended)],
    );
    for (const event of newEvents) {
      if (!NOTIFIABLE.has(event.type)) continue;
      await queueNotification({
        userId,
        kind: "trade_update",
        title: `${displayPair(instrument)} · ${event.type.replace(/_/g, " ").toLowerCase()}`,
        message: event.reason,
        instrument,
        paperTradeId: entry.paper_trade_id,
        dedupeKey: `monitor:${entry.id}:${event.dedupeKey}`,
      }).catch((error) => console.error(`[trade-monitor] notification failed for ${entry.id}`, error));
    }
  }

  return { monitored: true, tradeId: entry.paper_trade_id, health, newEvents };
}
