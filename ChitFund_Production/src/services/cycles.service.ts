// Business logic for monthly cycle management.
// Bid/winner data lives in cycle_winners (supports Double Chiti: multiple winners per cycle).
// Double Chiti eligibility: double_chiti = floor(total_basket / pool_amount) + 1,
//   total_basket = realized (current_balance) + unrealized (outstanding loan principals + accrued interest owed).

import { eq, and, desc, sum, count, sql, inArray, gt, ne } from 'drizzle-orm';
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
    const cyclesElapsed = Math.max(0, currentMonth - Number(loan.disbursement_month_number));
    const outstandingInterest = computeOutstandingInterest(
      cyclesElapsed, Number(loan.principal), Number(loan.monthly_interest_rate), Number(loan.total_interest_paid),
    );
    return acc + Number(loan.principal) + outstandingInterest;
  }, 0);

  const total_basket = realized + unrealized;
  const double_chiti = Math.floor(total_basket / pool) + 1;
  const eligible     = double_chiti >= 2;

  return {
    realized,
    unrealized,
    total_basket,
    pool_amount: pool,
    double_chiti,
    label:    eligible ? chitiLabel(double_chiti) : '',
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

    db.select({ pool_amount: chit_groups.pool_amount, admin_commission_rate: chit_groups.admin_commission_rate, status: chit_groups.status })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const cycle  = cycleRows[0];
  const basket = basketRows[0];
  const group  = groupRows[0];

  if (!group)                     throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (group.status === 'Closed')  throw new AppError(409, 'GROUP_CLOSED',    'This group is closed.');
  if (!cycle)                     throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found in this group.');
  if (cycle.status === 'Closed')  throw new AppError(409, 'CYCLE_CLOSED',    'Cycle is already closed.');

  const realized = Number(basket.current_balance);
  const pool     = Number(group.pool_amount);
  const nextSlot = existingWinnersRows.length + 1;

  // Double Chitti cap: maximum 2 winners per cycle.
  if (nextSlot > 2) throw new AppError(409, 'CHITI_SLOTS_FULL', 'Double Chitti only supports 2 winners per cycle. Both slots are already filled.');

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
    if (basket_credit < 0)      throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin commission (${admin_commission} paise).`);
    winner_takeaway  = pool - bid_amount;

    // ── Double Chitti financial validation (slot 2 only) ────────────────────
    // Validate at payout time: bid1_basket_credit + bid2_basket_credit + basket_balance >= pool_amount.
    // If the condition is not met, the basket cannot fund the second payout.
    if (nextSlot === 2) {
      const winner1BasketCredit = Number(existingWinnersRows[0]?.basket_credit ?? 0);
      const totalAvailable      = winner1BasketCredit + basket_credit + realized;
      if (totalAvailable < pool) {
        throw new AppError(
          400,
          'DOUBLE_CHITTI_INSUFFICIENT',
          `Double Chitti not possible: Basket Balance + Bid Discounts (${paiseToRupeeDisplay(totalAvailable)}) is less than Pool Amount (${paiseToRupeeDisplay(pool)}).`,
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

    if (!is_admin_withdrawal) {
      // Use atomic SQL increments — safe under retries; no stale snapshot math.
      const doubleChitiDebit = nextSlot > 1 ? pool : 0;
      await tx.update(baskets)
        .set({
          current_balance: sql`${baskets.current_balance} + ${basket_credit} - ${doubleChitiDebit}`,
          total_credited:  sql`${baskets.total_credited} + ${basket_credit}`,
          total_debited:   sql`${baskets.total_debited} + ${doubleChitiDebit}`,
        })
        .where(eq(baskets.id, basket.id));

      if (nextSlot > 1) {
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
    // Each extra winner (slot 2+) consumes a future winner slot, so the chit ends
    // one month early: the final remaining cycle becomes a payment-free skip month.
    // No winner, no basket payout — the basket already funded this extra payout above.
    if (nextSlot >= 2) {
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
  if (new_basket_credit < 0)                    throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin commission (${new_commission} paise).`);
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

// ─── correctClosedCycle ───────────────────────────────────────────────────────
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
    if (new_basket_credit < 0)            throw new AppError(400, 'BID_BELOW_COMMISSION', `bid_amount must be at least the admin commission (${new_commission} paise).`);
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

// ─── reopenCycle ─────────────────────────────────────────────────────────────
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

    db.select({
      monthly_contribution: chit_groups.monthly_contribution,
      pool_amount: chit_groups.pool_amount,
      admin_commission_rate: chit_groups.admin_commission_rate,
      total_months: chit_groups.total_months,
      total_shares: chit_groups.total_shares,
    })
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

      const currentBalance  = Number(basketRows?.current_balance ?? 0);
      const pool            = Number(group.pool_amount);
      const commissionRate  = parseFloat(String(group.admin_commission_rate));
      const adminCommission = Math.round(pool * commissionRate / 100);
      // Members + basket must collectively cover pool_amount AND admin commission.
      // Admin commission is settled in this cycle (last member auto-wins; no bid discount).
      const total_needed    = pool + adminCommission;

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
