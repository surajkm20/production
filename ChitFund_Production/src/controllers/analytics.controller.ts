// Handles HTTP layer for read-only analytics endpoints.
// All functions aggregate existing data — no writes happen here.
// Two access levels:
//   Admin  — full visibility (overview, all member balance sheets).
//   Member — restricted to their own balance sheet; read-only on ledger / trends.

import { Request, Response, NextFunction } from 'express';
import { eq, and, sum, count, sql } from 'drizzle-orm';
import { db } from '../config/db';
import {
  chit_groups, memberships, monthly_cycles, cycle_winners,
  payments, baskets, basket_transactions, loans, users,
} from '../db/schema';
import { AppError } from '../utils/AppError';
import { sendSuccess } from '../utils/response';
import { assertActiveMember } from '../services/memberships.service';

// ─── GET /groups/:group_id/analytics/overview ────────────────────────────────
// Admin-only dashboard metrics for the group. Six of the seven fields come from
// a single basket row; the two aggregate fields (total_collected and
// total_disbursed_to_winners) require JOIN queries against payments and
// monthly_cycles respectively. All five queries run in parallel.
//
// defaulters_this_month — count of Unpaid payment rows in the currently Open
//   cycle. Only one cycle should be Open at a time, so the filter on
//   monthly_cycles.status='Open' scopes this correctly without needing to know
//   the current cycle's ID in advance.
export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const userId   = req.user!.userId;

    await assertActiveMember(group_id, userId);

    const [basketRows, collectedRows, disbursedRows, loanCountRows, defaulterRows, adminCommRows, activeLoanRows, maxMonthRows] = await Promise.all([

      // Single row — basket holds the running aggregate totals.
      db.select({
        id:                    baskets.id,
        current_balance:       baskets.current_balance,
        total_lent_out:        baskets.total_lent_out,
        total_interest_earned: baskets.total_interest_earned,
      })
      .from(baskets)
      .where(eq(baskets.group_id, group_id))
      .limit(1),

      // total_collected — sum of every paid_amount that is Paid, joined to the
      // group via monthly_cycles so only this group's payments are included.
      db.select({ total: sum(payments.paid_amount) })
        .from(payments)
        .innerJoin(monthly_cycles, and(
          eq(monthly_cycles.id,       payments.cycle_id),
          eq(monthly_cycles.group_id, group_id),
        ))
        .where(eq(payments.status, 'Paid')),

      // total_disbursed_to_winners — sum of winner_takeaway across all cycle_winners rows for this group.
      db.select({ total: sum(cycle_winners.winner_takeaway) })
        .from(cycle_winners)
        .where(eq(cycle_winners.group_id, group_id)),

      // active_loans_count — loans are on the basket, not directly on the group.
      db.select({ active_loans: count(loans.id) })
        .from(loans)
        .innerJoin(baskets, eq(baskets.id, loans.basket_id))
        .where(and(
          eq(baskets.group_id, group_id),
          eq(loans.status,     'Active'),
        )),

      // defaulters_this_month — Unpaid payments in any currently Open cycle.
      // Since at most one cycle is Open at a time, this equals this month's defaulters.
      db.select({ defaulters: count(payments.id) })
        .from(payments)
        .innerJoin(monthly_cycles, and(
          eq(monthly_cycles.id,       payments.cycle_id),
          eq(monthly_cycles.group_id, group_id),
          eq(monthly_cycles.status,   'Open'),
        ))
        .where(eq(payments.status, 'Unpaid')),

      // total_admin_commission — sum of admin_commission from cycle_winners rows
      // that are not admin-withdrawal/skip (those have commission=0 already).
      db.select({ total: sum(cycle_winners.admin_commission) })
        .from(cycle_winners)
        .where(eq(cycle_winners.group_id, group_id)),

      // Active loan rows — needed to compute outstanding interest in app-code,
      // since interest is derived dynamically (not stored).
      db.select({
        principal:                 loans.principal,
        monthly_interest_rate:     loans.monthly_interest_rate,
        disbursement_month_number: loans.disbursement_month_number,
        total_interest_paid:       loans.total_interest_paid,
      })
      .from(loans)
      .innerJoin(baskets, eq(baskets.id, loans.basket_id))
      .where(and(
        eq(baskets.group_id, group_id),
        eq(loans.status,     'Active'),
      )),

      // Current cycle month — join to payments so future pre-created Open cycles
      // (which have no payments yet) don't inflate max(month_number).
      db.select({ max_month: sql<number>`max(${monthly_cycles.month_number})` })
        .from(monthly_cycles)
        .innerJoin(payments, eq(payments.cycle_id, monthly_cycles.id))
        .where(eq(monthly_cycles.group_id, group_id)),
    ]);

    const basket = basketRows[0];
    if (!basket) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found for this group.');

    const currentMonth = Number(maxMonthRows[0]?.max_month ?? 0);
    const { total_outstanding_interest, active_loans_principal } = activeLoanRows.reduce(
      (acc, r) => {
        const cyclesElapsed   = Math.max(0, currentMonth - r.disbursement_month_number + 1);
        const monthlyInterest = Math.round(Number(r.principal) * Number(r.monthly_interest_rate) / 100);
        const totalAccrued    = cyclesElapsed * monthlyInterest;
        return {
          active_loans_principal:    acc.active_loans_principal + Number(r.principal),
          total_outstanding_interest: acc.total_outstanding_interest + Math.max(0, totalAccrued - Number(r.total_interest_paid)),
        };
      },
      { active_loans_principal: 0, total_outstanding_interest: 0 },
    );

    sendSuccess(res, {
      total_collected:             Number(collectedRows[0].total    ?? 0),
      total_disbursed_to_winners:  Number(disbursedRows[0].total    ?? 0),
      current_basket_balance:      basket.current_balance,
      total_lent_out:              basket.total_lent_out,
      total_interest_earned:       basket.total_interest_earned,
      active_loans_count:          loanCountRows[0].active_loans,
      defaulters_this_month:       defaulterRows[0].defaulters,
      total_admin_commission:      Number(adminCommRows[0].total    ?? 0),
      total_outstanding_interest,
      active_loans_principal,
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /groups/:group_id/analytics/winners-ledger ──────────────────────────
// Accessible by any Active member. Returns one row per cycle that has a winner
// recorded (winner_user_id IS NOT NULL). Future/open cycles with no winner yet
// are excluded — the ledger only shows settled history.
// LEFT JOIN to users gives the winner's name without a separate query.
export async function winnersLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const userId   = req.user!.userId;

    await assertActiveMember(group_id, userId);

    // Each cycle may have multiple winners (X Chiti). Return one row per cycle_winner,
    // annotated with the cycle's month_number/label and is_skip_month flag.
    const rows = await db
      .select({
        month_number:     monthly_cycles.month_number,
        month_label:      monthly_cycles.month_label,
        is_skip_month:    monthly_cycles.is_skip_month,
        winner_number:    cycle_winners.winner_number,
        winner_name:      users.name,
        bid_amount:       cycle_winners.bid_amount,
        admin_commission: cycle_winners.admin_commission,
        basket_credit:    cycle_winners.basket_credit,
        winner_takeaway:  cycle_winners.winner_takeaway,
      })
      .from(cycle_winners)
      .innerJoin(monthly_cycles, eq(monthly_cycles.id, cycle_winners.cycle_id))
      .innerJoin(users, eq(users.id, cycle_winners.winner_user_id))
      .where(eq(cycle_winners.group_id, group_id))
      .orderBy(monthly_cycles.month_number, cycle_winners.winner_number);

    sendSuccess(res, rows.map(r => ({
      month_number:    r.month_number,
      month_label:     r.month_label,
      winner_number:   r.winner_number,
      winner_name:     r.winner_name,
      bid_amount:       r.is_skip_month ? null : r.bid_amount,
      admin_commission: r.is_skip_month ? null : r.admin_commission,
      basket_credit:    r.is_skip_month ? null : r.basket_credit,
      winner_takeaway:  r.winner_takeaway,
      is_skip_month:    r.is_skip_month,
    })));
  } catch (err) {
    next(err);
  }
}

// ─── GET /groups/:group_id/analytics/member-balance-sheet/:user_id ───────────
// Per-member financial position inside this group.
// Member can read their own sheet; Admin can read any member's.
//
// Fields:
//   total_contributed          — sum of all Paid payment amounts.
//   total_received_as_winner   — sum of winner_takeaway on cycles this user won.
//   active_loans_outstanding   — total outstanding_principal on Active loans.
//   projected_closure_split    — floor(share_count / total_shares × basket_balance).
//   net_position               — received + projected_split − contributed − loans.
//     Negative mid-cycle is normal: the member has paid in but not yet received.
export async function memberBalanceSheet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id as string;
    const target_user_id = req.params.user_id as string;
    const userId        = req.user!.userId;

    const caller = await assertActiveMember(group_id, userId);

    if (caller.role !== 'Admin' && userId !== target_user_id) {
      throw new AppError(403, 'FORBIDDEN', 'You can only view your own balance sheet.');
    }

    // Five parallel queries — all independent.
    const [memberRows, userRows, contributedRows, winnerRows, loanRows, basketRows, groupRows] =
      await Promise.all([

        // Membership: share_count, wins_count.
        db.select({ share_count: memberships.share_count, wins_count: memberships.wins_count })
          .from(memberships)
          .where(and(
            eq(memberships.group_id, group_id),
            eq(memberships.user_id,  target_user_id),
          ))
          .limit(1),

        // User's display name.
        db.select({ name: users.name })
          .from(users)
          .where(eq(users.id, target_user_id))
          .limit(1),

        // Total contributed — sum of paid_amount for Paid payments this user made in this group.
        db.select({ total: sum(payments.paid_amount) })
          .from(payments)
          .innerJoin(monthly_cycles, and(
            eq(monthly_cycles.id,       payments.cycle_id),
            eq(monthly_cycles.group_id, group_id),
          ))
          .where(and(
            eq(payments.member_user_id, target_user_id),
            eq(payments.status,         'Paid'),
          )),

        // Total received as winner — sum of winner_takeaway across all cycle_winners rows for this user.
        db.select({ total: sum(cycle_winners.winner_takeaway) })
          .from(cycle_winners)
          .where(and(
            eq(cycle_winners.group_id,      group_id),
            eq(cycle_winners.winner_user_id, target_user_id),
          )),

        // Active loans outstanding — principal not yet repaid.
        // Loans sit on the basket; join to reach the group.
        db.select({ outstanding: sum(loans.principal) })
          .from(loans)
          .innerJoin(baskets, eq(baskets.id, loans.basket_id))
          .where(and(
            eq(baskets.group_id,        group_id),
            eq(loans.borrower_user_id,  target_user_id),
            eq(loans.status,            'Active'),
          )),

        // Basket balance — needed for the projected closure split.
        db.select({ current_balance: baskets.current_balance })
          .from(baskets)
          .where(eq(baskets.group_id, group_id))
          .limit(1),

        // total_shares — denominator for the closure split fraction.
        db.select({ total_shares: chit_groups.total_shares })
          .from(chit_groups)
          .where(eq(chit_groups.id, group_id))
          .limit(1),
      ]);

    if (!memberRows[0]) {
      throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'No membership found for this user in the group.');
    }

    const share_count              = Number(memberRows[0].share_count);
    const wins_count               = Number(memberRows[0].wins_count);
    const total_shares             = Number(groupRows[0].total_shares);
    const current_balance          = Number(basketRows[0]?.current_balance ?? 0);
    const total_contributed        = Number(contributedRows[0].total        ?? 0);
    const total_received_as_winner = Number(winnerRows[0].total             ?? 0);
    const active_loans_outstanding = Number(loanRows[0].outstanding         ?? 0);
    const projected_closure_split  = Math.floor((share_count / total_shares) * current_balance);
    const net_position             = total_received_as_winner + projected_closure_split
                                   - total_contributed - active_loans_outstanding;

    sendSuccess(res, {
      user_id:                   target_user_id,
      name:                      userRows[0]?.name ?? null,
      share_count,
      wins_count,
      total_contributed,
      total_received_as_winner,
      active_loans_outstanding,
      projected_closure_split,
      net_position,
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /groups/:group_id/analytics/bid-trend ───────────────────────────────
// Accessible by any Active member. Returns one point per cycle ordered by
// month_number, useful for charting how bids trended over the group's life.
// Future cycles (no winner recorded) have bid_amount: null.
// Skip months are included in the series with bid_amount: null and
// is_skip_month: true so charts can render them as distinct markers.
export async function bidTrend(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const userId   = req.user!.userId;

    await assertActiveMember(group_id, userId);

    // For X Chiti cycles with multiple winners, sum their bid_amounts per cycle.
    const [cycleRows, winnerAggs] = await Promise.all([
      db.select({ month_number: monthly_cycles.month_number, is_skip_month: monthly_cycles.is_skip_month, id: monthly_cycles.id })
        .from(monthly_cycles)
        .where(eq(monthly_cycles.group_id, group_id))
        .orderBy(monthly_cycles.month_number),

      db.select({ cycle_id: cycle_winners.cycle_id, total_bid: sum(cycle_winners.bid_amount) })
        .from(cycle_winners)
        .where(eq(cycle_winners.group_id, group_id))
        .groupBy(cycle_winners.cycle_id),
    ]);

    const bidMap = new Map(winnerAggs.map(r => [r.cycle_id, Number(r.total_bid ?? 0)]));

    sendSuccess(res, cycleRows.map(r => ({
      month_number:  r.month_number,
      is_skip_month: r.is_skip_month,
      bid_amount: r.is_skip_month ? null : (bidMap.get(r.id) ?? null),
    })));
  } catch (err) {
    next(err);
  }
}

// ─── GET /groups/:group_id/analytics/basket-growth ───────────────────────────
// Accessible by any Active member. Shows the basket balance at the close of each
// completed cycle — the "growth curve" of the group's pot over time.
//
// Computed by replaying the basket_transactions ledger in chronological order and
// snapshotting the running balance at each cycle's closed_at timestamp.
// This approach is accurate even if basket adjustments or loans were recorded
// mid-cycle, since they appear as dated ledger entries.
//
// Only Closed cycles appear in the result — Open / future cycles have no
// closed_at so there is no meaningful snapshot to take.
export async function basketGrowth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const userId   = req.user!.userId;

    await assertActiveMember(group_id, userId);

    const [basketRows] = await db
      .select({ id: baskets.id })
      .from(baskets)
      .where(eq(baskets.group_id, group_id))
      .limit(1);

    if (!basketRows) throw new AppError(404, 'BASKET_NOT_FOUND', 'Basket not found.');

    // Fetch the two series in parallel — both are needed before we can merge them.
    const [txns, closedCycles] = await Promise.all([

      // All ledger entries for this basket, oldest first.
      // amount is always positive; direction tells us C (credit) or D (debit).
      db.select({
        amount:     basket_transactions.amount,
        direction:  basket_transactions.direction,
        created_at: basket_transactions.created_at,
      })
      .from(basket_transactions)
      .where(eq(basket_transactions.basket_id, basketRows.id))
      .orderBy(basket_transactions.created_at),

      // Closed cycles in month order — each is a snapshot point.
      db.select({
        month_number: monthly_cycles.month_number,
        closed_at:    monthly_cycles.closed_at,
      })
      .from(monthly_cycles)
      .where(and(
        eq(monthly_cycles.group_id, group_id),
        eq(monthly_cycles.status,   'Closed'),
      ))
      .orderBy(monthly_cycles.month_number),
    ]);

    // Two-pointer replay: advance through txns up to each cycle's close timestamp,
    // accumulating the running balance. O(T + C) where T = transactions, C = cycles.
    let runningBalance = 0;
    let txnIndex       = 0;

    const result = closedCycles
      .filter(c => c.closed_at !== null) // guard: closed cycles must have closed_at
      .map(cycle => {
        while (
          txnIndex < txns.length &&
          txns[txnIndex].created_at! <= cycle.closed_at!
        ) {
          const t = txns[txnIndex++];
          runningBalance += t.direction === 'C'
            ? Number(t.amount)
            : -Number(t.amount);
        }
        return { month_number: cycle.month_number, balance_at_close: runningBalance };
      });

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
