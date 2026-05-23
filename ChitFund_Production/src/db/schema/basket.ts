// Drizzle schema definitions for:
//   - baskets             : one row per group; caches current_balance + aggregate totals.
//                           Source of truth is basket_transactions; this is a fast-read cache.
//   - basket_transactions : append-only ledger. Every credit/debit to the basket is a new row.
//                           Never updated or deleted — corrections use an ADJUSTMENT entry.

import { pgTable, uuid, varchar, char, text, bigint, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { chit_groups } from './groups';
import { monthly_cycles } from './cycles';

export const baskets = pgTable('baskets', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  group_id:              uuid('group_id').notNull().unique().references(() => chit_groups.id),
  current_balance:       bigint('current_balance', { mode: 'number' }).notNull().default(0),
  total_credited:        bigint('total_credited', { mode: 'number' }).notNull().default(0),
  total_debited:         bigint('total_debited', { mode: 'number' }).notNull().default(0),
  total_lent_out:        bigint('total_lent_out', { mode: 'number' }).notNull().default(0),
  total_interest_earned: bigint('total_interest_earned', { mode: 'number' }).notNull().default(0),
  last_recomputed_at:    timestamp('last_recomputed_at', { withTimezone: true }).notNull().defaultNow(),
  created_at:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// related_loan_id has no .references() here — circular FK with loans table.
// loans.basket_id → baskets, basket_transactions.related_loan_id → loans.
// The FK is added in the migration SQL manually after both tables exist (mirrors the schema doc's ALTER TABLE approach).
export const basket_transactions = pgTable('basket_transactions', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  basket_id:            uuid('basket_id').notNull().references(() => baskets.id),
  cycle_id:             uuid('cycle_id').references(() => monthly_cycles.id),
  txn_type:             varchar('txn_type', { length: 30 }).notNull(),
  amount:               bigint('amount', { mode: 'number' }).notNull(),
  direction:            char('direction', { length: 1 }).notNull(),          // 'C' = credit | 'D' = debit
  counterparty_user_id: uuid('counterparty_user_id').references(() => users.id),
  related_loan_id:      uuid('related_loan_id'),
  notes:                text('notes'),
  created_by:           uuid('created_by').notNull().references(() => users.id),
  created_at:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_txns_basket').on(table.basket_id, table.created_at),
  index('idx_txns_cycle').on(table.cycle_id),
  index('idx_txns_loan').on(table.related_loan_id),
  index('idx_txns_user').on(table.counterparty_user_id),
  check('chk_txn_type', sql`${table.txn_type} IN (
    'CREDIT_DISCOUNT',
    'DEBIT_SKIP_MONTH',
    'DEBIT_X_CHITI',
    'DEBIT_FINAL_CYCLE_OFFSET',
    'LOAN_DISBURSED',
    'LOAN_REPAID',
    'INTEREST_ACCRUED',
    'CLOSURE_SPLIT',
    'ADJUSTMENT'
  )`),
  check('chk_direction',      sql`${table.direction} IN ('C', 'D')`),
  check('chk_amount_positive', sql`${table.amount} > 0`),
]);

