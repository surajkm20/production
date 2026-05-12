// Notification delivery dispatcher.
// Inserts notification rows and attempts Web Push delivery to registered devices.
// Respects per-user, per-group mute preferences.
//
// Web Push requires VAPID signing (RFC 8030) + AES-GCM payload encryption (RFC 8291).
// This service has the full pipeline wired; the actual HTTP send is stubbed pending:
//   npm install web-push && npm install -D @types/web-push
// Then replace tryPushSend() below with:
//   webpush.setVapidDetails(`mailto:${env.VAPID_CONTACT_EMAIL}`, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
//   await webpush.sendNotification({ endpoint, keys: { p256dh: p256dh_key, auth: auth_key } }, payload);

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../config/db';
import { notifications, notification_preferences, push_subscriptions } from '../db/schema';
import { env } from '../config/env';

export type NotificationInput = {
  user_id:   string;
  group_id?: string;
  type:      string;
  title:     string;
  body:      string;
  data?:     Record<string, unknown>;
};

// Main entry point. Inserts the DB row then fires push dispatch (non-blocking).
export async function notify(input: NotificationInput): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      user_id:  input.user_id,
      group_id: input.group_id ?? null,
      type:     input.type,
      title:    input.title,
      body:     input.body,
      data:     input.data ?? null,
    })
    .returning({ id: notifications.id });

  dispatchPush(row.id, input.user_id, input.group_id, input.title, input.body).catch(() => {});

  return row.id;
}

async function dispatchPush(
  notificationId: string,
  userId:         string,
  groupId:        string | undefined,
  title:          string,
  body:           string,
): Promise<void> {
  if (await isMuted(userId, groupId)) return;

  const subs = await db
    .select({ id: push_subscriptions.id, endpoint: push_subscriptions.endpoint, p256dh_key: push_subscriptions.p256dh_key, auth_key: push_subscriptions.auth_key })
    .from(push_subscriptions)
    .where(eq(push_subscriptions.user_id, userId));

  if (subs.length === 0) return;

  const payload    = JSON.stringify({ title, body, notificationId });
  let   anySuccess = false;

  for (const sub of subs) {
    const ok = await tryPushSend(sub.endpoint, sub.p256dh_key, sub.auth_key, payload);
    if (ok) anySuccess = true;
  }

  if (anySuccess) {
    await db.update(notifications).set({ sent_via_push: true }).where(eq(notifications.id, notificationId));
  }
}

async function isMuted(userId: string, groupId?: string): Promise<boolean> {
  if (groupId) {
    const [pref] = await db
      .select({ muted: notification_preferences.muted })
      .from(notification_preferences)
      .where(and(eq(notification_preferences.user_id, userId), eq(notification_preferences.group_id, groupId)))
      .limit(1);
    if (pref) return pref.muted;
  }

  const [global] = await db
    .select({ muted: notification_preferences.muted })
    .from(notification_preferences)
    .where(and(eq(notification_preferences.user_id, userId), isNull(notification_preferences.group_id)))
    .limit(1);

  return global?.muted ?? false;
}

// Stub — replace with web-push library call (see file comment).
async function tryPushSend(
  _endpoint:   string,
  _p256dh_key: string,
  _auth_key:   string,
  _payload:    string,
): Promise<boolean> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[PUSH stub] VAPID contact: ${env.VAPID_CONTACT_EMAIL} — install web-push to enable real delivery`);
    return true;
  }
  return false;
}
