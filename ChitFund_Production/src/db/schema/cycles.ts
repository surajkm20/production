// Drizzle schema definitions for:
//   - monthly_cycles : one row per month in a group's lifecycle, pre-created at group start.
//                      Bid/winner data moved to cycle_winners to support multiple winners (X Chiti).
//   - cycle_winners  : one row per winner per cycle. Single-winner cycles have 1 row;
//                      Double/Triple/etc. Chiti cycles have 2-N rows.

import { pgTable, uuid, varchar, text, bigint, smallint, date, timestamp, boolean, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { chit_groups } from './groups';

export const monthly_cycles = pgTable('monthly_cycles', {
  id:            uuid('id').primaryKey().defaultRandom(),
  group_id:      uuid('group_id').notNull().references(() => chit_groups.id),
  month_number:  smallint('month_number').notNull(),
  month_label:   varchar('month_label', { length: 20 }).notNull(),
  due_date:      date('due_date').notNull(),
  is_skip_month: boolean('is_skip_month').notNull().default(false),
  status:        varchar('status', { length: 20 }).notNull().default('Open'), // 'Open' | 'Closed'
  opened_at:     timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closed_at:     timestamp('closed_at', { withTimezone: true }),
  notes:         text('notes'),
}, (table) => [
  unique('uniq_group_month').on(table.group_id, table.month_number),
  index('idx_cycles_group').on(table.group_id, table.month_number),
  index('idx_cycles_status').on(table.group_id, table.status),
  check('chk_cycle_status', sql`${table.status} IN ('Open', 'Closed')`),
]);

export const cycle_winners = pgTable('cycle_winners', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  cycle_id:            uuid('cycle_id').notNull().references(() => monthly_cycles.id),
  group_id:            uuid('group_id').notNull().references(() => chit_groups.id),
  winner_number:       smallint('winner_number').notNull(),            // 1-based slot index within cycle
  winner_user_id:      uuid('winner_user_id').notNull().references(() => users.id),
  bid_amount:          bigint('bid_amount', { mode: 'number' }).notNull(),
  admin_commission:    bigint('admin_commission', { mode: 'number' }).notNull(),
  basket_credit:       bigint('basket_credit', { mode: 'number' }).notNull(),
  winner_takeaway:     bigint('winner_takeaway', { mode: 'number' }).notNull(),
  is_admin_withdrawal: boolean('is_admin_withdrawal').notNull().default(false),
  notes:               text('notes'),
  created_by:          uuid('created_by').notNull().references(() => users.id),
  created_at:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uniq_cycle_slot').on(table.cycle_id, table.winner_number),
  index('idx_cycle_winners_cycle').on(table.cycle_id),
  index('idx_cycle_winners_group').on(table.group_id),
  index('idx_cycle_winners_user').on(table.winner_user_id),
]);
