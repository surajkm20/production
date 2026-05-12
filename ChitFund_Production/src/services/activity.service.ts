// Activity feed service for group_activity table.
// insertActivity: fire-and-forget helper imported by other services.
// getGroupActivity: powers GET /groups/:group_id/activity.

import { eq, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { group_activity, users } from '../db/schema';
import { AppError } from '../utils/AppError';
import { assertActiveMember } from './memberships.service';

// ─── insertActivity ───────────────────────────────────────────────────────────
// Non-critical: errors are swallowed so a failed insert never breaks a mutation.
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

// ─── getGroupActivity ─────────────────────────────────────────────────────────
export async function getGroupActivity(
  userId:   string,
  group_id: string,
  limit:    number,
) {
  await assertActiveMember(group_id, userId);

  const safeLimit = Math.min(limit, 50);

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
