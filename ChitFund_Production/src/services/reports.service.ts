// Data-gathering service for all report endpoints.
// Returns structured JSON for each report type.
// To stream actual PDF/Excel files:
//   npm install pdfkit exceljs
//   npm install -D @types/pdfkit
// Then replace sendSuccess(res, data) in the controller with file streaming.

import { eq, and, desc, isNotNull, inArray } from 'drizzle-orm';
import { db } from '../config/db';
import {
  chit_groups, memberships, monthly_cycles, payments,
  baskets, basket_transactions, loans, loan_transactions, users,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { assertActiveMember } from './memberships.service';

// ─── getGroupLedger ──────────────────────────────────────────────────────────
// Full payment + basket ledger for admin. All cycles, all members, all payments.
export async function getGroupLedger(userId: string, group_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [groupRow] = await db
    .select({ id: chit_groups.id, name: chit_groups.name, pool_amount: chit_groups.pool_amount, monthly_contribution: chit_groups.monthly_contribution, total_shares: chit_groups.total_shares, start_month: chit_groups.start_month, status: chit_groups.status })
    .from(chit_groups).where(eq(chit_groups.id, group_id)).limit(1);

  if (!groupRow) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

  const [cycles, allPayments, basketRow] = await Promise.all([
    db.select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month, winner_name: users.name, bid_amount: monthly_cycles.bid_amount, winner_takeaway: monthly_cycles.winner_takeaway })
      .from(monthly_cycles)
      .leftJoin(users, eq(users.id, monthly_cycles.winner_user_id))
      .where(eq(monthly_cycles.group_id, group_id))
      .orderBy(monthly_cycles.month_number),

    db.select({ cycle_id: payments.cycle_id, member_name: users.name, share_count: memberships.share_count, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status, paid_at: payments.paid_at, notes: payments.notes })
      .from(payments)
      .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), eq(monthly_cycles.group_id, group_id)))
      .innerJoin(users, eq(users.id, payments.member_user_id))
      .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id))),

    db.select({ current_balance: baskets.current_balance, total_credited: baskets.total_credited, total_debited: baskets.total_debited, total_lent_out: baskets.total_lent_out, total_interest_earned: baskets.total_interest_earned })
      .from(baskets).where(eq(baskets.group_id, group_id)).limit(1),
  ]);

  const paymentsByCycle = new Map<string, typeof allPayments>();
  for (const p of allPayments) {
    const arr = paymentsByCycle.get(p.cycle_id) ?? [];
    arr.push(p);
    paymentsByCycle.set(p.cycle_id, arr);
  }

  return {
    group: groupRow,
    basket: basketRow[0] ?? null,
    cycles: cycles.map(c => ({
      ...c,
      payments: (paymentsByCycle.get(c.id) ?? []).map(p => ({ ...p, expected_amount: Number(p.expected_amount), paid_amount: Number(p.paid_amount), share_count: Number(p.share_count) })),
    })),
  };
}

// ─── getCycleSummary ─────────────────────────────────────────────────────────
export async function getCycleSummary(userId: string, group_id: string, cycle_id: string) {
  const caller = await assertActiveMember(group_id, userId);
  if (caller.role !== 'Admin') throw new AppError(403, 'FORBIDDEN', 'Admin only.');

  const [cycleRow] = await db
    .select({ id: monthly_cycles.id, month_number: monthly_cycles.month_number, month_label: monthly_cycles.month_label, due_date: monthly_cycles.due_date, status: monthly_cycles.status, is_skip_month: monthly_cycles.is_skip_month, bid_amount: monthly_cycles.bid_amount, winner_takeaway: monthly_cycles.winner_takeaway, winner_name: users.name })
    .from(monthly_cycles)
    .leftJoin(users, eq(users.id, monthly_cycles.winner_user_id))
    .where(and(eq(monthly_cycles.id, cycle_id), eq(monthly_cycles.group_id, group_id)))
    .limit(1);

  if (!cycleRow) throw new AppError(404, 'CYCLE_NOT_FOUND', 'Cycle not found.');

  const cyclePayments = await db
    .select({ member_name: users.name, share_count: memberships.share_count, expected_amount: payments.expected_amount, paid_amount: payments.paid_amount, status: payments.status, paid_at: payments.paid_at, notes: payments.notes })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.member_user_id))
    .innerJoin(memberships, and(eq(memberships.user_id, payments.member_user_id), eq(memberships.group_id, group_id)))
    .where(eq(payments.cycle_id, cycle_id));

  const total_expected  = cyclePayments.reduce((s, p) => s + Number(p.expected_amount), 0);
  const total_paid      = cyclePayments.reduce((s, p) => s + Number(p.paid_amount), 0);
  const paid_count      = cyclePayments.filter(p => p.status === 'Paid').length;
  const defaulter_count = cyclePayments.filter(p => p.status === 'Unpaid').length;

  return {
    cycle: cycleRow,
    payments: cyclePayments.map(p => ({ ...p, expected_amount: Number(p.expected_amount), paid_amount: Number(p.paid_amount), share_count: Number(p.share_count) })),
    summary: { total_expected, total_paid, paid_count, defaulter_count },
  };
}

// ─── getMemberHistory ────────────────────────────────────────────────────────
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

// ─── getClosureReport ────────────────────────────────────────────────────────
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

// ─── getLoanRegister ─────────────────────────────────────────────────────────
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
