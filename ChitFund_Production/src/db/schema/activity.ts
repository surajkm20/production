// Append-only display feed for group activity.
// One row per event — powers the "Recent activity" panel on the group dashboard.
// actor_id is nullable for system-triggered events (e.g. interest accrual).
// data carries event-specific structured payload; summary is built at the API layer.

import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { chit_groups } from './groups';
import { users } from './users';

export const group_activity = pgTable('group_activity', {
  id:         uuid('id').primaryKey().defaultRandom(),
  group_id:   uuid('group_id').notNull().references(() => chit_groups.id),
  event_type: varchar('event_type', { length: 40 }).notNull(),
  actor_id:   uuid('actor_id').references(() => users.id),
  data:       jsonb('data').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_activity_group').on(table.group_id, table.created_at),
]);
