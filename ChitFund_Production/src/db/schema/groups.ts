// Drizzle schema definition for the chit_groups table.
// Stores the top-level configuration of a chit fund group:
// pool_amount, monthly_contribution, total_shares, total_months, start_month,
// admin_commission_rate (% of winning bid retained by admin in cash),
// interest rate bounds, invitation_code, and lifecycle status.
// All money columns are BIGINT paise.
// pool_amount = monthly_contribution × total_months (what each winning share receives).
// total_shares and total_months are independent; constraint: total_shares >= total_months.
// winners_per_cycle = floor(total_shares / total_months) — derived in app logic, not stored.

import { pgTable, uuid, varchar, char, bigint, smallint, numeric, date, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const chit_groups = pgTable('chit_groups', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  name:                 varchar('name', { length: 100 }).notNull(),
  invitation_code:      varchar('invitation_code', { length: 10 }).notNull().unique(),
  pool_amount:          bigint('pool_amount', { mode: 'number' }).notNull(),
  monthly_contribution: bigint('monthly_contribution', { mode: 'number' }).notNull(),
  total_months:         smallint('total_months').notNull(),
  total_shares:         smallint('total_shares').notNull(),
  start_month:          date('start_month').notNull(),
  payment_due_day:        smallint('payment_due_day').notNull().default(10),
  admin_commission_rate:  numeric('admin_commission_rate', { precision: 4, scale: 2 }).notNull().default('0.00'),
  monthly_interest_rate:  numeric('monthly_interest_rate', { precision: 4, scale: 2 }).notNull().default('5.00'),
  currency:             char('currency', { length: 3 }).notNull().default('INR'),
  status:               varchar('status', { length: 20 }).notNull().default('Active'),
  created_by:           uuid('created_by').notNull().references(() => users.id),
  created_at:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  closed_at:                    timestamp('closed_at', { withTimezone: true }),
  invitation_code_expires_at:   timestamp('invitation_code_expires_at', { withTimezone: true }),
}, (table) => [
  index('idx_groups_creator').on(table.created_by),
  index('idx_groups_status').on(table.status),
  check('chk_pool_matches',   sql`${table.pool_amount} = ${table.monthly_contribution} * ${table.total_months}`),
  check('chk_months_shares',  sql`${table.total_months} > 0 AND ${table.total_shares} > 0 AND ${table.total_shares} >= ${table.total_months}`),
  check('chk_commission_rate',  sql`${table.admin_commission_rate} >= 0 AND ${table.admin_commission_rate} <= 100`),
  check('chk_interest_rate',    sql`${table.monthly_interest_rate} >= 0 AND ${table.monthly_interest_rate} <= 100`),
  check('chk_payment_due_day',  sql`${table.payment_due_day} >= 1 AND ${table.payment_due_day} <= 28`),
]);
