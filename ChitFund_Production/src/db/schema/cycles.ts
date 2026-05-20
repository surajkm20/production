// Drizzle schema definition for the monthly_cycles table.
// One row per month in a group's lifecycle, pre-created at group start.
// Stores auction result: bid_amount (winner's sacrifice), admin_commission (pool × rate, offline cash),
// basket_credit (= bid_amount, full sacrifice credited to basket), winner_takeaway (pool − bid − commission).
// A DB check constraint ensures all five bid fields are null or all filled.

import { pgTable, uuid, varchar, text, bigint, smallint, date, timestamp, boolean, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { chit_groups } from './groups';

export const monthly_cycles = pgTable('monthly_cycles', {
  id:             uuid('id').primaryKey().defaultRandom(),
  group_id:       uuid('group_id').notNull().references(() => chit_groups.id),
  month_number:   smallint('month_number').notNull(),
  month_label:    varchar('month_label', { length: 20 }).notNull(),
  due_date:       date('due_date').notNull(),
  is_skip_month:  boolean('is_skip_month').notNull().default(false),
  winner_user_id:   uuid('winner_user_id').references(() => users.id),
  bid_amount:       bigint('bid_amount', { mode: 'number' }),
  admin_commission: bigint('admin_commission', { mode: 'number' }),
  basket_credit:    bigint('basket_credit', { mode: 'number' }),
  winner_takeaway:  bigint('winner_takeaway', { mode: 'number' }),
  status:         varchar('status', { length: 20 }).notNull().default('Open'), // 'Open' | 'Closed'
  opened_at:      timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closed_at:      timestamp('closed_at', { withTimezone: true }),
  notes:          text('notes'),
}, (table) => [
  unique('uniq_group_month').on(table.group_id, table.month_number),
  index('idx_cycles_group').on(table.group_id, table.month_number),
  index('idx_cycles_status').on(table.group_id, table.status),
  check('chk_cycle_status', sql`${table.status} IN ('Open', 'Closed')`),
  check('chk_bid_consistency', sql`
    (${table.winner_user_id} IS NULL AND ${table.bid_amount} IS NULL AND ${table.admin_commission} IS NULL AND ${table.basket_credit} IS NULL AND ${table.winner_takeaway} IS NULL)
    OR
    (${table.winner_user_id} IS NOT NULL AND ${table.bid_amount} IS NOT NULL AND ${table.admin_commission} IS NOT NULL AND ${table.basket_credit} IS NOT NULL AND ${table.winner_takeaway} IS NOT NULL)
  `),
]);
