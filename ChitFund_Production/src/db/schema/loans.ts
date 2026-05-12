// Drizzle schema definitions for:
//   - loans             : a loan disbursed from the basket to a group member.
//                         Tracks principal, monthly_interest_rate (inherited from group at disbursement),
//                         and status. outstanding_interest is computed from disbursed_at × rate − total_interest_paid.
//   - loan_transactions : individual repayment events (PRINCIPAL_REPAID, INTEREST_PAID).
//                         Each principal repayment also produces a LOAN_REPAID row in basket_transactions.

import { pgTable, uuid, varchar, text, bigint, smallint, numeric, date, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { baskets } from './basket';

export const loans = pgTable('loans', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  basket_id:             uuid('basket_id').notNull().references(() => baskets.id),
  borrower_user_id:      uuid('borrower_user_id').notNull().references(() => users.id),
  principal:              bigint('principal', { mode: 'number' }).notNull(),
  monthly_interest_rate:    numeric('monthly_interest_rate', { precision: 4, scale: 2 }).notNull(),
  disbursement_month_number: smallint('disbursement_month_number').notNull().default(1),
  total_interest_paid:      bigint('total_interest_paid', { mode: 'number' }).notNull().default(0),
  disbursed_at:          timestamp('disbursed_at', { withTimezone: true }).notNull().defaultNow(),
  expected_close_date:   date('expected_close_date'),
  closed_at:             timestamp('closed_at', { withTimezone: true }),
  status:                varchar('status', { length: 20 }).notNull().default('Active'), // 'Active' | 'Repaid' | 'WrittenOff'
  notes:                 text('notes'),
  created_at:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_loans_borrower').on(table.borrower_user_id),
  index('idx_loans_basket').on(table.basket_id),
  index('idx_loans_status').on(table.basket_id, table.status),
  check('chk_loan_status',              sql`${table.status} IN ('Active', 'Repaid', 'WrittenOff')`),
  check('chk_principal_positive',       sql`${table.principal} > 0`),
  check('chk_loan_interest_rate', sql`${table.monthly_interest_rate} >= 0 AND ${table.monthly_interest_rate} <= 100`),
]);

export const loan_transactions = pgTable('loan_transactions', {
  id:         uuid('id').primaryKey().defaultRandom(),
  loan_id:    uuid('loan_id').notNull().references(() => loans.id),
  txn_type:   varchar('txn_type', { length: 20 }).notNull(), // 'PRINCIPAL_REPAID' | 'INTEREST_PAID'
  amount:     bigint('amount', { mode: 'number' }).notNull(),
  txn_date:   date('txn_date').notNull(),
  notes:      text('notes'),
  created_by: uuid('created_by').notNull().references(() => users.id),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_loan_txns_loan').on(table.loan_id, table.txn_date),
  check('chk_loan_txn_type',   sql`${table.txn_type} IN ('PRINCIPAL_REPAID', 'INTEREST_PAID')`),
  check('chk_loan_txn_amount', sql`${table.amount} > 0`),
]);
