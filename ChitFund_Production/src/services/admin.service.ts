/**
 * @fileoverview Platform-wide aggregation queries backing the SuperAdmin Money tab.
 * All functions are read-only and query across every group on the platform.
 * Designed for infrequent use (one page-load per admin session); revisit if
 * aggregation time exceeds 30 s (API spec § 12 COMPUTATION_TIMEOUT threshold).
 * @module services/admin
 * @author Suraj KM
 */

import { sql, eq, and, gte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../config/db';
import {
  chit_groups, memberships, baskets, basket_transactions,
  loans, payments, monthly_cycles, cycle_winners, users,
} from '../db/schema';
import { AppError } from '../utils/AppError';

const VALID_RANGES = new Set(['24h', '7d', '30d', '90d', 'all']);

function getRangeStart(range: string): Date | null {
  const ms: Record<string, number> = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6, '90d': 7776e6 };
  const offset = ms[range];
  return offset ? new Date(Date.now() - offset) : null;
}

function getGranularity(range: string): string {
  if (range === '24h') return 'hour';
  if (range === '90d') return 'week';
  if (range === 'all') return 'month';
  return 'day'; // 7d, 30d
}

/**
 * Aggregates platform-wide Money tab metrics: lifetime/range GMV, pool sizes,
 * loan portfolio, and time-series data for chart rendering on the Admin Console.
 *
 * @param range - Time window; one of `24h | 7d | 30d | 90d | all` (default `30d`)
 * @returns Aggregated money metrics matching the § 12 Money tab response shape
 * @throws {AppError} 400 INVALID_RANGE if range is not in the allowed set
 */
export async function getMoneyAnalytics(range: string) {
  if (!VALID_RANGES.has(range)) {
    throw new AppError(400, 'INVALID_RANGE', `range must be one of: ${[...VALID_RANGES].join(', ')}`);
  }

  const rangeStart = getRangeStart(range);
  const gran       = getGranularity(range);

  // Pre-aggregate all-time GMV per group so the top-groups JOIN is 1:1, not a cross-product.
  // .as() on raw sql fields is required by Drizzle to reference them in the outer query.
  const gmvAgg = db
    .select({
      group_id: monthly_cycles.group_id,
      total:    sql<number>`COALESCE(SUM(${payments.paid_amount}), 0)`.as('total'),
    })
    .from(monthly_cycles)
    .leftJoin(payments, and(
      eq(payments.cycle_id, monthly_cycles.id),
      eq(payments.status, 'Paid'),
    ))
    .groupBy(monthly_cycles.group_id)
    .as('gmv_agg');

  // Pre-aggregate active-member count per group for the same reason.
  const memberAgg = db
    .select({
      group_id: memberships.group_id,
      cnt:      sql<number>`COUNT(*)`.as('cnt'),
    })
    .from(memberships)
    .where(eq(memberships.status, 'Active'))
    .groupBy(memberships.group_id)
    .as('member_agg');

  // Second alias for memberships — used to isolate the group-admin join.
  const adminM = alias(memberships, 'admin_m');

  // Optional range conditions (undefined when range = 'all', which omits the WHERE clause).
  const paidCond   = rangeStart ? and(eq(payments.status, 'Paid'), gte(payments.paid_at!,              rangeStart)) : eq(payments.status, 'Paid');
  const winnerCond = rangeStart ? gte(cycle_winners.created_at,    rangeStart) : undefined;
  const btxnCond   = rangeStart ? gte(basket_transactions.created_at, rangeStart) : undefined;

  const [
    gmvLifetimeRows,
    gmvInRangeRows,
    avgPoolRows,
    basketValueRows,
    loanRows,
    gmvPaymentsSeries,
    gmvWinnerSeries,
    gmvLoanDisbSeries,
    poolDistRows,
    topGroupsRows,
    basketDeltaRows,
  ] = await Promise.all([

    // 1. All-time GMV (Paid payment amounts across all groups)
    db.select({ total: sql<number>`COALESCE(SUM(${payments.paid_amount}), 0)` })
      .from(payments)
      .where(eq(payments.status, 'Paid')),

    // 2. Range-scoped GMV
    db.select({ total: sql<number>`COALESCE(SUM(${payments.paid_amount}), 0)` })
      .from(payments)
      .where(paidCond),

    // 3. Average pool_amount across all groups (rounded to nearest paise)
    db.select({ avg: sql<number>`COALESCE(ROUND(AVG(${chit_groups.pool_amount})), 0)` })
      .from(chit_groups),

    // 4. Current sum of all basket balances (the platform's living kitty value)
    db.select({ total: sql<number>`COALESCE(SUM(${baskets.current_balance}), 0)` })
      .from(baskets),

    // 5. Loan portfolio counts/totals by status
    db.select({
      status:              loans.status,
      loan_count:          sql<number>`COUNT(*)`,
      total_principal:     sql<number>`COALESCE(SUM(${loans.principal}), 0)`,
      avg_interest_rate:   sql<number>`COALESCE(AVG(${loans.monthly_interest_rate}), 0)`,
      total_interest_paid: sql<number>`COALESCE(SUM(${loans.total_interest_paid}), 0)`,
    })
    .from(loans)
    .groupBy(loans.status),

    // 6. GMV time-series — member payment amounts (range-filtered)
    //    GROUP/ORDER BY 1 avoids Drizzle rendering `gran` as two different bind params ($1 vs $3)
    //    that PostgreSQL can't recognise as the same expression at parse time.
    db.select({
      date:         sql<string>`DATE_TRUNC(${gran}, ${payments.paid_at})`,
      payments_gmv: sql<number>`COALESCE(SUM(${payments.paid_amount}), 0)`,
    })
    .from(payments)
    .where(paidCond)
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 7. GMV time-series — winner takeaways (range-filtered)
    db.select({
      date:             sql<string>`DATE_TRUNC(${gran}, ${cycle_winners.created_at})`,
      winner_takeaways: sql<number>`COALESCE(SUM(${cycle_winners.winner_takeaway}), 0)`,
    })
    .from(cycle_winners)
    .where(winnerCond)
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 8. GMV time-series — loan disbursements from basket (range-filtered)
    db.select({
      date:               sql<string>`DATE_TRUNC(${gran}, ${basket_transactions.created_at})`,
      loan_disbursements: sql<number>`COALESCE(SUM(${basket_transactions.amount}), 0)`,
    })
    .from(basket_transactions)
    .where(and(eq(basket_transactions.txn_type, 'LOAN_DISBURSED'), btxnCond))
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 9. Pool size distribution by rupee band (pool_amount is paise; ₹1L = 10 000 000 p)
    //    GROUP BY 1 avoids the same CASE-expression parameterization mismatch.
    db.select({
      bucket_label: sql<string>`CASE
        WHEN ${chit_groups.pool_amount} < 10000000  THEN '<1L'
        WHEN ${chit_groups.pool_amount} < 50000000  THEN '1L-5L'
        WHEN ${chit_groups.pool_amount} < 100000000 THEN '5L-10L'
        ELSE '>10L'
      END`,
      group_count: sql<number>`COUNT(*)`,
    })
    .from(chit_groups)
    .groupBy(sql`1`)
    .orderBy(sql`MIN(${chit_groups.pool_amount})`),

    // 10. Top 10 groups by all-time GMV (pre-aggregated subqueries avoid cross-product)
    db.select({
      group_id:     chit_groups.id,
      name:         chit_groups.name,
      admin_name:   users.name,
      member_count: sql<number>`COALESCE(${memberAgg.cnt}, 0)`,
      gmv:          sql<number>`COALESCE(${gmvAgg.total}, 0)`,
      status:       chit_groups.status,
    })
    .from(chit_groups)
    .innerJoin(adminM, and(
      eq(adminM.group_id, chit_groups.id),
      eq(adminM.role, 'Admin'),
      eq(adminM.status, 'Active'),
    ))
    .innerJoin(users, eq(users.id, adminM.user_id))
    .leftJoin(gmvAgg, eq(gmvAgg.group_id, chit_groups.id))
    .leftJoin(memberAgg, eq(memberAgg.group_id, chit_groups.id))
    .orderBy(sql`COALESCE(${gmvAgg.total}, 0) DESC`)
    .limit(10),

    // 11. Basket balance delta series for the range (direction-signed sums per bucket)
    //     total_balance in the response is the cumulative change within the range, starting
    //     from 0 at range_start (not the absolute platform balance — use cumulative_basket_value for that).
    db.select({
      date:  sql<string>`DATE_TRUNC(${gran}, ${basket_transactions.created_at})`,
      delta: sql<number>`SUM(CASE WHEN ${basket_transactions.direction} = 'C'
                              THEN ${basket_transactions.amount}
                              ELSE -${basket_transactions.amount} END)`,
    })
    .from(basket_transactions)
    .where(btxnCond)
    .groupBy(sql`1`)
    .orderBy(sql`1`),
  ]);

  // ── Scalar metrics ─────────────────────────────────────────────────────────
  const gmv_lifetime            = Number(gmvLifetimeRows[0]?.total ?? 0);
  const gmv_in_range            = Number(gmvInRangeRows[0]?.total  ?? 0);
  const avg_pool_size           = Number(avgPoolRows[0]?.avg        ?? 0);
  const cumulative_basket_value = Number(basketValueRows[0]?.total  ?? 0);

  // ── Loan portfolio ─────────────────────────────────────────────────────────
  const activeRow     = loanRows.find(r => r.status === 'Active');
  const repaidRow     = loanRows.find(r => r.status === 'Repaid');
  const writtenOffRow = loanRows.find(r => r.status === 'WrittenOff');

  const total_loans       = loanRows.reduce((s, r) => s + Number(r.loan_count), 0);
  const written_off_count = Number(writtenOffRow?.loan_count ?? 0);
  const repaid_count      = Number(repaidRow?.loan_count     ?? 0);
  const closed_total      = repaid_count + written_off_count;

  const default_rate_pct = total_loans > 0
    ? Number(((written_off_count / total_loans) * 100).toFixed(1))
    : 0;

  const loan_portfolio = {
    active: {
      count:             Number(activeRow?.loan_count          ?? 0),
      total_principal:   Number(activeRow?.total_principal     ?? 0),
      avg_interest_rate: Number(Number(activeRow?.avg_interest_rate ?? 0).toFixed(1)),
      accrued_interest:  Number(activeRow?.total_interest_paid ?? 0),
    },
    closed: {
      repaid_count,
      written_off_count,
      default_rate_pct: closed_total > 0
        ? Number(((written_off_count / closed_total) * 100).toFixed(1))
        : 0,
    },
  };

  // ── GMV series (merge three sources by bucket date) ─────────────────────────
  const paymentsMap = new Map(gmvPaymentsSeries.map(r  => [String(r.date), Number(r.payments_gmv)]));
  const winnersMap  = new Map(gmvWinnerSeries.map(r    => [String(r.date), Number(r.winner_takeaways)]));
  const disbMap     = new Map(gmvLoanDisbSeries.map(r  => [String(r.date), Number(r.loan_disbursements)]));
  const allDates    = [...new Set([...paymentsMap.keys(), ...winnersMap.keys(), ...disbMap.keys()])].sort();

  const gmv_series = allDates.map(date => {
    const p = paymentsMap.get(date) ?? 0;
    const w = winnersMap.get(date)  ?? 0;
    const l = disbMap.get(date)     ?? 0;
    return { date, total: p + w + l, payments: p, winner_takeaways: w, loan_disbursements: l };
  });

  // ── Pool size distribution ─────────────────────────────────────────────────
  const pool_size_distribution = poolDistRows.map(r => ({
    bucket_label: r.bucket_label,
    count:        Number(r.group_count),
  }));

  // ── Top groups by GMV ─────────────────────────────────────────────────────
  const top_groups_by_gmv = topGroupsRows.map(r => ({
    group_id:     r.group_id,
    name:         r.name,
    admin_name:   r.admin_name,
    member_count: Number(r.member_count),
    gmv:          Number(r.gmv),
    status:       r.status,
  }));

  // ── Basket aggregate series (cumulative running sum within the range) ──────
  let running = 0;
  const basket_aggregate_series = basketDeltaRows.map(r => {
    running += Number(r.delta);
    return { date: String(r.date), total_balance: running };
  });

  return {
    gmv_lifetime,
    gmv_in_range,
    avg_pool_size,
    cumulative_basket_value,
    default_rate_pct,
    gmv_series,
    pool_size_distribution,
    top_groups_by_gmv,
    loan_portfolio,
    basket_aggregate_series,
  };
}
