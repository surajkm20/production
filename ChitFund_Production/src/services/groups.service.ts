/**
 * @fileoverview Chit group lifecycle business logic for the ChitFund API. It
 * creates groups (deriving the pool invariant, generating an invitation code,
 * pre-creating every monthly cycle and the basket), lists a user's groups with
 * cursor pagination and current-cycle enrichment, handles invitation-code joins
 * as pending requests, returns full group detail, updates mutable fields with
 * post-start lock checks, starts cycle 1, closes a group with the basket
 * closure-split computation, rotates invitation codes, and force-deletes a group
 * and all its data. It exists to keep every group-level state transition and its
 * invariants in one place.
 * @module services/groups
 * @author Suraj KM
 */

import { randomBytes } from 'crypto';
import { eq, and, lt, gt, desc, ilike, sum, count, inArray } from 'drizzle-orm';
import { db } from '../config/db';
import { chit_groups, memberships, baskets, monthly_cycles, cycle_winners, payments, loans, loan_transactions, basket_transactions, group_activity, pending_admin_transfers, users, notifications } from '../db/schema';
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
      id:                           chit_groups.id,
      name:                         chit_groups.name,
      invitation_code:              chit_groups.invitation_code,
      invitation_code_expires_at:   chit_groups.invitation_code_expires_at,
      pool_amount:                  chit_groups.pool_amount,
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
      id:            monthly_cycles.id,
      month_number:  monthly_cycles.month_number,
      month_label:   monthly_cycles.month_label,
      due_date:      monthly_cycles.due_date,
      status:        monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
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

  const currentCycleWinners = currentCycle
    ? await db.select({
        winner_number:    cycle_winners.winner_number,
        user_id:          cycle_winners.winner_user_id,
        name:             users.name,
        bid_amount:       cycle_winners.bid_amount,
        admin_commission: cycle_winners.admin_commission,
        basket_credit:    cycle_winners.basket_credit,
        winner_takeaway:  cycle_winners.winner_takeaway,
        is_admin_withdrawal: cycle_winners.is_admin_withdrawal,
      })
      .from(cycle_winners)
      .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
      .where(eq(cycle_winners.cycle_id, currentCycle.id))
      .orderBy(cycle_winners.winner_number)
    : [];

  return {
    group_id:                     row.id,
    name:                         row.name,
    invitation_code:              row.invitation_code,
    invitation_code_expires_at:   row.invitation_code_expires_at?.toISOString() ?? null,
    pool_amount:                  row.pool_amount,
    monthly_contribution: row.monthly_contribution,
    total_shares:         row.total_shares,
    total_months:         row.total_months,
    winners_per_cycle:    Math.floor(row.total_shares / row.total_months),
    excess_per_cycle:     row.monthly_contribution * (row.total_shares % row.total_months),
    shares_filled:        Number(shares_filled ?? 0),
    people_count,
    start_month:           row.start_month,
    payment_due_day:       row.payment_due_day,
    admin_commission_rate: row.admin_commission_rate,
    monthly_interest_rate: row.monthly_interest_rate,
    status:                row.status,
    current_cycle: currentCycle ? {
      cycle_id:      currentCycle.id,
      month_number:  currentCycle.month_number,
      month_label:   currentCycle.month_label,
      due_date:      currentCycle.due_date,
      status:        currentCycle.status,
      is_skip_month: currentCycle.is_skip_month,
      winners:       currentCycleWinners,
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

/**
 * Creates a chit group with the caller as admin, pre-creating all monthly cycles and the basket in one transaction.
 *
 * @param userId - The creating user, enrolled as the group admin
 * @param data - Group configuration
 * @param data.name - Group display name
 * @param data.monthly_contribution - Per-share monthly contribution in paise
 * @param data.total_shares - Total share slots across all members (>= total_months)
 * @param data.total_months - Calendar duration of the chit cycle; pool_amount = monthly_contribution × total_months
 * @param data.start_month - First cycle month as an ISO date string
 * @param data.payment_due_day - Day of month payments are due
 * @param data.admin_commission_rate - Optional admin maintenance fee rate (percent)
 * @param data.monthly_interest_rate - Optional basket loan interest rate (percent)
 * @param data.admin_share_count - Shares allocated to the admin (defaults to 1)
 * @returns A promise resolving to the created group's summary, including its invitation code
 * @throws {AppError} 400 INVALID_SHARE_COUNT if `admin_share_count` exceeds `total_shares`
 */
export async function createGroup(
  userId: string,
  data: {
    name:                   string;
    monthly_contribution:   number;
    total_shares:           number;
    total_months:           number;
    start_month:            string;
    payment_due_day:        number;
    admin_commission_rate?: number;
    monthly_interest_rate?: number;
    admin_share_count?:     number;
  },
) {
  const { name, monthly_contribution, total_shares, total_months, start_month, payment_due_day, admin_commission_rate, monthly_interest_rate, admin_share_count } = data;
  const pool_amount = monthly_contribution * total_months;
  const dueDayStr   = String(payment_due_day).padStart(2, '0');

  if (admin_share_count != null && admin_share_count > total_shares) {
    throw new AppError(400, 'INVALID_SHARE_COUNT', `admin_share_count (${admin_share_count}) cannot exceed total_shares (${total_shares}).`);
  }

  const group = await db.transaction(async (tx) => {
    const [newGroup] = await tx.insert(chit_groups).values({
      name,
      created_by:                 userId,
      invitation_code:            generateInvitationCode(),
      invitation_code_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
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

  const winners_per_cycle = Math.floor(group.total_shares / group.total_months);
  const excess_per_cycle  = group.monthly_contribution * (group.total_shares % group.total_months);

  return {
    group_id:             group.id,
    name:                 group.name,
    invitation_code:      group.invitation_code,
    pool_amount:          group.pool_amount,
    monthly_contribution: group.monthly_contribution,
    total_shares:         group.total_shares,
    total_months:         group.total_months,
    winners_per_cycle,
    excess_per_cycle,
    start_month:           group.start_month,
    payment_due_day:       group.payment_due_day,
    admin_commission_rate: group.admin_commission_rate,
    status:                group.status,
    cycle_status:          'PendingStart',
    created_at:            group.created_at,
  };
}

/**
 * Lists the groups a user actively belongs to, cursor-paginated and enriched with each group's current cycle, the user's payment status, and defaulter counts.
 *
 * @param userId - The user whose memberships to list
 * @param filters - Filtering and pagination options
 * @param filters.role - Restrict to `'admin'` or `'member'` memberships
 * @param filters.status - `'active'` (default) or `'closed'` groups
 * @param filters.q - Case-insensitive group-name search
 * @param filters.cursor - Opaque pagination cursor from a previous page
 * @param filters.limit - Page size (defaults to 20, capped at 100)
 * @returns A promise resolving to the enriched group items, the next cursor, and a `has_more` flag
 */
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
      closed_at:            chit_groups.closed_at,
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

  const has_more    = rows.length > limit;
  const items       = has_more ? rows.slice(0, limit) : rows;
  const last        = items.at(-1);
  const next_cursor = has_more && last
    ? encodeCursor({ id: last.group_id, created_at: last.created_at.toISOString() })
    : null;

  if (items.length === 0) return { items: [], next_cursor, has_more };

  // ── Enrich each group with current-cycle data ────────────────────────────────
  // The "current" cycle is the lowest-numbered Open cycle that already has payment
  // rows generated (all future pre-created cycles are also Open but have no rows yet).
  const groupIds = items.map(r => r.group_id);

  const activeCycleRows = await db
    .select({
      group_id:     monthly_cycles.group_id,
      cycle_id:     monthly_cycles.id,
      month_number: monthly_cycles.month_number,
      status:       monthly_cycles.status,
    })
    .from(monthly_cycles)
    .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
    .where(and(inArray(monthly_cycles.group_id, groupIds), eq(monthly_cycles.status, 'Open')))
    .orderBy(monthly_cycles.month_number);

  // One entry per group — take the first (lowest month_number)
  const cycleByGroup = new Map<string, { cycle_id: string; month_number: number; status: string }>();
  for (const c of activeCycleRows) {
    if (!cycleByGroup.has(c.group_id)) {
      cycleByGroup.set(c.group_id, { cycle_id: c.cycle_id, month_number: c.month_number, status: c.status });
    }
  }

  const cycleIds = [...new Set(activeCycleRows.map(c => c.cycle_id))];

  let userPaymentMap = new Map<string, string>(); // cycle_id → payment status
  let defaultersMap  = new Map<string, number>(); // cycle_id → unpaid count

  if (cycleIds.length > 0) {
    const [userPayments, defaulterCounts] = await Promise.all([
      db.select({ cycle_id: payments.cycle_id, status: payments.status })
        .from(payments)
        .where(and(inArray(payments.cycle_id, cycleIds), eq(payments.member_user_id, userId))),
      db.select({ cycle_id: payments.cycle_id, cnt: count(payments.id) })
        .from(payments)
        .where(and(inArray(payments.cycle_id, cycleIds), eq(payments.status, 'Unpaid')))
        .groupBy(payments.cycle_id),
    ]);

    for (const p of userPayments)   userPaymentMap.set(p.cycle_id, p.status);
    for (const d of defaulterCounts) defaultersMap.set(d.cycle_id, Number(d.cnt));
  }

  const enriched = items.map(row => {
    const cycle   = cycleByGroup.get(row.group_id) ?? null;
    const cycleId = cycle?.cycle_id ?? null;
    return {
      group_id:                       row.group_id,
      name:                           row.name,
      monthly_contribution:           row.monthly_contribution,
      total_shares:                   row.total_shares,
      status:                         row.status,
      closed_at:                      row.closed_at?.toISOString() ?? null,
      role:                           row.role,
      share_count:                    row.share_count,
      wins_count:                     row.wins_count,
      current_month_number:           cycle?.month_number ?? null,
      current_cycle_status:           cycle?.status ?? null,
      user_payment_status_this_month: cycleId ? (userPaymentMap.get(cycleId) ?? 'Unpaid') : null,
      defaulters_count:               cycleId ? (defaultersMap.get(cycleId) ?? 0) : 0,
    };
  });

  return { items: enriched, next_cursor, has_more };
}

/**
 * Submits a join request against an invitation code, creating a Pending membership and notifying the admin; the member becomes Active only on approval.
 *
 * @param userId - The user requesting to join
 * @param invitation_code - The group's current invitation code
 * @param requested_share_count - Shares the user is requesting, bounded by remaining capacity
 * @returns A promise resolving to the new pending membership summary and a confirmation message
 * @throws {AppError} 409 INVITATION_INVALID / INVITATION_EXPIRED / GROUP_CLOSED / GROUP_LOCKED on code or state issues
 * @throws {AppError} 409 ALREADY_MEMBER / REQUEST_ALREADY_SENT if the user already has a membership row
 * @throws {AppError} 409 GROUP_FULL / SHARES_EXCEEDED if requested shares exceed remaining capacity
 */
export async function joinGroup(userId: string, invitation_code: string, requested_share_count: number) {
  const [group] = await db
    .select()
    .from(chit_groups)
    .where(eq(chit_groups.invitation_code, invitation_code))
    .limit(1);

  if (!group)                    throw new AppError(409, 'INVITATION_INVALID', 'Invalid invitation code.');
  if (group.invitation_code_expires_at && group.invitation_code_expires_at < new Date()) {
    throw new AppError(409, 'INVITATION_EXPIRED', 'This invite code has expired. Ask the admin to generate a new one.');
  }
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

/**
 * Returns full group detail for a member: config, basket totals, the current open cycle with its winners, aggregate share/people counts, and the caller's own membership.
 *
 * @param userId - The requesting user, who must be an active member
 * @param group_id - Group to fetch
 * @returns A promise resolving to the assembled group-detail object
 * @throws {AppError} 404 GROUP_NOT_FOUND if the group does not exist
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 */
export async function getGroup(userId: string, group_id: string) {
  return fetchGroupDetail(userId, group_id);
}

/**
 * Updates a group's mutable fields (admin only), re-deriving the pool and adding/removing pre-created cycles when `total_shares` changes; financial fields lock once the group has started.
 *
 * @param userId - The requesting admin
 * @param group_id - Group to update
 * @param data - Fields to change
 * @param data.name - New display name
 * @param data.monthly_contribution - New per-share contribution (locked after start)
 * @param data.total_shares - New share/month count; grows or trims the pre-created cycles (locked after start)
 * @param data.start_month - New first-cycle month (locked after start)
 * @param data.admin_commission_rate - New admin maintenance fee rate (locked after start)
 * @param data.monthly_interest_rate - New basket loan interest rate
 * @returns A promise resolving to the refreshed group detail
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 409 FIELD_LOCKED if locked financial fields are changed after the group has started
 */
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

/**
 * Starts the group (admin only): requires all shares filled, generates cycle 1's payment rows, and auto-rejects any outstanding join requests.
 *
 * @param userId - The requesting admin
 * @param group_id - Group to start
 * @returns A promise resolving to the now-open first cycle's summary
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 409 GROUP_CLOSED, ALREADY_STARTED, or SHARES_NOT_FILLED on invalid state
 */
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
    activeMembers
      .filter(m => Number(m.share_count) > 0)
      .map(m => ({
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

/**
 * Closes the group (admin only) once all cycles are closed and no loans are outstanding, computing each member's share-weighted closure split of the basket balance.
 *
 * @param userId - The requesting admin
 * @param group_id - Group to close
 * @returns A promise resolving to the closed status, timestamp, per-member closure split, and total distributed
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 409 GROUP_CLOSED, CYCLES_PENDING, or LOANS_OUTSTANDING if preconditions are unmet
 */
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

/**
 * Generates a fresh invitation code with a new 24-hour expiry (admin only), invalidating the previous code.
 *
 * @param userId - The requesting admin
 * @param group_id - Group whose invitation code to rotate
 * @returns A promise resolving to the new code and its ISO expiry timestamp
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 */
export async function rotateInvitationCode(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the group admin can rotate the invitation code.');
  }

  const newCode   = generateInvitationCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.update(chit_groups)
    .set({ invitation_code: newCode, invitation_code_expires_at: expiresAt, updated_at: new Date() })
    .where(eq(chit_groups.id, group_id));

  return { invitation_code: newCode, invitation_code_expires_at: expiresAt.toISOString() };
}

/**
 * Permanently deletes a group and all of its data — cycles, payments, winners, loans, transactions, memberships, notifications, and activity — in one transaction (admin only); irreversible.
 *
 * @param userId - The requesting admin
 * @param group_id - Group to delete along with every dependent record
 * @returns A promise resolving to `{ deleted: true, group_id }`
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 */
export async function forceDeleteGroup(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Only the group admin can delete the group.');

  await db.transaction(async (tx) => {
    const [basketRows, cycleRows] = await Promise.all([
      tx.select({ id: baskets.id }).from(baskets).where(eq(baskets.group_id, group_id)),
      tx.select({ id: monthly_cycles.id }).from(monthly_cycles).where(eq(monthly_cycles.group_id, group_id)),
    ]);
    const basketIds = basketRows.map(b => b.id);
    const cycleIds  = cycleRows.map(c => c.id);

    const loanIds = basketIds.length
      ? (await tx.select({ id: loans.id }).from(loans).where(inArray(loans.basket_id, basketIds))).map(l => l.id)
      : [];

    if (cycleIds.length)  await tx.delete(cycle_winners).where(inArray(cycle_winners.cycle_id, cycleIds));
    if (cycleIds.length)  await tx.delete(payments).where(inArray(payments.cycle_id, cycleIds));
    if (loanIds.length)   await tx.delete(loan_transactions).where(inArray(loan_transactions.loan_id, loanIds));
    if (basketIds.length) await tx.delete(basket_transactions).where(inArray(basket_transactions.basket_id, basketIds));
    if (loanIds.length)   await tx.delete(loans).where(inArray(loans.basket_id, basketIds));
    if (cycleIds.length)  await tx.delete(monthly_cycles).where(eq(monthly_cycles.group_id, group_id));
    if (basketIds.length) await tx.delete(baskets).where(eq(baskets.group_id, group_id));
                          await tx.delete(pending_admin_transfers).where(eq(pending_admin_transfers.group_id, group_id));
                          await tx.delete(memberships).where(eq(memberships.group_id, group_id));
                          await tx.delete(notifications).where(eq(notifications.group_id, group_id));
                          await tx.delete(group_activity).where(eq(group_activity.group_id, group_id));
                          await tx.delete(chit_groups).where(eq(chit_groups.id, group_id));
  });

  return { deleted: true, group_id };
}
