import { query } from "./database.js";
import webpush from "web-push";

export type NotificationKind = "setup_ready" | "paper_opened" | "paper_closed" | "system_issue";

export type NotificationEvent = {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  instrument: string | null;
  paperTradeId: string | null;
  readAt: string | null;
  createdAt: string;
};

type QueueNotification = Omit<NotificationEvent, "id" | "readAt" | "createdAt"> & { userId: string; dedupeKey: string };

function pushConfig() {
  const rawSubject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  // web-push requires the subject to be a mailto: or https: URL. A bare email
  // (VAPID_SUBJECT=someone@example.com) throws "Vapid subject is not a valid
  // URL" on every send, so normalise it to a mailto: link rather than letting
  // the misconfiguration break notification delivery.
  const subject = rawSubject
    ? /^(mailto:|https?:\/\/)/i.test(rawSubject)
      ? rawSubject
      : `mailto:${rawSubject}`
    : undefined;
  if (subject && publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return { publicKey, privateKey };
  }
  return null;
}

export function pushPublicKey() { return pushConfig()?.publicKey ?? null; }

export async function savePushSubscription(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await query(
    `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=now()`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
  );
}

export async function removePushSubscription(userId: string, endpoint: string) {
  await query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [userId, endpoint]);
}

export async function sendPushNotification(event: QueueNotification) {
  if (!pushConfig()) return;
  const subscriptions = await query<{ endpoint: string; p256dh: string; auth: string }>("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=$1", [event.userId]);
  const payload = JSON.stringify({ title: event.title, body: event.message, url: "/", tag: event.dedupeKey });
  await Promise.all(subscriptions.rows.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload);
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
      if (statusCode === 404 || statusCode === 410) await query("DELETE FROM push_subscriptions WHERE endpoint=$1", [subscription.endpoint]);
      else console.error("[push] delivery failed", error);
    }
  }));
}

export async function queueNotification(event: QueueNotification) {
  const result = await query<{ id: string }>(
    `INSERT INTO notification_events(user_id,kind,title,message,instrument,paper_trade_id,dedupe_key)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_id,dedupe_key) DO NOTHING
     RETURNING id`,
    [event.userId, event.kind, event.title, event.message, event.instrument, event.paperTradeId, event.dedupeKey],
  );
  if (result.rows[0]) void sendPushNotification(event).catch((error) => console.error("[push] delivery error", error));
  return Boolean(result.rows[0]);
}

export async function notificationsForUser(userId: string, after?: string | null) {
  const validAfter = after && !Number.isNaN(new Date(after).getTime()) ? after : null;
  const rows = await query<NotificationEvent>(
    `SELECT id,kind,title,message,instrument AS "instrument",paper_trade_id AS "paperTradeId",read_at AS "readAt",created_at AS "createdAt"
     FROM notification_events
     WHERE user_id=$1 ${validAfter ? "AND created_at >= $2::timestamptz" : ""}
     ORDER BY created_at DESC
     LIMIT 50`,
    validAfter ? [userId, validAfter] : [userId],
  );
  const unread = await query<{ count: string }>("SELECT count(*)::text AS count FROM notification_events WHERE user_id=$1 AND read_at IS NULL", [userId]);
  return { notifications: rows.rows, unreadCount: Number(unread.rows[0]?.count ?? 0), cursor: rows.rows[0]?.createdAt ?? validAfter ?? null };
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  if (ids?.length) {
    await query("UPDATE notification_events SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, ids]);
  } else {
    await query("UPDATE notification_events SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND read_at IS NULL", [userId]);
  }
}

export function displayPair(instrument: string) {
  return instrument.replace("_", "/");
}
