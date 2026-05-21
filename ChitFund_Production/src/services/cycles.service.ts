// Business logic for monthly cycle management.
// Bid/winner data lives in cycle_winners (supports X Chiti: multiple winners per cycle).
// X Chiti eligibility: x_chiti = floor(total_basket / pool_amount),
//   total_basket = realized (current_balance) + unrealized (outstanding loan principals + accrued interest owed).

import { eq, and, desc, sum, count, sql, inArray, gt } from 'drizzle-orm';
import { db } from '../config/db';
import {
  chit_groups, memberships, monthly_cycles, cycle_winners,
  payments, baskets, basket_transactions, users, loans,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { paiseToRupeeDisplay } from '../utils/money';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';

// ─── helpers ─────────────────────────────────────────────────────────────────

function chitiLabel(x: number): string {
  if (x === 2) return 'Double Chiti';
  if (x === 3) return 'Triple Chiti';
  if (x === 4) return 'Quadruple Chiti';
  return `${x}× Chiti`;
}

// outstanding interest for a loan: cycles_elapsed × monthly_interest − total_interest_paid
function computeOutstandingInterest(cyclesElapsed: number, principal: number, rate: number, totalInterestPaid: number): number {
  const monthlyInterest = Math.round(principal * rate / 100);
  return Math.max(0, cyclesElapsed * monthlyInterest - totalInterestPaid);
}

// ─── getChitiEligibility ─────────────────────────────────────────────────────
export async function getChitiEligibility(userId: string, group_id: string) {
  await assertActiveMember(group_id, userId);

  const [basketRows, groupRows, activeLoans, currentCycleRows] = await Promise.all([
    db.select({ current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ pool_amount: chit_groups.pool_amount })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({
      principal: loans.principal,
      monthly_interest_rate: loans.monthly_interest_rate,
      disbursement_month_number: loans.disbursement_month_number,
      total_interest_paid: loans.total_interest_paid,
    })
    .from(loans)
    .innerJoin(baskets, eq(baskets.id, loans.basket_id))
    .where(and(eq(baskets.group_id, group_id), eq(loans.status, 'Active'))),

    // current open cycle for month number
    db.select({ month_number: monthly_cycles.month_number })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
      .orderBy(monthly_cycles.month_number)
      .limit(1),
  ]);

  const basket     = basketRows[0];
  const group      = groupRows[0];
  if (!basket || !group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

  const realized   = Number(basket.current_balance);
  const pool       = Number(group.pool_amount);
  const currentMonth = currentCycleRows[0]?.month_number ?? 1;

  const unrealized = activeLoans.reduce((acc, loan) => {
    const cyclesElapsed = Math.max(0, currentMonth - Number(loan.disbursement_month_number) + 1);
    const outstandingInterest = computeOutstandingInterest(
      cyclesElapsed, Number(loan.principal), Number(loan.monthly_interest_rate), Number(loan.total_interest_paid),
    );
    return acc + Number(loan.principal) + outstandingInterest;
  }, 0);

  const total_basket = realized + unrealized;
  const x_chiti     = Math.max(1, Math.floor(total_basket / pool));
  const eligible     = x_chiti >= 2;

  return {
    realized,
    unrealized,
    total_basket,
    pool_amount: pool,
    x_chiti,
    label:    eligible ? chitiLabel(x_chiti) : '',
    eligible,
  };
}

// ─── listCycles ──────────────────────────────────────────────────────────────
export async function listCycles(userId: string, group_id: string, filters: { status?: string }) {
  await assertActiveMember(group_id, userId);

  const cycleConditions = [eq(monthly_cycles.group_id, group_id)];
  if (filters.status === 'open')   cycleConditions.push(eq(monthly_cycles.status, 'Open'));
  if (filters.status === 'closed') cycleConditions.push(eq(monthly_cycles.status, 'Closed'));

  const [cycleRows, paidAggs, totalAggs, winnerRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, month_number: monthly_cycles.month_number,
      month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date,
      status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month,
    })
    .from(monthly_cycles)
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

    db.select({
      cycle_id: cycle_winners.cycle_id,
      winner_number: cycle_winners.winner_number,
      winner_user_id: cycle_winners.winner_user_id,
      winner_name: users.name,
      bid_amount: cycle_winners.bid_amount,
      admin_commission: cycle_winners.admin_commission,
      basket_credit: cycle_winners.basket_credit,
      winner_takeaway: cycle_winners.winner_takeaway,
      is_admin_withdrawal: cycle_winners.is_admin_withdrawal,
    })
    .from(cycle_winners)
    .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
    .innerJoin(monthly_cycles, eq(monthly_cycles.id, cycle_winners.cycle_id))
    .where(eq(monthly_cycles.group_id, group_id))
    .orderBy(cycle_winners.cycle_id, cycle_winners.winner_number),
  ]);

  const paidMap    = new Map(paidAggs.map(r => [r.cycle_id, r]));
  const totalMap   = new Map(totalAggs.map(r => [r.cycle_id, r]));
  const winnersMap = new Map<string, typeof winnerRows>();
  for (const w of winnerRows) {
    const arr = winnersMap.get(w.cycle_id) ?? [];
    arr.push(w);
    winnersMap.set(w.cycle_id, arr);
  }

  return cycleRows.map(c => ({
    cycle_id:         c.id,
    month_number:     c.month_number,
    month_label:      c.month_label,
    due_date:         c.due_date,
    status:           c.status,
    is_skip_month:    c.is_skip_month,
    winners:          (winnersMap.get(c.id) ?? []).map(w => ({
      winner_number:       w.winner_number,
      user_id:             w.winner_user_id,
      name:                w.winner_name,
      bid_amount:          w.bid_amount,
      admin_commission:    w.admin_commission,
      basket_credit:       w.basket_credit,
      winner_takeaway:     w.winner_takeaway,
      is_admin_withdrawal: w.is_admin_withdrawal,
    })),
    collected_amount: Number(paidMap.get(c.id)?.collected_amount  ?? 0),
    paid_count:       Number(paidMap.get(c.id)?.paid_count         ?? 0),
    total_count:      Number(totalMap.get(c.id)?.total_count        ?? 0),
    expected_amount:  Number(totalMap.get(c.id)?.expected_amount    ?? 0),
  }));
}

// ─── getCycle ────────────────────────────────────────────────────────────────
export async function getCycle(userId: string, group_id: string, cycle_id: string) {
  await assertActiveMember(group_id, userId);

  const [cycleRows, paymentRows, cycleTxnRows, basketRows, winnerRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, month_number: monthly_cycles.month_number,
      month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date,
      status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month,
      notes: monthly_cycles.notes, opened_at: monthly_cycles.opened_at, closed_at: monthly_cycles.closed_at,
    })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({
      payment_id: payments.id, member_user_id: payments.member_user_id,
      member_name: users.name, share_count: memberships.share_count,
      expected_amount: payments.expected_amount, paid_amount: payments.paid_amount,
      status: payments.status, paid_at: payments.paid_at,
      marked_by_name: sql<string | null>`(SELECT name FROM users WHERE id = ${payments.marked_by})`,
      notes: payments.notes,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.member_user_id))
    .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
    .where(eq(payments.cycle_id, cycle_id)),

    db.select({
      id: basket_transactions.id,
      amount: basket_transactions.amount, direction: basket_transactions.direction,
      created_at: basket_transactions.created_at, created_by: basket_transactions.created_by,
      basket_id: basket_transactions.basket_id,
    })
    .from(basket_transactions)
    .innerJoin(baskets, eq(baskets.id, basket_transactions.basket_id))
    .where(and(
      eq(baskets.group_id, group_id),
      eq(basket_transactions.cycle_id, cycle_id),
      inArray(basket_transactions.txn_type, ['CREDIT_DISCOUNT', 'DEBIT_SKIP_MONTH']),
    ))
    .orderBy(basket_transactions.created_at)
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({
      winner_number: cycle_winners.winner_number,
      winner_user_id: cycle_winners.winner_user_id,
      winner_name: users.name,
      bid_amount: cycle_winners.bid_amount,
      admin_commission: cycle_winners.admin_commission,
      basket_credit: cycle_winners.basket_credit,
      winner_takeaway: cycle_winners.winner_takeaway,
      is_admin_withdrawal: cycle_winners.is_admin_withdrawal,
      notes: cycle_winners.notes,
      created_at: cycle_winners.created_at,
    })
    .from(cycle_winners)
    .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
    .where(eq(cycle_winners.cycle_id, cycle_id))
    .orderBy(cycle_winners.winner_number),
  ]);

  const cycleRow = cycleRows[0];
  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const cycleTxn = cycleTxnRows[0] ?? null;
  const basket   = basketRows[0]   ?? null;

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

    const net_after      = Number(netAfterRow.net_change);
    const balance_after  = Number(basket.current_balance) - net_after;
    const delta          = cycleTxn.direction === 'C' ? Number(cycleTxn.amount) : -Number(cycleTxn.amount);
    const balance_before = balance_after - delta;
    basket_impact = { balance_before, balance_after, delta, related_txn_id: cycleTxn.id };
  }

  const now         = Date.now();
  const is_editable = cycleRow.status === 'Open' ||
    (cycleRow.status === 'Closed' && cycleRow.closed_at !== null &&
      now - cycleRow.closed_at.getTime() < 24 * 60 * 60 * 1000);

  const collected_amount = paymentRows.reduce((s, p) => s + (p.status === 'Paid' ? Number(p.paid_amount) : 0), 0);
  const paid_count       = paymentRows.filter(p => p.status === 'Paid').length;
  const total_count      = paymentRows.length;

  return {
    cycle_id:      cycleRow.id,
    month_number:  cycleRow.month_number,
    month_label:   cycleRow.month_label,
    due_date:      cycleRow.due_date,
    status:        cycleRow.status,
    is_skip_month: cycleRow.is_skip_month,
    winners: winnerRows.map(w => ({
      winner_number:       w.winner_number,
      user_id:             w.winner_user_id,
      name:                w.winner_name,
      bid_amount:          w.bid_amount,
      admin_commission:    w.admin_commission,
      basket_credit:       w.basket_credit,
      winner_takeaway:     w.winner_takeaway,
      is_admin_withdrawal: w.is_admin_withdrawal,
      notes:               w.notes,
      recorded_at:         w.created_at,
    })),
    notes:      cycleRow.notes,
    opened_at:  cycleRow.opened_at,
    closed_at:  cycleRow.closed_at,
    is_editable,
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

  const [cycleRows, basketRows, winnerMemberRows, winnerActiveLoanRows, existingWinnersRows, groupRows, currentCycleRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, status: monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
      month_label: monthly_cycles.month_label,
    })
    .from(monthly_cycles)
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

    // current winners in this cycle — for slot number + cap check
    db.select({ winner_user_id: cycle_winners.winner_user_id, winner_number: cycle_winners.winner_number })
      .from(cycle_winners)
      .where(eq(cycle_winners.cycle_id, cycle_id))
      .orderBy(cycle_winners.winner_number),

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ month_number: monthly_cycles.month_number })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
      .orderBy(monthly_cycles.month_number)
      .limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];
  const group  = groupRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',    'Cycle is already closed.');

  // Check duplicate winner
  const alreadyWon = existingWinnersRows.some(w => w.winner_user_id === winner_user_id);
  if (alreadyWon) throw new AppError(409, 'ALREADY_WON_THIS_CYCLE', 'This member has already won a slot in this cycle.');

  // Compute X Chiti cap
  const realized   = Number(basket.current_balance);
  const pool       = Number(group.pool_amount);
  const currentMonth = currentCycleRows[0]?.month_number ?? 1;

  const activeLoans = await db.select({
    principal: loans.principal,
    monthly_interest_rate: loans.monthly_interest_rate,
    disbursement_month_number: loans.disbursement_month_number,
    total_interest_paid: loans.total_interest_paid,
  })
  .from(loans)
  .innerJoin(baskets, eq(baskets.id, loans.basket_id))
  .where(and(eq(baskets.group_id, group_id), eq(loans.status, 'Active')));

  const unrealized = activeLoans.reduce((acc, loan) => {
    const elapsed = Math.max(0, currentMonth - Number(loan.disbursement_month_number) + 1);
    return acc + Number(loan.principal) + computeOutstandingInterest(elapsed, Number(loan.principal), Number(loan.monthly_interest_rate), Number(loan.total_interest_paid));
  }, 0);

  const x_chiti     = Math.max(1, Math.floor((realized + unrealized) / pool));
  const nextSlot    = existingWinnersRows.length + 1;

  if (nextSlot > x_chiti) throw new AppError(409, 'CHITI_SLOTS_FULL', `All ${x_chiti} winner slot(s) for this cycle are already filled.`);

  const winner = winnerMemberRows[0];
  if (!winner || Number(winner.wins_count) >= Number(winner.share_count)) {
    throw new AppError(409, 'WINNER_INELIGIBLE', 'This member is not eligible to win (already won their share allocation).');
  }
  const hasActiveLoan   = !!winnerActiveLoanRows[0];
  const commission_rate = parseFloat(String(group.admin_commission_rate));

  if (is_admin_withdrawal) {
    if (winner.role !== 'Admin')      throw new AppError(400, 'NOT_ADMIN',              'Admin withdrawal can only be used when the winner is the group admin.');
    if (winner.admin_withdrawal_used) throw new AppError(409, 'WITHDRAWAL_ALREADY_USED', 'The admin withdrawal (special share) has already been used for this group.');
  }

  let stored_bid: number, admin_commission: number, basket_credit: number, winner_takeaway: number, basket_balance_after: number;
  if (is_admin_withdrawal) {
    stored_bid           = 0;
    admin_commission     = 0;
    basket_credit        = 0;
    winner_takeaway      = pool;
    basket_balance_after = realized;
  } else {
    if (bid_amount <= 0)        throw new AppError(400, 'BID_NEGATIVE_OR_ZERO', 'bid_amount must be greater than 0.');
    if (bid_amount > pool)      throw new AppError(400, 'BID_EXCEEDS_POOL',     'bid_amount cannot exceed the group pool amount.');
    stored_bid           = bid_amount;
    admin_commission     = Math.round(pool * commission_rate / 100);
    basket_credit        = bid_amount - admin_commission;
    winner_takeaway      = pool - bid_amount;
    basket_balance_after = realized + basket_credit;
  }

  await db.transaction(async (tx) => {
    await tx.insert(cycle_winners).values({
      cycle_id,
      group_id,
      winner_number:       nextSlot,
      winner_user_id,
      bid_amount:          stored_bid,
      admin_commission,
      basket_credit,
      winner_takeaway,
      is_admin_withdrawal,
      notes:               notes ?? null,
      created_by:          userId,
    });

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

  const [freshBasket] = await db.select({ current_balance: baskets.current_balance })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  await insertActivity({
    group_id,
    event_type: 'WINNER_RECORDED',
    actor_id:   winner_user_id,
    data: { month_label: cycle.month_label, winner_number: nextSlot, bid_amount: stored_bid, admin_commission, basket_credit, winner_takeaway },
  });

  const [activeMembers, [winnerRow]] = await Promise.all([
    db.select({ user_id: memberships.user_id })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
    db.select({ name: users.name }).from(users).where(eq(users.id, winner_user_id)).limit(1),
  ]);

  const winnerName = winnerRow?.name ?? 'A member';
  const slotSuffix = x_chiti >= 2 ? ` (winner ${nextSlot} of ${x_chiti})` : '';
  const title      = `Winner announced — ${cycle.month_label}`;
  const body       = is_admin_withdrawal
    ? `${winnerName} (admin) withdrew the full pool of ${paiseToRupeeDisplay(pool)}.`
    : `${winnerName} won with a bid of ${paiseToRupeeDisplay(stored_bid)}${slotSuffix}.`;

  Promise.all(
    activeMembers.map(m => notify({
      user_id:  m.user_id,
      group_id,
      type:     'WINNER_ANNOUNCED',
      title,
      body,
      data:     { cycle_id, month_label: cycle.month_label, winner_user_id, winner_name: winnerName, winner_number: nextSlot, bid_amount: stored_bid, basket_credit },
    })),
  ).catch(() => {});

  return {
    cycle_id,
    winner_number:   nextSlot,
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

  const [cycleRows, basketRows, paidPayment, winnerMemberRows, winnerActiveLoanRows, existingWinnersRows] = await Promise.all([
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

    db.select({ winner_user_id: cycle_winners.winner_user_id })
      .from(cycle_winners).where(eq(cycle_winners.cycle_id, cycle_id)).limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',             'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',               'Cycle is already closed.');
  if (paidPayment[0])            throw new AppError(409, 'PAYMENTS_ALREADY_COLLECTED', 'Some members have already paid; cannot declare skip month.');
  if (existingWinnersRows.length > 0) throw new AppError(409, 'WINNER_ALREADY_RECORDED', 'A winner has already been recorded for this cycle; cannot declare skip month.');

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
      .set({ is_skip_month: true, ...(notes ? { notes } : {}) })
      .where(eq(monthly_cycles.id, cycle_id));

    await tx.insert(cycle_winners).values({
      cycle_id,
      group_id,
      winner_number:       1,
      winner_user_id,
      bid_amount:          0,
      admin_commission:    0,
      basket_credit:       0,
      winner_takeaway:     pool_amount,
      is_admin_withdrawal: false,
      notes:               notes ?? null,
      created_by:          userId,
    });

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
    data: { month_label: cycle.month_label, winner_takeaway: pool_amount },
  });

  return {
    cycle_id, is_skip_month: true, winner_user_id, winner_takeaway: pool_amount,
    basket_debit: pool_amount, basket_balance_after: balance_after,
    warnings: skipHasActiveLoan
      ? ['This member has an active loan. The admin should ensure it is settled.']
      : [],
  };
}

// ─── updateCycle (edit bid — only first winner, within 24h) ──────────────────
export async function updateCycle(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { bid_amount: number; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { bid_amount: new_bid, notes } = data;

  const [cycleRows, basketRows, winnerRows, groupRows, origTxnRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: cycle_winners.id, winner_number: cycle_winners.winner_number, winner_user_id: cycle_winners.winner_user_id, bid_amount: cycle_winners.bid_amount, basket_credit: cycle_winners.basket_credit, is_admin_withdrawal: cycle_winners.is_admin_withdrawal, created_at: cycle_winners.created_at })
      .from(cycle_winners)
      .where(and(eq(cycle_winners.cycle_id, cycle_id), eq(cycle_winners.winner_number, 1)))
      .limit(1),

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: basket_transactions.id, created_at: basket_transactions.created_at })
      .from(basket_transactions)
      .where(and(eq(basket_transactions.cycle_id, cycle_id), eq(basket_transactions.txn_type, 'CREDIT_DISCOUNT')))
      .orderBy(desc(basket_transactions.created_at))
      .limit(1),
  ]);

  const cycle    = cycleRows[0];
  const basket   = basketRows[0];
  const winnerW  = winnerRows[0];
  const group    = groupRows[0];
  const origTxn  = origTxnRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',  'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_CLOSED',     'Cannot edit a closed cycle.');
  if (cycle.is_skip_month)       throw new AppError(409, 'INVALID_REQUEST',  'Skip-month cycles cannot be edited via this endpoint.');
  if (!winnerW)                  throw new AppError(409, 'INVALID_REQUEST',  'No winner has been recorded yet. Use POST .../record-winner first.');
  if (winnerW.is_admin_withdrawal) throw new AppError(409, 'INVALID_REQUEST', 'Admin withdrawal cycles cannot be edited via this endpoint.');
  if (!origTxn)                  throw new AppError(409, 'INVALID_REQUEST',  'Cannot find the original basket transaction for this cycle.');

  if (origTxn.created_at! < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    throw new AppError(409, 'EDIT_WINDOW_EXPIRED', 'The 24-hour edit window has passed for this cycle.');
  }
  if (new_bid <= 0)                             throw new AppError(400, 'BID_NEGATIVE_OR_ZERO', 'bid_amount must be > 0.');
  if (new_bid > Number(group.pool_amount))      throw new AppError(400, 'BID_EXCEEDS_POOL',     'bid_amount cannot exceed pool_amount.');

  const commission_rate   = parseFloat(String(group.admin_commission_rate));
  const pool              = Number(group.pool_amount);
  const new_commission    = Math.round(pool * commission_rate / 100);
  const new_basket_credit = new_bid - new_commission;
  const old_basket_credit = Number(winnerW.basket_credit);
  const credit_delta      = new_basket_credit - old_basket_credit;
  const new_takeaway      = pool - new_bid;
  const balance_after     = Number(basket.current_balance) + credit_delta;

  await db.transaction(async (tx) => {
    await tx.update(cycle_winners)
      .set({ bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, ...(notes != null ? { notes } : {}) })
      .where(eq(cycle_winners.id, winnerW.id));

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

  return { cycle_id, winner_number: 1, winner_user_id: winnerW.winner_user_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, basket_balance_after: balance_after };
}

// ─── correctClosedCycle ───────────────────────────────────────────────────────
export async function correctClosedCycle(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; bid_amount?: number; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id: new_winner_id, bid_amount: new_bid, notes } = data;

  const [cycleRows, basketRows, firstWinnerRows, groupRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, status: monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
      month_label: monthly_cycles.month_label,
    })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: cycle_winners.id, winner_user_id: cycle_winners.winner_user_id, bid_amount: cycle_winners.bid_amount, basket_credit: cycle_winners.basket_credit })
      .from(cycle_winners)
      .where(and(eq(cycle_winners.cycle_id, cycle_id), eq(cycle_winners.winner_number, 1)))
      .limit(1),

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycle       = cycleRows[0];
  const basket      = basketRows[0];
  const firstWinner = firstWinnerRows[0];
  const group       = groupRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',  'Cycle not found in this group.');
  if (cycle.status !== 'Closed') throw new AppError(409, 'CYCLE_NOT_CLOSED', 'Only closed cycles can be corrected via this endpoint.');
  if (!firstWinner)              throw new AppError(409, 'INVALID_STATE',    'No winner record found for this cycle.');

  const old_winner_id  = firstWinner.winner_user_id;
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

  const pool = Number(group.pool_amount);

  if (!cycle.is_skip_month) {
    if (!new_bid || new_bid <= 0)         throw new AppError(400, 'BID_REQUIRED',     'bid_amount is required for a non-skip-month correction.');
    if (new_bid > pool)                   throw new AppError(400, 'BID_EXCEEDS_POOL', 'bid_amount cannot exceed the group pool amount.');

    const commission_rate   = parseFloat(String(group.admin_commission_rate));
    const new_commission    = Math.round(pool * commission_rate / 100);
    const new_basket_credit = new_bid - new_commission;
    const new_takeaway      = pool - new_bid;
    const old_basket_credit = Number(firstWinner.basket_credit);
    const credit_delta      = new_basket_credit - old_basket_credit;
    const new_balance       = Number(basket.current_balance) + credit_delta;

    await db.transaction(async (tx) => {
      await tx.update(cycle_winners)
        .set({ winner_user_id: new_winner_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, ...(notes != null ? { notes } : {}) })
        .where(eq(cycle_winners.id, firstWinner.id));

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
      data: { month_label: cycle.month_label, old_winner_id, new_winner_id, old_bid_amount: firstWinner.bid_amount, new_bid_amount: new_bid },
    });

    return { cycle_id, winner_user_id: new_winner_id, bid_amount: new_bid, admin_commission: Math.round(pool * parseFloat(String(group.admin_commission_rate)) / 100), basket_credit: new_bid - Math.round(pool * parseFloat(String(group.admin_commission_rate)) / 100), winner_takeaway: pool - new_bid, basket_balance_after: credit_delta !== 0 ? Number(basket.current_balance) + credit_delta : Number(basket.current_balance) };
  }

  // Skip month: winner change only
  await db.transaction(async (tx) => {
    await tx.update(cycle_winners)
      .set({ winner_user_id: new_winner_id, ...(notes != null ? { notes } : {}) })
      .where(eq(cycle_winners.id, firstWinner.id));

    if (winner_changed) {
      await tx.insert(basket_transactions).values([
        { basket_id: basket.id, cycle_id, txn_type: 'ADJUSTMENT', amount: pool, direction: 'C', counterparty_user_id: old_winner_id, notes: 'Skip month correction: reversing old debit', created_by: userId },
        { basket_id: basket.id, cycle_id, txn_type: 'ADJUSTMENT', amount: pool, direction: 'D', counterparty_user_id: new_winner_id, notes: 'Skip month correction: re-applying debit for corrected winner', created_by: userId },
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

  return { cycle_id, is_skip_month: true, winner_user_id: new_winner_id, winner_takeaway: pool, basket_balance_after: Number(basket.current_balance) };
}

// ─── closeCycle ──────────────────────────────────────────────────────────────
export async function closeCycle(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [cycleRows, unpaidProbe, groupRows, winnerProbe] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ name: users.name, expected_amount: payments.expected_amount })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .where(and(eq(payments.cycle_id, cycle_id), eq(payments.status, 'Unpaid'))),

    db.select({ monthly_contribution: chit_groups.monthly_contribution })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: cycle_winners.id })
      .from(cycle_winners).where(eq(cycle_winners.cycle_id, cycle_id)).limit(1),
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
  if (!cycle.is_skip_month && winnerProbe.length === 0) {
    throw new AppError(409, 'WINNER_NOT_RECORDED', 'Record the bid winner before closing this cycle.');
  }

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
