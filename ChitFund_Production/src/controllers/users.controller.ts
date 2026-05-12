// Handles HTTP layer for /me endpoints: profile reads/updates, session listing,
// notification inbox, notification preferences, and push subscription management.
// Reads req.user (set by authenticate middleware) to scope all queries to the caller.

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { eq, and, isNull, ne, gt, lt, desc, inArray, count } from 'drizzle-orm';
import { db } from '../config/db';
import { users, refresh_tokens, notifications, notification_preferences, push_subscriptions } from '../db/schema';
import { AppError } from '../utils/AppError';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { encodeCursor, decodeCursor } from '../utils/pagination';
import bcrypt from 'bcryptjs';

// ─── GET /me ─────────────────────────────────────────────────────────────────
// Pattern every controller follows:
//   1. Pull what you need from req (user, params, body)
//   2. Query the DB — select only the columns the client needs
//   3. Guard: throw AppError if something is wrong
//   4. Send response with sendSuccess / sendCreated / sendNoContent
export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;

    const [user] = await db
      .select({
        // Explicitly list safe columns — this prevents accidentally leaking
        // password_hash or deleted_at if we ever add new sensitive columns to the table.
        user_id:         users.id,
        name:            users.name,
        mobile_number:   users.mobile_number,
        username:        users.username,
        mobile_verified: users.mobile_verified,
        created_at:      users.created_at,
      })
      .from(users)
      // isNull(deleted_at) is the soft-delete guard — rows with a deleted_at timestamp
      // are "deleted" in our system even though they still exist in the DB.
      .where(and(eq(users.id, userId), isNull(users.deleted_at)))
      .limit(1);

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    sendSuccess(res, user);
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /me ───────────────────────────────────────────────────────────────
// Update the caller's own name and/or username. Both fields are optional;
// at least one must be provided, otherwise there's nothing to do.
export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { name, username } = req.body as { name?: string; username?: string };

    if (!name && !username) {
      throw new AppError(400, 'INVALID_REQUEST', 'At least one of name or username must be provided.');
    }

    if (username) {
      // We check uniqueness only when the caller is actually changing/setting a username.
      // ne(users.id, userId) excludes the caller's own row — without this, sending your
      // current username would wrongly fail with USERNAME_TAKEN.
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, username), ne(users.id, userId), isNull(users.deleted_at)))
        .limit(1);

      if (taken) throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken.');
    }

    const [updatedUser] = await db
      .update(users)
      .set({
        // Spread only the fields that were actually sent — omitting a field from the
        // spread means Drizzle won't include it in the SQL SET clause at all,
        // so unchanged columns are untouched.
        ...(name     ? { name }     : {}),
        ...(username ? { username } : {}),
        updated_at: new Date(),
      })
      .where(and(eq(users.id, userId), isNull(users.deleted_at)))
      // .returning() sends back the updated row in the same query — no second SELECT needed.
      .returning({
        user_id:         users.id,
        name:            users.name,
        mobile_number:   users.mobile_number,
        username:        users.username,
        mobile_verified: users.mobile_verified,
        created_at:      users.created_at,
      });

    if (!updatedUser) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    sendSuccess(res, updatedUser);
  } catch (err) {
    next(err);
  }
}

// ─── POST /me/change-password ─────────────────────────────────────────────────
// Verify the caller's current password first, then replace it with a new hash.
// Returns 204 (no body) on success — there's nothing meaningful to return here.
export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { current_password, new_password } = req.body as { current_password: string; new_password: string };

    if (!current_password || !new_password) {
      throw new AppError(400, 'INVALID_REQUEST', 'Both current_password and new_password are required.');
    }

    // We re-fetch the user here to get password_hash. req.user only carries userId and jti —
    // we never put sensitive fields like password_hash into the JWT or req.user object.
    const [user] = await db
      .select({ id: users.id, password_hash: users.password_hash })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deleted_at)))
      .limit(1);

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    // bcrypt.compare is timing-safe: it always takes roughly the same time whether the
    // password matches or not, preventing timing-based brute-force attacks.
    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');

    // Salt rounds = 10: bcrypt deliberately runs many iterations to make hashing slow,
    // so even if the DB leaks, cracking the hashes takes a very long time.
    const newHash = await bcrypt.hash(new_password, 10);
    await db
      .update(users)
      .set({ password_hash: newHash, updated_at: new Date() })
      .where(eq(users.id, userId));

    sendNoContent(res);
  } catch (err) {
    next(err);
  }
}

// ─── GET /me/sessions ─────────────────────────────────────────────────────────
// List all active sessions (devices) for the current user.
// "Active" means: not explicitly revoked AND not past the expiry date.
export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const now    = new Date();

    // jti from the current access token — used to mark which session row is "this device".
    const currentJti = req.user!.jti;

    const rows = await db
      .select({
        id:           refresh_tokens.id,
        session_id:   refresh_tokens.session_id,
        device_info:  refresh_tokens.device_info,
        created_at:   refresh_tokens.created_at,
        last_used_at: refresh_tokens.last_used_at,
      })
      .from(refresh_tokens)
      .where(
        and(
          eq(refresh_tokens.user_id, userId),
          isNull(refresh_tokens.revoked_at),   // skip explicitly logged-out sessions
          gt(refresh_tokens.expires_at, now),  // skip sessions past their 30-day lifetime
        ),
      )
      .orderBy(desc(refresh_tokens.created_at));

    // session_id is an internal correlation key stored when the token was issued or refreshed.
    // We compare it against the current jti to compute current: true, then strip it —
    // the client doesn't need this internal field; it just needs to know which one is "me".
    const sessions = rows.map(({ session_id, ...row }) => ({
      ...row,
      current: session_id === currentJti,
    }));

    sendSuccess(res, sessions);
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /me/sessions/:id ──────────────────────────────────────────────────
// Soft-revoke a specific refresh token (set revoked_at). Does NOT hard-delete —
// the row stays in the DB for audit purposes; listSessions filters it out via isNull(revoked_at).
export async function revokeSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;

    // The session id comes from the URL path param (:id), not a request body.
    // DELETE requests have no body — the resource to delete is always identified in the URL.
    const sessionId = req.params.id as string;

    const now = new Date();

    // eq(refresh_tokens.id, sessionId)   — targets the specific row
    // eq(refresh_tokens.user_id, userId) — IDOR guard: ensures you can only revoke YOUR OWN
    //   sessions. Without this, any authenticated user could revoke any session by UUID.
    // isNull(revoked_at)                 — already-revoked sessions are treated as not found
    // gt(expires_at, now)                — expired sessions are already dead; treat as not found
    const [revoked] = await db
      .update(refresh_tokens)
      .set({ revoked_at: now })
      .where(
        and(
          eq(refresh_tokens.id, sessionId),
          eq(refresh_tokens.user_id, userId),
          isNull(refresh_tokens.revoked_at),
          gt(refresh_tokens.expires_at, now),
        ),
      )
      // .returning() is the reliable way to check if the UPDATE matched anything.
      // The postgres.js driver exposes `count`, not `rowCount`, so result.rowCount
      // would always be undefined — .returning() + array destructure is the safe pattern.
      .returning({ id: refresh_tokens.id });

    if (!revoked) throw new AppError(404, 'NOT_FOUND', 'Session not found or already revoked.');

    sendNoContent(res);
  } catch (err) {
    next(err);
  }
}

// ─── GET /me/notifications ────────────────────────────────────────────────────
// Returns the caller's notification inbox, newest first.
// Supports filtering by unread status and group, plus cursor-based pagination.
export async function listNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { unread, group_id, cursor, limit: limitStr } = req.query as Record<string, string | undefined>;

    // Cap at 100 to prevent accidental large queries; default to 20.
    const limit = Math.min(parseInt(limitStr ?? '20', 10) || 20, 100);

    // Start with the mandatory ownership filter, then layer optional ones.
    const conditions: ReturnType<typeof eq>[] = [eq(notifications.user_id, userId)];
    if (unread === 'true')  conditions.push(isNull(notifications.read_at));
    if (group_id)           conditions.push(eq(notifications.group_id, group_id));

    // Cursor encodes the created_at of the last seen row. Rows older than that are the next page.
    if (cursor) {
      const decoded = decodeCursor(cursor);
      conditions.push(lt(notifications.created_at, new Date(decoded.created_at)));
    }

    // Fetch one extra row to know if another page exists without a separate COUNT query.
    const rows = await db
      .select({
        id:         notifications.id,
        type:       notifications.type,
        title:      notifications.title,
        body:       notifications.body,
        data:       notifications.data,
        group_id:   notifications.group_id,
        read_at:    notifications.read_at,
        created_at: notifications.created_at,
      })
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.created_at))
      .limit(limit + 1);

    const has_more  = rows.length > limit;
    const items     = has_more ? rows.slice(0, limit) : rows;
    const last      = items.at(-1);
    const next_cursor = has_more && last
      ? encodeCursor({ id: last.id, created_at: last.created_at.toISOString() })
      : null;

    // Unread badge count — always global (ignores the current page's filters) so the
    // client badge stays accurate regardless of what the user is currently filtering.
    const [{ unread_count }] = await db
      .select({ unread_count: count(notifications.id) })
      .from(notifications)
      .where(and(eq(notifications.user_id, userId), isNull(notifications.read_at)));

    sendSuccess(res, { items, next_cursor, has_more, unread_count });
  } catch (err) {
    next(err);
  }
}

// ─── POST /me/notifications/mark-read ────────────────────────────────────────
// Marks specific notifications as read (by ID array), or all unread at once.
// Returns how many rows were actually updated so the client can update its badge.
export async function markNotificationsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const body = req.body as { notification_ids?: string[]; all?: boolean };

    if (!body.all && (!Array.isArray(body.notification_ids) || body.notification_ids.length === 0)) {
      throw new AppError(400, 'INVALID_REQUEST', 'Provide notification_ids array or set all: true.');
    }

    const now = new Date();

    // eq(user_id) is the IDOR guard — prevents marking another user's notifications as read.
    // isNull(read_at) skips already-read rows so marked_count reflects actual changes.
    const baseWhere = and(
      eq(notifications.user_id, userId),
      isNull(notifications.read_at),
    );

    const whereClause = body.all
      ? baseWhere
      : and(baseWhere, inArray(notifications.id, body.notification_ids!));

    const updated = await db
      .update(notifications)
      .set({ read_at: now })
      .where(whereClause)
      .returning({ id: notifications.id });

    sendSuccess(res, { marked_count: updated.length });
  } catch (err) {
    next(err);
  }
}

// ─── GET /me/notification-preferences ────────────────────────────────────────
// Returns all preference rows for this user: one global row (group_id = null)
// plus one row per group where the user has explicitly changed the default.
export async function getNotificationPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;

    const prefs = await db
      .select({
        group_id:   notification_preferences.group_id,
        muted:      notification_preferences.muted,
        updated_at: notification_preferences.updated_at,
      })
      .from(notification_preferences)
      .where(eq(notification_preferences.user_id, userId))
      .orderBy(notification_preferences.group_id);

    sendSuccess(res, prefs);
  } catch (err) {
    next(err);
  }
}

// ─── PUT /me/notification-preferences ────────────────────────────────────────
// Upsert a single preference row. group_id = null sets the global default.
// Returns the full preference list (same shape as GET) so the client can sync in one round-trip.
export async function updateNotificationPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId  = req.user!.userId;
    const { group_id, muted } = req.body as { group_id?: string | null; muted: boolean };

    if (typeof muted !== 'boolean') {
      throw new AppError(400, 'INVALID_REQUEST', 'muted (boolean) is required.');
    }

    const groupId = group_id ?? null;

    // Manual upsert: PostgreSQL's UNIQUE constraint treats NULL != NULL, so two rows with
    // group_id = NULL don't conflict and onConflictDoUpdate would silently insert duplicates.
    // We SELECT first, then UPDATE or INSERT, which works correctly for both cases.
    const [existing] = await db
      .select({ id: notification_preferences.id })
      .from(notification_preferences)
      .where(
        groupId
          ? and(eq(notification_preferences.user_id, userId), eq(notification_preferences.group_id, groupId))
          : and(eq(notification_preferences.user_id, userId), isNull(notification_preferences.group_id))
      )
      .limit(1);

    if (existing) {
      await db
        .update(notification_preferences)
        .set({ muted, updated_at: new Date() })
        .where(eq(notification_preferences.id, existing.id));
    } else {
      await db
        .insert(notification_preferences)
        .values({ user_id: userId, group_id: groupId, muted });
    }

    // Return the full list so the client has a consistent view after the update.
    const prefs = await db
      .select({
        group_id:   notification_preferences.group_id,
        muted:      notification_preferences.muted,
        updated_at: notification_preferences.updated_at,
      })
      .from(notification_preferences)
      .where(eq(notification_preferences.user_id, userId))
      .orderBy(notification_preferences.group_id);

    sendSuccess(res, prefs);
  } catch (err) {
    next(err);
  }
}

// ─── POST /me/push-subscriptions ─────────────────────────────────────────────
// Register a Web Push endpoint for this device. If the same endpoint re-registers
// (e.g. after a browser reinstall), the keys are updated in place via upsert.
export async function addPushSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { endpoint, p256dh_key, auth_key, device_info } = req.body as {
      endpoint:    string;
      p256dh_key:  string;
      auth_key:    string;
      device_info?: string;
    };

    if (!endpoint || !p256dh_key || !auth_key) {
      throw new AppError(400, 'INVALID_REQUEST', 'endpoint, p256dh_key, and auth_key are required.');
    }

    // UNIQUE (user_id, endpoint): same device re-registering updates the keys, not a duplicate row.
    const [sub] = await db
      .insert(push_subscriptions)
      .values({ user_id: userId, endpoint, p256dh_key, auth_key, device_info })
      .onConflictDoUpdate({
        target: [push_subscriptions.user_id, push_subscriptions.endpoint],
        set:    { p256dh_key, auth_key, device_info },
      })
      .returning({ id: push_subscriptions.id });

    sendCreated(res, { id: sub.id });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /me/push-subscriptions/:id ───────────────────────────────────────
// Hard-delete a push subscription. Push subscriptions have no audit value —
// unlike payments or sessions, there's no reason to keep revoked device registrations.
export async function removePushSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    // ID is in the URL path (:id), not the request body.
    const subId = req.params.id as string;

    // eq(user_id) is the IDOR guard — you can only delete your own subscriptions.
    const [removed] = await db
      .delete(push_subscriptions)
      .where(and(
        eq(push_subscriptions.id, subId),
        eq(push_subscriptions.user_id, userId),
      ))
      .returning({ id: push_subscriptions.id });

    if (!removed) throw new AppError(404, 'NOT_FOUND', 'Push subscription not found.');

    sendNoContent(res);
  } catch (err) {
    next(err);
  }
}