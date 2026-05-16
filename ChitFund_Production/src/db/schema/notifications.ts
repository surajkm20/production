// Drizzle schema definitions for:
//   - notifications             : in-app inbox rows per user (PAYMENT_DUE, WINNER_ANNOUNCED, etc.)
//   - notification_preferences  : per-user, per-group mute toggle (NULL group_id = global preference)
//   - sms_logs                  : minimal delivery log for every SMS sent (OTP, reminders, invites).
//                                 Does not store message body — only purpose, provider, and delivery status.

import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm'; // used by check constraints and sms_logs partial index
import { users } from './users';
import { chit_groups } from './groups';

export const notifications = pgTable('notifications', {
  id:            uuid('id').primaryKey().defaultRandom(),
  user_id:       uuid('user_id').notNull().references(() => users.id),
  group_id:      uuid('group_id').references(() => chit_groups.id),
  type:          varchar('type', { length: 40 }).notNull(), // 'PAYMENT_DUE' | 'PAYMENT_RECEIVED' | 'WINNER_ANNOUNCED' | 'LOAN_DISBURSED' | 'LOAN_INTEREST_DUE' | 'SKIP_MONTH_DECLARED' | 'DEFAULTER_REMINDER' | 'BASKET_ADJUSTED'
  title:         varchar('title', { length: 200 }).notNull(),
  body:          text('body').notNull(),
  data:          jsonb('data'),
  read_at:       timestamp('read_at', { withTimezone: true }),
  sent_via_push: boolean('sent_via_push').notNull().default(false),
  sent_via_sms:  boolean('sent_via_sms').notNull().default(false),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // NOTE: should be partial (WHERE read_at IS NULL) — add that manually in the migration SQL
  index('idx_notif_user_unread').on(table.user_id, table.created_at),
  index('idx_notif_user_all').on(table.user_id, table.created_at),
]);

export const notification_preferences = pgTable('notification_preferences', {
  id:         uuid('id').primaryKey().defaultRandom(),
  user_id:    uuid('user_id').notNull().references(() => users.id),
  group_id:   uuid('group_id').references(() => chit_groups.id),
  muted:      boolean('muted').notNull().default(false),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uniq_pref_user_group').on(table.user_id, table.group_id),
]);

export const sms_logs = pgTable('sms_logs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  mobile_number:   varchar('mobile_number', { length: 15 }).notNull(),
  purpose:         varchar('purpose', { length: 30 }).notNull(),    // 'OTP' | 'DEFAULTER_REMINDER' | 'INVITE'
  provider:        varchar('provider', { length: 20 }).notNull(),   // 'MSG91' | 'TWILIO'
  provider_msg_id: varchar('provider_msg_id', { length: 100 }),
  status:          varchar('status', { length: 20 }).notNull().default('Sent'), // 'Sent' | 'Delivered' | 'Failed'
  error_message:   text('error_message'),
  sent_at:         timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  delivered_at:    timestamp('delivered_at', { withTimezone: true }),
}, (table) => [
  index('idx_sms_mobile').on(table.mobile_number, table.sent_at),
  // NOTE: should be partial (WHERE status = 'Failed') — add that manually in the migration SQL
  index('idx_sms_status').on(table.status, table.sent_at),
  check('chk_sms_status', sql`${table.status} IN ('Sent', 'Delivered', 'Failed')`),
]);
