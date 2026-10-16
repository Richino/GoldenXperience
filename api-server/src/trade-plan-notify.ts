import { query } from "./database.js";
import { queueNotification, type NotificationKind } from "./notifications.js";

/** The plan fields a notification needs. */
export type NotifiablePlan = {
  id: string;
  user_id: string;
  plan_version: number;
  monitoring_mode: string | null;
  instrument: string;
};

export type PlanNotice = { kind?: "notify"; event: string; title: string; message: string; notificationKind: NotificationKind };

/**
 * Notify once per plan version and event: the trade_plan_notifications row
 * is the gate, so a repeated tick, a restart or a second worker never sends
 * the same alert twice. Also writes the event to the plan's history.
 */
export async function notifyOnce(plan: NotifiablePlan, notice: PlanNotice) {
  const gate = await query<{ id: string }>(
    `INSERT INTO trade_plan_notifications(plan_id,event_type,monitoring_mode) VALUES($1,$2,$3)
     ON CONFLICT(plan_id,event_type) DO NOTHING RETURNING id`,
    [plan.id, `${notice.event}:v${plan.plan_version}`, plan.monitoring_mode],
  );
  if (!gate.rows[0]) return false;
  await query(
    `INSERT INTO trade_plan_events(plan_id,user_id,plan_version,event_type,actor,reason) VALUES($1,$2,$3,$4,'monitor',$5)`,
    [plan.id, plan.user_id, plan.plan_version, notice.event, notice.message],
  );
  const dedupeKey = `trade-plan:${plan.id}:v${plan.plan_version}:${notice.event}`;
  await queueNotification({
    userId: plan.user_id, kind: notice.notificationKind, title: notice.title, message: notice.message,
    instrument: plan.instrument, paperTradeId: null, dedupeKey, url: `/chart?instrument=${plan.instrument}`,
  });
  const notification = await query<{ id: string }>("SELECT id FROM notification_events WHERE user_id=$1 AND dedupe_key=$2", [plan.user_id, dedupeKey]);
  if (notification.rows[0]) await query("UPDATE trade_plan_notifications SET notification_id=$2 WHERE id=$1", [gate.rows[0].id, notification.rows[0].id]);
  return true;
}
