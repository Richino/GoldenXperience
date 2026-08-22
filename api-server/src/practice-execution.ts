import { query, transaction } from "./database.js";
import { OandaRequestError, closePracticeTrade, submitPracticeMarketOrder } from "../../frontend/src/lib/oanda/client.js";
import { brokerUnitsForOrder } from "../../frontend/src/lib/risk/engine.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

export type PracticeExecutionPolicy = { enabled: boolean; updatedAt: string };

async function ensurePolicy(userId: string) {
  await query("INSERT INTO practice_execution_policies(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
}

export async function practiceExecutionPolicy(userId: string): Promise<PracticeExecutionPolicy> {
  await ensurePolicy(userId);
  const result = await query<{ enabled: boolean; updatedAt: string }>("SELECT enabled,updated_at AS \"updatedAt\" FROM practice_execution_policies WHERE user_id=$1", [userId]);
  return result.rows[0] ?? { enabled: false, updatedAt: new Date(0).toISOString() };
}

export async function setPracticeExecutionEnabled(userId: string, enabled: boolean) {
  await query(
    `INSERT INTO practice_execution_policies(user_id,enabled) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
    [userId, enabled],
  );
  if (!enabled) {
    await query("UPDATE practice_order_intents SET status='disabled',updated_at=now() WHERE user_id=$1 AND status='pending'", [userId]);
  }
  return practiceExecutionPolicy(userId);
}

/**
 * The USD value of one unit of the trade's quote currency, recovered from the
 * trade itself.
 *
 * Sizing satisfies `riskAmount = units * |entry - stop| * quoteToUsdRate`, so
 * the rate the position was actually built with can be divided back out of the
 * stored columns. That is exact, and it beats re-deriving the rate from live
 * majors — a true cross would otherwise need a second instrument's price that
 * is no longer in hand by the time the order is queued.
 */
function quoteToUsdRateFromTrade(trade: { units: number; entry: number; stop: number; riskAmount: number }): number | undefined {
  const stopDistance = Math.abs(trade.entry - trade.stop);
  if (!(stopDistance > 0) || !(trade.units > 0) || !(trade.riskAmount > 0)) return undefined;
  const rate = trade.riskAmount / (trade.units * stopDistance);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export async function queuePracticeOrderIntent(userId: string, paperTradeId: string) {
  const policy = await practiceExecutionPolicy(userId);
  if (!policy.enabled) return false;
  const found = await query<{
    instrument: MajorInstrument; direction: "long" | "short";
    units: string; entry: string; stop: string; target: string;
    risk_amount: string; risk_percent: string;
  }>(
    `SELECT instrument,direction,calculated_units::text AS units,entry::text,stop::text,target::text,
            nominal_risk_amount::text AS risk_amount,nominal_risk_percent::text AS risk_percent
     FROM paper_strategy_trades WHERE id=$1 AND user_id=$2 AND status='open'`,
    [paperTradeId, userId],
  );
  const trade = found.rows[0];
  if (!trade) return false;

  const requestedUnits = Number(trade.units);
  const entry = Number(trade.entry);
  const riskAmount = Number(trade.risk_amount);
  const riskPercent = Number(trade.risk_percent);
  // The equity the position was sized against, recovered the same way.
  const accountBalance = riskPercent > 0 ? (riskAmount * 100) / riskPercent : 0;
  const sized = brokerUnitsForOrder({
    instrument: trade.instrument,
    requestedUnits,
    price: entry,
    accountBalance,
    quoteToUsdRate: quoteToUsdRateFromTrade({ units: requestedUnits, entry, stop: Number(trade.stop), riskAmount }),
  });
  if (sized.capped) {
    console.log(`[practice-execution] ${trade.instrument} order scaled ${sized.requestedUnits} -> ${sized.units} units `
      + `(notional $${Math.round(sized.notionalUsd ?? 0).toLocaleString()} within $${Math.round(sized.capUsd).toLocaleString()} cap)`);
  }

  const created = await query<{ id: string }>(
    `INSERT INTO practice_order_intents(user_id,paper_trade_id,request_payload)
     VALUES($1,$2,jsonb_build_object('instrument',$3::text,'direction',$4::text,'units',$5::bigint,'stop',$6::numeric,'target',$7::numeric,'requestedUnits',$8::bigint,'notionalCapped',$9::boolean))
     ON CONFLICT(paper_trade_id) DO NOTHING
     RETURNING id`,
    [userId, paperTradeId, trade.instrument, trade.direction, sized.units, trade.stop, trade.target, sized.requestedUnits, sized.capped],
  );
  return Boolean(created.rows[0]);
}

type PendingIntent = {
  id: string;
  user_id: string;
  client_request_id: string;
  instrument: string;
  direction: "long" | "short";
  units: string;
  stop: string;
  target: string;
};

async function claimPendingIntent(): Promise<PendingIntent | null> {
  return transaction(async (client) => {
    const pending = await client.query<PendingIntent>(
      // Units come from the intent's own payload, which is the margin-guarded
      // size. Reading trade.calculated_units here would send the uncapped
      // research position and reinstate the rejections.
      `SELECT intent.id,intent.user_id,intent.client_request_id,trade.instrument,trade.direction,COALESCE(intent.request_payload->>'units',trade.calculated_units::text) AS units,trade.stop::text AS stop,trade.target::text AS target
       FROM practice_order_intents intent
       JOIN paper_strategy_trades trade ON trade.id=intent.paper_trade_id
       JOIN practice_execution_policies policy ON policy.user_id=intent.user_id
       WHERE intent.status='pending' AND policy.enabled=true AND trade.status='open'
       ORDER BY intent.created_at
       LIMIT 1 FOR UPDATE OF intent SKIP LOCKED`,
    );
    const intent = pending.rows[0];
    if (!intent) return null;
    await client.query("UPDATE practice_order_intents SET status='sending',updated_at=now() WHERE id=$1 AND status='pending'", [intent.id]);
    return intent;
  });
}

export async function processPendingPracticeOrders() {
  let submitted = 0;
  let failed = 0;
  let unknown = 0;
  let rejected = 0;
  for (;;) {
    const intent = await claimPendingIntent();
    if (!intent) break;
    try {
      const result = await submitPracticeMarketOrder({
        instrument: intent.instrument,
        direction: intent.direction,
        units: Number(intent.units),
        stop: Number(intent.stop),
        target: Number(intent.target),
        clientRequestId: intent.client_request_id,
      });
      if (!result.orderId) throw new OandaRequestError("OANDA accepted the request without a broker order identifier.");
      // An order the broker cancelled is NOT submitted. OANDA returns 201 with
      // an orderCancelTransaction for an INSUFFICIENT_MARGIN rejection, and
      // recording that as 'submitted' claimed a position that does not exist —
      // which then deadlocked the close path, because there is no trade id to
      // close and the internal trade could never be squared. A live order
      // always yields a tradeId; anything else is a rejection.
      if (result.cancelReason || !result.tradeId) {
        await query(
          "UPDATE practice_order_intents SET status='rejected',broker_order_id=$2,failure_reason=$3,updated_at=now() WHERE id=$1",
          [intent.id, result.orderId, `Broker did not open a position (${result.cancelReason ?? "no trade opened"}).`],
        );
        rejected += 1;
        continue;
      }
      await query("UPDATE practice_order_intents SET status='submitted',broker_order_id=$2,broker_trade_id=$3,submitted_at=now(),updated_at=now() WHERE id=$1", [intent.id, result.orderId, result.tradeId]);
      submitted += 1;
    } catch (error) {
      const status = error instanceof OandaRequestError ? error.status : undefined;
      const terminal = typeof status === "number" && status >= 400 && status < 500;
      await query("UPDATE practice_order_intents SET status=$2,failure_reason=$3,updated_at=now() WHERE id=$1", [intent.id, terminal ? "failed" : "unknown", error instanceof Error ? error.message.slice(0, 500) : "Unknown practice order failure"]);
      if (terminal) failed += 1;
      else unknown += 1;
    }
  }
  return { submitted, failed, unknown, rejected };
}

/**
 * Square the broker leg of a paper trade before the internal trade closes.
 *
 * Returns true when there is nothing left open at the broker — either because
 * the close was sent, or because no position was ever opened. Only a genuinely
 * indeterminate state returns false, because a false answer holds the internal
 * trade open, and an internal trade left open freezes its instrument and its
 * whole batch indefinitely.
 */
export async function closePracticeTradeForPaperTrade(paperTradeId: string) {
  const intent = await query<{ broker_trade_id: string | null; status: string }>("SELECT broker_trade_id,status FROM practice_order_intents WHERE paper_trade_id=$1", [paperTradeId]);
  const row = intent.rows[0];
  if (!row) return true;
  // Nothing was ever opened at the broker, so there is nothing to square and
  // the internal trade must be free to close. Blocking here is what stranded
  // four instruments: a margin-rejected order left a row that could never be
  // closed and never be retried into existence.
  if (row.status === "rejected" || row.status === "failed") return true;
  if (row.status === "submitted" && !row.broker_trade_id) return true;
  if (row.status !== "submitted" || !row.broker_trade_id) return false;
  const closeTransactionId = await closePracticeTrade(row.broker_trade_id);
  await query("UPDATE practice_order_intents SET broker_close_transaction_id=$2,close_requested_at=now(),updated_at=now() WHERE paper_trade_id=$1", [paperTradeId, closeTransactionId]);
  return true;
}

export async function practiceExecutionOverview(userId: string) {
  const policy = await practiceExecutionPolicy(userId);
  const counts = await query<{ pending: string; sending: string; submitted: string; failed: string; unknown: string; rejected: string }>(
    `SELECT count(*) FILTER(WHERE status='pending')::text AS pending,count(*) FILTER(WHERE status='sending')::text AS sending,count(*) FILTER(WHERE status='submitted')::text AS submitted,count(*) FILTER(WHERE status='failed')::text AS failed,count(*) FILTER(WHERE status='unknown')::text AS unknown,count(*) FILTER(WHERE status='rejected')::text AS rejected
     FROM practice_order_intents WHERE user_id=$1`, [userId],
  );
  const row = counts.rows[0] ?? { pending: "0", sending: "0", submitted: "0", failed: "0", unknown: "0", rejected: "0" };
  return { policy, intents: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) };
}
