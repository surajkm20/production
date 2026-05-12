// Drizzle schema definitions for:
//   - payments  : one row per (cycle, member) tracking Paid/Unpaid/Waived status and amount.
//                 expected_amount = monthly_contribution × share_count (0 for skip-month cycles).
//   - audit_logs: append-only log of every change to payments, cycles, memberships, loans, groups.
//                 Stores old_values and new_values as JSONB snapshots.

import { pgTable, uuid, varchar, text, bigint, timestamp, jsonb, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { monthly_cycles } from './cycles';

export const payments = pgTable('payments', {
  id:              uuid('id').primaryKey().defaultRandom(),
  cycle_id:        uuid('cycle_id').notNull().references(() => monthly_cycles.id),
  member_user_id:  uuid('member_user_id').notNull().references(() => users.id),
  expected_amount: bigint('expected_amount', { mode: 'number' }).notNull(),
  paid_amount:     bigint('paid_amount', { mode: 'number' }).notNull().default(0),
  status:          varchar('status', { length: 20 }).notNull().default('Unpaid'), // 'Paid' | 'Unpaid' | 'Waived'
  paid_at:         timestamp('paid_at', { withTimezone: true }),
  marked_by:       uuid('marked_by').references(() => users.id),
  notes:           text('notes'),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uniq_cycle_member').on(table.cycle_id, table.member_user_id),
  index('idx_payments_cycle').on(table.cycle_id),
  index('idx_payments_member').on(table.member_user_id),
  index('idx_payments_status').on(table.cycle_id, table.status),
  check('chk_payment_status', sql`${table.status} IN ('Paid', 'Unpaid', 'Waived')`),
  check('chk_paid_consistency', sql`
    (${table.status} = 'Paid' AND ${table.paid_at} IS NOT NULL AND ${table.marked_by} IS NOT NULL)
    OR
    (${table.status} IN ('Unpaid', 'Waived'))
  `),
]);

export const audit_logs = pgTable('audit_logs', {
  id:          uuid('id').primaryKey().defaultRandom(),
  entity_type: varchar('entity_type', { length: 30 }).notNull(), // 'payment' | 'cycle' | 'membership' | 'loan' | 'group'
  entity_id:   uuid('entity_id').notNull(),
  action:      varchar('action', { length: 20 }).notNull(),      // 'CREATE' | 'UPDATE' | 'SOFT_DELETE'
  changed_by:  uuid('changed_by').notNull().references(() => users.id),
  old_values:  jsonb('old_values'),
  new_values:  jsonb('new_values'),
  notes:       text('notes'),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_audit_entity').on(table.entity_type, table.entity_id, table.created_at),
  index('idx_audit_user').on(table.changed_by, table.created_at),
]);
