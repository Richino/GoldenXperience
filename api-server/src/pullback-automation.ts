import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { highImpactMinutesFor } from "../../frontend/src/lib/macro/rates.js";
import { trendPullbackContext } from "../../frontend/src/lib/strategy/trend-pullback-v1.js";
import {
  evaluatePullbackWatch,
  PULLBACK_WATCH,
  pullbackSignalFresh,
  pullbackTradeFromWatch,
  type PullbackTrade,
  type PullbackWatch,
} from "../../frontend/src/lib/strategy/pullback-watch.js";
import type { MajorInstrument, MarketPriceTick } from "./market-stream-types.js";
import { query } from "./database.js";
import { displayPair, queueNotification } from "./notifications.js";
import { createPendingManualEntry, evaluatePendingManualEntries } from "./pending-manual-entries.js";

/**
 * Automate: a per-pair server loop that watches the TrendPullbackV1 level and,
 * when the last M15 candle confirms it (rejection or liquidity sweep), either
 * alerts with an Accept/Reject plan ('alert') or places the practice order
 * itself ('auto'). Every confirmation is recorded, including skipped ones, so
 * the forward test sees them all.
 */

export type AutomationMode = "alert" | "auto";
type TickSource = (instrument: MajorInstrument) => Promise<MarketPriceTick | null>;

type AutomationRow = { id: string; user_id: string; instrument: MajorInstrument; enabled: boolean; mode: AutomationMode };

/** What the chart panel and a stored signal need; the full plan stays out of the database. */
type StoredWatch = Omit<PullbackWatch, "plan"> & {
  trend: string | null;
  levelKind: string | null;
  context?: ReturnType<typeof automationContext>;
};

export type PullbackSignal = {
  id: string;
  instrument: MajorInstrument;
  mode: AutomationMode;
  confirmation: "REJECTION" | "SWEEP";
  direction: "long" | "short";
  candleTime: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  spreadPips: number;
  status: "ALERTED" | "PLACED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "SKIPPED" | "FAILED";
  reason: string;
  pendingEntryId: string | null;
  expiresAt: string;
  createdAt: string;
};

const SIGNAL_FIELDS = `id, instrument, mode, confirmation, direction, candle_time AS "candleTime",
  entry_price::float8 AS "entryPrice", stop_price::float8 AS "stopPrice", target_price::float8 AS "targetPrice",
  spread_pips::float8 AS "spreadPips", status, reason, pending_entry_id AS "pendingEntryId", expires_at AS "expiresAt", created_at AS "createdAt"`;

function storedWatch(watch: PullbackWatch): StoredWatch {
  const { plan, ...rest } = watch;
  return { ...rest, trend: plan?.trend ?? null, levelKind: plan?.debug.pullbackLevelKind ?? null };
}

function automationContext(watch: PullbackWatch, trade: PullbackTrade, mode: AutomationMode) {
  const base = trendPullbackContext(watch.plan!);
  return {
    ...base,
    direction: trade.direction,
    setup: "trend-pullback-automate-v1",
    frozen: {
      ...base.frozen,
      automation: {
        mode, confirmation: watch.confirmation, candleTime: watch.candle?.time ?? null,
        level: watch.level, zoneFar: watch.zoneFar, spreadPips: trade.spreadPips, spreadShare: trade.spreadShare,
        planned: { entry: trade.entry, stop: trade.stop, target: trade.target, riskPips: trade.riskPips, rewardRisk: trade.rewardRisk },
      },
    },
  };
}

export async function pullbackAutomationForUser(userId: string, instrument: MajorInstrument) {
  const [automation, signals] = await Promise.all([
    query<{ enabled: boolean; mode: AutomationMode; lastWatch: StoredWatch | null; lastCheckedAt: string | null }>(
      `SELECT enabled, mode, last_watch AS "lastWatch", last_checked_at AS "lastCheckedAt"
         FROM pullback_automations WHERE user_id=$1 AND instrument=$2`,
      [userId, instrument],
    ),
    query<PullbackSignal>(
      `SELECT ${SIGNAL_FIELDS} FROM pullback_signals WHERE user_id=$1 AND instrument=$2 ORDER BY created_at DESC LIMIT 10`,
      [userId, instrument],
    ),
  ]);
  const row = automation.rows[0];
  return {
    automation: row ? { enabled: row.enabled, mode: row.mode, lastCheckedAt: row.lastCheckedAt } : { enabled: false, mode: "alert" as AutomationMode, lastCheckedAt: null },
    watch: row?.lastWatch ?? null,
    signals: signals.rows,
  };
}

export async function setPullbackAutomation(userId: string, instrument: MajorInstrument, input: { enabled: boolean; mode: AutomationMode }) {
  await query(
    `INSERT INTO pullback_automations(user_id, instrument, enabled, mode) VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id, instrument) DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode, updated_at=now()`,
    [userId, instrument, input.enabled, input.mode],
  );
}

/** News gate: fail closed for auto-placed orders; an alert only carries a warning. */
async function newsCheck(instrument: MajorInstrument) {
  try {
    const calendar = await getEconomicCalendar();
    const coverageUntil = calendar.data.coverageUntil ? Date.parse(calendar.data.coverageUntil) : Number.NaN;
    const connected = calendar.data.connected && Number.isFinite(coverageUntil) && coverageUntil - Date.now() >= 30 * 60_000;
    if (!connected) return { connected: false, minutes: null };
    return { connected: true, minutes: highImpactMinutesFor(instrument, calendar.data.events) };
  } catch {
    return { connected: false, minutes: null };
  }
}

async function recordSignal(row: AutomationRow, watch: PullbackWatch, trade: PullbackTrade, status: PullbackSignal["status"], reason: string, context: ReturnType<typeof automationContext>) {
  const expiresAt = new Date(Date.parse(watch.candleCloseTime!) + PULLBACK_WATCH.signalFreshMinutes * 60_000).toISOString();
  const inserted = await query<{ id: string }>(
    `INSERT INTO pullback_signals(user_id, instrument, mode, confirmation, direction, candle_time, entry_price, stop_price, target_price, spread_pips, status, reason, expires_at, watch)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT(user_id, instrument, candle_time) DO NOTHING RETURNING id`,
    [row.user_id, row.instrument, row.mode, watch.confirmation, trade.direction, watch.candle!.time, trade.entry, trade.stop, trade.target,
      trade.spreadPips, status, reason, expiresAt, JSON.stringify({ ...storedWatch(watch), context })],
  );
  return inserted.rows[0]?.id ?? null;
}

function tradeLine(trade: PullbackTrade) {
  return `Entry ${trade.entry}, stop ${trade.stop} (${trade.riskPips} pips), target ${trade.target} (${trade.rewardRisk}:1). Spread ${trade.spreadPips} pips = ${Math.round(trade.spreadShare * 100)}% of the stop.`;
}

async function placeFromSignal(userId: string, instrument: MajorInstrument, trade: PullbackTrade, context: unknown, tick: MarketPriceTick) {
  const entry = await createPendingManualEntry(userId, {
    instrument,
    direction: trade.direction,
    entryPrice: trade.entry,
    orderReferencePrice: trade.entry,
    stopPrice: trade.stop,
    targetPrice: trade.target,
    // A marketable stop order: if it has not filled in 15 minutes the moment is gone.
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    analysisContext: context,
  }, tick);
  // Same as a chart-created entry: check the fresh tick right away.
  void evaluatePendingManualEntries(tick).catch((error) => console.error("[automate] initial evaluation failed", error));
  return entry;
}

async function runAutomation(row: AutomationRow, tickFor: TickSource) {
  const [m15, h1, h4, pricing] = await Promise.all([
    getCandles(row.instrument, "M15", 500),
    getCandles(row.instrument, "H1", 250),
    getCandles(row.instrument, "H4", 250),
    getPricing([row.instrument]),
  ]);
  if (m15.status.state !== "connected") return;
  const watch = evaluatePullbackWatch({
    instrument: row.instrument,
    candles: m15.data.candles,
    h1Candles: h1.status.state === "connected" ? h1.data.candles : undefined,
    h4Candles: h4.status.state === "connected" ? h4.data.candles : undefined,
  });
  await query(
    "UPDATE pullback_automations SET last_watch=$2::jsonb, last_checked_at=now() WHERE id=$1",
    [row.id, JSON.stringify(storedWatch(watch))],
  );
  if (watch.state !== "CONFIRMED" || !pullbackSignalFresh(watch)) return;
  const seen = await query("SELECT 1 FROM pullback_signals WHERE user_id=$1 AND instrument=$2 AND candle_time=$3", [row.user_id, row.instrument, watch.candle!.time]);
  if (seen.rowCount) return;
  // The same level often confirms on several candles in a row; one live signal
  // per pair and direction an hour keeps that to a single alert or order.
  const recent = await query(
    `SELECT 1 FROM pullback_signals WHERE user_id=$1 AND instrument=$2 AND direction=$3
        AND status IN ('ALERTED','PLACED','ACCEPTED') AND created_at > now() - interval '60 minutes'`,
    [row.user_id, row.instrument, watch.direction],
  );
  if (recent.rowCount) return;

  const tick = await tickFor(row.instrument);
  const quote = tick ?? pricing.data[0];
  if (!quote) return;
  const trade = pullbackTradeFromWatch(watch, row.instrument, quote);
  if (!trade) return;
  const context = automationContext(watch, trade, row.mode);
  const pair = displayPair(row.instrument);
  const side = trade.direction === "long" ? "LONG" : "SHORT";
  const what = watch.confirmation === "SWEEP" ? "sweep" : "rejection";

  const news = await newsCheck(row.instrument);
  const newsBlock = news.minutes !== null && news.minutes <= 30 ? `High-impact news in ${news.minutes} min.` : null;
  const skip = trade.blocked ?? newsBlock ?? (row.mode === "auto" && !news.connected ? "Economic calendar unavailable, so no automatic order (news gate fails closed)." : null);
  if (skip) {
    await recordSignal(row, watch, trade, "SKIPPED", `${watch.reason} Skipped: ${skip}`, context);
    return;
  }

  if (row.mode === "alert") {
    const reason = `${watch.reason} ${tradeLine(trade)}${news.connected ? "" : " Calendar unavailable, check news yourself."}`;
    const id = await recordSignal(row, watch, trade, "ALERTED", reason, context);
    if (!id) return;
    await queueNotification({
      userId: row.user_id, kind: "setup_ready",
      title: `${pair} ${side} · ${what} confirmed`,
      message: `${reason} Open the chart to accept within ${PULLBACK_WATCH.signalFreshMinutes} min.`,
      instrument: row.instrument, paperTradeId: null, dedupeKey: `pullback-signal:${id}`,
    }).catch((error) => console.error(`[automate] notification failed for ${id}`, error));
    return;
  }

  if (!tick) {
    await recordSignal(row, watch, trade, "FAILED", `${watch.reason} No fresh executable quote, so no order was placed.`, context);
    return;
  }
  const id = await recordSignal(row, watch, trade, "PLACED", `${watch.reason} ${tradeLine(trade)}`, context);
  if (!id) return;
  try {
    const entry = await placeFromSignal(row.user_id, row.instrument, trade, context, tick);
    const failed = entry.status === "FAILED";
    await query(
      "UPDATE pullback_signals SET status=$2, pending_entry_id=$3, reason=CASE WHEN $4::text IS NULL THEN reason ELSE reason || ' ' || $4::text END, updated_at=now() WHERE id=$1",
      [id, failed ? "FAILED" : "PLACED", entry.id, failed ? `OANDA: ${entry.failureReason ?? "rejected"}` : null],
    );
    await queueNotification({
      userId: row.user_id, kind: "trade_update",
      title: failed ? `${pair} ${side} · automate order rejected` : `${pair} ${side} · automate placed (${what})`,
      message: failed ? entry.failureReason ?? "OANDA rejected the order." : `${watch.reason} ${tradeLine(trade)}`,
      instrument: row.instrument, paperTradeId: null, dedupeKey: `pullback-signal:${id}`,
    }).catch((error) => console.error(`[automate] notification failed for ${id}`, error));
  } catch (error) {
    // Most often: a trade or pending entry already holds this pair. Yours wins.
    const message = error instanceof Error ? error.message : "The order could not be created.";
    await query("UPDATE pullback_signals SET status='SKIPPED', reason=reason || ' Skipped: ' || $2::text, updated_at=now() WHERE id=$1", [id, message]);
  }
}

/** One pass over every enabled pair. Called from the server loop while the market is open. */
export async function runPullbackAutomations(tickFor: TickSource) {
  await query("UPDATE pullback_signals SET status='EXPIRED', updated_at=now() WHERE status='ALERTED' AND expires_at <= now()");
  const rows = await query<AutomationRow>("SELECT id, user_id, instrument, enabled, mode FROM pullback_automations WHERE enabled");
  for (const row of rows.rows) {
    try { await runAutomation(row, tickFor); }
    catch (error) { console.error(`[automate] ${row.instrument} failed`, error); }
  }
  return rows.rows.length;
}

/** Accept an alerted signal: re-price entry at the current quote, keep the wick-based stop. */
export async function acceptPullbackSignal(userId: string, id: string, tickFor: TickSource) {
  const found = await query<{ instrument: MajorInstrument; status: string; expires_at: string; watch: StoredWatch }>(
    "SELECT instrument, status, expires_at, watch FROM pullback_signals WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  const signal = found.rows[0];
  if (!signal) throw new Error("Signal not found.");
  if (signal.status !== "ALERTED") throw new Error(`This signal is already ${signal.status.toLowerCase()}.`);
  if (Date.parse(signal.expires_at) <= Date.now()) {
    await query("UPDATE pullback_signals SET status='EXPIRED', updated_at=now() WHERE id=$1", [id]);
    throw new Error("This signal has expired; the setup is no longer fresh.");
  }
  const tick = await tickFor(signal.instrument);
  if (!tick) throw new Error("A fresh market quote is not available yet.");
  const trade = pullbackTradeFromWatch({ ...signal.watch, plan: null }, signal.instrument, tick);
  if (!trade) throw new Error("Price has moved past the stop; the setup is gone.");
  if (trade.blocked) throw new Error(trade.blocked);
  const context = signal.watch.context
    ? { ...signal.watch.context, frozen: { ...signal.watch.context.frozen, automation: { ...signal.watch.context.frozen.automation, planned: { entry: trade.entry, stop: trade.stop, target: trade.target, riskPips: trade.riskPips, rewardRisk: trade.rewardRisk } } } }
    : null;
  const entry = await placeFromSignal(userId, signal.instrument, trade, context, tick);
  await query(
    "UPDATE pullback_signals SET status=$2, pending_entry_id=$3, entry_price=$4, stop_price=$5, target_price=$6, spread_pips=$7, updated_at=now() WHERE id=$1",
    [id, entry.status === "FAILED" ? "FAILED" : "ACCEPTED", entry.id, trade.entry, trade.stop, trade.target, trade.spreadPips],
  );
  return { entry, trade };
}

export async function rejectPullbackSignal(userId: string, id: string) {
  const result = await query("UPDATE pullback_signals SET status='REJECTED', updated_at=now() WHERE id=$1 AND user_id=$2 AND status='ALERTED'", [id, userId]);
  if (!result.rowCount) throw new Error("Only an open alert can be rejected.");
}
