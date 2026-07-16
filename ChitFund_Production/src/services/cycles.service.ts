/**
 * @fileoverview Monthly-cycle business logic for the ChitFund API. It computes
 * Double Chiti eligibility from the realized + unrealized basket, lists and reads
 * cycles with their winners and payment rollups, records winners (with admin
 * withdrawal and up-to-two-winner Double Chiti support, plus the basket payout
 * math), declares skip months, edits the first winner's bid inside a 24-hour
 * window, corrects or reopens a closed cycle, and closes a cycle (handling the
 * final-cycle basket offset and skip-month bookkeeping). Bid/winner data lives in
 * `cycle_winners`; every basket-affecting step is written transactionally with
 * its ledger entry. Double Chiti eligibility is `floor(total_basket / pool) + 1`,
 * where `total_basket` = realized balance plus outstanding loan principal and
 * accrued interest.
 * @module services/cycles
 * @author Suraj KM
 */

import { eq, and, desc, sum, count, sql, inArray, gt, ne, or } from 'drizzle-orm';
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

// outstanding interest for a loan: interest starts from the cycle AFTER disbursement.
// cycles_elapsed = currentMonth - disbursement_month_number (0 in the disbursement cycle itself).
// total_accrued = cycles_elapsed × monthly_interest; outstanding = total_accrued − total_interest_paid
function computeOutstandingInterest(cyclesElapsed: number, principal: number, rate: number, totalInterestPaid: number): number {
  const monthlyInterest = Math.round(principal * rate / 100);
  return Math.max(0, cyclesElapsed * monthlyInterest - totalInterestPaid);
}

/**
 * Computes how many winners the basket could fund this cycle (Double Chiti and beyond) from the realized balance plus unrealized loan principal and interest.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group whose chiti eligibility to evaluate
 * @returns A promise resolving to the realized/unrealized/total basket, pool amount, the `double_chiti` multiplier, a display label, and an `eligible` flag
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 GROUP_NOT_FOUND if the group or basket is missing
 */
export async function getChitiEligibility(userId: string, group_id: string) {
  await assertActiveMember(group_id, userId);

  const [basketRows, groupRows, activeLoans, currentCycleRows] = await Promise.all([
    db.select({ current_balance: baskets.current_balance })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ pool_amount: chit_groups.pool_amount, total_shares: chit_groups.total_shares, total_months: chit_groups.total_months })
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
  const winners_per_cycle = Math.floor(Number(group.total_shares) / Number(group.total_months));
  const currentMonth = currentCycleRows[0]?.month_number ?? 1;

  const unrealized = activeLoans.reduce((acc, loan) => {
    const cyclesElapsed = Math.max(0, currentMonth - Number(loan.disbursement_month_number));
    const outstandingInterest = computeOutstandingInterest(
      cyclesElapsed, Number(loan.principal), Number(loan.monthly_interest_rate), Number(loan.total_interest_paid),
    );
    return acc + Number(loan.principal) + outstandingInterest;
  }, 0);

  const total_basket = realized + unrealized;
  const double_chiti = winners_per_cycle + Math.floor(total_basket / pool);
  const eligible     = double_chiti > winners_per_cycle;

  return {
    realized,
    unrealized,
    total_basket,
    pool_amount: pool,
    winners_per_cycle,
    double_chiti,
    label:    eligible ? chitiLabel(double_chiti) : '',
    eligible,
  };
}

/**
 * Lists a group's cycles (newest first) with their winners and per-cycle payment rollups (collected/expected amounts and counts).
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group whose cycles to list
 * @param filters - Optional filters
 * @param filters.status - Restrict to `'open'` or `'closed'` cycles
 * @returns A promise resolving to the cycles with embedded winners and payment aggregates
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 */
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

/**
 * Returns full detail for one cycle: winners, every payment, payment totals, the 24-hour editability flag, and any basket impact from skip-month or final-cycle offset transactions.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Cycle to fetch
 * @returns A promise resolving to the assembled cycle-detail object
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle does not exist in this group
 */
export async function getCycle(userId: string, group_id: string, cycle_id: string) {
  await assertActiveMember(group_id, userId);

  const [cycleRows, paymentRows, cycleTxnRows, basketRows, winnerRows, groupRows] = await Promise.all([
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
      txn_type: basket_transactions.txn_type,
      amount: basket_transactions.amount, direction: basket_transactions.direction,
      created_at: basket_transactions.created_at, created_by: basket_transactions.created_by,
      basket_id: basket_transactions.basket_id,
    })
    .from(basket_transactions)
    .innerJoin(baskets, eq(baskets.id, basket_transactions.basket_id))
    .where(and(
      eq(baskets.group_id, group_id),
      eq(basket_transactions.cycle_id, cycle_id),
      inArray(basket_transactions.txn_type, ['CREDIT_DISCOUNT', 'DEBIT_SKIP_MONTH', 'DEBIT_FINAL_CYCLE_OFFSET']),
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

    db.select({ total_months: chit_groups.total_months })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycleRow = cycleRows[0];
  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');

  const cycleTxn   = cycleTxnRows[0] ?? null;
  const basket     = basketRows[0]   ?? null;
  const totalMonths = Number(groupRows[0]?.total_months ?? 0);
  const is_final_cycle = totalMonths > 0 && cycleRow.month_number === totalMonths;

  // basket_contribution is the DEBIT_FINAL_CYCLE_OFFSET amount if this is the final cycle
  const basket_contribution = (is_final_cycle && cycleTxn?.txn_type === 'DEBIT_FINAL_CYCLE_OFFSET')
    ? Number(cycleTxn.amount)
    : 0;

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
  const waived_count     = paymentRows.filter(p => p.status === 'Waived').length;

  return {
    cycle_id:      cycleRow.id,
    month_number:  cycleRow.month_number,
    month_label:   cycleRow.month_label,
    due_date:      cycleRow.due_date,
    status:        cycleRow.status,
    is_skip_month: cycleRow.is_skip_month,
    is_final_cycle,
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
    basket_contribution,
    collected_amount,
    paid_count,
    waived_count,
    total_count,
    payments: paymentRows,
  };
}

/**
 * Records a winner for a cycle (admin only): validates eligibility and bid, computes the commission/basket-credit/takeaway split, and updates the basket transactionally — supports admin withdrawal and a second Double Chiti winner.
 *
 * @param userId - The requesting admin, recorded as the winner-record creator
 * @param group_id - Group the cycle belongs to; must not be closed
 * @param cycle_id - Cycle to record the winner for; must be open
 * @param data - Winner details
 * @param data.winner_user_id - Active, win-eligible member taking the slot
 * @param data.bid_amount - Bid in paise (0 and ignored when `is_admin_withdrawal` is set); must be > 0 and ≤ pool otherwise
 * @param data.is_admin_withdrawal - Records the admin's special bid-free withdrawal instead of a normal bid
 * @param data.notes - Optional note stored on the winner row
 * @returns A promise resolving to the recorded winner's financial breakdown, resulting basket balance, and any auto-generated payment-free skip month
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 GROUP_NOT_FOUND / CYCLE_NOT_FOUND if missing
 * @throws {AppError} 409 GROUP_CLOSED, CYCLE_CLOSED, CHITI_SLOTS_FULL, WINNER_INELIGIBLE, or WITHDRAWAL_ALREADY_USED
 * @throws {AppError} 400 BID_NEGATIVE_OR_ZERO, BID_EXCEEDS_POOL, BID_BELOW_COMMISSION, NOT_ADMIN, or DOUBLE_CHITTI_INSUFFICIENT
 */
export async function recordWinner(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; bid_amount: number; is_admin_withdrawal?: boolean; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id, bid_amount, is_admin_withdrawal = false, notes } = data;

  const [cycleRows, basketRows, winnerMemberRows, winnerActiveLoanRows, existingWinnersRows, groupRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, status: monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
      month_label: monthly_cycles.month_label,
      month_number: monthly_cycles.month_number,
    })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited })
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

    // current winners in this cycle — for slot number
    db.select({ winner_user_id: cycle_winners.winner_user_id, winner_number: cycle_winners.winner_number, basket_credit: cycle_winners.basket_credit })
      .from(cycle_winners)
      .where(eq(cycle_winners.cycle_id, cycle_id))
      .orderBy(cycle_winners.winner_number),

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate, status: chit_groups.status, total_shares: chit_groups.total_shares, total_months: chit_groups.total_months })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];
  const group  = groupRows[0];

  if (!group)                     throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (group.status === 'Closed')  throw new AppError(409, 'GROUP_CLOSED',    'This group is closed.');
  if (!cycle)                     throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');
  if (cycle.status === 'Closed')  throw new AppError(409, 'CYCLE_CLOSED',    'Cycle is already closed.');

  const realized          = Number(basket.current_balance);
  const pool              = Number(group.pool_amount);
  const nextSlot          = existingWinnersRows.length + 1;
  const winners_per_cycle = Math.floor(Number(group.total_shares) / Number(group.total_months));
  // Include the incoming bid's provisional basket credit so the cap is evaluated
  // AFTER this bid, not before. Structural winners always pass; extra winners pass
  // only if basket + bid can fund the pool (financial validation confirms the exact amount).
  const provisionalCredit = is_admin_withdrawal ? 0 : Math.max(0, bid_amount);
  const maxWinners        = winners_per_cycle + Math.floor((Math.max(0, realized) + provisionalCredit) / pool);

  if (nextSlot > maxWinners) {
    throw new AppError(409, 'CHITI_SLOTS_FULL',
      nextSlot <= winners_per_cycle
        ? `All ${winners_per_cycle} structural winner slot(s) for this cycle are already filled.`
        : `Basket has insufficient funds for another Double Chiti winner.`,
    );
  }

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

  let stored_bid: number, admin_commission: number, basket_credit: number, winner_takeaway: number;
  if (is_admin_withdrawal) {
    stored_bid       = 0;
    admin_commission = 0;
    basket_credit    = 0;
    winner_takeaway  = pool;
  } else {
    if (bid_amount <= 0)        throw new AppError(400, 'BID_NEGATIVE_OR_ZERO', 'bid_amount must be greater than 0.');
    if (bid_amount > pool)      throw new AppError(400, 'BID_EXCEEDS_POOL',     'bid_amount cannot exceed the group pool amount.');
    stored_bid       = bid_amount;
    admin_commission = Math.round(pool * commission_rate / 100);
    basket_credit    = bid_amount - admin_commission;
    if (basket_credit < 0)      throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin maintenance fee (${admin_commission} paise).`);
    winner_takeaway  = pool - bid_amount;

    // ── Extra-winner financial validation (any slot beyond structural winners) ─
    // Previous winners' basket credits are already reflected in `realized` (committed in prior API calls).
    // So the basket available after this bid = realized + basket_credit. Must be >= pool to fund this payout.
    if (nextSlot > winners_per_cycle) {
      const totalAvailable = realized + basket_credit;
      if (totalAvailable < pool) {
        throw new AppError(
          400,
          'DOUBLE_CHITTI_INSUFFICIENT',
          `Double Chiti not possible: basket balance + this bid's discount (${paiseToRupeeDisplay(totalAvailable)}) is less than pool amount (${paiseToRupeeDisplay(pool)}).`,
        );
      }
    }
  }

  // Captured inside the transaction so the response can report the auto-generated
  // payment-free skip month (or warn when no future cycle was available for one).
  let autoSkip: { cycle_id: string; month_label: string } | null = null;
  let autoSkipUnavailable = false;

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

    const isExtraWinner = nextSlot > winners_per_cycle;

    if (!is_admin_withdrawal) {
      // Basket debit only for basket-funded EXTRA winners (beyond structural winners_per_cycle).
      // Structural winners (slot 1…winners_per_cycle) add their bid credit but take nothing from basket.
      const doubleChitiDebit = isExtraWinner ? pool : 0;
      await tx.update(baskets)
        .set({
          current_balance: sql`${baskets.current_balance} + ${basket_credit} - ${doubleChitiDebit}`,
          total_credited:  sql`${baskets.total_credited} + ${basket_credit}`,
          total_debited:   sql`${baskets.total_debited} + ${doubleChitiDebit}`,
        })
        .where(eq(baskets.id, basket.id));

      if (isExtraWinner) {
        await tx.insert(basket_transactions).values({
          basket_id:            basket.id,
          cycle_id,
          txn_type:             'DEBIT_DOUBLE_CHITI',
          amount:               pool,
          direction:            'D',
          counterparty_user_id: winner_user_id,
          notes:                `Double Chiti payout — winner ${nextSlot}`,
          created_by:           userId,
        });
      }

      if (basket_credit > 0) {
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
    }

    await tx.update(memberships)
      .set({
        wins_count: Number(winner.wins_count) + 1,
        ...(is_admin_withdrawal ? { admin_withdrawal_used: true } : {}),
      })
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, winner_user_id)));

    // ── Double Chiti auto-skip ──────────────────────────────────────────────
    // Each basket-funded extra winner consumes a future winner slot. For groups
    // with winners_per_cycle > 1, a single extra winner only banks a spare slot —
    // a payment-free month is freed only once every winners_per_cycle cumulative
    // extra winners are accumulated across the group's full history.
    if (isExtraWinner) {
      const [extraCountRow] = await tx
        .select({ cnt: count(cycle_winners.id) })
        .from(cycle_winners)
        .innerJoin(monthly_cycles, eq(monthly_cycles.id, cycle_winners.cycle_id))
        .where(and(
          eq(monthly_cycles.group_id, group_id),
          gt(cycle_winners.winner_number, winners_per_cycle),
        ));

      const totalExtraWinners = Number(extraCountRow?.cnt ?? 0);

      if (totalExtraWinners % winners_per_cycle === 0) {
        const [targetCycle] = await tx
          .select({ id: monthly_cycles.id, month_label: monthly_cycles.month_label })
          .from(monthly_cycles)
          .where(and(
            eq(monthly_cycles.group_id, group_id),
            eq(monthly_cycles.status, 'Open'),
            eq(monthly_cycles.is_skip_month, false),
            gt(monthly_cycles.month_number, cycle.month_number),
            sql`NOT EXISTS (SELECT 1 FROM ${cycle_winners} cw WHERE cw.cycle_id = ${monthly_cycles.id})`,
          ))
          .orderBy(desc(monthly_cycles.month_number))
          .limit(1);

        if (targetCycle) {
          autoSkip = { cycle_id: targetCycle.id, month_label: targetCycle.month_label };

          await tx.update(monthly_cycles)
            .set({ is_skip_month: true, notes: `Payment-free month — saved by Double Chiti (${cycle.month_label})` })
            .where(eq(monthly_cycles.id, targetCycle.id));

          // Waive any payment rows that already exist for that cycle. Final cycles are
          // usually seeded lazily at close time — closeCycle honours is_skip_month then.
          await tx.update(payments)
            .set({ expected_amount: 0, paid_amount: 0, status: 'Waived', updated_at: new Date() })
            .where(and(eq(payments.cycle_id, targetCycle.id), ne(payments.status, 'Paid')));
        } else {
          autoSkipUnavailable = true;
        }
      }
    }
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
  const slotSuffix = nextSlot >= 2 ? ` (winner ${nextSlot})` : '';
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
    auto_skip: autoSkip,
    warnings: [
      ...(hasActiveLoan ? ['This member has an active loan. The admin should ensure it is settled.'] : []),
      ...(autoSkipUnavailable ? ['Double Chiti recorded, but no future cycle was available to mark as a payment-free skip month.'] : []),
    ],
  };
}

/**
 * Declares a cycle a skip month (admin only): the winner takes the full pool funded from the basket with no member contributions collected for that month.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Cycle to mark as a skip month; must be open with no payments collected or winner recorded
 * @param data - Skip-month details
 * @param data.winner_user_id - Active, win-eligible member who takes the pool
 * @param data.notes - Optional note stored on the winner row
 * @returns A promise resolving to the skip-month winner and resulting basket state
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle is missing
 * @throws {AppError} 409 CYCLE_CLOSED, PAYMENTS_ALREADY_COLLECTED, WINNER_ALREADY_RECORDED, WINNER_INELIGIBLE, or BASKET_INSUFFICIENT
 */
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

    db.select({ id: baskets.id, current_balance: baskets.current_balance, total_debited: baskets.total_debited })
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

    // Skip month: members owe nothing (spec F-12). Waive every non-Paid payment row
    // so member/admin views, the Defaulters screen, and closeCycle stay consistent.
    await tx.update(payments)
      .set({ expected_amount: 0, paid_amount: 0, status: 'Waived', updated_at: new Date() })
      .where(and(eq(payments.cycle_id, cycle_id), ne(payments.status, 'Paid')));

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
      .set({
        current_balance: balance_after,
        total_debited:   Number(basket.total_debited) + pool_amount,
      })
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

/**
 * Corrects the first winner's bid within the 24-hour edit window (admin only), recomputing the commission/credit/takeaway split and posting an adjustment for the basket-credit delta.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Open, non-skip cycle whose first winner's bid is being edited
 * @param data - Edit details
 * @param data.bid_amount - Corrected bid in paise; must be > 0, ≤ pool, and at least the admin maintenance fee
 * @param data.notes - Optional note stored on the winner row
 * @returns A promise resolving to the recomputed winner breakdown and resulting basket balance
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle is missing
 * @throws {AppError} 409 CYCLE_CLOSED, INVALID_REQUEST (skip/admin-withdrawal/no winner), or EDIT_WINDOW_EXPIRED
 * @throws {AppError} 400 BID_NEGATIVE_OR_ZERO, BID_EXCEEDS_POOL, or BID_BELOW_COMMISSION
 */
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

    db.select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited })
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
  if (new_basket_credit < 0)                    throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin maintenance fee (${new_commission} paise).`);
  const old_basket_credit = Number(winnerW.basket_credit);
  const credit_delta      = new_basket_credit - old_basket_credit;
  const new_takeaway      = pool - new_bid;
  const balance_after     = Number(basket.current_balance) + credit_delta;

  await db.transaction(async (tx) => {
    await tx.update(cycle_winners)
      .set({ bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, ...(notes != null ? { notes } : {}) })
      .where(eq(cycle_winners.id, winnerW.id));

    if (credit_delta !== 0) {
      await tx.update(baskets).set({
        current_balance: balance_after,
        ...(credit_delta > 0
          ? { total_credited: Number(basket.total_credited) + credit_delta }
          : { total_debited:  Number(basket.total_debited)  + Math.abs(credit_delta) }),
      }).where(eq(baskets.id, basket.id));
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

/**
 * Corrects the recorded winner (and optionally bid) of an already-closed cycle (admin only), re-deriving the financial split and reconciling the basket.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Closed cycle being corrected
 * @param data - Correction details
 * @param data.winner_user_id - The corrected winning member
 * @param data.bid_amount - Corrected bid in paise (if the bid is being changed)
 * @param data.notes - Optional note stored on the winner row
 * @param data.winner_number - Which winner slot to correct (defaults to 1)
 * @returns A promise resolving to the corrected winner breakdown and resulting basket state
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle is missing
 * @throws {AppError} 409 on invalid cycle state or winner-eligibility conflicts
 */
export async function correctClosedCycle(
  userId:   string,
  group_id: string,
  cycle_id: string,
  data:     { winner_user_id: string; bid_amount?: number; notes?: string; winner_number?: number },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { winner_user_id: new_winner_id, bid_amount: new_bid, notes, winner_number = 1 } = data;

  const [cycleRows, basketRows, firstWinnerRows, groupRows] = await Promise.all([
    db.select({
      id: monthly_cycles.id, status: monthly_cycles.status,
      is_skip_month: monthly_cycles.is_skip_month,
      month_label: monthly_cycles.month_label,
    })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1),

    db.select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ id: cycle_winners.id, winner_user_id: cycle_winners.winner_user_id, bid_amount: cycle_winners.bid_amount, basket_credit: cycle_winners.basket_credit })
      .from(cycle_winners)
      .where(and(eq(cycle_winners.cycle_id, cycle_id), eq(cycle_winners.winner_number, winner_number)))
      .limit(1),

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycle       = cycleRows[0];
  const basket      = basketRows[0];
  const firstWinner = firstWinnerRows[0];
  const group       = groupRows[0];

  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',  'Cycle not found in this group.');
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
    if (new_basket_credit < 0)            throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin maintenance fee (${new_commission} paise).`);
    const new_takeaway      = pool - new_bid;
    const old_basket_credit = Number(firstWinner.basket_credit);
    const credit_delta      = new_basket_credit - old_basket_credit;
    const new_balance       = Number(basket.current_balance) + credit_delta;

    await db.transaction(async (tx) => {
      await tx.update(cycle_winners)
        .set({ winner_user_id: new_winner_id, bid_amount: new_bid, admin_commission: new_commission, basket_credit: new_basket_credit, winner_takeaway: new_takeaway, ...(notes != null ? { notes } : {}) })
        .where(eq(cycle_winners.id, firstWinner.id));

      if (credit_delta !== 0) {
        await tx.update(baskets).set({
          current_balance: new_balance,
          ...(credit_delta > 0
            ? { total_credited: Number(basket.total_credited) + credit_delta }
            : { total_debited:  Number(basket.total_debited)  + Math.abs(credit_delta) }),
        }).where(eq(baskets.id, basket.id));
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

/**
 * Reopens a closed cycle (admin only), setting it back to Open and clearing its closed timestamp.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Closed cycle to reopen
 * @returns A promise resolving to the reopened cycle's id, status, and labels
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle is missing
 * @throws {AppError} 400 CYCLE_NOT_CLOSED if the cycle is not currently closed
 */
export async function reopenCycle(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [cycleRows] = await db
    .select({ id: monthly_cycles.id, status: monthly_cycles.status, month_label: monthly_cycles.month_label })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1);

  if (!cycleRows)                     throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');
  if (cycleRows.status !== 'Closed')  throw new AppError(400, 'CYCLE_NOT_CLOSED', 'Cycle is not closed — only Closed cycles can be reopened.');

  await db.update(monthly_cycles)
    .set({ status: 'Open', closed_at: null })
    .where(eq(monthly_cycles.id, cycle_id));

  await insertActivity({
    group_id,
    event_type: 'CYCLE_REOPENED',
    actor_id:   userId,
    data: { month_label: cycleRows.month_label },
  });

  const [updated] = await db
    .select({ id: monthly_cycles.id, status: monthly_cycles.status, closed_at: monthly_cycles.closed_at, month_label: monthly_cycles.month_label, month_number: monthly_cycles.month_number })
    .from(monthly_cycles)
    .where(eq(monthly_cycles.id, cycle_id))
    .limit(1);

  return updated;
}

/**
 * Closes a cycle (admin only) once all payments are settled and a winner is recorded (unless it is a skip month), then advances bookkeeping — seeding the next cycle, auto-waiving a payment-free skip month, and applying the final-cycle basket offset.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Open cycle to close
 * @returns A promise resolving to the closed cycle's summary and any follow-on cycle/basket effects
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle is missing
 * @throws {AppError} 409 CYCLE_ALREADY_CLOSED, PAYMENTS_OUTSTANDING, or WINNER_NOT_RECORDED
 */
export async function closeCycle(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [cycleRows, unpaidProbe, groupRows, winnerProbe] = await Promise.all([
    db.select({ id: monthly_cycles.id, status: monthly_cycles.status, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ name: users.name, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .where(and(
        eq(payments.cycle_id, cycle_id),
        or(
          eq(payments.status, 'Unpaid'),
          and(eq(payments.status, 'Paid'), sql`${payments.paid_amount} < ${payments.expected_amount}`),
        ),
      )),

    db.select({
      monthly_contribution: chit_groups.monthly_contribution,
      pool_amount: chit_groups.pool_amount,
      admin_commission_rate: chit_groups.admin_commission_rate,
      total_months: chit_groups.total_months,
      total_shares: chit_groups.total_shares,
    })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: cycle_winners.id })
      .from(cycle_winners).where(eq(cycle_winners.cycle_id, cycle_id)),
  ]);

  const cycle = cycleRows[0];
  if (!cycle)                    throw new AppError(404, 'CYCLE_NOT_FOUND',      'Cycle not found in this group.');
  if (cycle.status === 'Closed') throw new AppError(409, 'CYCLE_ALREADY_CLOSED', 'Cycle is already closed.');
  if (unpaidProbe.length > 0) {
    const list = unpaidProbe
      .map(p => {
        const expected = Number(p.expected_amount);
        const paid     = Number(p.paid_amount);
        if (p.status === 'Paid' && paid < expected) {
          return `${p.name} (partial: ₹${(paid / 100).toLocaleString('en-IN')} of ₹${(expected / 100).toLocaleString('en-IN')} due)`;
        }
        return `${p.name} (₹${(expected / 100).toLocaleString('en-IN')} due)`;
      })
      .join(', ');
    throw new AppError(409, 'PAYMENTS_OUTSTANDING', `Outstanding dues: ${list}`);
  }
  if (!cycle.is_skip_month) {
    const group_for_wpc = groupRows[0];
    const winners_per_cycle = group_for_wpc
      ? Math.floor(Number(group_for_wpc.total_shares) / Number(group_for_wpc.total_months))
      : 1;
    if (winnerProbe.length === 0) {
      throw new AppError(409, 'WINNER_NOT_RECORDED', 'Record the bid winner before closing this cycle.');
    }
    if (winnerProbe.length < winners_per_cycle) {
      throw new AppError(409, 'STRUCTURAL_WINNERS_INCOMPLETE',
        `This group requires ${winners_per_cycle} winner(s) per cycle — only ${winnerProbe.length} recorded.`);
    }
  }

  const group = groupRows[0];
  const closedAt = new Date();
  const nextMonthNumber = Number(cycle.month_number) + 1;

  await db.transaction(async (tx) => {
    await tx.update(monthly_cycles).set({ status: 'Closed', closed_at: closedAt }).where(eq(monthly_cycles.id, cycle_id));

    const [nextCycle] = await tx
      .select({ id: monthly_cycles.id, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, nextMonthNumber)))
      .limit(1);

    if (nextCycle && nextCycle.is_skip_month) {
      // ── Next cycle is a payment-free skip (e.g. saved by Double Chiti) ──────────
      // Members owe nothing; the basket already funded the early payout. No winner,
      // no basket activity here — just seed/waive every member's payment as Waived ₹0.
      const skipMembers = (await tx
        .select({ user_id: memberships.user_id, share_count: memberships.share_count })
        .from(memberships)
        .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))))
        .filter(m => Number(m.share_count) > 0);

      const [skipExists] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.cycle_id, nextCycle.id)).limit(1);

      if (skipExists) {
        await tx.update(payments)
          .set({ expected_amount: 0, paid_amount: 0, status: 'Waived', updated_at: new Date() })
          .where(and(eq(payments.cycle_id, nextCycle.id), ne(payments.status, 'Paid')));
      } else if (skipMembers.length > 0) {
        await tx.insert(payments).values(
          skipMembers.map(m => ({
            cycle_id:        nextCycle.id,
            member_user_id:  m.user_id,
            expected_amount: 0,
            status:          'Waived' as const,
          })),
        );
      }
    } else if (nextCycle) {
      const [basketRows] = await tx.select({ id: baskets.id, current_balance: baskets.current_balance, total_debited: baskets.total_debited })
        .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

      const currentBalance    = Number(basketRows?.current_balance ?? 0);
      const pool              = Number(group.pool_amount);
      const commissionRate    = parseFloat(String(group.admin_commission_rate));
      const adminCommission   = Math.round(pool * commissionRate / 100);
      const winners_per_cycle = Math.floor(Number(group.total_shares) / Number(group.total_months));
      // Members + basket must collectively cover pool_amount AND admin commission for each structural winner.
      const total_needed      = winners_per_cycle * (pool + adminCommission);

      const activeMembers = (await tx
        .select({ user_id: memberships.user_id, share_count: memberships.share_count, wins_count: memberships.wins_count, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.user_id))
        .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))))
        .filter(m => Number(m.share_count) > 0);

      // Compute remaining wins needed AFTER the current cycle's winner(s) are already recorded in memberships.
      // The basket offset must only apply when seeding the FINAL cycle — i.e. exactly 1 win remains.
      const remainingWinsNeeded = activeMembers.reduce(
        (sum, m) => sum + Math.max(0, Number(m.share_count) - Number(m.wins_count)),
        0,
      );

      const [alreadyExists] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.cycle_id, nextCycle.id)).limit(1);

      if (remainingWinsNeeded === 1 && currentBalance > 0) {
        // ── Final cycle + basket has funds: seed/update payments with basket-offset reduced amounts ──
        const basket_contribution  = Math.min(currentBalance, total_needed);
        const remaining_to_collect = Math.max(0, total_needed - basket_contribution);
        const total_shares         = Number(group.total_shares);

        const sortedMembers = [...activeMembers].sort((a, b) => {
          const shareDiff = Number(b.share_count) - Number(a.share_count);
          if (shareDiff !== 0) return shareDiff;
          return a.name.localeCompare(b.name);
        });

        const memberAmounts = sortedMembers.map(m => ({
          user_id:     m.user_id,
          share_count: Number(m.share_count),
          amount:      remaining_to_collect === 0
            ? 0
            : Math.floor(remaining_to_collect * Number(m.share_count) / total_shares),
        }));

        if (remaining_to_collect > 0 && memberAmounts.length > 0) {
          const allocatedSum = memberAmounts.reduce((s, m) => s + m.amount, 0);
          const residual = remaining_to_collect - allocatedSum;
          if (residual > 0) memberAmounts[0].amount += residual;
        }

        if (alreadyExists) {
          for (const m of memberAmounts) {
            await tx.update(payments)
              .set({ expected_amount: m.amount, status: m.amount === 0 ? 'Waived' : 'Unpaid' })
              .where(and(eq(payments.cycle_id, nextCycle.id), eq(payments.member_user_id, m.user_id)));
          }
        } else {
          await tx.insert(payments).values(
            memberAmounts.map(m => ({
              cycle_id:        nextCycle.id,
              member_user_id:  m.user_id,
              expected_amount: m.amount,
              status:          (m.amount === 0 ? 'Waived' : 'Unpaid') as 'Waived' | 'Unpaid',
            })),
          );
        }

        if (basket_contribution > 0) {
          await tx.update(baskets)
            .set({
              current_balance: currentBalance - basket_contribution,
              total_debited:   Number(basketRows.total_debited) + basket_contribution,
            })
            .where(eq(baskets.id, basketRows.id));

          await tx.insert(basket_transactions).values({
            basket_id:  basketRows.id,
            cycle_id:   nextCycle.id,
            txn_type:   'DEBIT_FINAL_CYCLE_OFFSET',
            amount:     basket_contribution,
            direction:  'D',
            notes:      `Basket offset for final cycle ${nextMonthNumber}: covers ${basket_contribution} of ${total_needed} (pool ${pool} + commission ${adminCommission})`,
            created_by: userId,
          });
        }
      } else if (!alreadyExists) {
        // ── Normal cycle or no basket funds: seed with standard full contribution amounts ─────
        const contribution = Number(group.monthly_contribution);
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

  // Auto-close the group when every active member has exhausted their shares
  const [remainingWinner] = await db
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(and(
      eq(memberships.group_id, group_id),
      eq(memberships.status, 'Active'),
      sql`${memberships.wins_count} < ${memberships.share_count}`,
    ))
    .limit(1);

  if (!remainingWinner) {
    const [activeLoan] = await db
      .select({ id: loans.id })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(eq(baskets.group_id, group_id), eq(loans.status, 'Active')))
      .limit(1);

    if (!activeLoan) {
      const groupClosedAt = new Date();
      // Close any remaining Open cycles (e.g. a trailing payment-free skip month saved by
      // Double Chiti, which has no winner to record) so the closed group has no dangling cycles.
      await db.update(monthly_cycles)
        .set({ status: 'Closed', closed_at: groupClosedAt })
        .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')));
      await db.update(chit_groups)
        .set({ status: 'Closed', closed_at: groupClosedAt, updated_at: groupClosedAt })
        .where(eq(chit_groups.id, group_id));
      await insertActivity({ group_id, event_type: 'GROUP_CLOSED', actor_id: userId });
      return { cycle_id, status: 'Closed', closed_at: closedAt, group_closed: true };
    }
  }

  return { cycle_id, status: 'Closed', closed_at: closedAt, group_closed: false };
}
