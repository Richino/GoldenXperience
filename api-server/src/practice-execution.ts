import { query, transaction } from "./database.js";
import { OandaRequestError, closePracticeTrade, submitPracticeMarketOrder } from "../../frontend/src/lib/oanda/client.js";

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

export async function queuePracticeOrderIntent(userId: string, paperTradeId: string) {
  const policy = await practiceExecutionPolicy(userId);
  if (!policy.enabled) return false;
  const created = await query<{ id: string }>(
    `INSERT INTO practice_order_intents(user_id,paper_trade_id,request_payload)
     SELECT trade.user_id,trade.id,jsonb_build_object('instrument',trade.instrument,'direction',trade.direction,'units',trade.calculated_units,'stop',trade.stop,'target',trade.target)
     FROM paper_strategy_trades trade
     WHERE trade.id=$1 AND trade.user_id=$2 AND trade.status='open'
     ON CONFLICT(paper_trade_id) DO NOTHING
     RETURNING id`,
    [paperTradeId, userId],
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
      `SELECT intent.id,intent.user_id,intent.client_request_id,trade.instrument,trade.direction,trade.calculated_units::text AS units,trade.stop::text AS stop,trade.target::text AS target
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
  return { submitted, failed, unknown };
}

export async function closePracticeTradeForPaperTrade(paperTradeId: string) {
  const intent = await query<{ broker_trade_id: string | null; status: string }>("SELECT broker_trade_id,status FROM practice_order_intents WHERE paper_trade_id=$1", [paperTradeId]);
  const row = intent.rows[0];
  if (!row) return true;
  if (row.status !== "submitted" || !row.broker_trade_id) return false;
  const closeTransactionId = await closePracticeTrade(row.broker_trade_id);
  await query("UPDATE practice_order_intents SET broker_close_transaction_id=$2,close_requested_at=now(),updated_at=now() WHERE paper_trade_id=$1", [paperTradeId, closeTransactionId]);
  return true;
}

export async function practiceExecutionOverview(userId: string) {
  const policy = await practiceExecutionPolicy(userId);
  const counts = await query<{ pending: string; sending: string; submitted: string; failed: string; unknown: string }>(
    `SELECT count(*) FILTER(WHERE status='pending')::text AS pending,count(*) FILTER(WHERE status='sending')::text AS sending,count(*) FILTER(WHERE status='submitted')::text AS submitted,count(*) FILTER(WHERE status='failed')::text AS failed,count(*) FILTER(WHERE status='unknown')::text AS unknown
     FROM practice_order_intents WHERE user_id=$1`, [userId],
  );
  const row = counts.rows[0] ?? { pending: "0", sending: "0", submitted: "0", failed: "0", unknown: "0" };
  return { policy, intents: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) };
}
