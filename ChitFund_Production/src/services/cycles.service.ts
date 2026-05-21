// Business logic for monthly cycle management.
// Responsibilities: record winner + bid (validate eligibility, compute winner_takeaway,
// write CREDIT_DISCOUNT basket transaction, increment wins_count), declare skip-month
// (validate basket balance ≥ pool, validate no payments collected yet, set all payments
// to Waived, write DEBIT_SKIP_MONTH), close cycle.

import { eq, and, desc, sum, count, sql, inArray, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../config/db';
import {
  chit_groups, memberships, monthly_cycles,
  payments, baskets, basket_transactions, users, loans, loan_transactions,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { paiseToRupeeDisplay } from '../utils/money';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';

// ─── listCycles ──────────────────────────────────────────────────────────────
export async function listCycles(
  userId:   string,
  group_id: string,
  filters:  { status?: string },
) {
  await assertActiveMember(group_id, userId);

  const cycleConditions = [eq(monthly_cycles.group_id, group_id)];
  if (filters.status === 'open')   cycleConditions.push(eq(monthly_cycles.status, 'Open'));
  if (filters.status === 'closed') cycleConditions.push(eq(monthly_cycles.status, 'Closed'));

  const [cycleRows, paidAggs, totalAggs] = await Promise.all([
    db.select({
      id: monthly_cycles.id, month_number: monthly_cycles.month_number,
      month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date,
      status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month,
      winner_user_id: monthly_cycles.winner_user_id, winner_name: users.name,
      bid_amount: monthly_cycles.bid_amount, admin_commission: monthly_cycles.admin_commission,
      basket_credit: monthly_cycles.basket_credit, winner_takeaway: monthly_cycles.winner_takeaway,
    })
    .from(monthly_cycles)
    .leftJoin(users, eq(users.id, monthly_cycles.winner_user_id))
    .where(and(...cycleConditions))
    .orderBy(desc(monthly_cycles.month_number)),

    db.select({ cycle_id: payments.cycle_id, collected_amount: sum(payments.paid_amount), paid_count: count(payments.id) })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(payments.status, 'Paid')))
      .groupBy(payments.cycle_id),

    db.select({ cycle_id: payments.cycle_id, total_count: count(payments.id), expected_amount: sum(payments.expected_amount) })
      .from(payments)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, payments.cycle_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .groupBy(payments.cycle_id),
  ]);

  const paidMap  = new Map(paidAggs.map(r => [r.cycle_id, r]));
  const totalMap = new Map(totalAggs.map(r => [r.cycle_id, r]));

  return cycleRows.map(c => ({
    cycle_id:         c.id,
    month_number:     c.month_number,
    month_label:      c.month_label,
    due_date:         c.due_date,
    status:           c.status,
    is_skip_month:    c.is_skip_month,
    winner:           c.winner_user_id ? { user_id: c.winner_user_id, name: c.winner_name } : null,
    bid_amount:       c.bid_amount,
    admin_commission: c.admin_commission,
    basket_credit:    c.basket_credit,
    winner_takeaway:  c.winner_takeaway,
    collected_amount: Number(paidMap.get(c.id)?.collected_amount  ?? 0),
    paid_count:       Number(paidMap.get(c.id)?.paid_count         ?? 0),
    total_count:      Number(totalMap.get(c.id)?.total_count        ?? 0),
    expected_amount:  Number(totalMap.get(c.id)?.expected_amount    ?? 0),
  }));
}

// ─── getCycle ────────────────────────────────────────────────────────────────
export async function getCycle(userId: string, group_id: string, cycle_id: string) {
  await assertActiveMember(group_id, userId);

  const markerUser   = alias(users, 'marker');
  const recorderUser = alias(users, 'recorder');

  const [cycleRows, paymentRows, cycleTxnRows, basketRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, month_number: monthly_cycles.month_number,
      month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date,
      status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month,
      winner_user_id: monthly_cycles.winner_user_id, winner_name: users.name,
      bid_amount: monthly_cycles.bid_amount, admin_commission: monthly_cycles.admin_commission,
      basket_credit: monthly_cycles.basket_credit, winner_takeaway: monthly_cycles.winner_takeaway,
      notes: monthly_cycles.notes, opened_at: monthly_cycles.opened_at, closed_at: monthly_cycles.closed_at,
    })
    .from(monthly_cycles)
    .leftJoin(users, eq(users.id, monthly_cycles.winner_user_id))
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({
      payment_id: payments.id, member_user_id: payments.member_user_id,
      member_name: users.name, share_count: memberships.share_count,
      expected_amount: payments.expected_amount, paid_amount: payments.paid_amount,
      status: payments.status, paid_at: payments.paid_at,
      marked_by_name: markerUser.name, notes: payments.notes,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.member_user_id))
    .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
    .leftJoin(markerUser, eq(markerUser.id, payments.marked_by))
    .where(eq(payments.cycle_id, cycle_id)),

    // Basket transaction for this cycle — gives us recorded_by/at and basket impact anchor
    db.select({
      id: basket_transactions.id,
      amount: basket_transactions.amount, direction: basket_transactions.direction,
      created_at: basket_transactions.created_at, created_by: basket_transactions.created_by,
      recorder_name: recorderUser.name, basket_id: basket_transactions.basket_id,
    })
    .from(basket_transactions)
    .innerJoin(baskets, eq(baskets.id, basket_transactions.basket_id))
    .leftJoin(recorderUser, eq(recorderUser.id, basket_transactions.created_by))
    .where(and(
      eq(baskets.group_id, group_id),
      eq(basket_transactions.cycle_id, cycle_id),
      inArray(basket_transactions.txn_type, ['CREDIT_DISCOUNT', 'DEBIT_SKIP_MONTH']),
    ))
    .orderBy(basket_transactions.created_at)
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),
  ]);

  const cycleRow = cycleRows[0];
  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const cycleTxn = cycleTxnRows[0] ?? null;
  const basket   = basketRows[0]   ?? null;

  // Compute basket_impact by working backwards from current balance
  let basket_impact = null;
  if (cycleTxn && basket) {
    const [netAfterRow] = await db.select({
      net_change: sql<string>`COALESCE(SUM(CASE WHEN direction = 'C' THEN amount ELSE -amount END), 0)`,
    })
    .from(basket_transactions)
    .where(and(
      eq(basket_transactions.basket_id, cycleTxn.basket_id),
      gt(basket_transactions.created_at, cycleTxn.created_at),
    ));

    const net_after     = Number(netAfterRow.net_change);
    const balance_after = Number(basket.current_balance) - net_after;
    const delta         = cycleTxn.direction === 'C' ? Number(cycleTxn.amount) : -Number(cycleTxn.amount);
    const balance_before = balance_after - delta;

    basket_impact = {
      balance_before,
      balance_after,
      delta,
      related_txn_id: cycleTxn.id,
    };
  }

  const now         = Date.now();
  const is_editable = cycleRow.status === 'Open' ||
    (cycleRow.status === 'Closed' && cycleRow.closed_at !== null &&
      now - cycleRow.closed_at.getTime() < 24 * 60 * 60 * 1000);

  const collected_amount = paymentRows.reduce((s, p) => s + (p.status === 'Paid' ? Number(p.paid_amount) : 0), 0);
  const paid_count       = paymentRows.filter(p => p.status === 'Paid').length;
  const total_count      = paymentRows.length;

  return {
    cycle_id:        cycleRow.id,
    month_number:    cycleRow.month_number,
    month_label:     cycleRow.month_label,
    due_date:        cycleRow.due_date,
    status:          cycleRow.status,
    is_skip_month:   cycleRow.is_skip_month,
    winner:           cycleRow.winner_user_id ? { user_id: cycleRow.winner_user_id, name: cycleRow.winner_name } : null,
    bid_amount:       cycleRow.bid_amount,
    admin_commission: cycleRow.admin_commission,
    basket_credit:    cycleRow.basket_credit,
    winner_takeaway:  cycleRow.winner_takeaway,
    notes:           cycleRow.notes,
    opened_at:       cycleRow.opened_at,
    closed_at:       cycleRow.closed_at,
    is_editable,
    recorded_by:     cycleTxn ? { user_id: cycleTxn.created_by, name: cycleTxn.recorder_name } : null,
    recorded_at:     cycleTxn?.created_at ?? null,
    basket_impact,
    collected_amount,
    paid_count,
    total_count,
    payments: paymentRows,
  };
}

// ─── recordWinner ────────────────────────────────────────────────────────────
export async function recordWinner(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; bid_amount: number; is_admin_withdrawal?: boolean; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id, bid_amount, is_admin_withdrawal = false, notes } = data;

  const [cycleRows, basketRows, winnerMemberRows, winnerActiveLoanRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month, winner_user_id: monthly_cycles.winner_user_id, pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate, month_label: monthly_cycles.month_label })
      .from(monthly_cycles)
      .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ share_count: memberships.share_count, wins_count: memberships.wins_count, role: memberships.role, admin_withdrawal_used: memberships.admin_withdrawal_used })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, winner_user_id), eq(memberships.status, 'Active')))
      .limit(1),

    db.select({ id: loans.id })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(eq(baskets.group_id, group_id), eq(loans.borrower_user_id, winner_user_id), eq(loans.status, 'Active')))
      .limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];

  if (!cycle)                        throw new AppError(404, 'CYCLE_NOT_FOUND',         'Cycle not found in this group.');
  if (cycle.status === 'Closed')     throw new AppError(409, 'CYCLE_CLOSED',            'Cycle is already closed.');
  if (cycle.winner_user_id !== null) throw new AppError(409, 'CYCLE_ALREADY_RECORDED', 'Winner already recorded. Use PATCH to edit within 24h.');

  const winner = winnerMemberRows[0];
  if (!winner || Number(winner.wins_count) >= Number(winner.share_count)) {
    throw new AppError(409, 'WINNER_INELIGIBLE', 'This member is not eligible to win (already won their share allocation).');
  }
  const hasActiveLoan   = !!winnerActiveLoanRows[0];
  const pool_amount_num = Number(cycle.pool_amount);
  const commission_rate = parseFloat(String(cycle.admin_commission_rate));

  if (is_admin_withdrawal) {
    if (winner.role !== 'Admin')       throw new AppError(400, 'NOT_ADMIN',             'Admin withdrawal can only be used when the winner is the group admin.');
    if (winner.admin_withdrawal_used)  throw new AppError(409, 'WITHDRAWAL_ALREADY_USED', 'The admin withdrawal (special share) has already been used for this group.');
  }

  // Admin withdrawal: full pool to admin, no commission, nothing to basket
  let stored_bid: number, admin_commission: number, basket_credit: number, winner_takeaway: number, basket_balance_after: number;
  if (is_admin_withdrawal) {
    stored_bid           = 0;
    admin_commission     = 0;
    basket_credit        = 0;
    winner_takeaway      = pool_amount_num;
    basket_balance_after = Number(basket.current_balance);
  } else {
    if (bid_amount <= 0)               throw new AppError(400, 'BID_NEGATIVE_OR_ZERO', 'bid_amount must be greater than 0.');
    if (bid_amount > pool_amount_num)  throw new AppError(400, 'BID_EXCEEDS_POOL',     'bid_amount cannot exceed the group pool amount.');
    stored_bid           = bid_amount;
    admin_commission     = Math.round(pool_amount_num * commission_rate / 100);
    basket_credit        = bid_amount - admin_commission;
    winner_takeaway      = pool_amount_num - bid_amount;
    basket_balance_after = Number(basket.current_balance) + basket_credit;
  }

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles)
      .set({ winner_user_id, bid_amount: stored_bid, admin_commission, basket_credit, winner_takeaway, ...(notes ? { notes } : {}) })
      .where(eq(monthly_cycles.id, cycle_id));

    if (!is_admin_withdrawal) {
      await tx.update(baskets)
        .set({ current_balance: basket_balance_after })
        .where(eq(baskets.id, basket.id));

      await tx.insert(basket_transactions).values({
        basket_id:            basket.id,
        cycle_id,
        txn_type:             'CREDIT_DISCOUNT',
        amount:               basket_credit,
        direction:            'C',
        counterparty_user_id: winner_user_id,
        notes:                notes ?? 'Cycle bid savings',
        created_by:           userId,
      });
    }

    await tx.update(memberships)
      .set({
        wins_count: Number(winner.wins_count) + 1,
        ...(is_admin_withdrawal ? { admin_withdrawal_used: true } : {}),
      })
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, winner_user_id)));
  });

  const [freshBasket] = await db
    .select({ current_balance: baskets.current_balance })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  await insertActivity({
    group_id,
    event_type: 'WINNER_RECORDED',
    actor_id:   winner_user_id,
    data: {
      month_label:      cycle.month_label,
      bid_amount:       stored_bid,
      admin_commission,
      basket_credit,
      winner_takeaway,
    },
  });

  const [activeMembers, [winnerRow]] = await Promise.all([
    db.select({ user_id: memberships.user_id })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
    db.select({ name: users.name })
      .from(users).where(eq(users.id, winner_user_id)).limit(1),
  ]);

  const winnerName = winnerRow?.name ?? 'A member';
  const title      = `Winner announced — ${cycle.month_label}`;
  const body       = is_admin_withdrawal
    ? `${winnerName} (admin) withdrew the full pool of ${paiseToRupeeDisplay(pool_amount_num)}.`
    : `${winnerName} won with a bid of ${paiseToRupeeDisplay(stored_bid)}.`;

  Promise.all(
    activeMembers.map(m => notify({
      user_id:  m.user_id,
      group_id,
      type:     'WINNER_ANNOUNCED',
      title,
      body,
      data:     { cycle_id, month_label: cycle.month_label, winner_user_id, winner_name: winnerName, bid_amount: stored_bid, basket_credit },
    })),
  ).catch(() => {});

  return {
    cycle_id,
    winner_user_id,
    bid_amount:      stored_bid,
    admin_commission,
    basket_credit,
    winner_takeaway,
    basket_balance_after: freshBasket.current_balance,
    warnings: hasActiveLoan
      ? ['This member has an active loan. The admin should ensure it is settled.']
      : [],
  };
}

// ─── declareSkipMonth ────────────────────────────────────────────────────────
export async function declareSkipMonth(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id, notes } = data;

  const [cycleRows, basketRows, paidPayment, winnerMemberRows, winnerActiveLoanRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, pool_amount: chit_groups.pool_amount, month_label: monthly_cycles.month_label })
      .from(monthly_cycles)
      .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.cycle_id, cycle_id), eq(payments.status, 'Paid')))
      .limit(1),

    db.select({ share_count: memberships.share_count, wins_count: memberships.wins_count })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, winner_user_id), eq(memberships.status, 'Active')))
      .limit(1),

    db.select({ id: loans.id })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(eq(baskets.group_id, group_id), eq(loans.borrower_user_id, winner_user_id), eq(loans.status, 'Active')))
      .limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',             'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',               'Cycle is already closed.');
  if (paidPayment[0])            throw new AppError(409, 'PAYMENTS_ALREADY_COLLECTED', 'Some members have already paid; cannot declare skip month.');

  const winner = winnerMemberRows[0];
  if (!winner || Number(winner.wins_count) >= Number(winner.share_count)) {
    throw new AppError(409, 'WINNER_INELIGIBLE', 'This member is not eligible to win.');
  }
  const skipHasActiveLoan = !!winnerActiveLoanRows[0];

  const pool_amount  = Number(cycle.pool_amount);
  if (Number(basket.current_balance) < pool_amount) {
    throw new AppError(409, 'BASKET_INSUFFICIENT', 'Basket balance is below the pool amount required for a skip month.');
  }

  const balance_after = Number(basket.current_balance) - pool_amount;

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles)
      .set({ is_skip_month: true, winner_user_id, bid_amount: 0, admin_commission: 0, basket_credit: 0, winner_takeaway: pool_amount, ...(notes ? { notes } : {}) })
      .where(eq(monthly_cycles.id, cycle_id));

    await tx.update(baskets)
      .set({ current_balance: balance_after })
      .where(eq(baskets.id, basket.id));

    await tx.insert(basket_transactions).values({
      basket_id:            basket.id,
      cycle_id,
      txn_type:             'DEBIT_SKIP_MONTH',
      amount:               pool_amount,
      direction:            'D',
      counterparty_user_id: winner_user_id,
      notes:                notes ?? 'Skip month — basket paid full pool to winner',
      created_by:           userId,
    });

    await tx.update(memberships)
      .set({ wins_count: Number(winner.wins_count) + 1 })
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, winner_user_id)));
  });

  await insertActivity({
    group_id,
    event_type: 'SKIP_MONTH_DECLARED',
    actor_id:   winner_user_id,
    data: {
      month_label:     cycle.month_label,
      winner_takeaway: pool_amount,
    },
  });

  return {
    cycle_id, is_skip_month: true, winner_user_id, winner_takeaway: pool_amount,
    basket_debit: pool_amount, basket_balance_after: balance_after,
    warnings: skipHasActiveLoan
      ? ['This member has an active loan. The admin should ensure it is settled.']
      : [],
  };
}

// ─── updateCycle ─────────────────────────────────────────────────────────────
export async function updateCycle(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { bid_amount: number; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { bid_amount: new_bid, notes } = data;

  const [cycleRows, basketRows, originalTxnRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month, winner_user_id: monthly_cycles.winner_user_id, bid_amount: monthly_cycles.bid_amount, basket_credit: monthly_cycles.basket_credit, pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate })
      .from(monthly_cycles)
      .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: basket_transactions.id, created_at: basket_transactions.created_at })
      .from(basket_transactions)
      .where(and(eq(basket_transactions.cycle_id, cycle_id), eq(basket_transactions.txn_type, 'CREDIT_DISCOUNT')))
      .orderBy(desc(basket_transactions.created_at))
      .limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];
  const origTxn = originalTxnRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',   'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',      'Cannot edit a closed cycle.');
  if (cycle.is_skip_month)       throw new AppError(409, 'INVALID_REQUEST',   'Skip-month cycles cannot be edited via this endpoint.');
  if (!cycle.winner_user_id)     throw new AppError(409, 'INVALID_REQUEST',   'No winner has been recorded yet. Use POST .../record-winner first.');
  if (!origTxn)                  throw new AppError(409, 'INVALID_REQUEST',   'Cannot find the original basket transaction for this cycle.');

  if (origTxn.created_at! < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    throw new AppError(409, 'EDIT_WINDOW_EXPIRED', 'The 24-hour edit window has passed for this cycle.');
  }
  if (new_bid <= 0)                           throw new AppError(400, 'BID_NEGATIVE_OR_ZERO', 'bid_amount must be > 0.');
  if (new_bid > Number(cycle.pool_amount))    throw new AppError(400, 'BID_EXCEEDS_POOL',     'bid_amount cannot exceed pool_amount.');

  const commission_rate     = parseFloat(String(cycle.admin_commission_rate));
  const new_commission      = Math.round(Number(cycle.pool_amount) * commission_rate / 100);
  const new_basket_credit   = new_bid - new_commission;
  const old_basket_credit   = Number(cycle.basket_credit);
  const credit_delta        = new_basket_credit - old_basket_credit;
  const new_takeaway        = Number(cycle.pool_amount) - new_bid;
  const balance_after       = Number(basket.current_balance) + credit_delta;

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles)
      .set({ bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, ...(notes != null ? { notes } : {}) })
      .where(eq(monthly_cycles.id, cycle_id));

    if (credit_delta !== 0) {
      await tx.update(baskets).set({ current_balance: balance_after }).where(eq(baskets.id, basket.id));
      await tx.insert(basket_transactions).values({
        basket_id:  basket.id,
        cycle_id,
        txn_type:   'ADJUSTMENT',
        amount:     Math.abs(credit_delta),
        direction:  credit_delta > 0 ? 'C' : 'D',
        notes:      `Bid correction: basket_credit ${old_basket_credit} → ${new_basket_credit}`,
        created_by: userId,
      });
    }
  });

  return { cycle_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, winner_user_id: cycle.winner_user_id, basket_balance_after: balance_after };
}

// ─── correctClosedCycle ───────────────────────────────────────────────────────
// Allows an admin to fix a wrong winner or wrong bid amount on a closed cycle.
// Atomically rolls back the old basket transaction + wins_count adjustment, then
// applies the corrected values. Works for both regular and skip-month cycles.
export async function correctClosedCycle(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; bid_amount?: number; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id: new_winner_id, bid_amount: new_bid, notes } = data;

  const [cycleRows, basketRows, oldTxnRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, status: monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
      winner_user_id: monthly_cycles.winner_user_id,
      bid_amount: monthly_cycles.bid_amount,
      basket_credit: monthly_cycles.basket_credit,
      month_label: monthly_cycles.month_label,
      pool_amount: chit_groups.pool_amount,
      admin_commission_rate: chit_groups.admin_commission_rate,
    })
    .from(monthly_cycles)
    .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: basket_transactions.id, amount: basket_transactions.amount, txn_type: basket_transactions.txn_type })
      .from(basket_transactions)
      .innerJoin(baskets, eq(baskets.id, basket_transactions.basket_id))
      .where(and(
        eq(baskets.group_id, group_id),
        eq(basket_transactions.cycle_id, cycle_id),
        inArray(basket_transactions.txn_type, ['CREDIT_DISCOUNT', 'DEBIT_SKIP_MONTH']),
      ))
      .orderBy(desc(basket_transactions.created_at))
      .limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];
  const oldTxn = oldTxnRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',  'Cycle not found in this group.');
  if (cycle.status !== 'Closed') throw new AppError(409, 'CYCLE_NOT_CLOSED', 'Only closed cycles can be corrected via this endpoint.');
  if (!oldTxn)                   throw new AppError(409, 'INVALID_STATE',    'No original basket transaction found for this cycle.');

  const old_winner_id  = cycle.winner_user_id!;
  const winner_changed = old_winner_id !== new_winner_id;

  if (winner_changed) {
    const [newMember] = await db.select({ share_count: memberships.share_count, wins_count: memberships.wins_count })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, new_winner_id), eq(memberships.status, 'Active')))
      .limit(1);

    if (!newMember) throw new AppError(404, 'MEMBER_NOT_FOUND', 'New winner is not an active member of this group.');
    if (Number(newMember.wins_count) >= Number(newMember.share_count)) {
      throw new AppError(409, 'WINNER_INELIGIBLE', 'New winner has already used all their share allocations.');
    }
  }

  // ── Regular month ────────────────────────────────────────────────────────────
  if (!cycle.is_skip_month) {
    if (!new_bid || new_bid <= 0)               throw new AppError(400, 'BID_REQUIRED',     'bid_amount is required for a non-skip-month correction.');
    if (new_bid > Number(cycle.pool_amount))    throw new AppError(400, 'BID_EXCEEDS_POOL', 'bid_amount cannot exceed the group pool amount.');

    const commission_rate    = parseFloat(String(cycle.admin_commission_rate));
    const new_commission     = Math.round(Number(cycle.pool_amount) * commission_rate / 100);
    const new_basket_credit  = new_bid - new_commission;
    const new_winner_takeaway = Number(cycle.pool_amount) - new_bid;
    const old_basket_credit  = Number(cycle.basket_credit);
    const credit_delta       = new_basket_credit - old_basket_credit;
    const new_balance        = Number(basket.current_balance) + credit_delta;

    await db.transaction(async (tx) => {
      await tx.update(monthly_cycles)
        .set({ winner_user_id: new_winner_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_winner_takeaway, ...(notes != null ? { notes } : {}) })
        .where(eq(monthly_cycles.id, cycle_id));

      if (credit_delta !== 0) {
        await tx.update(baskets).set({ current_balance: new_balance }).where(eq(baskets.id, basket.id));
        await tx.insert(basket_transactions).values({
          basket_id:  basket.id, cycle_id,
          txn_type:   'ADJUSTMENT',
          amount:     Math.abs(credit_delta),
          direction:  credit_delta > 0 ? 'C' : 'D',
          notes:      `Correction: basket_credit ${old_basket_credit} → ${new_basket_credit}`,
          created_by: userId,
        });
      }

      if (winner_changed) {
        const [[oldMember], [newMember]] = await Promise.all([
          tx.select({ wins_count: memberships.wins_count }).from(memberships)
            .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, old_winner_id))).limit(1),
          tx.select({ wins_count: memberships.wins_count }).from(memberships)
            .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, new_winner_id))).limit(1),
        ]);
        await tx.update(memberships)
          .set({ wins_count: Math.max(0, Number(oldMember.wins_count) - 1) })
          .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, old_winner_id)));
        await tx.update(memberships)
          .set({ wins_count: Number(newMember.wins_count) + 1 })
          .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, new_winner_id)));
      }
    });

    await insertActivity({
      group_id, event_type: 'CYCLE_CORRECTED', actor_id: userId,
      data: { month_label: cycle.month_label, old_winner_id, new_winner_id, old_bid_amount: cycle.bid_amount, new_bid_amount: new_bid },
    });

    return { cycle_id, winner_user_id: new_winner_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_winner_takeaway, basket_balance_after: credit_delta !== 0 ? new_balance : Number(basket.current_balance) };
  }

  // ── Skip month (winner change only — basket net change is zero) ───────────────
  const pool_amount = Number(cycle.pool_amount);

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles)
      .set({ winner_user_id: new_winner_id, ...(notes != null ? { notes } : {}) })
      .where(eq(monthly_cycles.id, cycle_id));

    if (winner_changed) {
      // Reverse the old DEBIT_SKIP_MONTH then re-apply for the new winner (audit trail only; net = 0)
      await tx.insert(basket_transactions).values([
        { basket_id: basket.id, cycle_id, txn_type: 'ADJUSTMENT', amount: pool_amount, direction: 'C', counterparty_user_id: old_winner_id, notes: 'Skip month correction: reversing old debit', created_by: userId },
        { basket_id: basket.id, cycle_id, txn_type: 'ADJUSTMENT', amount: pool_amount, direction: 'D', counterparty_user_id: new_winner_id, notes: 'Skip month correction: re-applying debit for corrected winner', created_by: userId },
      ]);

      const [[oldMember], [newMember]] = await Promise.all([
        tx.select({ wins_count: memberships.wins_count }).from(memberships)
          .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, old_winner_id))).limit(1),
        tx.select({ wins_count: memberships.wins_count }).from(memberships)
          .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, new_winner_id))).limit(1),
      ]);
      await tx.update(memberships)
        .set({ wins_count: Math.max(0, Number(oldMember.wins_count) - 1) })
        .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, old_winner_id)));
      await tx.update(memberships)
        .set({ wins_count: Number(newMember.wins_count) + 1 })
        .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, new_winner_id)));
    }
  });

  await insertActivity({
    group_id, event_type: 'CYCLE_CORRECTED', actor_id: userId,
    data: { month_label: cycle.month_label, is_skip_month: true, old_winner_id, new_winner_id },
  });

  return { cycle_id, is_skip_month: true, winner_user_id: new_winner_id, winner_takeaway: pool_amount, basket_balance_after: Number(basket.current_balance) };
}

// ─── closeCycle ──────────────────────────────────────────────────────────────
export async function closeCycle(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [cycleRows, unpaidProbe, groupRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, winner_user_id: monthly_cycles.winner_user_id, is_skip_month: monthly_cycles.is_skip_month, due_date: monthly_cycles.due_date })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ name: users.name, expected_amount: payments.expected_amount })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .where(and(eq(payments.cycle_id, cycle_id), eq(payments.status, 'Unpaid'))),

    db.select({ monthly_contribution: chit_groups.monthly_contribution })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycle = cycleRows[0];
  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',      'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_ALREADY_CLOSED', 'Cycle is already closed.');
  if (unpaidProbe.length > 0) {
    const list = unpaidProbe
      .map(p => `${p.name} (₹${(Number(p.expected_amount) / 100).toLocaleString('en-IN')})`)
      .join(', ');
    throw new AppError(409, 'PAYMENTS_OUTSTANDING', `Unpaid: ${list}`);
  }
  if (!cycle.is_skip_month && !cycle.winner_user_id)
    throw new AppError(409, 'WINNER_NOT_RECORDED', 'Record the bid winner before closing this cycle.');

  const closedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles).set({ status: 'Closed', closed_at: closedAt }).where(eq(monthly_cycles.id, cycle_id));

    const nextMonthNumber = Number(cycle.month_number) + 1;
    const [nextCycle] = await tx
      .select({ id: monthly_cycles.id })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, nextMonthNumber)))
      .limit(1);

    if (nextCycle) {
      const [alreadyExists] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.cycle_id, nextCycle.id)).limit(1);
      if (!alreadyExists) {
        const activeMembers = await tx
          .select({ user_id: memberships.user_id, share_count: memberships.share_count })
          .from(memberships)
          .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active')));

        const contribution = Number(groupRows[0].monthly_contribution);
        await tx.insert(payments).values(
          activeMembers.map(m => ({
            cycle_id:        nextCycle.id,
            member_user_id:  m.user_id,
            expected_amount: contribution * Number(m.share_count),
          })),
        );
      }
    }
  });

  await insertActivity({
    group_id,
    event_type: 'CYCLE_CLOSED',
    actor_id:   userId,
    data: { month_label: cycle.month_label },
  });

  return { cycle_id, status: 'Closed', closed_at: closedAt };
}
