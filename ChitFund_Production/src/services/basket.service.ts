/**
 * @fileoverview Basket (communal kitty) and loan business logic for the ChitFund
 * API. It reads basket state and the transaction ledger, records manual basket
 * adjustments, disburses loans against the balance, lists/fetches loans with
 * computed outstanding interest, records single and bulk repayments (idempotent
 * via the idempotency helpers), deletes Active loans by reversing their basket
 * effects, and write-offs/edits loans. Every balance change is written inside a
 * transaction alongside its ledger entry, all amounts are integer paise, and
 * monthly interest is accrued per elapsed cycle.
 * @module services/basket
 * @author Suraj KM
 */

import { eq, and, desc, gte, lte, count, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../config/db';
import {
  chit_groups, memberships, baskets, basket_transactions,
  loans, loan_transactions, users, monthly_cycles, payments,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { encodeCursor, decodeCursor } from '../utils/pagination';
import { paiseToRupeeDisplay } from '../utils/money';
import { checkIdempotency, storeIdempotency } from '../utils/idempotency';
import { assertActiveMember } from './memberships.service';
import { notify } from './notifications.service';
import { insertActivity } from './activity.service';

/**
 * Returns the group's basket overview, giving admins full totals and active-loan count while members see only the balance and their projected closure share.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group whose basket to read
 * @returns A promise resolving to the admin basket view or the limited member view
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 BASKET_NOT_FOUND if the group has no basket
 */
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

/**
 * Lists basket ledger entries (cursor-paginated), scoping non-admins to only their own transactions and enriching each row with cycle and counterparty labels.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group whose basket ledger to read
 * @param filters - Filtering and pagination options
 * @param filters.type - Restrict to a specific transaction type
 * @param filters.cycle_id - Restrict to transactions tagged with a cycle
 * @param filters.from - Inclusive lower bound on `created_at` (ISO date)
 * @param filters.to - Inclusive upper bound on `created_at` (ISO date)
 * @param filters.cursor - Opaque pagination cursor from a previous page
 * @param filters.limit - Page size (defaults to 100, capped at 500)
 * @returns A promise resolving to the ledger rows, the next cursor, and a `has_more` flag
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 BASKET_NOT_FOUND if the group has no basket
 */
export async function listTransactions(
  userId:   string,
  group_id: string,
  filters:  { type?: string; cycle_id?: string; from?: string; to?: string; cursor?: string; limit?: number },
) {
  const caller  = await assertActiveMember(group_id, userId);
  const isAdmin = caller.role === 'Admin';
  const limit   = Math.min(filters.limit ?? 100, 500);

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

  // Alias for the cycle the transaction belongs to (repayment/disbursement cycle tag)
  const txnCycle          = alias(monthly_cycles, 'txn_cycle');
  // Alias for the cycle the loan was disbursed in (looked up via loans.disbursement_month_number)
  const disbursementCycle = alias(monthly_cycles, 'disbursement_cycle');
  // Alias for the loan's borrower — reliable even when counterparty_user_id is null on repayment rows
  const loanBorrower      = alias(users, 'loan_borrower');

  const rows = await db
    .select({
      id:                              basket_transactions.id,
      txn_type:                        basket_transactions.txn_type,
      direction:                       basket_transactions.direction,
      amount:                          basket_transactions.amount,
      cycle_month_label:               txnCycle.month_label,
      cycle_month_number:              txnCycle.month_number,
      counterparty_user_id:            basket_transactions.counterparty_user_id,
      counterparty_name:               users.name,
      loan_borrower_name:              loanBorrower.name,
      notes:                           basket_transactions.notes,
      created_at:                      basket_transactions.created_at,
      related_loan_id:                 basket_transactions.related_loan_id,
      loan_disbursement_month_number:  disbursementCycle.month_number,
      loan_disbursement_label:         disbursementCycle.month_label,
    })
    .from(basket_transactions)
    .leftJoin(txnCycle, eq(txnCycle.id, basket_transactions.cycle_id))
    .leftJoin(users, eq(users.id, basket_transactions.counterparty_user_id))
    .leftJoin(loans, eq(loans.id, basket_transactions.related_loan_id))
    .leftJoin(loanBorrower, eq(loanBorrower.id, loans.borrower_user_id))
    .leftJoin(
      disbursementCycle,
      and(
        eq(disbursementCycle.month_number, loans.disbursement_month_number),
        eq(disbursementCycle.group_id, group_id),
      ),
    )
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
      txn_id:                         r.id,
      txn_type:                       r.txn_type,
      direction:                      r.direction,
      amount:                         r.amount,
      cycle_month_label:              r.cycle_month_label ?? null,
      cycle_month_number:             r.cycle_month_number ?? null,
      counterparty_name:              r.counterparty_name ?? null,
      loan_borrower_name:             r.loan_borrower_name ?? null,
      notes:                          r.notes ?? null,
      created_at:                     r.created_at,
      related_loan_id:                r.related_loan_id ?? null,
      loan_disbursement_month_number: r.loan_disbursement_month_number ?? null,
      loan_disbursement_label:        r.loan_disbursement_label ?? null,
    })),
    next_cursor,
    has_more,
  };
}

/**
 * Records a manual basket credit or debit (admin only), updating the balance and totals in a transaction and notifying all active members.
 *
 * @param userId - The requesting admin, recorded as the transaction creator
 * @param group_id - Group whose basket is adjusted; must not be closed
 * @param data - Adjustment details
 * @param data.direction - `'C'` to credit the basket or `'D'` to debit it
 * @param data.amount - Adjustment amount in paise
 * @param data.notes - Required reason, surfaced to members in the notification
 * @returns A promise resolving to the new transaction's id, amounts, and resulting balance
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 GROUP_NOT_FOUND / BASKET_NOT_FOUND if missing
 * @throws {AppError} 409 GROUP_CLOSED, or BASKET_INSUFFICIENT if a debit exceeds the balance
 */
export async function recordAdjustment(
  userId:   string,
  group_id: string,
  data:     { direction: 'C' | 'D'; amount: number; notes: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [groupRow] = await db.select({ status: chit_groups.status })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);
  if (!groupRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (groupRow.status === 'Closed') throw new AppError(409, 'GROUP_CLOSED', 'This group is closed.');

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

/**
 * Disburses a loan from the basket to an active member (admin only), writing the LOAN_DISBURSED ledger entry and decrementing the balance, with soft warnings for eligibility/multiple-loan cases.
 *
 * @param userId - The requesting admin, recorded as the transaction creator
 * @param group_id - Group whose basket funds the loan; must not be closed
 * @param data - Loan details
 * @param data.borrower_user_id - Active member receiving the loan
 * @param data.principal - Loan principal in paise; must not exceed the basket balance
 * @param data.expected_close_date - Optional expected repayment date
 * @param data.notes - Optional note stored on the loan and ledger entry
 * @returns A promise resolving to the new loan summary, resulting balance, and any advisory `warnings`
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 GROUP_NOT_FOUND if the group is missing
 * @throws {AppError} 409 GROUP_CLOSED, BORROWER_NOT_MEMBER, or INSUFFICIENT_BASKET_BALANCE
 */
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

  const [groupClosedRow] = await db.select({ status: chit_groups.status })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);
  if (!groupClosedRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (groupClosedRow.status === 'Closed') throw new AppError(409, 'GROUP_CLOSED', 'This group is closed.');

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
    .select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number })
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
      ...(currentCycleRow?.id ? { cycle_id: currentCycleRow.id } : {}),
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

/**
 * Lists basket loans with computed outstanding interest, next due date, and repayment history; non-admins see only their own loans.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group whose loans to list
 * @param filters - Optional filters
 * @param filters.status - Restrict to `'active'`, `'repaid'`, or `'written_off'`
 * @param filters.borrower_user_id - Admin-only filter to a single borrower
 * @returns A promise resolving to the matching loans, each enriched with interest and repayment fields (empty array if none)
 * @throws {AppError} 403 NOT_A_MEMBER if the caller is not an active member
 * @throws {AppError} 404 BASKET_NOT_FOUND if the group has no basket
 */
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

  // Alias for disbursement cycle lookup
  const disbCycle = alias(monthly_cycles, 'disb_cycle');

  const [rows, [cycleRow]] = await Promise.all([
    db.select({
      loan_id: loans.id, borrower_user_id: loans.borrower_user_id, borrower_name: users.name,
      principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate,
      disbursement_month_number: loans.disbursement_month_number,
      disbursement_month_label: disbCycle.month_label,
      total_interest_paid: loans.total_interest_paid,
      disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date, status: loans.status,
    })
    .from(loans)
    .innerJoin(users, eq(users.id, loans.borrower_user_id))
    .leftJoin(disbCycle, and(
      eq(disbCycle.group_id, group_id),
      eq(disbCycle.month_number, loans.disbursement_month_number),
    ))
    .where(and(...conditions))
    .orderBy(desc(loans.disbursed_at)),

    db.select({ current_month: sql<number>`min(${monthly_cycles.month_number})` })
      .from(monthly_cycles)
      .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open'))),
  ]);

  const currentMonth = cycleRow?.current_month ?? 0;

  if (rows.length === 0) return [];

  // Fetch repayment basket_transactions for all loans in one query
  const loanIds = rows.map(r => r.loan_id);
  const repayTxns = await db
    .select({
      related_loan_id:  basket_transactions.related_loan_id,
      txn_type:         basket_transactions.txn_type,
      amount:           basket_transactions.amount,
      cycle_month_number: monthly_cycles.month_number,
      cycle_month_label:  monthly_cycles.month_label,
      created_at:       basket_transactions.created_at,
    })
    .from(basket_transactions)
    .leftJoin(monthly_cycles, eq(monthly_cycles.id, basket_transactions.cycle_id))
    .where(and(
      sql`${basket_transactions.related_loan_id} = ANY(${sql.raw(`ARRAY[${loanIds.map(id => `'${id}'`).join(',')}]::uuid[]`)})`,
      sql`${basket_transactions.txn_type} IN ('LOAN_REPAID', 'INTEREST_ACCRUED')`,
    ))
    .orderBy(basket_transactions.created_at);

  // Group repayment txns by loan_id
  type RepayTxn = typeof repayTxns[number];
  const repayByLoan = new Map<string, RepayTxn[]>();
  for (const txn of repayTxns) {
    if (!txn.related_loan_id) continue;
    const list = repayByLoan.get(txn.related_loan_id) ?? [];
    list.push(txn);
    repayByLoan.set(txn.related_loan_id, list);
  }

  return rows.map(r => {
    const cyclesElapsed = Math.max(0, currentMonth - r.disbursement_month_number);
    const loanTxns      = repayByLoan.get(r.loan_id) ?? [];

    // Build repayment_history: one entry per (cycle, txn_type)
    const repaymentHistory = loanTxns.map(t => ({
      txn_type:           t.txn_type,   // 'LOAN_REPAID' | 'INTEREST_ACCRUED'
      amount:             t.amount,
      cycle_month_number: t.cycle_month_number ?? null,
      cycle_month_label:  t.cycle_month_label  ?? null,
      cycle_label:        t.cycle_month_number ? `Cycle ${t.cycle_month_number}` : null,
    }));

    // Settlement cycle = the LOAN_REPAID txn (principal repayment closes the loan)
    const settlementTxn = loanTxns.find(t => t.txn_type === 'LOAN_REPAID');
    const settlement_cycle_number = settlementTxn?.cycle_month_number ?? null;
    const settlement_cycle_label  = settlementTxn?.cycle_month_label  ?? null;

    return {
      ...r,
      disbursement_month_label: r.disbursement_month_label ?? null,
      cycle_label: `Cycle ${r.disbursement_month_number}`,
      outstanding_interest: r.status === 'Active'
        ? computeOutstandingInterest(cyclesElapsed, Number(r.principal), Number(r.monthly_interest_rate), Number(r.total_interest_paid))
        : 0,
      next_cycle_due_date:     computeNextDueDate(r.disbursed_at, r.status),
      repayment_history:       repaymentHistory,
      settlement_cycle_number,
      settlement_cycle_label,
    };
  });
}

/**
 * Returns one loan's detail with its outstanding interest and full transaction history; members may view only their own loans.
 *
 * @param userId - The requesting user, validated as an active member
 * @param group_id - Group the loan belongs to
 * @param loan_id - Loan to fetch
 * @returns A promise resolving to the loan detail including borrower, amounts, status, and transactions
 * @throws {AppError} 404 BASKET_NOT_FOUND / LOAN_NOT_FOUND if missing
 * @throws {AppError} 403 FORBIDDEN if a non-admin requests another member's loan
 */
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

/**
 * Records a repayment of principal and/or interest on an active loan (admin only), crediting the basket in a transaction and closing the loan when principal is fully repaid; idempotent when a key is supplied.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the loan belongs to
 * @param loan_id - Active loan being repaid
 * @param data - Repayment details
 * @param data.principal_repaid - Principal repaid in paise; if non-zero it must equal the full outstanding principal
 * @param data.interest_paid - Interest paid in paise; must not exceed cumulative outstanding interest
 * @param data.txn_date - Repayment date; also used to resolve the cycle when `cycle_id` is omitted (supports backdating)
 * @param data.cycle_id - Explicit cycle to tag the repayment to
 * @param data.notes - Optional note stored on the transactions
 * @param data.idempotency_key - Optional key; a repeated call returns the cached result
 * @returns A promise resolving to the updated interest totals, loan status, and resulting basket balance
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 400 INVALID_REQUEST if neither amount is positive
 * @throws {AppError} 404 LOAN_NOT_FOUND if the loan is missing
 * @throws {AppError} 409 LOAN_CLOSED, PRINCIPAL_EXCEEDS_OUTSTANDING, PARTIAL_PRINCIPAL_NOT_ALLOWED, or INTEREST_EXCEEDS_OUTSTANDING
 */
export async function repayLoan(
  userId:   string,
  group_id: string,
  loan_id:  string,
  data:     { principal_repaid?: number; interest_paid?: number; txn_date: string; cycle_id?: string; notes?: string; idempotency_key?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { principal_repaid = 0, interest_paid = 0, txn_date, cycle_id, notes, idempotency_key } = data;

  // Idempotency check: if key provided and previously succeeded, return cached result.
  if (idempotency_key) {
    const cached = await checkIdempotency(userId, idempotency_key, 'LOAN_REPAY');
    if (cached) return JSON.parse(cached);
  }

  if (principal_repaid <= 0 && interest_paid <= 0) {
    throw new AppError(400, 'INVALID_REQUEST', 'At least one of principal_repaid or interest_paid must be > 0.');
  }

  const [basketRows] = await db
    .select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  const [[loanRow], [cycleRow], [txnDateCycleRow]] = await Promise.all([
    db.select({ id: loans.id, status: loans.status, principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate, disbursement_month_number: loans.disbursement_month_number, total_interest_paid: loans.total_interest_paid, borrower_user_id: loans.borrower_user_id })
      .from(loans)
      .where(and(eq(loans.id, loan_id), eq(loans.basket_id, basketRows.id)))
      .limit(1),

    // Only the aggregated current_month is needed here. Selecting a plain column (id)
    // alongside min() with no GROUP BY is invalid SQL — and cycleRow.id is unused anyway
    // (effective_cycle_id falls back to txnDateCycleRow.id). See sibling queries above.
    db.select({ current_month: sql<number>`min(${monthly_cycles.month_number})` })
      .from(monthly_cycles)
      .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
      .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open'))),

    // Find the cycle whose month matches txn_date — used when no explicit cycle_id is passed.
    // This correctly handles backdated repayments (e.g. recording a Jan repayment in May).
    db.select({ id: monthly_cycles.id })
      .from(monthly_cycles)
      .where(and(
        eq(monthly_cycles.group_id, group_id),
        sql`${monthly_cycles.month_label} = TO_CHAR(${txn_date}::date, 'Mon YYYY')`,
      ))
      .limit(1),
  ]);

  if (!loanRow) throw new AppError(404, 'LOAN_NOT_FOUND', 'Loan not found.');
  if (loanRow.status !== 'Active') throw new AppError(409, 'LOAN_CLOSED', 'Cannot record repayment on a closed or written-off loan.');

  const effective_cycle_id   = cycle_id ?? txnDateCycleRow?.id ?? undefined;
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
      await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'LOAN_REPAID', amount: principal_repaid, direction: 'C', related_loan_id: loan_id, ...(effective_cycle_id ? { cycle_id: effective_cycle_id } : {}), notes: notes ?? null, created_by: userId });
    }
    if (interest_paid > 0) {
      await tx.insert(loan_transactions).values({ loan_id, txn_type: 'INTEREST_PAID', amount: interest_paid, txn_date, notes: notes ?? null, created_by: userId });
      await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'INTEREST_ACCRUED', amount: interest_paid, direction: 'C', related_loan_id: loan_id, ...(effective_cycle_id ? { cycle_id: effective_cycle_id } : {}), notes: notes ?? null, created_by: userId });
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

  const result = {
    loan_id,
    total_interest_paid:  newTotalInterestPaid,
    outstanding_interest: newOutstandingInterest,
    status:               loanFullyRepaid ? 'Repaid' : 'Active',
    basket_balance_after: newBalance,
  };

  if (idempotency_key) {
    await storeIdempotency(userId, idempotency_key, 'LOAN_REPAY', result);
  }

  return result;
}

/**
 * Repays all of a member's active loans in one transaction per the chosen mode (admin only); idempotent when a key is supplied.
 *
 * @param adminUserId - The requesting admin
 * @param group_id - Group the member's loans belong to
 * @param data - Bulk repayment parameters
 * @param data.member_user_id - Member whose active loans are repaid
 * @param data.mode - `'interest_only'`, `'principal_only'`, or `'full_settlement'` (principal plus any outstanding interest)
 * @param data.idempotency_key - Optional key; a repeated call returns the cached result
 * @returns A promise resolving to the count of loans fully repaid and the total amount applied
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 BASKET_NOT_FOUND if the group has no basket
 * @throws {AppError} 409 NO_ACTIVE_LOANS or NOTHING_TO_REPAY if there is nothing to apply
 */
export async function bulkRepayMember(
  adminUserId: string,
  group_id:    string,
  data: {
    member_user_id:  string;
    mode:            'interest_only' | 'principal_only' | 'full_settlement';
    idempotency_key?: string;
  },
) {
  const caller = await assertActiveMember(group_id, adminUserId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { member_user_id, mode, idempotency_key } = data;

  // Idempotency check: if key provided and previously succeeded, return cached result.
  if (idempotency_key) {
    const cached = await checkIdempotency(adminUserId, idempotency_key, 'BULK_REPAY');
    if (cached) return JSON.parse(cached);
  }

  const [basketRows] = await db
    .select({ id: baskets.id, current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);
  if (!basketRows) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  // Find the current open cycle (join with payments to find one with pending payments)
  const [currentCycleRow] = await db
    .select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number })
    .from(monthly_cycles)
    .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.status, 'Open')))
    .orderBy(monthly_cycles.month_number)
    .limit(1);

  const currentMonth   = currentCycleRow?.month_number ?? 0;
  const currentCycleId = currentCycleRow?.id ?? undefined;

  // Fetch all active loans for this member in the group
  const activeLoans = await db
    .select({
      id:                      loans.id,
      principal:               loans.principal,
      monthly_interest_rate:   loans.monthly_interest_rate,
      disbursement_month_number: loans.disbursement_month_number,
      total_interest_paid:     loans.total_interest_paid,
      borrower_user_id:        loans.borrower_user_id,
    })
    .from(loans)
    .where(and(eq(loans.basket_id, basketRows.id), eq(loans.borrower_user_id, member_user_id), eq(loans.status, 'Active')));

  if (activeLoans.length === 0) {
    throw new AppError(409, 'NO_ACTIVE_LOANS', 'This member has no active loans in this group.');
  }

  let loans_repaid = 0;
  let total_amount = 0;
  const now = new Date();
  const txn_date = now.toISOString().slice(0, 10);

  // Snapshot basket balance for mutation
  let currentBalance        = Number(basketRows.current_balance);
  let currentTotalCredited  = Number(basketRows.total_credited);
  let currentLentOut        = Number(basketRows.total_lent_out);
  let currentInterestEarned = Number(basketRows.total_interest_earned);

  await db.transaction(async (tx) => {
    for (const loan of activeLoans) {
      const cyclesElapsed = Math.max(0, currentMonth - loan.disbursement_month_number);
      const outstanding_interest = computeOutstandingInterest(
        cyclesElapsed, Number(loan.principal), Number(loan.monthly_interest_rate), Number(loan.total_interest_paid),
      );

      let principal_repaid = 0;
      let interest_paid    = 0;

      if (mode === 'interest_only') {
        if (outstanding_interest <= 0) continue;
        interest_paid = outstanding_interest;
      } else if (mode === 'principal_only') {
        principal_repaid = Number(loan.principal);
      } else {
        // full_settlement: always repay principal; interest only if > 0
        principal_repaid = Number(loan.principal);
        if (outstanding_interest > 0) interest_paid = outstanding_interest;
      }

      if (principal_repaid <= 0 && interest_paid <= 0) continue;

      const loanFullyRepaid = principal_repaid > 0;
      const repaymentTotal  = principal_repaid + interest_paid;

      if (principal_repaid > 0) {
        await tx.insert(loan_transactions).values({ loan_id: loan.id, txn_type: 'PRINCIPAL_REPAID', amount: principal_repaid, txn_date, created_by: adminUserId });
        await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'LOAN_REPAID', amount: principal_repaid, direction: 'C', related_loan_id: loan.id, ...(currentCycleId ? { cycle_id: currentCycleId } : {}), created_by: adminUserId });
      }
      if (interest_paid > 0) {
        await tx.insert(loan_transactions).values({ loan_id: loan.id, txn_type: 'INTEREST_PAID', amount: interest_paid, txn_date, created_by: adminUserId });
        await tx.insert(basket_transactions).values({ basket_id: basketRows.id, txn_type: 'INTEREST_ACCRUED', amount: interest_paid, direction: 'C', related_loan_id: loan.id, ...(currentCycleId ? { cycle_id: currentCycleId } : {}), created_by: adminUserId });
      }

      const newTotalInterestPaid = Number(loan.total_interest_paid) + interest_paid;
      await tx.update(loans).set({
        total_interest_paid: newTotalInterestPaid,
        updated_at: now,
        ...(loanFullyRepaid ? { status: 'Repaid', closed_at: now } : {}),
      }).where(eq(loans.id, loan.id));

      // Accumulate basket changes
      currentBalance        += repaymentTotal;
      currentTotalCredited  += repaymentTotal;
      currentLentOut        -= principal_repaid;
      currentInterestEarned += interest_paid;

      total_amount  += repaymentTotal;
      loans_repaid  += loanFullyRepaid ? 1 : 0;
    }

    // Write updated basket in one shot
    await tx.update(baskets).set({
      current_balance:       currentBalance,
      total_credited:        currentTotalCredited,
      total_lent_out:        currentLentOut,
      total_interest_earned: currentInterestEarned,
    }).where(eq(baskets.id, basketRows.id));
  });

  if (total_amount === 0) {
    throw new AppError(409, 'NOTHING_TO_REPAY', 'No repayable amounts found for the selected mode on this member\'s loans.');
  }

  await insertActivity({
    group_id,
    event_type: 'LOAN_REPAID',
    actor_id:   member_user_id,
    data:       { amount: total_amount, bulk: true },
  });

  const bulkResult = { loans_repaid, total_amount };

  if (idempotency_key) {
    await storeIdempotency(adminUserId, idempotency_key, 'BULK_REPAY', bulkResult);
  }

  return bulkResult;
}

/**
 * Hard-deletes an Active loan (admin only), removing its loan and basket transactions and reversing the disbursement's effect on the basket balance.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the loan belongs to
 * @param loan_id - Active loan to delete
 * @returns A promise resolving to `{ deleted: true, loan_id }`
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 BASKET_NOT_FOUND / LOAN_NOT_FOUND if missing
 * @throws {AppError} 409 LOAN_NOT_ACTIVE if the loan is not Active
 */
export async function deleteLoan(
  userId:   string,
  group_id: string,
  loan_id:  string,
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [basketRow] = await db
    .select({ id: baskets.id, current_balance: baskets.current_balance, total_lent_out: baskets.total_lent_out, total_debited: baskets.total_debited })
    .from(baskets).where(eq(baskets.group_id, group_id)).limit(1);

  if (!basketRow) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  const [loanRow] = await db
    .select({ id: loans.id, status: loans.status, principal: loans.principal, borrower_user_id: loans.borrower_user_id })
    .from(loans)
    .where(and(eq(loans.id, loan_id), eq(loans.basket_id, basketRow.id)))
    .limit(1);

  if (!loanRow) throw new AppError(404, 'LOAN_NOT_FOUND', 'Loan not found in this group.');
  if (loanRow.status !== 'Active') throw new AppError(409, 'LOAN_NOT_ACTIVE', 'Only Active loans can be deleted.');

  const principal = Number(loanRow.principal);

  await db.transaction(async (tx) => {
    // 1. Delete all loan_transactions for this loan
    await tx.delete(loan_transactions).where(eq(loan_transactions.loan_id, loan_id));

    // 2. Delete all basket_transactions referencing this loan
    await tx.delete(basket_transactions).where(eq(basket_transactions.related_loan_id, loan_id));

    // 3. Reverse basket balance: add back principal, subtract from total_lent_out and total_debited
    await tx.update(baskets).set({
      current_balance: Number(basketRow.current_balance) + principal,
      total_lent_out:  Number(basketRow.total_lent_out)  - principal,
      total_debited:   Number(basketRow.total_debited)   - principal,
    }).where(eq(baskets.id, basketRow.id));

    // 4. Delete the loan row
    await tx.delete(loans).where(eq(loans.id, loan_id));
  });

  return { deleted: true, loan_id };
}

/**
 * Updates an Active loan (admin only): write it off, correct its principal (adjusting basket lent-out by the delta), reschedule the close date, or edit notes.
 *
 * @param userId - The requesting admin
 * @param group_id - Group the loan belongs to
 * @param loan_id - Active loan to update
 * @param data - Fields to change (one of status/principal/date/notes per call)
 * @param data.status - Only `'WrittenOff'` is permitted from Active
 * @param data.principal - Corrected principal in paise; basket `total_lent_out` is adjusted by the delta
 * @param data.expected_close_date - New expected close date
 * @param data.notes - Updated note
 * @returns A promise resolving to the refreshed loan record
 * @throws {AppError} 403 FORBIDDEN if the caller is not an admin
 * @throws {AppError} 404 LOAN_NOT_FOUND if the loan is missing
 * @throws {AppError} 409 LOAN_CLOSED if not Active, or INVALID_TRANSITION for a disallowed status change
 */
export async function updateLoan(
  userId:   string,
  group_id: string,
  loan_id:  string,
  data:     { status?: string; principal?: number; expected_close_date?: string; notes?: string },
) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const { status: new_status, principal: new_principal, expected_close_date, notes } = data;

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
      await tx.update(loans).set({ status: 'WrittenOff', closed_at: now, updated_at: now, ...(notes !== undefined ? { notes } : {}) }).where(eq(loans.id, loan_id));
      await tx.update(baskets).set({ total_lent_out: Number(basketRows.total_lent_out) - Number(loanRow.principal) }).where(eq(baskets.id, basketRows.id));
    });
  } else if (new_principal !== undefined) {
    // Correct the principal: adjust basket.total_lent_out by the delta.
    const oldPrincipal = Number(loanRow.principal);
    const delta        = new_principal - oldPrincipal;
    await db.transaction(async (tx) => {
      await tx.update(loans).set({ principal: new_principal, updated_at: now, ...(notes !== undefined ? { notes } : {}) }).where(eq(loans.id, loan_id));
      await tx.update(baskets).set({ total_lent_out: Number(basketRows.total_lent_out) + delta }).where(eq(baskets.id, basketRows.id));
    });
  } else if (expected_close_date !== undefined) {
    await db.update(loans).set({ expected_close_date, updated_at: now, ...(notes !== undefined ? { notes } : {}) }).where(eq(loans.id, loan_id));
  } else if (notes !== undefined) {
    // notes-only update
    await db.update(loans).set({ notes, updated_at: now }).where(eq(loans.id, loan_id));
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
