import { db } from '../../config/db';
import {
  chit_groups,
  monthly_cycles,
  baskets,
  memberships,
  cycle_winners,
  users,
} from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { contextCache } from '../cache/contextCache';
import type { WorkflowState } from '../graph/state';

// Loads only the context slices that the current intentType actually needs.
// Each slice is independently cached so parallel requests share data.
export async function contextNode(state: WorkflowState): Promise<WorkflowState> {
  const { groupId, cycleId, intentType } = state;
  const loads: Promise<void>[] = [];

  if (groupId && !state.context.group) {
    loads.push(
      contextCache
        .getOrFetch(`group:${groupId}`, () =>
          db
            .select({
              id: chit_groups.id,
              name: chit_groups.name,
              status: chit_groups.status,
              pool_amount: chit_groups.pool_amount,
              monthly_contribution: chit_groups.monthly_contribution,
              total_months: chit_groups.total_months,
              admin_commission_rate: chit_groups.admin_commission_rate,
              monthly_interest_rate: chit_groups.monthly_interest_rate,
            })
            .from(chit_groups)
            .where(eq(chit_groups.id, groupId))
            .limit(1)
            .then(r => r[0] ?? null),
        )
        .then(g => {
          if (g) {
            state.context.group = g as WorkflowState['context']['group'];
            if (contextCache.lastWasHit) state.meta.cacheHits++;
          }
        }),
    );
  }

  if (cycleId && !state.context.cycle) {
    loads.push(
      contextCache
        .getOrFetch(`cycle:${cycleId}`, () =>
          db
            .select({
              id: monthly_cycles.id,
              month_number: monthly_cycles.month_number,
              month_label: monthly_cycles.month_label,
              status: monthly_cycles.status,
              due_date: monthly_cycles.due_date,
            })
            .from(monthly_cycles)
            .where(eq(monthly_cycles.id, cycleId))
            .limit(1)
            .then(r => r[0] ?? null),
        )
        .then(c => {
          if (c) {
            state.context.cycle = c as WorkflowState['context']['cycle'];
            if (contextCache.lastWasHit) state.meta.cacheHits++;
          }
        }),
    );
  }

  // Basket: only for financial queries — skipped for pure lookups
  if (groupId && !state.context.basket && (intentType === 'calculation' || intentType === 'report')) {
    loads.push(
      contextCache
        .getOrFetch(`basket:${groupId}`, () =>
          db
            .select({
              id: baskets.id,
              current_balance: baskets.current_balance,
              total_lent_out: baskets.total_lent_out,
              total_interest_earned: baskets.total_interest_earned,
            })
            .from(baskets)
            .where(eq(baskets.group_id, groupId))
            .limit(1)
            .then(r => r[0] ?? null),
        )
        .then(b => {
          if (b) {
            state.context.basket = b as WorkflowState['context']['basket'];
            if (contextCache.lastWasHit) state.meta.cacheHits++;
          }
        }),
    );
  }

  // Winners: only when querying a specific cycle
  if (cycleId && !state.context.winners && intentType === 'query') {
    loads.push(
      contextCache
        .getOrFetch(`winners:${cycleId}`, () =>
          db
            .select({
              winner_user_id: cycle_winners.winner_user_id,
              winner_number: cycle_winners.winner_number,
              bid_amount: cycle_winners.bid_amount,
              winner_takeaway: cycle_winners.winner_takeaway,
              basket_credit: cycle_winners.basket_credit,
            })
            .from(cycle_winners)
            .where(eq(cycle_winners.cycle_id, cycleId)),
        )
        .then(w => {
          state.context.winners = w;
          if (contextCache.lastWasHit) state.meta.cacheHits++;
        }),
    );
  }

  // Members: only for reports or member-listing queries
  if (groupId && !state.context.members && intentType === 'report') {
    loads.push(
      contextCache
        .getOrFetch(`members:${groupId}`, () =>
          db
            .select({
              user_id: memberships.user_id,
              name: users.name,
              role: memberships.role,
              share_count: memberships.share_count,
              wins_count: memberships.wins_count,
              status: memberships.status,
            })
            .from(memberships)
            .innerJoin(users, eq(memberships.user_id, users.id))
            .where(and(eq(memberships.group_id, groupId), eq(memberships.status, 'Active'))),
        )
        .then(m => {
          state.context.members = m;
          if (contextCache.lastWasHit) state.meta.cacheHits++;
        }),
    );
  }

  await Promise.all(loads);
  return state;
}
