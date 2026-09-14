import { getCandles, getAccountSummary, submitPracticeEntryOrder, cancelPracticeOrder, getPracticeOrderState, getPracticeTradeState } from "../../frontend/src/lib/oanda/client.js";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import { calculatePositionSize, DEFAULT_RISK_POLICY } from "../../frontend/src/lib/risk/engine.js";
import type { MajorInstrument, MarketPriceTick } from "./market-stream-types.js";
import { query, transaction } from "./database.js";
import { displayPair, queueNotification } from "./notifications.js";

/** STOP for buy/sell-stop (break beyond), LIMIT for buy/sell-limit (pullback). */
function oandaOrderKind(entryOrderType: string): "STOP" | "LIMIT" {
  return entryOrderType.endsWith("stop") ? "STOP" : "LIMIT";
}

type ManualEntryNotification =
  | "accepted"
  | "triggered"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "failed"
  | "won"
  | "lost"
  | "breakeven";

async function notifyManualEntry(input: {
  userId: string;
  entryId: string;
  instrument: string;
  event: ManualEntryNotification;
  paperTradeId?: string | null;
  message?: string;
}) {
  const label = displayPair(input.instrument);
  const copy: Record<ManualEntryNotification, { title: string; message: string }> = {
    accepted: { title: `${label} entry accepted`, message: "Your pending entry is now being monitored." },
    triggered: { title: `${label} trade opened`, message: "Your entry was filled and the trade is now open." },
    cancelled: { title: `${label} entry cancelled`, message: "Your pending entry was cancelled." },
    expired: { title: `${label} entry expired`, message: "Your pending entry expired before it filled." },
    invalidated: { title: `${label} entry invalidated`, message: "Your pending entry was cancelled at its invalidation price." },
    failed: { title: `${label} entry needs attention`, message: "The entry triggered but the trade could not be opened." },
    won: { title: `${label} trade won`, message: "Target reached. Your trade is closed." },
    lost: { title: `${label} trade lost`, message: "Stop reached. Your trade is closed." },
    breakeven: { title: `${label} trade closed`, message: "Your trade closed at breakeven." },
  };
  const notification = copy[input.event];
  await queueNotification({
    userId: input.userId,
    kind: "trade_update",
    title: notification.title,
    message: input.message ?? notification.message,
    instrument: input.instrument,
    paperTradeId: input.paperTradeId ?? null,
    dedupeKey: `manual-entry:${input.entryId}:${input.event}`,
  }).catch((error) => console.error(`[pending-entry] notification failed for ${input.entryId}`, error));
}

/**
 * Place a manual pending entry as a real OANDA entry order, sized by risk % of
 * the account. Returns the resting broker order id, or throws with a reason.
 */
async function submitManualEntryToOanda(params: {
  clientRequestId: string;
  instrument: MajorInstrument;
  direction: PendingManualEntryDirection;
  entryOrderType: string;
  entryPrice: number;
  stop: number;
  target: number;
  gtdTime: string | null;
}) {
  const summary = await getAccountSummary();
  const balance = Number(summary.data?.balance);
  if (!Number.isFinite(balance) || balance <= 0) {
    throw new Error("OANDA account balance is unavailable, so the order could not be sized.");
  }
  const sized = calculatePositionSize({
    instrument: params.instrument,
    accountBalance: balance,
    riskPercent: DEFAULT_RISK_POLICY.riskPercent,
    entry: params.entryPrice,
    stop: params.stop,
  });
  const units = sized?.units ?? 0;
  if (!(units >= 1)) throw new Error("Risk-based position size came out below one unit; widen the stop or raise risk.");
  const result = await submitPracticeEntryOrder({
    instrument: params.instrument,
    direction: params.direction,
    kind: oandaOrderKind(params.entryOrderType),
    entryPrice: params.entryPrice,
    units,
    stop: params.stop,
    target: params.target,
    clientRequestId: params.clientRequestId,
    gtdTime: params.gtdTime,
  });
  if (result.cancelReason) throw new Error(`OANDA rejected the entry order (${result.cancelReason}).`);
  if (!result.orderId) throw new Error("OANDA accepted the request without an order identifier.");
  return { orderId: result.orderId, units, riskPercent: DEFAULT_RISK_POLICY.riskPercent };
}

export type PendingManualEntryStatus = "PENDING" | "TRIGGERING" | "TRIGGERED" | "EXPIRED" | "INVALIDATED" | "CANCELLED" | "FAILED";
export type PendingManualEntryDirection = "long" | "short";

export type PendingManualEntry = {
  id: string;
  instrument: MajorInstrument;
  direction: PendingManualEntryDirection;
  entryPrice: number;
  entryOrderType: "buy_stop" | "buy_limit" | "sell_stop" | "sell_limit";
  currentPriceAtCreation: number;
  expirationType: "none" | "time";
  expiresAt: string | null;
  invalidationPrice: number | null;
  status: PendingManualEntryStatus;
  triggerPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  paperTradeId: string | null;
  failureReason: string | null;
  triggeredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

type EntryRow = {
  id: string;
  user_id: string;
  instrument: MajorInstrument;
  direction: PendingManualEntryDirection;
  entry_price: string;
  entry_order_type: PendingManualEntry["entryOrderType"];
  current_price_at_creation: string;
  expiration_type: "none" | "time";
  expires_at: string | null;
  invalidation_price: string | null;
  invalidation_side: "above" | "below" | null;
  status: PendingManualEntryStatus;
  trigger_price: string | null;
  stop_price: string | null;
  target_price: string | null;
  paper_trade_id: string | null;
  failure_reason: string | null;
  last_observed_price: string | null;
  triggered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

const SELECT_FIELDS = `id,user_id,instrument,direction,entry_price::text,entry_order_type,
  current_price_at_creation::text,expiration_type,expires_at,invalidation_price::text,invalidation_side,
  status,trigger_price::text,stop_price::text,target_price::text,paper_trade_id,failure_reason,
  last_observed_price::text,triggered_at,cancelled_at,created_at,updated_at,metadata`;

function numberOrNull(value: string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serialize(row: EntryRow): PendingManualEntry {
  return {
    id: row.id,
    instrument: row.instrument,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    entryOrderType: row.entry_order_type,
    currentPriceAtCreation: Number(row.current_price_at_creation),
    expirationType: row.expiration_type,
    expiresAt: row.expires_at,
    invalidationPrice: numberOrNull(row.invalidation_price),
    status: row.status,
    triggerPrice: numberOrNull(row.trigger_price),
    stopPrice: numberOrNull(row.stop_price),
    targetPrice: numberOrNull(row.target_price),
    paperTradeId: row.paper_trade_id,
    failureReason: row.failure_reason,
    triggeredAt: row.triggered_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ?? {},
  };
}

function finitePrice(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function executablePrice(direction: PendingManualEntryDirection, tick: MarketPriceTick) {
  return direction === "long" ? tick.ask : tick.bid;
}

export function inferPendingOrderType(direction: PendingManualEntryDirection, entryPrice: number, currentPrice: number): PendingManualEntry["entryOrderType"] {
  if (direction === "long") return entryPrice >= currentPrice ? "buy_stop" : "buy_limit";
  return entryPrice <= currentPrice ? "sell_stop" : "sell_limit";
}

export function decidePendingManualEntryEvent(input: {
  entryOrderType: PendingManualEntry["entryOrderType"];
  entryPrice: number;
  invalidationPrice: number | null;
  invalidationSide: "above" | "below" | null;
  previousPrice: number;
  currentPrice: number;
  expiresAt: string | null;
  tickTime: Date;
}): "expired" | "entry" | "invalidation" | null {
  if (input.expiresAt && Date.parse(input.expiresAt) <= input.tickTime.getTime()) return "expired";
  const entryHit = input.entryOrderType === "buy_stop" || input.entryOrderType === "sell_limit"
    ? input.currentPrice >= input.entryPrice
    : input.currentPrice <= input.entryPrice;
  const invalidationHit = input.invalidationPrice !== null && input.invalidationSide !== null
    ? input.invalidationSide === "above"
      ? input.currentPrice >= input.invalidationPrice
      : input.currentPrice <= input.invalidationPrice
    : false;
  if (entryHit && invalidationHit) {
    const entryProgress = crossingProgress(input.previousPrice, input.currentPrice, input.entryPrice);
    const invalidationProgress = crossingProgress(input.previousPrice, input.currentPrice, input.invalidationPrice!);
    return entryProgress <= invalidationProgress ? "entry" : "invalidation";
  }
  if (entryHit) return "entry";
  if (invalidationHit) return "invalidation";
  return null;
}

function invalidationSide(invalidationPrice: number, currentPrice: number) {
  return invalidationPrice > currentPrice ? "above" as const : "below" as const;
}

function validateTick(tick: MarketPriceTick) {
  if (tick.source !== "oanda") throw new Error("A live OANDA quote is required for a pending entry.");
  const tickTime = Date.parse(tick.time);
  if (!Number.isFinite(tickTime) || Date.now() - tickTime > 30_000) throw new Error("The market price is stale. Wait for a fresh OANDA quote.");
  if (!(tick.bid > 0) || !(tick.ask > 0) || tick.ask < tick.bid) throw new Error("The executable OANDA quote is invalid.");
}

function parseExpiresAt(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Choose a valid expiration.");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error("Expiration must be in the future.");
  if (timestamp > Date.now() + 30 * 24 * 60 * 60_000) throw new Error("Expiration cannot be more than 30 days away.");
  return new Date(timestamp).toISOString();
}

function optionalTradeLevels(payload: Record<string, unknown>, direction: PendingManualEntryDirection, entryPrice: number) {
  const rawStop = payload.stopPrice;
  const rawTarget = payload.targetPrice;
  const stop = rawStop === null || rawStop === undefined || rawStop === "" ? null : finitePrice(rawStop);
  const target = rawTarget === null || rawTarget === undefined || rawTarget === "" ? null : finitePrice(rawTarget);
  if ((rawStop !== null && rawStop !== undefined && rawStop !== "" && stop === null) || (rawTarget !== null && rawTarget !== undefined && rawTarget !== "" && target === null)) {
    throw new Error("Enter valid stop and target prices.");
  }
  if ((stop === null) !== (target === null)) throw new Error("Enter both stop and target, or leave both blank.");
  if (stop === null || target === null) return { stop: null, target: null };
  const valid = direction === "long"
    ? stop < entryPrice && target > entryPrice
    : stop > entryPrice && target < entryPrice;
  if (!valid) throw new Error("Stop and target must be on the correct side of entry.");
  return { stop, target };
}

export async function pendingManualEntriesForUser(userId: string, instrument?: string) {
  const values: unknown[] = [userId];
  const instrumentClause = instrument ? " AND instrument=$2" : "";
  if (instrument) values.push(instrument);
  const result = await query<EntryRow>(
    `SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE user_id=$1${instrumentClause} ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(serialize);
}

export async function expirePendingManualEntries(userId?: string) {
  const values: unknown[] = [];
  const userClause = userId ? " AND user_id=$1" : "";
  if (userId) values.push(userId);
  const result = await query(
    `UPDATE pending_manual_entries SET status='EXPIRED',updated_at=now()
     WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at<=now()${userClause}`,
    values,
  );
  return result.rowCount;
}

export async function createPendingManualEntry(userId: string, payload: Record<string, unknown>, tick: MarketPriceTick) {
  validateTick(tick);
  const direction = payload.direction === "long" || payload.direction === "short" ? payload.direction : null;
  if (!direction) throw new Error("Choose LONG or SHORT.");
  if (payload.instrument !== tick.instrument) throw new Error("The selected instrument does not match the live quote.");
  const entryPrice = finitePrice(payload.entryPrice);
  if (entryPrice === null) throw new Error("Enter a valid entry price.");
  const currentPrice = executablePrice(direction, tick);
  const orderReferencePrice = finitePrice(payload.orderReferencePrice) ?? currentPrice;
  const levels = optionalTradeLevels(payload, direction, entryPrice);
  const expiresAt = parseExpiresAt(payload.expiresAt);
  const invalidationPrice = payload.invalidationPrice === null || payload.invalidationPrice === undefined || payload.invalidationPrice === ""
    ? null : finitePrice(payload.invalidationPrice);
  if (payload.invalidationPrice !== null && payload.invalidationPrice !== undefined && payload.invalidationPrice !== "" && invalidationPrice === null) {
    throw new Error("Enter a valid cancellation price.");
  }
  if (invalidationPrice !== null && Math.abs(invalidationPrice - currentPrice) < Number.EPSILON) {
    throw new Error("The cancellation price is already reached.");
  }
  if (invalidationPrice !== null && Math.abs(invalidationPrice - entryPrice) < Number.EPSILON) {
    throw new Error("Entry and cancellation prices must be different.");
  }
  // Concrete stop/target are resolved now so the broker order can carry the
  // stop-loss and take-profit. Use the user's own levels when supplied; else an
  // H1 ATR14 1R stop with a 1:2 target.
  const risk = levels.stop !== null && levels.target !== null
    ? { stop: levels.stop, target: levels.target, model: "MANUAL_LEVELS" as const }
    : await calculateManualTradeRisk(tick.instrument, direction, entryPrice);
  const result = await query<EntryRow>(
    `INSERT INTO pending_manual_entries(
       user_id,instrument,direction,entry_price,entry_order_type,current_price_at_creation,
       expiration_type,expires_at,invalidation_price,invalidation_side,last_observed_price,last_observed_at,stop_price,target_price,metadata
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,jsonb_build_object('priceSource',$15::text,'createdFrom','chart','orderReferencePrice',$11::numeric))
     RETURNING ${SELECT_FIELDS}`,
    [userId, tick.instrument, direction, entryPrice, inferPendingOrderType(direction, entryPrice, orderReferencePrice), currentPrice,
      expiresAt ? "time" : "none", expiresAt, invalidationPrice,
      invalidationPrice === null ? null : invalidationSide(invalidationPrice, orderReferencePrice), orderReferencePrice, tick.time, risk.stop, risk.target, tick.source],
  );
  const entryRow = result.rows[0]!;
  // Submit the real (practice-only) OANDA entry order. On rejection the entry is
  // recorded as FAILED with the reason so the user sees why nothing rests at the
  // broker, rather than a silent paper-only fill.
  try {
    const broker = await submitManualEntryToOanda({
      clientRequestId: entryRow.id,
      instrument: tick.instrument,
      direction,
      entryOrderType: entryRow.entry_order_type,
      entryPrice,
      stop: risk.stop,
      target: risk.target,
      gtdTime: expiresAt ? new Date(expiresAt).toISOString() : null,
    });
    const updated = await query<EntryRow>(
      `UPDATE pending_manual_entries SET metadata = metadata || $2::jsonb, updated_at=now()
        WHERE id=$1 RETURNING ${SELECT_FIELDS}`,
      [entryRow.id, JSON.stringify({ execution: "oanda_entry_order", brokerOrderId: broker.orderId, units: broker.units, riskPercent: broker.riskPercent, riskModel: risk.model })],
    );
    return serialize(updated.rows[0] ?? entryRow);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "OANDA submission failed.";
    const failed = await query<EntryRow>(
      `UPDATE pending_manual_entries SET status='FAILED', failure_reason=$2,
              metadata = metadata || '{"execution":"oanda_rejected"}'::jsonb, updated_at=now()
        WHERE id=$1 AND status='PENDING' RETURNING ${SELECT_FIELDS}`,
      [entryRow.id, reason],
    );
    return serialize(failed.rows[0] ?? entryRow);
  }
}

export async function editPendingManualEntry(userId: string, id: string, payload: Record<string, unknown>, tick: MarketPriceTick) {
  validateTick(tick);
  return transaction(async (client) => {
    const found = await client.query<EntryRow>(`SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    const existing = found.rows[0];
    if (!existing) throw new Error("Pending entry not found.");
    if (existing.status !== "PENDING") throw new Error("Only a pending entry can be edited.");
    if (existing.instrument !== tick.instrument) throw new Error("No fresh quote is available for this entry.");
    const direction = payload.direction === "long" || payload.direction === "short" ? payload.direction : existing.direction;
    const entryPrice = finitePrice(payload.entryPrice ?? existing.entry_price);
    if (entryPrice === null) throw new Error("Enter a valid entry price.");
    const currentPrice = executablePrice(direction, tick);
    const orderReferencePrice = finitePrice(payload.orderReferencePrice) ?? currentPrice;
    const levels = optionalTradeLevels(payload, direction, entryPrice);
    const expiresAt = parseExpiresAt(payload.expiresAt);
    const rawInvalidation = payload.invalidationPrice;
    const invalidationPrice = rawInvalidation === null || rawInvalidation === undefined || rawInvalidation === "" ? null : finitePrice(rawInvalidation);
    if (rawInvalidation !== null && rawInvalidation !== undefined && rawInvalidation !== "" && invalidationPrice === null) throw new Error("Enter a valid cancellation price.");
    if (invalidationPrice !== null && (invalidationPrice === currentPrice || invalidationPrice === entryPrice)) throw new Error("Cancellation must differ from the current and entry prices.");
    const updated = await client.query<EntryRow>(
      `UPDATE pending_manual_entries SET direction=$3,entry_price=$4,entry_order_type=$5,
         expiration_type=$6,expires_at=$7,invalidation_price=$8,invalidation_side=$9,
         last_observed_price=$10,last_observed_at=$11,stop_price=$12,target_price=$13,updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status='PENDING' RETURNING ${SELECT_FIELDS}`,
      [id, userId, direction, entryPrice, inferPendingOrderType(direction, entryPrice, orderReferencePrice), expiresAt ? "time" : "none", expiresAt,
        invalidationPrice, invalidationPrice === null ? null : invalidationSide(invalidationPrice, orderReferencePrice), orderReferencePrice, tick.time, levels.stop, levels.target],
    );
    return serialize(updated.rows[0]!);
  });
}

function brokerOrderIdOf(row: EntryRow): string | null {
  const meta = row.metadata as Record<string, unknown> | null | undefined;
  const id = meta && typeof meta === "object" ? meta.brokerOrderId : null;
  return typeof id === "string" && id ? id : null;
}

export async function cancelPendingManualEntry(userId: string, id: string) {
  const found = await query<EntryRow>(
    `SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE id=$1 AND user_id=$2 AND status='PENDING'`,
    [id, userId],
  );
  const entry = found.rows[0];
  if (!entry) throw new Error("The entry already changed state and cannot be cancelled.");
  const brokerOrderId = brokerOrderIdOf(entry);
  if (brokerOrderId) {
    // Cancel the resting OANDA order. If the broker already removed it (filled
    // or expired), don't trap the local entry — proceed to cancel it here too.
    try {
      await cancelPracticeOrder(brokerOrderId);
    } catch (error) {
      console.error(`[pending-entry] ${id} broker order cancel failed`, error);
    }
  }
  const result = await query<EntryRow>(
    `UPDATE pending_manual_entries SET status='CANCELLED',cancelled_at=now(),updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status='PENDING' RETURNING ${SELECT_FIELDS}`,
    [id, userId],
  );
  if (!result.rows[0]) throw new Error("The entry already changed state and cannot be cancelled.");
  const cancelled = serialize(result.rows[0]);
  await notifyManualEntry({
    userId,
    entryId: cancelled.id,
    instrument: cancelled.instrument,
    event: "cancelled",
  });
  return cancelled;
}

function crossingProgress(previous: number, current: number, level: number) {
  if (previous === current) return 0;
  const progress = (level - previous) / (current - previous);
  return progress >= 0 && progress <= 1 ? progress : 0;
}

export async function calculateManualTradeRisk(instrument: MajorInstrument, direction: PendingManualEntryDirection, entry: number) {
  const candles = await getCandles(instrument as never, "H1", 64);
  if (candles.status.state !== "connected") throw new Error("OANDA H1 candles are unavailable for stop calculation.");
  const complete = candles.data.candles.filter((candle) => candle.complete);
  const atr = calculateAtrValues(complete, 14).at(-1);
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) throw new Error("A trustworthy H1 ATR14 stop could not be calculated.");
  const precision = precisionFor(instrument);
  const rounded = (value: number) => Number(value.toFixed(precision));
  const stop = rounded(direction === "long" ? entry - atr : entry + atr);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) throw new Error("The calculated stop distance is invalid.");
  const target = rounded(direction === "long" ? entry + 2 * risk : entry - 2 * risk);
  return { stop, target, atr14: atr, rewardRisk: 2, model: "H1_ATR14_1R" };
}

async function finalizeTriggeredEntry(id: string) {
  try {
    const found = await query<EntryRow>(`SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE id=$1 AND status='TRIGGERING'`, [id]);
    const entry = found.rows[0];
    if (!entry || entry.trigger_price === null) return;
    const triggerPrice = Number(entry.trigger_price);
    const storedStop = numberOrNull(entry.stop_price);
    const storedTarget = numberOrNull(entry.target_price);
    const hasStoredLevels = storedStop !== null && storedTarget !== null && (entry.direction === "long"
      ? storedStop < triggerPrice && storedTarget > triggerPrice
      : storedStop > triggerPrice && storedTarget < triggerPrice);
    const risk = hasStoredLevels
      ? { stop: storedStop!, target: storedTarget!, atr14: null, rewardRisk: Math.abs(storedTarget! - triggerPrice) / Math.abs(triggerPrice - storedStop!), model: "MANUAL_LEVELS" }
      : await calculateManualTradeRisk(entry.instrument, entry.direction, triggerPrice);
    const triggered = await transaction(async (client) => {
      const locked = await client.query<EntryRow>(`SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE id=$1 FOR UPDATE`, [id]);
      if (locked.rows[0]?.status !== "TRIGGERING") return null;
      const trade = await client.query<{ id: string }>(
        `INSERT INTO paper_trades(user_id,legacy_id,origin,pair,direction,status,result,opened_at,entry,stop,target,reason,notes)
         VALUES($1,$2,'manual',$3,$4,'open','open',$5,$6,$7,$8,'Pending manual entry triggered',$9)
         ON CONFLICT(user_id,legacy_id) DO UPDATE SET updated_at=paper_trades.updated_at RETURNING id`,
        [entry.user_id, `pending-entry:${entry.id}`, entry.instrument.replace("_", "/"), entry.direction, entry.triggered_at,
          triggerPrice, risk.stop, risk.target, `Backend OANDA-price trigger. Risk model ${risk.model}; 1:2 R:R. Broker execution not submitted.`],
      );
      await client.query(
        `UPDATE pending_manual_entries SET status='TRIGGERED',stop_price=$2,target_price=$3,paper_trade_id=$4,
           metadata=metadata || $5::jsonb,updated_at=now() WHERE id=$1 AND status='TRIGGERING'`,
        [id, risk.stop, risk.target, trade.rows[0]!.id, JSON.stringify({ riskModel: risk.model, atr14: risk.atr14, rewardRisk: 2, execution: "simulated_paper" })],
      );
      return trade.rows[0]!.id;
    });
    if (triggered) {
      await notifyManualEntry({
        userId: entry.user_id,
        entryId: entry.id,
        instrument: entry.instrument,
        event: "triggered",
        paperTradeId: triggered,
      });
    }
  } catch (error) {
    console.error(`[pending-entry] ${id} finalization failed`, error);
    await query(
      "UPDATE pending_manual_entries SET status='FAILED',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='TRIGGERING'",
      [id, error instanceof Error ? error.message.slice(0, 500) : "Pending-entry trigger failed."],
    );
    const failed = await query<{ user_id: string; instrument: MajorInstrument }>(
      "SELECT user_id,instrument FROM pending_manual_entries WHERE id=$1",
      [id],
    );
    if (failed.rows[0]) {
      await notifyManualEntry({
        userId: failed.rows[0].user_id,
        entryId: id,
        instrument: failed.rows[0].instrument,
        event: "failed",
      });
    }
  }
}

export async function evaluatePendingManualEntries(tick: MarketPriceTick) {
  if (!(tick.bid > 0) || !(tick.ask > 0)) return { changed: 0 };
  const { claimed, toCancel, terminal } = await transaction(async (client) => {
    const pending = await client.query<EntryRow>(
      `SELECT ${SELECT_FIELDS} FROM pending_manual_entries
       WHERE instrument=$1 AND status='PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED`,
      [tick.instrument],
    );
    const claimed: string[] = [];
    // Broker order ids to cancel after the transaction — never call OANDA while
    // holding row locks.
    const toCancel: string[] = [];
    const terminal: Array<{ entry: EntryRow; event: "expired" | "invalidated" }> = [];
    const tickTime = Number.isFinite(Date.parse(tick.time)) ? new Date(tick.time) : new Date();
    for (const row of pending.rows) {
      const price = executablePrice(row.direction, tick);
      // An OANDA-backed entry: the broker owns the trigger, fill, SL and TP, so
      // this monitor must NOT open a paper trade for it. It still watches the
      // user's "cancel if price reaches" and expiry to pull the resting order.
      const brokerOrderId = brokerOrderIdOf(row);
      const event = decidePendingManualEntryEvent({
        entryOrderType: row.entry_order_type,
        entryPrice: Number(row.entry_price),
        invalidationPrice: numberOrNull(row.invalidation_price),
        invalidationSide: row.invalidation_side,
        previousPrice: Number(row.last_observed_price ?? row.current_price_at_creation),
        currentPrice: price,
        expiresAt: row.expires_at,
        tickTime,
      });
      if (event === "expired") {
        await client.query("UPDATE pending_manual_entries SET status='EXPIRED',updated_at=now(),last_observed_price=$2,last_observed_at=$3 WHERE id=$1 AND status='PENDING'", [row.id, price, tickTime]);
        if (brokerOrderId) toCancel.push(brokerOrderId);
        terminal.push({ entry: row, event: "expired" });
        continue;
      }
      if (event === "invalidation") {
        await client.query("UPDATE pending_manual_entries SET status='INVALIDATED',cancelled_at=$2,last_observed_price=$3,last_observed_at=$2,updated_at=now() WHERE id=$1 AND status='PENDING'", [row.id, tickTime, price]);
        if (brokerOrderId) toCancel.push(brokerOrderId);
        terminal.push({ entry: row, event: "invalidated" });
      } else if (event === "entry" && !brokerOrderId) {
        const updated = await client.query("UPDATE pending_manual_entries SET status='TRIGGERING',trigger_price=$2,triggered_at=$3,last_observed_price=$2,last_observed_at=$3,updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING id", [row.id, price, tickTime]);
        if (updated.rows[0]) claimed.push(row.id);
      } else {
        // Either a plain "hold", or an OANDA-backed entry whose level was hit —
        // the broker fills that one, so only record the observation here.
        await client.query("UPDATE pending_manual_entries SET last_observed_price=$2,last_observed_at=$3,updated_at=now() WHERE id=$1 AND status='PENDING'", [row.id, price, tickTime]);
      }
    }
    return { claimed, toCancel, terminal };
  });
  for (const item of terminal) {
    await notifyManualEntry({
      userId: item.entry.user_id,
      entryId: item.entry.id,
      instrument: item.entry.instrument,
      event: item.event,
    });
  }
  for (const orderId of toCancel) {
    try {
      await cancelPracticeOrder(orderId);
    } catch (error) {
      console.error(`[pending-entry] broker order ${orderId} cancel failed`, error);
    }
  }
  for (const id of claimed) await finalizeTriggeredEntry(id);
  return { changed: claimed.length + toCancel.length };
}

/** Resume entries claimed immediately before a process restart. */
export async function recoverTriggeringManualEntries() {
  const rows = await query<{ id: string }>("SELECT id FROM pending_manual_entries WHERE status='TRIGGERING' ORDER BY updated_at");
  for (const row of rows.rows) await finalizeTriggeredEntry(row.id);
  return rows.rowCount;
}

/**
 * Close an open manual trade once price reaches its stop or target. Manual
 * trades are opened by finalizeTriggeredEntry but were never resolved, so they
 * hung on "open" forever with no result. This marks the outcome from the level
 * that was hit (paper fill at the level), giving a definite win/loss and R.
 * OANDA-backed trades let the broker's own SL/TP square the position; this
 * covers the paper trades that have no broker leg.
 */
export async function resolveOpenManualTrades(tick: MarketPriceTick) {
  if (!(tick.bid > 0) || !(tick.ask > 0)) return { closed: 0 };
  const pair = tick.instrument.replace("_", "/");
  const closed = await transaction(async (client) => {
    // OANDA-backed trades (their entry carries a brokerTradeId) are squared by
    // the broker's own SL/TP and mirrored back by reconcileManualOandaOrders —
    // this paper resolver only closes trades that have no broker leg.
    const open = await client.query<{ id: string; user_id: string; direction: PendingManualEntryDirection; entry: string; stop: string; target: string }>(
      `SELECT t.id, t.user_id, t.direction, t.entry::text AS entry, t.stop::text AS stop, t.target::text AS target
         FROM paper_trades t
         LEFT JOIN pending_manual_entries e ON e.paper_trade_id = t.id
        WHERE t.origin='manual' AND t.status='open' AND t.pair=$1
          AND t.entry IS NOT NULL AND t.stop IS NOT NULL AND t.target IS NOT NULL
          AND (e.metadata->>'brokerTradeId') IS NULL
        FOR UPDATE OF t SKIP LOCKED`,
      [pair],
    );
    const events: Array<{ id: string; userId: string; result: "win" | "loss" }> = [];
    for (const row of open.rows) {
      const entry = Number(row.entry), stop = Number(row.stop), target = Number(row.target);
      // Exit at the price you could actually close on: bid for a long, ask for a short.
      const exitQuote = row.direction === "long" ? tick.bid : tick.ask;
      let hit: { exit: number; result: "win" | "loss" } | null = null;
      if (row.direction === "long") {
        if (exitQuote <= stop) hit = { exit: stop, result: "loss" };
        else if (exitQuote >= target) hit = { exit: target, result: "win" };
      } else {
        if (exitQuote >= stop) hit = { exit: stop, result: "loss" };
        else if (exitQuote <= target) hit = { exit: target, result: "win" };
      }
      if (!hit) continue;
      const risk = Math.abs(entry - stop);
      const reward = row.direction === "long" ? hit.exit - entry : entry - hit.exit;
      const resultR = risk > 0 ? Number((reward / risk).toFixed(4)) : 0;
      await client.query(
        `UPDATE paper_trades SET status='closed', result=$2, exit=$3, result_r=$4, closed_at=now(), updated_at=now()
          WHERE id=$1 AND status='open'`,
        [row.id, hit.result, hit.exit, resultR],
      );
      events.push({ id: row.id, userId: row.user_id, result: hit.result });
    }
    return events;
  });
  for (const event of closed) {
    await notifyManualEntry({
      userId: event.userId,
      entryId: event.id,
      instrument: tick.instrument,
      event: event.result === "win" ? "won" : "lost",
      paperTradeId: event.id,
    });
  }
  return { closed: closed.length };
}

/** Open the app-side trade for a manual OANDA order that just filled. */
async function openFilledManualTrade(entry: EntryRow, brokerTradeId: string, fillPrice: number | null) {
  const state = await getPracticeTradeState(brokerTradeId).catch(() => null);
  const openPrice = state?.entryPrice ?? fillPrice ?? Number(entry.entry_price);
  const stop = numberOrNull(entry.stop_price) ?? openPrice;
  const target = numberOrNull(entry.target_price) ?? openPrice;
  const opened = await transaction(async (client) => {
    const locked = await client.query<EntryRow>(`SELECT ${SELECT_FIELDS} FROM pending_manual_entries WHERE id=$1 FOR UPDATE`, [entry.id]);
    if (locked.rows[0]?.status !== "PENDING") return null;
    const trade = await client.query<{ id: string }>(
      `INSERT INTO paper_trades(user_id,legacy_id,origin,pair,direction,status,result,opened_at,entry,stop,target,reason,notes)
       VALUES($1,$2,'manual',$3,$4,'open','open',now(),$5,$6,$7,'Manual OANDA order filled',$8)
       ON CONFLICT(user_id,legacy_id) DO UPDATE SET updated_at=paper_trades.updated_at RETURNING id`,
      [entry.user_id, `pending-entry:${entry.id}`, entry.instrument.replace("_", "/"), entry.direction,
        openPrice, stop, target, `Filled from OANDA order; broker trade ${brokerTradeId} @ ${openPrice}.`],
    );
    await client.query(
      `UPDATE pending_manual_entries
          SET status='TRIGGERED', trigger_price=$2, triggered_at=now(), paper_trade_id=$3,
              metadata = metadata || jsonb_build_object('brokerTradeId', $4::text, 'execution', 'oanda_filled'),
              updated_at=now()
        WHERE id=$1 AND status='PENDING'`,
      [entry.id, openPrice, trade.rows[0]!.id, brokerTradeId],
    );
    return trade.rows[0]!.id;
  });
  if (opened) {
    await notifyManualEntry({
      userId: entry.user_id,
      entryId: entry.id,
      instrument: entry.instrument,
      event: "triggered",
      paperTradeId: opened,
    });
  }
}

/**
 * Mirror manual OANDA orders back into the app: a resting order that filled
 * becomes an open trade (so it shows in the app with the broker's live P&L), a
 * cancelled/expired order closes the entry, and a broker position that has since
 * closed squares the app trade. Runs on a short interval from the server.
 */
export async function reconcileManualOandaOrders() {
  let filled = 0, cancelled = 0, closedTrades = 0;

  // 1) Resting orders → detect fill or cancellation.
  const resting = await query<EntryRow>(
    `SELECT ${SELECT_FIELDS} FROM pending_manual_entries
      WHERE status='PENDING' AND metadata->>'brokerOrderId' IS NOT NULL`,
  );
  for (const entry of resting.rows) {
    const orderId = brokerOrderIdOf(entry);
    if (!orderId) continue;
    try {
      const state = await getPracticeOrderState(orderId);
      if (!state) continue;
      if (state.state === "FILLED" && state.tradeId) {
        await openFilledManualTrade(entry, state.tradeId, state.fillPrice);
        filled += 1;
      } else if (state.state === "CANCELLED") {
        const cancelledEntry = await query<{ id: string }>(
          "UPDATE pending_manual_entries SET status='CANCELLED',cancelled_at=now(),updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING id",
          [entry.id],
        );
        if (cancelledEntry.rows[0]) {
          cancelled += 1;
          await notifyManualEntry({
            userId: entry.user_id,
            entryId: entry.id,
            instrument: entry.instrument,
            event: "cancelled",
          });
        }
      }
    } catch (error) {
      console.error(`[pending-entry] reconcile order ${orderId} failed`, error);
    }
  }

  // 2) Open trades with a broker leg → square the app trade once OANDA closes it.
  const open = await query<{ id: string; user_id: string; pair: string; direction: PendingManualEntryDirection; entry: string; broker_trade_id: string }>(
    `SELECT t.id, t.user_id, t.pair, t.direction, t.entry::text AS entry, e.metadata->>'brokerTradeId' AS broker_trade_id
       FROM paper_trades t
       JOIN pending_manual_entries e ON e.paper_trade_id = t.id
      WHERE t.origin='manual' AND t.status='open' AND e.metadata->>'brokerTradeId' IS NOT NULL`,
  );
  for (const row of open.rows) {
    try {
      const state = await getPracticeTradeState(row.broker_trade_id);
      if (!state?.closed) continue;
      const entry = Number(row.entry);
      const exit = state.averageClosePrice ?? entry;
      const pl = state.realizedPL ?? 0;
      const result = pl > 0 ? "win" : pl < 0 ? "loss" : "breakeven";
      const updated = await query<{ id: string }>(
        `UPDATE paper_trades SET status='closed', result=$2, exit=$3, closed_at=$4, updated_at=now()
          WHERE id=$1 AND status='open' RETURNING id`,
        [row.id, result, exit, state.closeTime ?? new Date().toISOString()],
      );
      if (updated.rows[0]) {
        closedTrades += 1;
        await notifyManualEntry({
          userId: row.user_id,
          entryId: row.id,
          instrument: row.pair.replace("/", "_"),
          event: result === "win" ? "won" : result === "loss" ? "lost" : "breakeven",
          paperTradeId: row.id,
        });
      }
    } catch (error) {
      console.error(`[pending-entry] reconcile trade ${row.broker_trade_id} failed`, error);
    }
  }

  return { filled, cancelled, closedTrades };
}
