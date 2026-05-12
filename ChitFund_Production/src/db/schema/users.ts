// Drizzle schema definitions for the authentication tables:
//   - users            : core user accounts (mobile, username, password_hash)
//   - otp_verifications: hashed OTPs for signup / login / password_reset / admin_transfer
//   - refresh_tokens   : long-lived tokens (30 days) stored hashed, one row per device
//   - push_subscriptions: Web Push API endpoint + keys per device, for push notifications

import { pgTable, uuid, varchar, boolean, timestamp, smallint, text, unique, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            varchar('name', { length: 100 }).notNull(),
  mobile_number:   varchar('mobile_number', { length: 15 }).notNull().unique(),
  username:        varchar('username', { length: 50 }).unique(),
  password_hash:   varchar('password_hash', { length: 255 }).notNull(),
  mobile_verified: boolean('mobile_verified').notNull().default(false),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deleted_at:      timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  // NOTE: these should be partial indexes (WHERE deleted_at IS NULL) — add that manually in the migration SQL
  index('idx_users_mobile').on(table.mobile_number),
  index('idx_users_username').on(table.username),
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
