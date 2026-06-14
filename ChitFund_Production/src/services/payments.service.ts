/**
 * @fileoverview Payment-tracking business logic for the ChitFund API. It lists a
 * cycle's payments with computed totals, updates a single payment's status with
 * the Paid/Unpaid/Waived consistency rules, performs transactional bulk marking,
 * sends de-duplicated defaulter reminders, and returns a member's payment
 * history. All amounts are handled as integer paise (never floats), every edit
 * is guarded against closed cycles, and `paid_amount` is validated never to
 * exceed `expected_amount`.
 * @module services/payments
 * @author Suraj KM
 */

import { eq, and, desc, inArray, gte } from 'drizzle-orm';
import { db } from '../config/db';
import { chit_groups, memberships, monthly_cycles, payments, users, notifications, baskets, basket_transactions } from '../db/schema';
import { AppError } from '../utils/AppError';
import { paiseToRupeeDisplay } from '../utils/money';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';


/**
 * Lists all payments for a cycle with per-member detail and aggregate totals, including the basket offset on the final cycle.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Cycle whose payments to list
 * @param filters - Optional filters
 * @param filters.status - Restrict to `'paid'`, `'unpaid'`, or `'waived'`; omitted/`'all'` returns every payment
 * @returns A promise resolving to the filtered payment rows plus a summary block (totals, counts, final-cycle flag)
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle does not exist in this group
 */
export async function listPayments(
  userId:   string,
  group_id: string,
  cycle_id: string,
  filters:  { status?: string },
) {
  await assertActiveMember(group_id, userId);

  const [[cycleRow], [groupRow]] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, month_number: monthly_cycles.month_number })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),
    db.select({ total_months: chit_groups.total_months })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const is_final_cycle = groupRow && cycleRow.month_number === Number(groupRow.total_months);

  const [allPayments, offsetTxnRows] = await Promise.all([
    db.select({
      id: payments.id, member_user_id: payments.member_user_id, member_name: users.name,
      share_count: memberships.share_count, expected_amount: payments.expected_amount,
      paid_amount: payments.paid_amount, status: payments.status,
      paid_at: payments.paid_at, marked_by: payments.marked_by, notes: payments.notes,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.member_user_id))
    .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
    .where(eq(payments.cycle_id, cycle_id)),

    is_final_cycle
      ? db.select({ amount: basket_transactions.amount })
          .from(basket_transactions)
          .innerJoin(baskets, eq(baskets.id, basket_transactions.basket_id))
          .where(and(
            eq(baskets.group_id, group_id),
            eq(basket_transactions.cycle_id, cycle_id),
            eq(basket_transactions.txn_type, 'DEBIT_FINAL_CYCLE_OFFSET'),
          ))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const total_expected = allPayments.reduce((s, p) => s + Number(p.expected_amount), 0);
  const total_paid     = allPayments.reduce((s, p) => s + Number(p.paid_amount),     0);
  const paid_count     = allPayments.filter(p => p.status === 'Paid').length;
  const unpaid_count   = allPayments.filter(p => p.status === 'Unpaid').length;
  const waived_count   = allPayments.filter(p => p.status === 'Waived').length;
  const basket_contribution = offsetTxnRows[0] ? Number(offsetTxnRows[0].amount) : 0;

  const { status = 'all' } = filters;
  const dbStatus = status === 'paid' ? 'Paid' : status === 'unpaid' ? 'Unpaid' : status === 'waived' ? 'Waived' : null;
  const data = dbStatus ? allPayments.filter(p => p.status === dbStatus) : allPayments;

  return {
    data: data.map(p => ({
      payment_id: p.id, member_user_id: p.member_user_id, member_name: p.member_name,
      share_count: Number(p.share_count), expected_amount: Number(p.expected_amount),
      paid_amount: Number(p.paid_amount), status: p.status, paid_at: p.paid_at,
      marked_by: p.marked_by, notes: p.notes,
    })),
    summary: { total_expected, total_paid, paid_count, unpaid_count, waived_count, basket_contribution, is_final_cycle: !!is_final_cycle },
  };
}

/**
 * Updates a single payment's status and/or amount (admin only), applying the Paid/Unpaid/Waived field rules and emitting activity + notifications when marked Paid.
 *
 * @param userId - The requesting admin, recorded as `marked_by` when marking Paid
 * @param group_id - Group the payment belongs to
 * @param payment_id - Payment to update
 * @param data - Fields to change
 * @param data.status - New status: `'Paid'`, `'Unpaid'`, or `'Waived'`
 * @param data.paid_amount - Amount paid in paise; must not exceed the expected amount
 * @param data.paid_at - ISO timestamp of payment; defaults to now when marking Paid
 * @param data.notes - Free-text note to attach
 * @returns A promise resolving to the updated payment's id, status, paid amount, and paid-at
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 PAYMENT_NOT_FOUND if the payment is not in this group
 * @throws {AppError} 409 CYCLE_CLOSED if the cycle is closed
 * @throws {AppError} 400 INVALID_STATUS or AMOUNT_EXCEEDS_EXPECTED on invalid input
 */
export async function updatePayment(
  userId:     string,
  group_id:   string,
  payment_id: string,
  data: {
    status?:      string;
    paid_amount?: number;
    paid_at?:     string;
    notes?:       string;
  },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { status: new_status, paid_amount: new_paid_amount, paid_at: new_paid_at, notes } = data;

  const [paymentRow] = await db
    .select({
      id: payments.id, cycle_id: payments.cycle_id,
      member_user_id: payments.member_user_id,
      expected_amount: payments.expected_amount, paid_amount: payments.paid_amount,
      status: payments.status, cycle_status: monthly_cycles.status,
      month_label: monthly_cycles.month_label,
    })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), eq(monthly_cycles.group_id, group_id)))
    .where(eq(payments.id, payment_id))
    .limit(1);

  if (!paymentRow)                          throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found in this group.');
  if (paymentRow.cycle_status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',      'Cannot edit payments for a closed cycle.');

  const validStatuses = ['Paid', 'Unpaid', 'Waived'];
  if (new_status && !validStatuses.includes(new_status)) {
    throw new AppError(400, 'INVALID_STATUS', `status must be one of: ${validStatuses.join(', ')}.`);
  }

  const effectivePaidAmount = new_paid_amount ?? (new_status === 'Paid' ? Number(paymentRow.expected_amount) : Number(paymentRow.paid_amount));
  if (effectivePaidAmount > Number(paymentRow.expected_amount)) {
    throw new AppError(400, 'AMOUNT_EXCEEDS_EXPECTED', `paid_amount (${effectivePaidAmount}) cannot exceed expected_amount (${paymentRow.expected_amount}).`);
  }

  const now = new Date();
  const updateSet: Record<string, unknown> = {};

  if (new_status === 'Paid') {
    updateSet.status = 'Paid'; updateSet.paid_at = new_paid_at ? new Date(new_paid_at) : now;
    updateSet.marked_by = userId; updateSet.paid_amount = effectivePaidAmount;
  } else if (new_status === 'Unpaid') {
    updateSet.status = 'Unpaid'; updateSet.paid_at = null; updateSet.marked_by = null; updateSet.paid_amount = 0;
  } else if (new_status === 'Waived') {
    updateSet.status = 'Waived'; updateSet.paid_at = null; updateSet.marked_by = null; updateSet.paid_amount = 0;
  } else {
    if (new_paid_amount != null) updateSet.paid_amount = new_paid_amount;
  }
  if (notes != null) updateSet.notes = notes;

  await db.update(payments).set(updateSet).where(eq(payments.id, payment_id));

  if (new_status === 'Paid') {
    await insertActivity({
      group_id,
      event_type: 'PAYMENT_MARKED',
      actor_id:   paymentRow.member_user_id,
      data: {
        amount:      effectivePaidAmount,
        month_label: paymentRow.month_label,
      },
    });

    notify({
      user_id:  paymentRow.member_user_id,
      group_id,
      type:     'PAYMENT_RECEIVED',
      title:    'Payment confirmed',
      body:     `${paiseToRupeeDisplay(effectivePaidAmount)} received for ${paymentRow.month_label}.`,
      data:     { cycle_id: paymentRow.cycle_id, month_label: paymentRow.month_label, paid_amount: effectivePaidAmount },
    }).catch(() => {});
  }

  const [updated] = await db
    .select({ id: payments.id, status: payments.status, paid_amount: payments.paid_amount, paid_at: payments.paid_at })
    .from(payments).where(eq(payments.id, payment_id)).limit(1);

  return { payment_id: updated.id, status: updated.status, paid_amount: updated.paid_amount, paid_at: updated.paid_at };
}

/**
 * Marks many payments to a target status in one transaction (admin only), skipping any already in that status or outside the cycle.
 *
 * @param userId - The requesting admin, recorded as `marked_by` when marking Paid
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Cycle whose payments are being marked
 * @param data - Bulk operation parameters
 * @param data.payment_ids - Explicit payment ids, or the literal `'all_unpaid'` to target every unpaid payment in the cycle
 * @param data.status - Target status: `'Paid'`, `'Unpaid'`, or `'Waived'`
 * @param data.paid_at - ISO timestamp applied when marking Paid; defaults to now
 * @returns A promise resolving to the updated count and the list of skipped ids
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 400 INVALID_STATUS for an unknown target status
 * @throws {AppError} 404 CYCLE_NOT_FOUND or 409 CYCLE_CLOSED on cycle issues
 */
export async function bulkMarkPayments(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { payment_ids: string[] | 'all_unpaid'; status: string; paid_at?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { payment_ids, status: target_status, paid_at } = data;

  const validStatuses = ['Paid', 'Unpaid', 'Waived'];
  if (!validStatuses.includes(target_status)) {
    throw new AppError(400, 'INVALID_STATUS', `status must be one of: ${validStatuses.join(', ')}.`);
  }

  const [cycleRow] = await db
    .select({ id: monthly_cycles.id, status: monthly_cycles.status })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1);

  if (!cycleRow)                        throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');
  if (cycleRow.status === 'Closed')      throw new AppError(409, 'CYCLE_CLOSED',    'Cannot edit payments for a closed cycle.');

  let targetIds: string[];
  if (payment_ids === 'all_unpaid') {
    const rows = await db.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.cycle_id, cycle_id), eq(payments.status, 'Unpaid')));
    targetIds = rows.map(r => r.id);
  } else {
    targetIds = payment_ids;
  }

  if (targetIds.length === 0) return { data: { updated_count: 0, skipped: [] } };

  const existing = await db
    .select({ id: payments.id, status: payments.status, cycle_id: payments.cycle_id, expected_amount: payments.expected_amount })
    .from(payments)
    .where(inArray(payments.id, targetIds));

  const toUpdate = existing.filter(p => p.cycle_id === cycle_id && p.status !== target_status);
  const skipped  = targetIds.filter(id => !toUpdate.some(p => p.id === id));

  if (toUpdate.length === 0) return { data: { updated_count: 0, skipped } };

  const now    = new Date();
  const paidAt = paid_at ? new Date(paid_at) : now;

  await db.transaction(async (tx) => {
    for (const p of toUpdate) {
      if (target_status === 'Paid') {
        await tx.update(payments)
          .set({ status: 'Paid', paid_at: paidAt, marked_by: userId, paid_amount: Number(p.expected_amount) })
          .where(eq(payments.id, p.id));
      } else if (target_status === 'Unpaid') {
        await tx.update(payments)
          .set({ status: 'Unpaid', paid_at: null, marked_by: null, paid_amount: 0 })
          .where(eq(payments.id, p.id));
      } else {
        await tx.update(payments)
          .set({ status: 'Waived', paid_at: null, marked_by: null })
          .where(eq(payments.id, p.id));
      }
    }
  });

  if (target_status === 'Paid') {
    const [cycleInfo] = await db
      .select({ month_label: monthly_cycles.month_label })
      .from(monthly_cycles).where(eq(monthly_cycles.id, cycle_id)).limit(1);
    await insertActivity({
      group_id,
      event_type: 'PAYMENT_MARKED',
      actor_id:   userId,
      data: { bulk: true, count: toUpdate.length, month_label: cycleInfo?.month_label ?? '' },
    });
  }

  return { data: { updated_count: toUpdate.length, skipped } };
}

/**
 * Sends a payment reminder to every unpaid member of a cycle (admin only), de-duplicating anyone already reminded for this cycle today.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to; must not be closed
 * @param cycle_id - Cycle whose defaulters to remind
 * @param data - Reminder options
 * @param data.channels - Delivery channels to record on the notification (defaults to `['push']`)
 * @returns A promise resolving to the count of reminders sent and any failures
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 GROUP_NOT_FOUND / CYCLE_NOT_FOUND or 409 GROUP_CLOSED on invalid state
 */
export async function remindDefaulters(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { channels?: string[] },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [groupRow] = await db.select({ status: chit_groups.status })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);
  if (!groupRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (groupRow.status === 'Closed') throw new AppError(409, 'GROUP_CLOSED', 'This group is closed.');

  const [cycleRow] = await db
    .select({ id: monthly_cycles.id, month_label: monthly_cycles.month_label })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1);

  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const defaulters = await db
    .select({ user_id: payments.member_user_id })
    .from(payments)
    .where(and(eq(payments.cycle_id, cycle_id), eq(payments.status, 'Unpaid')));

  if (defaulters.length === 0) return { data: { reminders_sent: 0, failed: [] } };

  // Deduplicate: skip any user who already received a DEFAULTER_REMINDER for
  // this cycle today (prevents duplicate rows when admin taps the button multiple times).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const alreadySent = await db
    .select({ user_id: notifications.user_id })
    .from(notifications)
    .where(and(
      inArray(notifications.user_id, defaulters.map(d => d.user_id)),
      eq(notifications.group_id, group_id),
      eq(notifications.type, 'DEFAULTER_REMINDER'),
      gte(notifications.created_at, startOfToday),
    ));

  const alreadySentSet = new Set(alreadySent.map(r => r.user_id));
  const toRemind = defaulters.filter(d => !alreadySentSet.has(d.user_id));

  if (toRemind.length === 0) return { data: { reminders_sent: 0, failed: [] } };

  const channels = data.channels ?? ['push'];
  await db.insert(notifications).values(
    toRemind.map(d => ({
      user_id:  d.user_id,
      group_id,
      type:     'DEFAULTER_REMINDER' as const,
      title:    'Payment Reminder',
      body:     `Your payment for ${cycleRow.month_label} is still outstanding. Please pay at the earliest.`,
      data:     { channels, cycle_id },
    })),
  );

  return { data: { reminders_sent: toRemind.length, failed: [] } };
}

/**
 * Returns a member's full payment history across the group's cycles (newest first); members may view their own, admins may view anyone's.
 *
 * @param userId - The requesting user
 * @param group_id - Group whose cycles to report on
 * @param target_user_id - The member whose history is requested
 * @returns A promise resolving to the member's per-cycle payment rows with normalised amounts
 * @throws {AppError} 403 FORBIDDEN if a non-admin requests another member's history
 * @throws {AppError} 404 MEMBERSHIP_NOT_FOUND if the target has no membership in this group
 */
export async function memberPaymentHistory(
  userId:          string,
  group_id:        string,
  target_user_id:  string,
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin' && userId !== target_user_id) {
    throw new AppError(403, 'FORBIDDEN', 'You can only view your own payment history.');
  }

  const [targetMembership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, target_user_id)))
    .limit(1);

  if (!targetMembership) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'No membership found for this user in the group.');

  const rows = await db
    .select({
      payment_id:        payments.id,
      cycle_month_label: monthly_cycles.month_label,
      expected_amount:   payments.expected_amount,
      paid_amount:       payments.paid_amount,
      status:            payments.status,
      paid_at:           payments.paid_at,
      is_skip_month:     monthly_cycles.is_skip_month,
    })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), eq(monthly_cycles.group_id, group_id)))
    .where(eq(payments.member_user_id, target_user_id))
    .orderBy(desc(monthly_cycles.month_number));

  return rows.map(r => ({
    payment_id:        r.payment_id,
    cycle_month_label: r.cycle_month_label,
    expected_amount:   Number(r.expected_amount),
    paid_amount:       Number(r.paid_amount),
    status:            r.status,
    paid_at:           r.paid_at,
    is_skip_month:     r.is_skip_month,
  }));
}
