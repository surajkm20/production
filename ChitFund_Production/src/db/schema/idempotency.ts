// Idempotency keys for mutation endpoints.
// Any client-generated UUID submitted as X-Idempotency-Key or in the request body
// is stored here. A second request with the same key returns the cached response_body
// instead of re-running the operation, preventing double-processing from retries /
// double-clicks / network disconnects.

import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

export const idempotency_keys = pgTable('idempotency_keys', {
  id:            uuid('id').primaryKey().defaultRandom(),
  key:           varchar('key', { length: 64 }).notNull(),    // client-supplied UUID
  endpoint:      varchar('endpoint', { length: 100 }).notNull(), // e.g. 'LOAN_REPAY' | 'BULK_REPAY'
  user_id:       uuid('user_id').notNull().references(() => users.id),
  response_body: text('response_body').notNull(),              // JSON-serialised success response
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expires_at:    timestamp('expires_at', { withTimezone: true }).notNull(),  // purge after 24h
}, (table) => [
  uniqueIndex('idx_idempotency_key_endpoint').on(table.key, table.endpoint),
  index('idx_idempotency_user').on(table.user_id),
  index('idx_idempotency_expires').on(table.expires_at),
]);
