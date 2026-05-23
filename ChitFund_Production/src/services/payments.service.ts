// Business logic for payment tracking.
// Responsibilities: mark payment paid/unpaid (with audit log), bulk-update,
// validate paid_amount does not exceed expected_amount, enforce cycle-not-closed
// guard before edits. All money arithmetic done in integer paise — never floats.

import { eq, and, desc, inArray, gte } from 'drizzle-orm';
import { db } from '../config/db';
import { chit_groups, memberships, monthly_cycles, payments, users, notifications } from '../db/schema';
import { AppError } from '../utils/AppError';
import { paiseToRupeeDisplay } from '../utils/money';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';


// ─── listPayments ────────────────────────────────────────────────────────────
export async function listPayments(
  userId:   string,
  group_id: string,
  cycle_id: string,
  filters:  { status?: string },
) {
  await assertActiveMember(group_id, userId);

  const [cycleRow] = await db
    .select({ id: monthly_cycles.id, status: monthly_cycles.status })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1);

  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const allPayments = await db
    .select({
      id: payments.id, member_user_id: payments.member_user_id, member_name: users.name,
      share_count: memberships.share_count, expected_amount: payments.expected_amount,
      paid_amount: payments.paid_amount, status: payments.status,
      paid_at: payments.paid_at, marked_by: payments.marked_by, notes: payments.notes,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.member_user_id))
    .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
    .where(eq(payments.cycle_id, cycle_id));

  const total_expected = allPayments.reduce((s, p) => s + Number(p.expected_amount), 0);
  const total_paid     = allPayments.reduce((s, p) => s + Number(p.paid_amount),     0);
  const paid_count     = allPayments.filter(p => p.status === 'Paid').length;
  const unpaid_count   = allPayments.filter(p => p.status === 'Unpaid').length;
  const waived_count   = allPayments.filter(p => p.status === 'Waived').length;

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
    summary: { total_expected, total_paid, paid_count, unpaid_count, waived_count },
  };
}

// ─── updatePayment ───────────────────────────────────────────────────────────
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
    updateSet.status = 'Waived'; updateSet.paid_at = null; updateSet.marked_by = null;
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

// ─── bulkMarkPayments ────────────────────────────────────────────────────────
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

// ─── remindDefaulters ────────────────────────────────────────────────────────
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

// ─── memberPaymentHistory ────────────────────────────────────────────────────
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
