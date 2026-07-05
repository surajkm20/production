/**
 * @fileoverview Activity-feed service backing the `group_activity` table. It
 * provides a fire-and-forget writer that other services call to record domain
 * events (member joined, payment marked, winner recorded, loan disbursed, etc.)
 * and a reader that powers the group activity feed, enriching each row with the
 * actor's name and a human-readable summary line. It exists to give every group
 * an audit-style timeline without letting feed writes ever interfere with the
 * core mutation that triggered them.
 * @module services/activity
 * @author Suraj KM
 */

import { eq, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { group_activity, users } from '../db/schema';
import { AppError } from '../utils/AppError';
import { assertActiveMember } from './memberships.service';

/**
 * Records a group activity event; safe to call fire-and-forget since any failure is logged, not thrown, so it never breaks the triggering mutation.
 *
 * @param params - Event payload
 * @param params.group_id - Group the event belongs to
 * @param params.event_type - Event type key (e.g. `'WINNER_RECORDED'`) used to build the feed summary
 * @param params.actor_id - User who triggered the event, or null for system events
 * @param params.data - Event-specific structured payload rendered into the summary
 * @returns A promise that always resolves, even when the insert fails
 */
export async function insertActivity(params: {
  group_id:   string;
  event_type: string;
  actor_id?:  string | null;
  data?:      Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(group_activity).values({
      group_id:   params.group_id,
      event_type: params.event_type,
      actor_id:   params.actor_id ?? null,
      data:       params.data ?? {},
    });
  } catch (err) {
    console.error('[activity] insert failed:', err);
  }
}

// ─── Summary builder ─────────────────────────────────────────────────────────
function paiseToDisplay(paise: unknown): string {
  const n = Number(paise ?? 0);
  return `₹${(n / 100).toLocaleString('en-IN')}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function buildSummary(
  event_type: string,
  actor_name: string | null,
  data: Record<string, unknown>,
): string {
  const name = actor_name ?? 'Someone';
  switch (event_type) {
    case 'GROUP_STARTED':
      return 'Group started — cycle 1 is now open';
    case 'GROUP_CLOSED':
      return 'Group closed';
    case 'MEMBER_JOINED':
      return `${name} joined with ${data.share_count} share(s)`;
    case 'MEMBER_REMOVED':
      return `${name} was removed from the group`;
    case 'PAYMENT_MARKED':
      if (data.member_name) {
        return `${name}(Admin) marked payment for ${data.member_name} of ${paiseToDisplay(data.amount)} for ${ordinal(Number(data.month_number))} Cycle`;
      }
      return `${name} paid ${paiseToDisplay(data.amount)} · ${data.month_label}`;
    case 'WINNER_RECORDED':
      return `${name} won ${data.month_label} · bid ${paiseToDisplay(data.bid_amount)}`;
    case 'SKIP_MONTH_DECLARED':
      return `${data.month_label} declared skip month · ${name} takes home ${paiseToDisplay(data.winner_takeaway)}`;
    case 'CYCLE_CLOSED':
      return `${data.month_label} cycle closed`;
    case 'LOAN_DISBURSED':
      return `${name} borrowed ${paiseToDisplay(data.principal)}`;
    case 'LOAN_REPAID':
      return `${name} repaid ${paiseToDisplay(data.amount)}`;
    case 'BASKET_ADJUSTED':
      return `Basket adjusted ${data.direction === 'C' ? '+' : '-'}${paiseToDisplay(data.amount)}`;
    default:
      return event_type.replace(/_/g, ' ').toLowerCase();
  }
}

/**
 * Returns the most recent activity-feed entries for a group, each enriched with the actor's name and a display summary; the caller must be an active member.
 *
 * @param userId - The requesting user, validated as an active member of the group
 * @param group_id - Group whose activity feed to read
 * @param limit - Maximum number of entries to return (capped at 50)
 * @returns A promise resolving to feed entries ordered newest-first, or an empty array if none exist
 * @throws {AppError} 403 NOT_A_MEMBER if the user is not an active member of the group
 */
export async function getGroupActivity(
  userId:   string,
  group_id: string,
  limit:    number,
) {
  await assertActiveMember(group_id, userId);

  const safeLimit = Math.min(limit, 200);

  const rows = await db
    .select({
      id:         group_activity.id,
      event_type: group_activity.event_type,
      actor_id:   group_activity.actor_id,
      actor_name: users.name,
      data:       group_activity.data,
      created_at: group_activity.created_at,
    })
    .from(group_activity)
    .leftJoin(users, eq(users.id, group_activity.actor_id))
    .where(eq(group_activity.group_id, group_id))
    .orderBy(desc(group_activity.created_at))
    .limit(safeLimit);

  if (!rows.length) return [];

  return rows.map(r => ({
    id:         r.id,
    event_type: r.event_type,
    actor_id:   r.actor_id,
    actor_name: r.actor_name ?? null,
    data:       r.data as Record<string, unknown>,
    summary:    buildSummary(r.event_type, r.actor_name ?? null, r.data as Record<string, unknown>),
    created_at: r.created_at,
  }));
}
