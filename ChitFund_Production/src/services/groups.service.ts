// Business logic for chit group lifecycle.
// Responsibilities: create group (validate pool invariant, generate invitation code,
// pre-create all monthly_cycles, create the basket row), start cycle 1, update group fields
// (with lock checks for financial fields post-start), close group (validate all cycles closed
// and no outstanding loans, compute and record CLOSURE_SPLIT basket transactions).

import { randomBytes } from 'crypto';
import { eq, and, lt, gt, desc, ilike, sum, count } from 'drizzle-orm';
import { db } from '../config/db';
import { chit_groups, memberships, baskets, monthly_cycles, payments, loans, users, notifications } from '../db/schema';
import { AppError } from '../utils/AppError';
import { encodeCursor, decodeCursor } from '../utils/pagination';
import { assertActiveMember } from './memberships.service';
import { insertActivity } from './activity.service';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function generateInvitationCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

// Shared re-fetch used by getGroup and updateGroup — returns the full group detail shape.
async function fetchGroupDetail(userId: string, group_id: string) {
  const [row] = await db
    .select({
      id:                   chit_groups.id,
      name:                 chit_groups.name,
      invitation_code:      chit_groups.invitation_code,
      pool_amount:          chit_groups.pool_amount,
      monthly_contribution: chit_groups.monthly_contribution,
      total_shares:         chit_groups.total_shares,
      total_months:         chit_groups.total_months,
      start_month:          chit_groups.start_month,
      payment_due_day:       chit_groups.payment_due_day,
      admin_commission_rate: chit_groups.admin_commission_rate,
      monthly_interest_rate: chit_groups.monthly_interest_rate,
      status:                chit_groups.status,
      created_at:           chit_groups.created_at,
      my_role:              memberships.role,
      my_share_count:       memberships.share_count,
      my_wins_count:        memberships.wins_count,
    })
    .from(chit_groups)
    .innerJoin(memberships, and(
      eq(memberships.group_id, chit_groups.id),
      eq(memberships.user_id,  userId),
      eq(memberships.status,   'Active'),
    ))
    .where(eq(chit_groups.id, group_id))
    .limit(1);

  if (!row) {
    const [exists] = await db
      .select({ id: chit_groups.id })
      .from(chit_groups)
      .where(eq(chit_groups.id, group_id))
      .limit(1);
    if (!exists) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
    throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
  }

  const [basketRows, cycleRows, aggRows] = await Promise.all([
    db.select({
      current_balance: baskets.current_balance,
      total_credited:  baskets.total_credited,
      total_debited:   baskets.total_debited,
      total_lent_out:  baskets.total_lent_out,
    })
    .from(baskets)
    .where(eq(baskets.group_id, group_id))
    .limit(1),

    db.select({
      id:               monthly_cycles.id,
      month_number:     monthly_cycles.month_number,
      month_label:      monthly_cycles.month_label,
      due_date:         monthly_cycles.due_date,
      status:           monthly_cycles.status,
      is_skip_month:    monthly_cycles.is_skip_month,
      winner_user_id:   monthly_cycles.winner_user_id,
      bid_amount:       monthly_cycles.bid_amount,
      admin_commission: monthly_cycles.admin_commission,
      basket_credit:    monthly_cycles.basket_credit,
      winner_takeaway:  monthly_cycles.winner_takeaway,
    })
    .from(monthly_cycles)
    .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
    .orderBy(monthly_cycles.month_number)
    .limit(1),

    db.select({
      shares_filled: sum(memberships.share_count),
      people_count:  count(memberships.id),
    })
    .from(memberships)
    .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
  ]);

  const basket       = basketRows[0]  ?? null;
  const currentCycle = cycleRows[0]   ?? null;
  const { shares_filled, people_count } = aggRows[0];

  return {
    group_id:             row.id,
    name:                 row.name,
    invitation_code:      row.invitation_code,
    pool_amount:          row.pool_amount,
    monthly_contribution: row.monthly_contribution,
    total_shares:         row.total_shares,
    total_months:         row.total_months,
    shares_filled:        Number(shares_filled ?? 0),
    people_count,
    start_month:           row.start_month,
    payment_due_day:       row.payment_due_day,
    admin_commission_rate: row.admin_commission_rate,
    monthly_interest_rate: row.monthly_interest_rate,
    status:                row.status,
    current_cycle: currentCycle ? {
      cycle_id:         currentCycle.id,
      month_number:     currentCycle.month_number,
      month_label:      currentCycle.month_label,
      due_date:         currentCycle.due_date,
      status:           currentCycle.status,
      is_skip_month:    currentCycle.is_skip_month,
      winner_user_id:   currentCycle.winner_user_id,
      bid_amount:       currentCycle.bid_amount,
      admin_commission: currentCycle.admin_commission,
      basket_credit:    currentCycle.basket_credit,
      winner_takeaway:  currentCycle.winner_takeaway,
    } : null,
    basket: basket ? {
      current_balance: basket.current_balance,
      total_credited:  basket.total_credited,
      total_debited:   basket.total_debited,
      total_lent_out:  basket.total_lent_out,
    } : null,
    my_membership: {
      role:        row.my_role,
      share_count: row.my_share_count,
      wins_count:  row.my_wins_count,
    },
    created_at: row.created_at,
  };
}

// ─── createGroup ─────────────────────────────────────────────────────────────
export async function createGroup(
  userId: string,
  data: {
    name:                   string;
    monthly_contribution:   number;
    total_shares:           number;
    start_month:            string;
    payment_due_day:        number;
    admin_commission_rate?: number;
    monthly_interest_rate?: number;
    admin_share_count?:     number;
  },
) {
  const { name, monthly_contribution, total_shares, start_month, payment_due_day, admin_commission_rate, monthly_interest_rate, admin_share_count } = data;
  const pool_amount  = monthly_contribution * total_shares;
  const total_months = total_shares;
  const dueDayStr    = String(payment_due_day).padStart(2, '0');

  if (admin_share_count != null && admin_share_count > total_shares) {
    throw new AppError(400, 'INVALID_SHARE_COUNT', `admin_share_count (${admin_share_count}) cannot exceed total_shares (${total_shares}).`);
  }

  const group = await db.transaction(async (tx) => {
    const [newGroup] = await tx.insert(chit_groups).values({
      name,
      created_by:      userId,
      invitation_code: generateInvitationCode(),
      pool_amount,
      monthly_contribution,
      total_months,
      total_shares,
      start_month,
      payment_due_day,
      ...(admin_commission_rate != null ? { admin_commission_rate: String(admin_commission_rate) } : {}),
      ...(monthly_interest_rate != null ? { monthly_interest_rate: String(monthly_interest_rate) } : {}),
    }).returning();

    await tx.insert(memberships).values({ group_id: newGroup.id, user_id: userId, role: 'Admin', share_count: admin_share_count ?? 1 });
    await tx.insert(baskets).values({ group_id: newGroup.id });

    const startDate = new Date(start_month);
    const cycleRows = Array.from({ length: total_months }, (_, i) => {
      const month_number = i + 1;
      const cycleDate    = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
      const month_label  = `${MONTHS[cycleDate.getMonth()]} ${cycleDate.getFullYear()}`;
      const due_date     = `${cycleDate.getFullYear()}-${String(cycleDate.getMonth() + 1).padStart(2, '0')}-${dueDayStr}`;
      return { group_id: newGroup.id, month_number, month_label, due_date };
    });
    await tx.insert(monthly_cycles).values(cycleRows);

    return newGroup;
  });

  return {
    group_id:             group.id,
    name:                 group.name,
    invitation_code:      group.invitation_code,
    pool_amount:          group.pool_amount,
    monthly_contribution: group.monthly_contribution,
    total_shares:         group.total_shares,
    total_months:         group.total_months,
    start_month:           group.start_month,
    payment_due_day:       group.payment_due_day,
    admin_commission_rate: group.admin_commission_rate,
    status:                group.status,
    cycle_status:          'PendingStart',
    created_at:            group.created_at,
  };
}

// ─── listGroups ──────────────────────────────────────────────────────────────
export async function listGroups(
  userId:  string,
  filters: { role?: string; status?: string; q?: string; cursor?: string; limit?: number },
) {
  const { role, status = 'active', q, cursor } = filters;
  const limit = Math.min(filters.limit ?? 20, 100);

  const conditions = [
    eq(memberships.user_id, userId),
    eq(memberships.status,  'Active'),
  ];

  if (role === 'admin')  conditions.push(eq(memberships.role, 'Admin'));
  if (role === 'member') conditions.push(eq(memberships.role, 'Member'));
  if (status === 'active') conditions.push(eq(chit_groups.status, 'Active'));
  if (status === 'closed') conditions.push(eq(chit_groups.status, 'Closed'));
  if (q) conditions.push(ilike(chit_groups.name, `%${q}%`));
  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(lt(chit_groups.created_at, new Date(decoded.created_at)));
  }

  const rows = await db
    .select({
      group_id:             chit_groups.id,
      name:                 chit_groups.name,
      monthly_contribution: chit_groups.monthly_contribution,
      total_shares:         chit_groups.total_shares,
      status:               chit_groups.status,
      created_at:           chit_groups.created_at,
      role:                 memberships.role,
      share_count:          memberships.share_count,
      wins_count:           memberships.wins_count,
    })
    .from(chit_groups)
    .innerJoin(memberships, eq(memberships.group_id, chit_groups.id))
    .where(and(...conditions))
    .orderBy(desc(chit_groups.created_at))
    .limit(limit + 1);

  const has_more   = rows.length > limit;
  const items      = has_more ? rows.slice(0, limit) : rows;
  const last       = items.at(-1);
  const next_cursor = has_more && last
    ? encodeCursor({ id: last.group_id, created_at: last.created_at.toISOString() })
    : null;

  return { items, next_cursor, has_more };
}

// ─── joinGroup ───────────────────────────────────────────────────────────────
// Creates a Pending membership (join request). Admin must approve before the
// member becomes Active. Blocked once cycle 1 has started.
export async function joinGroup(userId: string, invitation_code: string, requested_share_count: number) {
  const [group] = await db
    .select()
    .from(chit_groups)
    .where(eq(chit_groups.invitation_code, invitation_code))
    .limit(1);

  if (!group)                    throw new AppError(409, 'INVITATION_INVALID', 'Invalid or expired invitation code.');
  if (group.status === 'Closed') throw new AppError(409, 'GROUP_CLOSED',       'This group is closed.');

  // Block once cycle 1 has started (any payments exist = group is live)
  const [existingPayment] = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
    .where(eq(monthly_cycles.group_id, group.id))
    .limit(1);

  if (existingPayment) {
    throw new AppError(409, 'GROUP_LOCKED', 'This group has already started. Ask the admin to add you directly.');
  }

  // Block if user already has any membership row for this group
  const [existing] = await db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.group_id, group.id), eq(memberships.user_id, userId)))
    .limit(1);

  if (existing?.status === 'Active')  throw new AppError(409, 'ALREADY_MEMBER',       'You are already a member of this group.');
  if (existing?.status === 'Pending') throw new AppError(409, 'REQUEST_ALREADY_SENT', 'You already have a pending join request for this group. Wait for the admin to review it.');

  // Capacity check — only Active shares count toward shares_filled
  const [{ taken }] = await db
    .select({ taken: sum(memberships.share_count) })
    .from(memberships)
    .where(and(eq(memberships.group_id, group.id), eq(memberships.status, 'Active')));

  const activeShares = Number(taken ?? 0);
  const remaining    = group.total_shares - activeShares;

  if (remaining <= 0) {
    throw new AppError(409, 'GROUP_FULL', 'All shares in this group are filled.');
  }
  if (requested_share_count > remaining) {
    throw new AppError(409, 'SHARES_EXCEEDED',
      `Only ${remaining} share(s) remaining. You requested ${requested_share_count}.`);
  }

  const [membership] = await db
    .insert(memberships)
    .values({
      group_id:             group.id,
      user_id:              userId,
      role:                 'Member',
      share_count:          requested_share_count,
      requested_share_count,
      status:               'Pending',
    })
    .returning({
      id:                   memberships.id,
      group_id:             memberships.group_id,
      role:                 memberships.role,
      share_count:          memberships.share_count,
      requested_share_count: memberships.requested_share_count,
      status:               memberships.status,
    });

  // Notify the admin
  const [adminRow] = await db
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(and(eq(memberships.group_id, group.id), eq(memberships.role, 'Admin'), eq(memberships.status, 'Active')))
    .limit(1);

  const [requester] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (adminRow) {
    await db.insert(notifications).values({
      user_id:  adminRow.user_id,
      group_id: group.id,
      type:     'JOIN_REQUEST_RECEIVED',
      title:    'New join request',
      body:     `${requester.name} wants to join ${group.name} with ${requested_share_count} share(s). Review in Members.`,
      data:     { membership_id: membership.id },
    });
  }

  return {
    membership_id:        membership.id,
    group_id:             membership.group_id,
    role:                 membership.role,
    requested_share_count: membership.requested_share_count,
    status:               membership.status,
    message:              'Join request submitted. You will be notified once the admin reviews it.',
  };
}

// ─── getGroup ────────────────────────────────────────────────────────────────
export async function getGroup(userId: string, group_id: string) {
  return fetchGroupDetail(userId, group_id);
}

// ─── updateGroup ─────────────────────────────────────────────────────────────
export async function updateGroup(
  userId:   string,
  group_id: string,
  data: {
    name?:                   string;
    monthly_contribution?:   number;
    total_shares?:           number;
    start_month?:            string;
    admin_commission_rate?:  number;
    monthly_interest_rate?:  number;
  },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can update group settings.');
  }

  const { name, monthly_contribution, total_shares, start_month, admin_commission_rate, monthly_interest_rate } = data;
  const lockedFieldsSent = monthly_contribution != null || total_shares != null || start_month != null || admin_commission_rate != null;

  if (lockedFieldsSent) {
    const [existingPayment] = await db
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .limit(1);
    if (existingPayment) {
      throw new AppError(409, 'FIELD_LOCKED', 'monthly_contribution, total_shares, start_month, and admin_commission_rate cannot be changed after the group has started.');
    }
  }

  const [current] = await db
    .select({
      monthly_contribution: chit_groups.monthly_contribution,
      total_shares:         chit_groups.total_shares,
      start_month:          chit_groups.start_month,
      payment_due_day:      chit_groups.payment_due_day,
    })
    .from(chit_groups)
    .where(eq(chit_groups.id, group_id))
    .limit(1);

  const eff_monthly_contribution = monthly_contribution ?? Number(current.monthly_contribution);
  const eff_total_shares         = total_shares         ?? Number(current.total_shares);
  const eff_start_month          = start_month          ?? String(current.start_month);
  const eff_pool_amount          = eff_monthly_contribution * eff_total_shares;

  const updateSet = {
    updated_at: new Date(),
    ...(name                   != null ? { name }                                                     : {}),
    ...(admin_commission_rate  != null ? { admin_commission_rate: String(admin_commission_rate) }   : {}),
    ...(monthly_interest_rate  != null ? { monthly_interest_rate: String(monthly_interest_rate) }   : {}),
    ...(monthly_contribution != null ? { monthly_contribution }                      : {}),
    ...(total_shares != null        ? { total_shares: eff_total_shares, total_months: eff_total_shares } : {}),
    ...(monthly_contribution != null || total_shares != null ? { pool_amount: eff_pool_amount } : {}),
    ...(start_month != null ? { start_month }                                        : {}),
  };

  const sharesChanged  = total_shares != null && eff_total_shares !== Number(current.total_shares);
  const oldTotalShares = Number(current.total_shares);

  await (sharesChanged
    ? db.transaction(async (tx) => {
        await tx.update(chit_groups).set(updateSet).where(eq(chit_groups.id, group_id));

        if (eff_total_shares > oldTotalShares) {
          const startDate  = new Date(eff_start_month);
          const dueDayStr  = String(current.payment_due_day).padStart(2, '0');
          const newCycles = Array.from({ length: eff_total_shares - oldTotalShares }, (_, i) => {
            const month_number = oldTotalShares + i + 1;
            const cycleDate    = new Date(startDate.getFullYear(), startDate.getMonth() + month_number - 1, 1);
            const month_label  = `${MONTHS[cycleDate.getMonth()]} ${cycleDate.getFullYear()}`;
            const due_date     = `${cycleDate.getFullYear()}-${String(cycleDate.getMonth() + 1).padStart(2, '0')}-${dueDayStr}`;
            return { group_id, month_number, month_label, due_date };
          });
          await tx.insert(monthly_cycles).values(newCycles);
        } else {
          await tx.delete(monthly_cycles).where(and(
            eq(monthly_cycles.group_id,    group_id),
            gt(monthly_cycles.month_number, eff_total_shares),
          ));
        }
      })
    : db.update(chit_groups).set(updateSet).where(eq(chit_groups.id, group_id))
  );

  return fetchGroupDetail(userId, group_id);
}

// ─── startGroup ──────────────────────────────────────────────────────────────
export async function startGroup(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Only the group admin can start the group.');

  const [groupRows, [existingPayment], aggRows, cycle1Rows, activeMembers] = await Promise.all([
    db.select({ status: chit_groups.status, monthly_contribution: chit_groups.monthly_contribution, total_shares: chit_groups.total_shares })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: payments.id })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .limit(1),

    db.select({ shares_filled: sum(memberships.share_count) })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),

    db.select({ id: monthly_cycles.id, due_date: monthly_cycles.due_date })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, 1)))
      .limit(1),

    db.select({ user_id: memberships.user_id, share_count: memberships.share_count })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
  ]);

  const group  = groupRows[0];
  const cycle1 = cycle1Rows[0];

  if (group.status === 'Closed') throw new AppError(409, 'GROUP_CLOSED', 'This group is already closed.');
  if (existingPayment)           throw new AppError(409, 'ALREADY_STARTED', 'This group has already been started.');

  const sharesFilled = Number(aggRows[0].shares_filled ?? 0);
  if (sharesFilled !== Number(group.total_shares)) {
    throw new AppError(409, 'SHARES_NOT_FILLED',
      `Group requires ${group.total_shares} shares to be filled; currently ${sharesFilled}.`);
  }

  await db.insert(payments).values(
    activeMembers.map(m => ({
      cycle_id:        cycle1.id,
      member_user_id:  m.user_id,
      expected_amount: Number(group.monthly_contribution) * Number(m.share_count),
    })),
  );

  await insertActivity({ group_id, event_type: 'GROUP_STARTED', actor_id: userId });

  // Auto-reject any pending join requests — the invitation code is now locked
  await db
    .update(memberships)
    .set({ status: 'Inactive', deactivated_at: new Date(), notes: 'Auto-rejected: group started before request was reviewed.' })
    .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Pending')));

  return { current_cycle: { cycle_id: cycle1.id, month_number: 1, status: 'Open', due_date: cycle1.due_date } };
}

// ─── closeGroup ──────────────────────────────────────────────────────────────
export async function closeGroup(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Only the group admin can close the group.');

  const [groupRows, openCycleRow, activeLoanRow, basketRows, memberRows] = await Promise.all([
    db.select({ status: chit_groups.status, total_shares: chit_groups.total_shares })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: monthly_cycles.id })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
      .limit(1),

    db.select({ id: loans.id })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(eq(baskets.group_id, group_id), eq(loans.status, 'Active')))
      .limit(1),

    db.select({ current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ user_id: memberships.user_id, share_count: memberships.share_count, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
  ]);

  if (groupRows[0].status === 'Closed') throw new AppError(409, 'GROUP_CLOSED', 'This group is already closed.');
  if (openCycleRow[0])                  throw new AppError(409, 'CYCLES_PENDING', 'All cycles must be closed before closing the group.');
  if (activeLoanRow[0])                 throw new AppError(409, 'LOANS_OUTSTANDING', 'All loans must be repaid before closing the group.');

  const totalBalance = Number(basketRows[0]?.current_balance ?? 0);
  const totalShares  = Number(groupRows[0].total_shares);
  const closedAt     = new Date();

  const closureSplit = memberRows.map(m => ({
    user_id:     m.user_id,
    name:        m.name,
    share_count: Number(m.share_count),
    amount:      Math.floor((Number(m.share_count) / totalShares) * totalBalance),
  }));

  await db.update(chit_groups)
    .set({ status: 'Closed', closed_at: closedAt, updated_at: closedAt })
    .where(eq(chit_groups.id, group_id));

  await insertActivity({ group_id, event_type: 'GROUP_CLOSED', actor_id: userId });

  return {
    status:            'Closed',
    closed_at:         closedAt,
    closure_split:     closureSplit,
    total_distributed: closureSplit.reduce((acc, r) => acc + r.amount, 0),
  };
}

// ─── rotateInvitationCode ────────────────────────────────────────────────────
export async function rotateInvitationCode(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can rotate the invitation code.');
  }

  const newCode = generateInvitationCode();
  await db.update(chit_groups)
    .set({ invitation_code: newCode, updated_at: new Date() })
    .where(eq(chit_groups.id, group_id));

  return { invitation_code: newCode };
}
