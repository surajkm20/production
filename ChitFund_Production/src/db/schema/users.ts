// Drizzle schema definitions for the authentication tables:
//   - users            : core user accounts (mobile, username, password_hash)
//   - otp_verifications: hashed OTPs for signup / login / password_reset / admin_transfer
//   - refresh_tokens   : long-lived tokens (30 days) stored hashed, one row per device
//   - push_subscriptions: Web Push API endpoint + keys per device, for push notifications

import { pgTable, uuid, varchar, boolean, timestamp, smallint, text, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            varchar('name', { length: 100 }).notNull(),
  mobile_number:   varchar('mobile_number', { length: 15 }).notNull().unique(),
  username:        varchar('username', { length: 50 }).unique(),
  password_hash:   varchar('password_hash', { length: 255 }).notNull(),
  mobile_verified: boolean('mobile_verified').notNull().default(false),
  // Platform-level role, distinct from memberships.role (per-group Admin/Member).
  // 'User' for everyone by default; 'SuperAdmin' powers the read-only Admin Console.
  // Promoted only via a direct DB UPDATE by the platform owner — there is no API/UI to set it.
  role:            varchar('role', { length: 20 }).notNull().default('User'),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deleted_at:      timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  // NOTE: these should be partial indexes (WHERE deleted_at IS NULL) — add that manually in the migration SQL
  index('idx_users_mobile').on(table.mobile_number),
  index('idx_users_username').on(table.username),
  // NOTE: should be partial (WHERE role = 'SuperAdmin' AND deleted_at IS NULL) — made partial in the migration SQL.
  // SuperAdmin rows are a tiny minority, so a partial index keeps the per-request role lookup cheap.
  index('idx_users_superadmin').on(table.role),
  check('chk_user_role', sql`${table.role} IN ('User', 'SuperAdmin')`),
]);

export const otp_verifications = pgTable('otp_verifications', {
  id:            uuid('id').primaryKey().defaultRandom(),
  mobile_number: varchar('mobile_number', { length: 15 }).notNull(),
  otp_hash:      varchar('otp_hash', { length: 255 }).notNull(),
  purpose:       varchar('purpose', { length: 20 }).notNull(), // 'signup' | 'login' | 'password_reset' | 'admin_transfer'
  expires_at:    timestamp('expires_at', { withTimezone: true }).notNull(),
  verified_at:   timestamp('verified_at', { withTimezone: true }),
  attempts:      smallint('attempts').notNull().default(0),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // JSON blob for new-user signup path: { name, password_hash, username? }.
  // Present when sendOtp is called before the user row exists; null for stub-claiming.
  // Consumed by verifySignupOtp to create the user only after OTP is confirmed.
  pending_data:  text('pending_data'),
});

export const refresh_tokens = pgTable('refresh_tokens', {
  id:           uuid('id').primaryKey().defaultRandom(),
  user_id:      uuid('user_id').notNull().references(() => users.id),
  token_hash:   varchar('token_hash', { length: 255 }).notNull().unique(),
  // jti of the most-recently-issued access token for this session.
  // Updated on every /auth/refresh so listSessions can mark the active session.
  session_id:   uuid('session_id'),
  device_info:  varchar('device_info', { length: 255 }),
  expires_at:   timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at:   timestamp('revoked_at', { withTimezone: true }),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  // NOTE: should be partial (WHERE revoked_at IS NULL) — add that manually in the migration SQL
  index('idx_refresh_user').on(table.user_id),
]);

export const push_subscriptions = pgTable('push_subscriptions', {
  id:           uuid('id').primaryKey().defaultRandom(),
  user_id:      uuid('user_id').notNull().references(() => users.id),
  endpoint:     text('endpoint').notNull(),
  p256dh_key:   text('p256dh_key').notNull(),
  auth_key:     text('auth_key').notNull(),
  device_info:  varchar('device_info', { length: 255 }),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  unique().on(table.user_id, table.endpoint),
  index('idx_push_user').on(table.user_id),
]);
