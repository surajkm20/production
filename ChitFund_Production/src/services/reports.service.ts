/**
 * @fileoverview Report data-gathering service for the ChitFund API. Each function
 * assembles the fully-structured JSON for one report type — group ledger, cycle
 * summary, member history, closure split, and loan register — running the
 * necessary joins/aggregations and normalising BIGINT paise columns to numbers.
 * It exists to keep all reporting queries in one place and decoupled from output
 * format: controllers currently return this JSON directly, and PDF/Excel
 * streaming can be layered on later without touching these queries.
 * @module services/reports
 * @author Suraj KM
 */

import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../config/db';
import {
  chit_groups, memberships, monthly_cycles, cycle_winners, payments,
  baskets, loans, loan_transactions, users,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { assertActiveMember } from './memberships.service';

/**
 * Builds the full admin ledger for a group: every cycle with its winners and per-member payments, plus basket totals.
 *
 * @param userId - The requesting user, who must be the group admin
 * @param group_id - Group to build the ledger for
 * @returns A promise resolving to the group, basket totals, and an array of cycles each containing their winners and payments
 * @throws {AppError} 403 NOT_A_MEMBER / FORBIDDEN if the caller is not an active admin
 * @throws {AppError} 404 GROUP_NOT_FOUND if the group does not exist
 */
export async function getGroupLedger(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [groupRow] = await db
    .select({ id: chit_groups.id, name: chit_groups.name, pool_amount: chit_groups.pool_amount, monthly_contribution: chit_groups.monthly_contribution, total_shares: chit_groups.total_shares, start_month: chit_groups.start_month, status: chit_groups.status })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);

  if (!groupRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

  const [cycles, allPayments, basketRow, allWinners] = await Promise.all([
    db.select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(eq(monthly_cycles.group_id, group_id))
      .orderBy(monthly_cycles.month_number),

    db.select({ cycle_id: payments.cycle_id, member_name: users.name, share_count: memberships.share_count, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status, paid_at: payments.paid_at, notes: payments.notes })
      .from(payments)
      .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), eq(monthly_cycles.group_id, group_id)))
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id))),

    db.select({ current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ cycle_id: cycle_winners.cycle_id, winner_number: cycle_winners.winner_number, winner_name: users.name, bid_amount: cycle_winners.bid_amount, winner_takeaway: cycle_winners.winner_takeaway })
      .from(cycle_winners)
      .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
      .where(eq(cycle_winners.group_id, group_id))
      .orderBy(cycle_winners.winner_number),
  ]);

  const paymentsByCycle = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const arr = paymentsByCycle.get(p.cycle_id) ?? [];
    arr.push(p);
    paymentsByCycle.set(p.cycle_id, arr);
  }

  const winnersByCycle = new Map<string, typeof allWinners>();
  for (const w of allWinners) {
    const arr = winnersByCycle.get(w.cycle_id) ?? [];
    arr.push(w);
    winnersByCycle.set(w.cycle_id, arr);
  }

  return {
    group: groupRow,
    basket: basketRow[0] ?? null,
    cycles: cycles.map(c => ({
      ...c,
      winners: (winnersByCycle.get(c.id) ?? []).map(w => ({ ...w, bid_amount: Number(w.bid_amount), winner_takeaway: Number(w.winner_takeaway) })),
      payments: (paymentsByCycle.get(c.id) ?? []).map(p => ({ ...p, expected_amount: Number(p.expected_amount), paid_amount: Number(p.paid_amount), share_count: Number(p.share_count) })),
    })),
  };
}

/**
 * Builds a single cycle's summary: its winners, per-member payments, and aggregate paid/expected/defaulter totals.
 *
 * @param userId - The requesting user, who must be the group admin
 * @param group_id - Group the cycle belongs to
 * @param cycle_id - Cycle to summarise
 * @returns A promise resolving to the cycle (with winners), its payments, and a computed summary block
 * @throws {AppError} 403 NOT_A_MEMBER / FORBIDDEN if the caller is not an active admin
 * @throws {AppError} 404 CYCLE_NOT_FOUND if the cycle does not exist in this group
 */
export async function getCycleSummary(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [[cycleRow], cyclePayments, cycleWinnerRows] = await Promise.all([
    db.select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month })
      .from(monthly_cycles)
      .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
      .limit(1),

    db.select({ member_name: users.name, share_count: memberships.share_count, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status, paid_at: payments.paid_at, notes: payments.notes })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
      .where(eq(payments.cycle_id, cycle_id)),

    db.select({ winner_number: cycle_winners.winner_number, winner_name: users.name, bid_amount: cycle_winners.bid_amount, winner_takeaway: cycle_winners.winner_takeaway, is_admin_withdrawal: cycle_winners.is_admin_withdrawal })
      .from(cycle_winners)
      .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
      .where(eq(cycle_winners.cycle_id, cycle_id))
      .orderBy(cycle_winners.winner_number),
  ]);

  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found.');

  const total_expected  = cyclePayments.reduce((s, p) => s + Number(p.expected_amount), 0);
  const total_paid      = cyclePayments.reduce((s, p) => s + Number(p.paid_amount), 0);
  const paid_count      = cyclePayments.filter(p => p.status === 'Paid').length;
  const defaulter_count = cyclePayments.filter(p => p.status === 'Unpaid').length;

  return {
    cycle: { ...cycleRow, winners: cycleWinnerRows.map(w => ({ ...w, bid_amount: Number(w.bid_amount), winner_takeaway: Number(w.winner_takeaway) })) },
    payments: cyclePayments.map(p => ({ ...p, expected_amount: Number(p.expected_amount), paid_amount: Number(p.paid_amount), share_count: Number(p.share_count) })),
    summary: { total_expected, total_paid, paid_count, defaulter_count },
  };
}

/**
 * Builds a member's payment history across all cycles in a group; members may view their own, admins may view anyone's.
 *
 * @param userId - The requesting user
 * @param group_id - Group whose cycles to report on
 * @param target_user_id - The member whose history is requested
 * @returns A promise resolving to the member name, group name, and per-cycle payment rows
 * @throws {AppError} 403 NOT_A_MEMBER / FORBIDDEN if a non-admin requests another member's history
 * @throws {AppError} 404 NOT_FOUND if the target user does not exist
 */
export async function getMemberHistory(userId: string, group_id: string, target_user_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin' && userId !== target_user_id) throw new AppError(403, 'FORBIDDEN', 'You can only access your own history.');

  const [userRow] = await db.select({ name: users.name }).from(users).where(eq(users.id, target_user_id)).limit(1);
  if (!userRow) throw new AppError(404, 'NOT_FOUND', 'User not found.');

  const [groupRow] = await db.select({ name: chit_groups.name }).from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);

  const rows = await db
    .select({ cycle_month_label: monthly_cycles.month_label, month_number: monthly_cycles.month_number, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status, paid_at: payments.paid_at, is_skip_month: monthly_cycles.is_skip_month })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), eq(monthly_cycles.group_id, group_id)))
    .where(eq(payments.member_user_id, target_user_id))
    .orderBy(monthly_cycles.month_number);

  return {
    member_name: userRow.name,
    group_name:  groupRow?.name ?? '',
    payments:    rows.map(r => ({ ...r, expected_amount: Number(r.expected_amount), paid_amount: Number(r.paid_amount) })),
  };
}

/**
 * Builds the closure report for a closed group: the final basket balance split across members by share count.
 *
 * @param userId - The requesting user, who must be the group admin
 * @param group_id - Group to report on; must already be closed
 * @returns A promise resolving to the basket totals, the per-member closure split, the total distributed, and loan summaries
 * @throws {AppError} 403 NOT_A_MEMBER / FORBIDDEN if the caller is not an active admin
 * @throws {AppError} 404 GROUP_NOT_FOUND if the group does not exist
 * @throws {AppError} 409 REPORT_NOT_AVAILABLE if the group has not been closed yet
 */
export async function getClosureReport(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [groupRow] = await db
    .select({ name: chit_groups.name, status: chit_groups.status, total_shares: chit_groups.total_shares })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);

  if (!groupRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  if (groupRow.status !== 'Closed') throw new AppError(409, 'REPORT_NOT_AVAILABLE', 'Closure report is only available after the group has been closed.');

  const [basketRow, allMembers, allLoans] = await Promise.all([
    db.select({ current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),

    db.select({ user_id: memberships.user_id, name: users.name, share_count: memberships.share_count, wins_count: memberships.wins_count, status: memberships.status })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(eq(memberships.group_id, group_id)),

    db.select({ id: loans.id, borrower_name: users.name, principal: loans.principal, total_interest_paid: loans.total_interest_paid, status: loans.status })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .innerJoin(users, eq(users.id, loans.borrower_user_id))
      .where(eq(baskets.group_id, group_id)),
  ]);

  const balance     = Number(basketRow[0]?.current_balance ?? 0);
  const totalShares = Number(groupRow.total_shares);

  const closure_split = allMembers.map(m => ({
    user_id:      m.user_id,
    name:         m.name,
    share_count:  Number(m.share_count),
    wins_count:   Number(m.wins_count),
    status:       m.status,
    split_amount: Math.floor((Number(m.share_count) / totalShares) * balance),
  }));

  return {
    group_name:  groupRow.name,
    basket:      basketRow[0] ?? null,
    closure_split,
    total_distributed: closure_split.reduce((s, m) => s + m.split_amount, 0),
    loans: allLoans.map(l => ({ ...l, principal: Number(l.principal), total_interest_paid: Number(l.total_interest_paid) })),
  };
}

/**
 * Builds the loan register for a group: every loan (newest first) with its full transaction history attached.
 *
 * @param userId - The requesting user, who must be the group admin
 * @param group_id - Group whose basket loans to list
 * @returns A promise resolving to all loans, each with normalised amounts and its transactions array
 * @throws {AppError} 403 NOT_A_MEMBER / FORBIDDEN if the caller is not an active admin
 * @throws {AppError} 404 BASKET_NOT_FOUND if the group has no basket
 */
export async function getLoanRegister(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [basketRow] = await db.select({ id: baskets.id }).from(baskets).where(eq(baskets.group_id, group_id)).limit(1);
  if (!basketRow) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

  const allLoans = await db
    .select({ id: loans.id, borrower_name: users.name, principal: loans.principal, monthly_interest_rate: loans.monthly_interest_rate, total_interest_paid: loans.total_interest_paid, disbursed_at: loans.disbursed_at, expected_close_date: loans.expected_close_date, closed_at: loans.closed_at, status: loans.status, notes: loans.notes })
    .from(loans)
    .innerJoin(users, eq(users.id, loans.borrower_user_id))
    .where(eq(loans.basket_id, basketRow.id))
    .orderBy(desc(loans.disbursed_at));

  const loanIds = allLoans.map(l => l.id);
  const allTxns = loanIds.length > 0
    ? await db.select({ loan_id: loan_transactions.loan_id, txn_type: loan_transactions.txn_type, amount: loan_transactions.amount, txn_date: loan_transactions.txn_date, notes: loan_transactions.notes })
        .from(loan_transactions)
        .where(inArray(loan_transactions.loan_id, loanIds))
        .orderBy(desc(loan_transactions.created_at))
    : [];

  // Group transactions by loan_id
  const txnsByLoan = new Map<string, typeof allTxns>();
  for (const t of allTxns) {
    const arr = txnsByLoan.get(t.loan_id) ?? [];
    arr.push(t);
    txnsByLoan.set(t.loan_id, arr);
  }

  return {
    loans: allLoans.map(l => ({
      ...l,
      principal: Number(l.principal),
      total_interest_paid: Number(l.total_interest_paid),
      transactions: txnsByLoan.get(l.id) ?? [],
    })),
  };
}
