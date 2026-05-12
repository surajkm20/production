// Drizzle schema definition for the memberships table.
// Links a user to a chit group with their role (Admin/Member), share_count, and wins_count.
// One row per (group, user) pair — share_count folds multiple shares into a single row.
// A unique partial index enforces exactly one active admin per group.

import { pgTable, uuid, varchar, timestamp, smallint, text, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { chit_groups } from './groups';

export const memberships = pgTable('memberships', {
  id:             uuid('id').primaryKey().defaultRandom(),
  group_id:       uuid('group_id').notNull().references(() => chit_groups.id),
  user_id:        uuid('user_id').notNull().references(() => users.id),
  role:           varchar('role', { length: 20 }).notNull(),         // 'Admin' | 'Member'
  share_count:            smallint('share_count').notNull().default(1),
  requested_share_count:  smallint('requested_share_count'),                     // null for admin-added members
  wins_count:             smallint('wins_count').notNull().default(0),
  status:                 varchar('status', { length: 20 }).notNull().default('Active'), // 'Pending' | 'Active' | 'Inactive'
  joined_at:      timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
  notes:          text('notes'),
}, (table) => [
  unique('uniq_group_user').on(table.group_id, table.user_id),
  uniqueIndex('idx_one_admin_per_group').on(table.group_id).where(sql`${table.role} = 'Admin' AND ${table.status} = 'Active'`),
  index('idx_memberships_user').on(table.user_id),
  index('idx_memberships_group').on(table.group_id),
  check('chk_role',              sql`${table.role} IN ('Admin', 'Member')`),
  check('chk_membership_status',       sql`${table.status} IN ('Pending', 'Active', 'Inactive')`),
  check('chk_requested_share_count',   sql`${table.requested_share_count} IS NULL OR ${table.requested_share_count} >= 1`),
  check('chk_share_count',       sql`${table.share_count} >= 1`),
  check('chk_wins_le_shares',    sql`${table.wins_count} >= 0 AND ${table.wins_count} <= ${table.share_count}`),
]);
