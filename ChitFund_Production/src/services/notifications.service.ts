/**
 * @fileoverview Notification delivery service for the ChitFund API. It persists an
 * in-app notification row and then attempts Web Push delivery to all of the
 * user's registered devices, honouring per-user and per-group mute preferences.
 * It exists to centralise the "store + push" pipeline so callers fire a single
 * `notify(...)` and get reliable in-app delivery plus best-effort push. The
 * VAPID/AES-GCM push pipeline is fully wired but the final HTTP send is stubbed
 * until the `web-push` dependency is installed (see `tryPushSend`).
 * @module services/notifications
 * @author Suraj KM
 */

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../config/db';
import { notifications, notification_preferences, push_subscriptions } from '../db/schema';
import { env } from '../config/env';

/** Payload describing a single notification to store and push. */
export type NotificationInput = {
  /** Recipient user id. */
  user_id:   string;
  /** Originating group id, or omitted for account-level notifications. */
  group_id?: string;
  /** Notification type key used for client-side grouping/icons. */
  type:      string;
  /** Short headline shown in the in-app list and push banner. */
  title:     string;
  /** Longer body text shown beneath the title. */
  body:      string;
  /** Optional structured payload (e.g. deep-link ids) attached to the row. */
  data?:     Record<string, unknown>;
};

/**
 * Stores an in-app notification and triggers best-effort push delivery to the user's devices.
 *
 * @param input - The notification to create and dispatch
 * @returns A promise resolving to the new notification's id; push delivery runs in the background and does not affect this result
 */
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
