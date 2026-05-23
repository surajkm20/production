import { db } from '../../config/db';
import {
  monthly_cycles,
  memberships,
  payments,
  users,
  cycle_winners,
} from '../../db/schema';
import { eq, and, count, sql } from 'drizzle-orm';
import type { WorkflowState } from '../graph/state';

// Read-only DB operations that fetch structured data for response generation.
// Write operations must go through existing services — this node never mutates.
export async function dbReadNode(state: WorkflowState): Promise<WorkflowState> {
  const { groupId, cycleId, intentType } = state;
  const result: Record<string, unknown> = {};
  const fetches: Promise<void>[] = [];

  if (groupId) {
    // Active member count
    fetches.push(
      db
        .select({ count: count() })
        .from(memberships)
        .where(and(eq(memberships.group_id, groupId), eq(memberships.status, 'Active')))
        .then(([row]) => {
          result.active_member_count = row?.count ?? 0;
        }),
    );

    // Open vs closed cycle counts
    fetches.push(
      db
        .select({
          status: monthly_cycles.status,
          count: count(),
        })
        .from(monthly_cycles)
        .where(eq(monthly_cycles.group_id, groupId))
        .groupBy(monthly_cycles.status)
        .then(rows => {
          result.cycle_counts = Object.fromEntries(rows.map(r => [r.status.toLowerCase(), r.count]));
        }),
    );
  }

  if (cycleId) {
    // Winner details with member names
    fetches.push(
      db
        .select({
          winner_number: cycle_winners.winner_number,
          bid_amount: cycle_winners.bid_amount,
          winner_takeaway: cycle_winners.winner_takeaway,
          basket_credit: cycle_winners.basket_credit,
          winner_name: users.name,
        })
        .from(cycle_winners)
        .innerJoin(users, eq(cycle_winners.winner_user_id, users.id))
        .where(eq(cycle_winners.cycle_id, cycleId))
        .then(rows => {
          result.cycle_winners = rows;
        }),
    );

    // Payment completion for the cycle
    if (groupId) {
      fetches.push(
        db
          .select({
            status: payments.status,
            count: count(),
          })
          .from(payments)
          .where(eq(payments.cycle_id, cycleId))
          .groupBy(payments.status)
          .then(rows => {
            result.payment_summary = Object.fromEntries(
              rows.map(r => [r.status.toLowerCase(), r.count]),
            );
          }),
      );
    }
  }

  await Promise.all(fetches);
  state.result.data = { ...state.result.data, ...result };
  return state;
}
