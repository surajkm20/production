// Business logic for the basket (communal kitty) and loans.
// Responsibilities: disburse loan (validate basket balance, write LOAN_DISBURSED txn,
// decrement basket), record repayment (principal + interest, write LOAN_REPAID /
// INTEREST_ACCRUED txn, update outstanding_principal), compute monthly interest accrual,
// write-off loan, recompute cached basket balance from ledger for integrity checks.

import { eq, and, desc, gte, lte, count, sql } from 'drizzle-orm';
import { db } from '../config/db';
import {
  chit_groups, memberships, baskets, basket_transactions,
  loans, loan_transactions, users, monthly_cycles, payments,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { encodeCursor, decodeCursor } from '../utils/pagination';
import { paiseToRupeeDisplay } from '../utils/money';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';

// ─── getBasket ───────────────────────────────────────────────────────────────
export async function getBasket(userId: string, group_id: string) {
  const caller  = await assertActiveMember(group_id, userId);
  const isAdmin = caller.role === 'Admin';

  const [basketRows, groupRows] = await Promise.all([
    db.select({
      id: baskets.id, current_balance: baskets.current_balance,
      total_credited: baskets.total_credited, total_debited: baskets.total_debited,
      total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned,
      last_recomputed_at: baskets.last_recomputed_at,
    })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ total_shares: chit_groups.total_shares })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),
  ]);

  const basket = basketRows[0];
  if (!basket) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found for this group.');

  if (isAdmin) {
    const [{ active_loans }] = await db
      .select({ active_loans: count(loans.id) })
      .from(loans)
      .where(and(eq(loans.basket_id, basket.id), eq(loans.status, 'Active')));

    return {
      basket_id:             basket.id,
      current_balance:       basket.current_balance,
      total_credited:        basket.total_credited,
      total_debited:         basket.total_debited,
      total_lent_out:        basket.total_lent_out,
      total_interest_earned: basket.total_interest_earned,
      active_loans_count:    active_loans,
      last_recomputed_at:    basket.last_recomputed_at,
    };
  }

  const myShareCount  = Number(caller.share_count);
  const totalShares   = Number(groupRows[0].total_shares);
  const myShareIfClosed = Math.floor((myShareCount / totalShares) * Number(basket.current_balance));

  return {
    basket_id:                basket.id,
    current_balance:          basket.current_balance,
    my_share_if_closed_today: myShareIfClosed,
  };
}

// ─── listTransactions ────────────────────────────────────────────────────────
export async function listTransactions(
  userId:   string,
  group_id: string,
  filters:  { type?: string; cycle_id?: string; from?: string; to?: string; cursor?: string; limit?: number },
) {
  const caller  = await assertActiveMember(group_id, userId);
  const isAdmin = caller.role === 'Admin';
  const limit   = Math.min(filters.limit ?? 20, 100);

  const [basketRows] = await db
    .select({ id: baskets.id })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  if (!basketRows) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  const conditions: ReturnType<typeof eq>[] = [eq(basket_transactions.basket_id, basketRows.id)];
  if (!isAdmin)           conditions.push(eq(basket_transactions.counterparty_user_id, userId));
  if (filters.type)       conditions.push(eq(basket_transactions.txn_type, filters.type));
  if (filters.cycle_id)   conditions.push(eq(basket_transactions.cycle_id, filters.cycle_id));
  if (filters.from)       conditions.push(gte(basket_transactions.created_at, new Date(filters.from)));
  if (filters.to)         conditions.push(lte(basket_transactions.created_at, new Date(filters.to)));
  if (filters.cursor) {
    const { created_at } = decodeCursor(filters.cursor);
    conditions.push(lte(basket_transactions.created_at, new Date(created_at)));
  }

  const rows = await db
    .select({
      id:                   basket_transactions.id,
      txn_type:             basket_transactions.txn_type,
      direction:            basket_transactions.direction,
      amount:               basket_transactions.amount,
      cycle_month_label:    monthly_cycles.month_label,
      counterparty_user_id: basket_transactions.counterparty_user_id,
      counterparty_name:    users.name,
      notes:                basket_transactions.notes,
      created_at:           basket_transactions.created_at,
    })
    .from(basket_transactions)
    .leftJoin(monthly_cycles, eq(monthly_cycles.id, basket_transactions.cycle_id))
    .leftJoin(users, eq(users.id, basket_transactions.counterparty_user_id))
    .where(and(...conditions))
    .orderBy(desc(basket_transactions.created_at))
    .limit(limit + 1);

  const has_more  = rows.length > limit;
  const items     = has_more ? rows.slice(0, limit) : rows;
  const last      = items.at(-1);
  const next_cursor = (has_more && last)
    ? encodeCursor({ id: last.id, created_at: last.created_at!.toISOString() })
    : null;

  return {
    data: items.map(r => ({
      txn_id:            r.id,
      txn_type:          r.txn_type,
      direction:         r.direction,
      amount:            r.amount,
      cycle_month_label: r.cycle_month_label ?? null,
      counterparty_name: r.counterparty_name ?? null,
      notes:             r.notes ?? null,
      created_at:        r.created_at,
    })),
    next_cursor,
    has_more,
  };
}

// ─── recordAdjustment ────────────────────────────────────────────────────────
export async function recordAdjustment(
  userId:   string,
  group_id: string,
  data:     { direction: 'C' | 'D'; amount: number; notes: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { direction, amount, notes } = data;

  const [basketRow] = await db
    .select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  if (!basketRow) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  if (direction === 'D' && amount > Number(basketRow.current_balance)) {
    throw new AppError(409, 'BASKET_INSUFFICIENT', 'Debit amount exceeds current basket balance.');
  }

  const balanceAfter = direction === 'C'
    ? Number(basketRow.current_balance) + amount
    : Number(basketRow.current_balance) - amount;

  const txn = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(basket_transactions).values({
      basket_id:  basketRow.id,
      txn_type:   'ADJUSTMENT',
      amount,
      direction,
      notes,
      created_by: userId,
    }).returning({ id: basket_transactions.id, created_at: basket_transactions.created_at });

    await tx.update(baskets).set({
      current_balance: balanceAfter,
      ...(direction === 'C'
        ? { total_credited: Number(basketRow.total_credited) + amount }
        : { total_debited:  Number(basketRow.total_debited)  + amount }),
    }).where(eq(baskets.id, basketRow.id));

    return inserted;
  });

  const [activeMembers, [adminRow]] = await Promise.all([
    db.select({ user_id: memberships.user_id })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.status, 'Active'))),
    db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
  ]);

  const dirLabel = direction === 'C' ? 'credited to' : 'debited from';
  const title    = `Basket adjusted by ${adminRow.name}`;
  const body     = `${paiseToRupeeDisplay(amount)} ${dirLabel} basket. Reason: ${notes}`;

  Promise.all(
    activeMembers.map(m => notify({ user_id: m.user_id, group_id, type: 'BASKET_ADJUSTED', title, body, data: { group_id } })),
  ).catch(() => {});

  await insertActivity({
    group_id,
    event_type: 'BASKET_ADJUSTED',
    actor_id:   userId,
    data:       { amount, direction },
  });

  return { txn_id: txn.id, txn_type: 'ADJUSTMENT' as const, direction, amount, notes, basket_balance_after: balanceAfter, created_at: txn.created_at };
}

// ─── disburseLoan ────────────────────────────────────────────────────────────
export async function disburseLoan(
  userId:   string,
  group_id: string,
  data: {
    borrower_user_id:     string;
    principal:            number;
    expected_close_date?: string;
    notes?:               string;
  },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { borrower_user_id, principal, expected_close_date, notes } = data;

  const [basketRows, groupRows, borrowerMemberRows, activeLoanRows] = await Promise.all([
    db.select({ id: baskets.id, current_balance: baskets.current_balance, total_debited: baskets.total_debited, total_credited: baskets.total_credited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ monthly_interest_rate: chit_groups.monthly_interest_rate, monthly_contribution: chit_groups.monthly_contribution, total_months: chit_groups.total_months })
      .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1),

    db.select({ id: memberships.id, share_count: memberships.share_count, wins_count: memberships.wins_count })
      .from(memberships)
      .where(and(eq(memberships.group_id, group_id), eq(memberships.user_id, borrower_user_id), eq(memberships.status, 'Active')))
      .limit(1),

    db.select({ id: loans.id })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(eq(baskets.group_id, group_id), eq(loans.borrower_user_id, borrower_user_id), eq(loans.status, 'Active')))
      .limit(1),
  ]);

  const basket         = basketRows[0];
  const group          = groupRows[0];
  const borrowerMember = borrowerMemberRows[0];
  const monthly_rate   = Number(group.monthly_interest_rate);

  if (!borrowerMember) throw new AppError(409, 'BORROWER_NOT_MEMBER', 'The borrower must be an active member of this group.');

  const remaining_shares   = Number(borrowerMember.share_count) - Number(borrowerMember.wins_count);
  const allSharesWithdrawn = remaining_shares <= 0;
  const hasActiveLoan      = !!activeLoanRows[0];

  const per_share_value    = Number(group.monthly_contribution) * Number(group.total_months);
  const eligibility_cap    = remaining_shares * per_share_value;
  const exceedsEligibility = principal > eligibility_cap;

  const balanceAfter = Number(basket.current_balance) - principal;
  if (balanceAfter < 0)
    throw new AppError(409, 'INSUFFICIENT_BASKET_BALANCE', `Basket balance (${paiseToRupeeDisplay(Number(basket.current_balance))}) is less than the loan amount (${paiseToRupeeDisplay(principal)}).`);

  const [currentCycleRow] = await db
    .select({ month_number: monthly_cycles.month_number })
    .from(monthly_cycles)
    .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
    .orderBy(monthly_cycles.month_number)
    .limit(1);

  const disbursement_month_number = currentCycleRow?.month_number ?? 1;

  const newLoan = await db.transaction(async (tx) => {
    const [loan] = await tx.insert(loans).values({
      basket_id:                 basket.id,
      borrower_user_id,
      principal,
      monthly_interest_rate:     String(monthly_rate),
      disbursement_month_number,
      ...(expected_close_date ? { expected_close_date } : {}),
      ...(notes ? { notes } : {}),
    }).returning({ id: loans.id, disbursed_at: loans.disbursed_at });

    await tx.insert(basket_transactions).values({
      basket_id:            basket.id,
      txn_type:             'LOAN_DISBURSED',
      amount:               principal,
      direction:            'D',
      counterparty_user_id: borrower_user_id,
      related_loan_id:      loan.id,
      notes:                notes ?? null,
      created_by:           userId,
    });

    await tx.update(baskets).set({
      current_balance: balanceAfter,
      total_debited:   Number(basket.total_debited) + principal,
      total_lent_out:  Number(basket.total_lent_out) + principal,
    }).where(eq(baskets.id, basket.id));

    return loan;
  });

  await insertActivity({
    group_id,
    event_type: 'LOAN_DISBURSED',
    actor_id:   borrower_user_id,
    data:       { principal },
  });

  notify({
    user_id:  borrower_user_id,
    group_id,
    type:     'LOAN_DISBURSED',
    title:    'Loan disbursed',
    body:     `${paiseToRupeeDisplay(principal)} has been disbursed to you from the basket.`,
    data:     { loan_id: newLoan.id, principal },
  }).catch(() => {});

  return {
    loan_id:              newLoan.id,
    borrower_user_id,
    principal,
    monthly_interest_rate: monthly_rate,
    disbursed_at:         newLoan.disbursed_at,
    status:               'Active',
    basket_balance_after: balanceAfter,
    warnings: [
      ...(allSharesWithdrawn ? ['This member has already withdrawn all their shares (wins = total shares). Proceeding on admin\'s discretion.'] : []),
      ...(exceedsEligibility && !allSharesWithdrawn ? [`Loan of ${paiseToRupeeDisplay(principal)} exceeds this member's eligibility of ${paiseToRupeeDisplay(eligibility_cap)} (${remaining_shares} share${remaining_shares !== 1 ? 's' : ''} × ${paiseToRupeeDisplay(per_share_value)}/share). Proceeding on admin's discretion.`] : []),
      ...(hasActiveLoan ? ['Member already has an active loan in this group. Multiple active loans are now outstanding.'] : []),
    ],
  };
}

function computeOutstandingInterest(
  cyclesElapsed: number,
  principal: number,
  rate: number,
  totalInterestPaid: number,
): number {
  const monthlyInterest = Math.round(principal * rate / 100);
  const totalAccrued    = cyclesElapsed * monthlyInterest;
  return Math.max(0, totalAccrued - totalInterestPaid);
}

function computeNextDueDate(disbursedAt: Date | null, status: string): string | null {
  if (status !== 'Active' || !disbursedAt) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = disbursedAt.getDate();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const clamp = (y: number, m: number) => {
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, last));
  };
  const thisMonth = clamp(today.getFullYear(), today.getMonth());
  if (thisMonth >= today) return fmt(thisMonth);
  const nextM = today.getMonth() + 1;
  const nextY = today.getFullYear() + (nextM > 11 ? 1 : 0);
  return fmt(clamp(nextY, nextM % 12));
}

// ─── listLoans ───────────────────────────────────────────────────────────────
export async function listLoans(
  userId:   string,
  group_id: string,
  filters:  { status?: string; borrower_user_id?: string },
) {
  const caller  = await assertActiveMember(group_id, userId);
  const isAdmin = caller.role === 'Admin';

  const [basketRows] = await db
    .select({ id: baskets.id })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  if (!basketRows) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  const conditions: ReturnType<typeof eq>[] = [eq(loans.basket_id, basketRows.id)];
  if (!isAdmin) {
    conditions.push(eq(loans.borrower_user_id, userId));
  } else if (filters.borrower_user_id) {
    conditions.push(eq(loans.borrower_user_id, filters.borrower_user_id));
  }

  if (filters.status) {
    const dbStatus = filters.status === 'written_off' ? 'WrittenOff'
                   : filters.status === 'active'      ? 'Active'
                   : filters.status === 'repaid'      ? 'Repaid'
                   : filters.status;
    conditions.push(eq(loans.status, dbStatus));
  }

  const [rows, [cycleRow]] = await Promise.all([
    db.select({
      loan_id: loans.id, borrower_user_id: loans.borrower_user_id, borrower_name: users.name,
      principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate,
      disbursement_month_number: loans.disbursement_month_number,
      total_interest_paid: loans.total_interest_paid,
      disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date, status: loans.status,
    })
    .from(loans)
    .innerJoin(users, eq(users.id, loans.borrower_user_id))
    .where(and(...conditions))
    .orderBy(desc(loans.disbursed_at)),

    db.select({ current_month: sql<number>`min(${monthly_cycles.month_number})` })
      .from(monthly_cycles)
      .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open'))),
  ]);

  const currentMonth = cycleRow?.current_month ?? 0;

  return rows.map(r => {
    const cyclesElapsed = Math.max(0, currentMonth - r.disbursement_month_number);
    return {
      ...r,
      outstanding_interest: r.status === 'Active'
        ? computeOutstandingInterest(cyclesElapsed, Number(r.principal), Number(r.monthly_interest_rate), Number(r.total_interest_paid))
        : 0,
      next_cycle_due_date: computeNextDueDate(r.disbursed_at, r.status),
    };
  });
}

// ─── getLoan ─────────────────────────────────────────────────────────────────
export async function getLoan(userId: string, group_id: string, loan_id: string) {
  const caller  = await assertActiveMember(group_id, userId);
  const isAdmin = caller.role === 'Admin';

  const [basketRows] = await db
    .select({ id: baskets.id })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  if (!basketRows) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  const [[loanRow], [cycleRow]] = await Promise.all([
    db.select({
      id: loans.id, borrower_user_id: loans.borrower_user_id, borrower_name: users.name,
      principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate,
      disbursement_month_number: loans.disbursement_month_number,
      total_interest_paid: loans.total_interest_paid,
      disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date,
      closed_at: loans.closed_at, status: loans.status, notes: loans.notes,
    })
    .from(loans)
    .innerJoin(users, eq(users.id, loans.borrower_user_id))
    .where(and(eq(loans.id, loan_id), eq(loans.basket_id, basketRows.id)))
    .limit(1),

    db.select({ current_month: sql<number>`min(${monthly_cycles.month_number})` })
      .from(monthly_cycles)
      .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open'))),
  ]);

  if (!loanRow) throw new AppError(404, 'LOAN_NOT_FOUND', 'Loan not found in this group.');
  if (!isAdmin && loanRow.borrower_user_id !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only view your own loans.');

  const txns = await db
    .select({ id: loan_transactions.id, type: loan_transactions.txn_type, amount: loan_transactions.amount, txn_date: loan_transactions.txn_date, notes: loan_transactions.notes, created_at: loan_transactions.created_at })
    .from(loan_transactions)
    .where(eq(loan_transactions.loan_id, loan_id))
    .orderBy(desc(loan_transactions.created_at));

  const currentMonth = cycleRow?.current_month ?? 0;
  const cyclesElapsed = Math.max(0, currentMonth - loanRow.disbursement_month_number);
  const outstanding_interest = loanRow.status === 'Active'
    ? computeOutstandingInterest(cyclesElapsed, Number(loanRow.principal), Number(loanRow.monthly_interest_rate), Number(loanRow.total_interest_paid))
    : 0;

  return {
    loan_id:  loanRow.id,
    borrower: { user_id: loanRow.borrower_user_id, name: loanRow.borrower_name },
    principal: loanRow.principal, monthly_interest_rate: loanRow.monthly_interest_rate,
    total_interest_paid: loanRow.total_interest_paid,
    outstanding_interest,
    disbursed_at: loanRow.disbursed_at, expected_close_date: loanRow.expected_close_date,
    closed_at: loanRow.closed_at, status: loanRow.status, notes: loanRow.notes,
    transactions: txns,
  };
}

// ─── repayLoan ───────────────────────────────────────────────────────────────
export async function repayLoan(
  userId:   string,
  group_id: string,
  loan_id:  string,
  data:     { principal_repaid?: number; interest_paid?: number; txn_date: string; cycle_id?: string; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { principal_repaid = 0, interest_paid = 0, txn_date, cycle_id, notes } = data;

  if (principal_repaid <= 0 && interest_paid <= 0) {
    throw new AppError(400, 'INVALID_REQUEST', 'At least one of principal_repaid or interest_paid must be > 0.');
  }

  const [basketRows] = await db
    .select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  const [[loanRow], [cycleRow]] = await Promise.all([
    db.select({ id: loans.id, status: loans.status, principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate, disbursement_month_number: loans.disbursement_month_number, total_interest_paid: loans.total_interest_paid, borrower_user_id: loans.borrower_user_id })
      .from(loans)
      .where(and(eq(loans.id, loan_id), eq(loans.basket_id, basketRows.id)))
      .limit(1),

    db.select({ current_month: sql<number>`min(${monthly_cycles.month_number})` })
      .from(monthly_cycles)
      .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open'))),
  ]);

  if (!loanRow) throw new AppError(404, 'LOAN_NOT_FOUND', 'Loan not found.');
  if (loanRow.status !== 'Active') throw new AppError(409, 'LOAN_CLOSED', 'Cannot record repayment on a closed or written-off loan.');

  const currentMonth         = cycleRow?.current_month ?? 0;
  const cyclesElapsed        = Math.max(0, currentMonth - loanRow.disbursement_month_number);
  const outstanding_interest = computeOutstandingInterest(
    cyclesElapsed, Number(loanRow.principal), Number(loanRow.monthly_interest_rate), Number(loanRow.total_interest_paid),
  );

  if (principal_repaid > Number(loanRow.principal)) {
    throw new AppError(409, 'PRINCIPAL_EXCEEDS_OUTSTANDING', `principal_repaid (${paiseToRupeeDisplay(principal_repaid)}) exceeds the outstanding principal (${paiseToRupeeDisplay(Number(loanRow.principal))}).`);
  }
  if (principal_repaid > 0 && principal_repaid < Number(loanRow.principal)) {
    throw new AppError(409, 'PARTIAL_PRINCIPAL_NOT_ALLOWED', `Loan principal must be repaid in full. Full principal is ${paiseToRupeeDisplay(Number(loanRow.principal))}.`);
  }
  if (interest_paid > outstanding_interest) {
    throw new AppError(409, 'INTEREST_EXCEEDS_OUTSTANDING', `interest_paid (${paiseToRupeeDisplay(interest_paid)}) exceeds the cumulative outstanding interest (${paiseToRupeeDisplay(outstanding_interest)}).`);
  }

  const newTotalInterestPaid   = Number(loanRow.total_interest_paid) + interest_paid;
  const newOutstandingInterest = outstanding_interest - interest_paid;
  const loanFullyRepaid   = principal_repaid > 0;
  const totalReturn       = principal_repaid + interest_paid;
  const newBalance        = Number(basketRows.current_balance)       + totalReturn;
  const newLentOut        = Number(basketRows.total_lent_out)        - principal_repaid;
  const newInterestEarned = Number(basketRows.total_interest_earned) + interest_paid;
  const now               = new Date();

  await db.transaction(async (tx) => {
    if (principal_repaid > 0) {
      await tx.insert(loan_transactions).values({ loan_id, txn_type: 'PRINCIPAL_REPAID', amount: principal_repaid, txn_date, notes: notes ?? null, created_by: userId });
      await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'LOAN_REPAID', amount: principal_repaid, direction: 'C', related_loan_id: loan_id, ...(cycle_id ? { cycle_id } : {}), notes: notes ?? null, created_by: userId });
    }
    if (interest_paid > 0) {
      await tx.insert(loan_transactions).values({ loan_id, txn_type: 'INTEREST_PAID', amount: interest_paid, txn_date, notes: notes ?? null, created_by: userId });
      await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'INTEREST_ACCRUED', amount: interest_paid, direction: 'C', related_loan_id: loan_id, ...(cycle_id ? { cycle_id } : {}), notes: notes ?? null, created_by: userId });
    }
    await tx.update(loans).set({ total_interest_paid: newTotalInterestPaid, updated_at: now, ...(loanFullyRepaid ? { status: 'Repaid', closed_at: now } : {}) }).where(eq(loans.id, loan_id));
    await tx.update(baskets).set({ current_balance: newBalance, total_credited: Number(basketRows.total_credited) + totalReturn, total_lent_out: newLentOut, total_interest_earned: newInterestEarned }).where(eq(baskets.id, basketRows.id));
  });

  await insertActivity({
    group_id,
    event_type: 'LOAN_REPAID',
    actor_id:   loanRow.borrower_user_id,
    data:       { amount: principal_repaid + interest_paid },
  });

  return {
    loan_id,
    total_interest_paid:  newTotalInterestPaid,
    outstanding_interest: newOutstandingInterest,
    status:               loanFullyRepaid ? 'Repaid' : 'Active',
    basket_balance_after: newBalance,
  };
}

// ─── updateLoan ──────────────────────────────────────────────────────────────
export async function updateLoan(
  userId:   string,
  group_id: string,
  loan_id:  string,
  data:     { status?: string; expected_close_date?: string; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { status: new_status, expected_close_date, notes } = data;

  const [basketRows] = await db
    .select({ id: baskets.id, total_lent_out: baskets.total_lent_out })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  const [loanRow] = await db
    .select({ id: loans.id, status: loans.status, principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate, total_interest_paid: loans.total_interest_paid, disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date, borrower_user_id: loans.borrower_user_id, notes: loans.notes })
    .from(loans)
    .where(and(eq(loans.id, loan_id), eq(loans.basket_id, basketRows.id)))
    .limit(1);

  if (!loanRow) throw new AppError(404, 'LOAN_NOT_FOUND', 'Loan not found.');
  if (loanRow.status !== 'Active') throw new AppError(409, 'LOAN_CLOSED', 'Cannot update a Repaid or WrittenOff loan.');

  const now = new Date();

  if (new_status !== undefined) {
    if (new_status !== 'WrittenOff') {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot transition from Active to '${new_status}'. Only 'WrittenOff' is allowed.`);
    }
    await db.transaction(async (tx) => {
      await tx.update(loans).set({ status: 'WrittenOff', closed_at: now, updated_at: now, ...(notes ? { notes } : {}) }).where(eq(loans.id, loan_id));
      await tx.update(baskets).set({ total_lent_out: Number(basketRows.total_lent_out) - Number(loanRow.principal) }).where(eq(baskets.id, basketRows.id));
    });
  } else if (expected_close_date !== undefined) {
    await db.update(loans).set({ expected_close_date, updated_at: now, ...(notes ? { notes } : {}) }).where(eq(loans.id, loan_id));
  } else {
    throw new AppError(400, 'INVALID_REQUEST', 'Provide status or expected_close_date to update.');
  }

  const [updated] = await db
    .select({ id: loans.id, borrower_user_id: loans.borrower_user_id, principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate, total_interest_paid: loans.total_interest_paid, disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date, closed_at: loans.closed_at, status: loans.status, notes: loans.notes })
    .from(loans).where(eq(loans.id, loan_id)).limit(1);

  return {
    loan_id: updated.id, borrower_user_id: updated.borrower_user_id, principal: updated.principal,
    monthly_interest_rate: updated.monthly_interest_rate,
    total_interest_paid: updated.total_interest_paid, disbursed_at: updated.disbursed_at,
    expected_close_date: updated.expected_close_date, closed_at: updated.closed_at,
    status: updated.status, notes: updated.notes,
  };
}
