import { pgTable, uuid, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { chit_groups } from './groups';
import { memberships } from './memberships';

export const pending_admin_transfers = pgTable('pending_admin_transfers', {
  id:                uuid('id').primaryKey().defaultRandom(),
  group_id:          uuid('group_id').notNull().references(() => chit_groups.id),
  from_user_id:      uuid('from_user_id').notNull().references(() => users.id),
  to_user_id:        uuid('to_user_id').notNull().references(() => users.id),
  to_membership_id:  uuid('to_membership_id').notNull().references(() => memberships.id),
  from_confirmed_at: timestamp('from_confirmed_at', { withTimezone: true }),
  to_confirmed_at:   timestamp('to_confirmed_at', { withTimezone: true }),
  expires_at:        timestamp('expires_at', { withTimezone: true }).notNull(),
  completed_at:      timestamp('completed_at', { withTimezone: true }),
  created_at:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_transfers_group').on(table.group_id),
  index('idx_transfers_from').on(table.from_user_id),
  index('idx_transfers_to').on(table.to_user_id),
]);
