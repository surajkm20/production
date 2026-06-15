/**
 * @fileoverview Platform-wide aggregation queries backing the SuperAdmin Money tab.
 * All functions are read-only and query across every group on the platform.
 * Designed for infrequent use (one page-load per admin session); revisit if
 * aggregation time exceeds 30 s (API spec § 12 COMPUTATION_TIMEOUT threshold).
 * @module services/admin
 * @author Suraj KM
 */

import { sql, eq, and, gte, isNull, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../config/db';
import {
  chit_groups, memberships, baskets, basket_transactions,
  loans, payments, monthly_cycles, cycle_winners, users, refresh_tokens,
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

/**
 * Aggregates platform-wide Growth tab metrics: user signups, MAU/WAU/DAU,
 * group lifecycle, and time-series charts for the Admin Console Growth tab.
 *
 * MAU/WAU/DAU are always computed from NOW (fixed windows), not from the
 * selected range — per wireframe §12 Tab 1.
 *
 * @param range - Time window; one of `24h | 7d | 30d | 90d | all` (default `30d`)
 * @throws {AppError} 400 INVALID_RANGE if range is not in the allowed set
 */
export async function getGrowthAnalytics(range: string) {
  if (!VALID_RANGES.has(range)) {
    throw new AppError(400, 'INVALID_RANGE', `range must be one of: ${[...VALID_RANGES].join(', ')}`);
  }

  const rangeStart = getRangeStart(range);
  const gran       = getGranularity(range);
  const now        = new Date();

  // MAU/WAU/DAU fixed windows — independent of the selected range.
  const mauStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const wauStart = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
  const dauStart = new Date(now.getTime() -       24 * 60 * 60 * 1000);

  // For range='all', use epoch so WHERE clauses still work without special-casing.
  const since = rangeStart ?? new Date(0);

  // Active token condition shared by MAU/WAU/DAU — not revoked, last_used_at present.
  const activeToken = and(isNotNull(refresh_tokens.last_used_at), isNull(refresh_tokens.revoked_at));

  const [
    totalUserRows,
    newSignupRows,
    mauRows,
    wauRows,
    dauRows,
    totalGroupRows,
    newGroupRows,
    closedGroupRows,
    groupStatusRows,
    signupSeriesRows,
    groupCreatedSeriesRows,
    groupClosedSeriesRows,
  ] = await Promise.all([

    // 1. Total platform users
    db.select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(isNull(users.deleted_at)),

    // 2. New signups within the selected range
    db.select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(and(isNull(users.deleted_at), gte(users.created_at, since))),

    // 3. MAU — distinct users whose refresh token was used in the last 30 days
    db.select({ count: sql<number>`COUNT(DISTINCT ${refresh_tokens.user_id})` })
      .from(refresh_tokens)
      .where(and(activeToken, gte(refresh_tokens.last_used_at!, mauStart))),

    // 4. WAU — same, last 7 days
    db.select({ count: sql<number>`COUNT(DISTINCT ${refresh_tokens.user_id})` })
      .from(refresh_tokens)
      .where(and(activeToken, gte(refresh_tokens.last_used_at!, wauStart))),

    // 5. DAU — same, last 24 hours
    db.select({ count: sql<number>`COUNT(DISTINCT ${refresh_tokens.user_id})` })
      .from(refresh_tokens)
      .where(and(activeToken, gte(refresh_tokens.last_used_at!, dauStart))),

    // 6. Total groups (all time)
    db.select({ count: sql<number>`COUNT(*)` })
      .from(chit_groups),

    // 7. Groups created within the selected range
    db.select({ count: sql<number>`COUNT(*)` })
      .from(chit_groups)
      .where(gte(chit_groups.created_at, since)),

    // 8. Groups closed within the selected range
    db.select({ count: sql<number>`COUNT(*)` })
      .from(chit_groups)
      .where(and(
        eq(chit_groups.status, 'Closed'),
        isNotNull(chit_groups.closed_at),
        gte(chit_groups.closed_at!, since),
      )),

    // 9. Group status breakdown: active (started) / closed / pending (future start_month)
    db.select({
      label: sql<string>`CASE
        WHEN ${chit_groups.status} = 'Closed' THEN 'closed'
        WHEN ${chit_groups.start_month} > CURRENT_DATE THEN 'pending'
        ELSE 'active'
      END`,
      count: sql<number>`COUNT(*)`,
    })
    .from(chit_groups)
    .groupBy(sql`1`),

    // 10. Signup velocity series — new users per date bucket
    db.select({
      date:  sql<string>`DATE_TRUNC(${gran}, ${users.created_at})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(users)
    .where(and(isNull(users.deleted_at), gte(users.created_at, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 11. Groups created series
    db.select({
      date:    sql<string>`DATE_TRUNC(${gran}, ${chit_groups.created_at})`,
      created: sql<number>`COUNT(*)`,
    })
    .from(chit_groups)
    .where(gte(chit_groups.created_at, since))
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 12. Groups closed series
    db.select({
      date:   sql<string>`DATE_TRUNC(${gran}, ${chit_groups.closed_at!})`,
      closed: sql<number>`COUNT(*)`,
    })
    .from(chit_groups)
    .where(and(
      eq(chit_groups.status, 'Closed'),
      isNotNull(chit_groups.closed_at),
      gte(chit_groups.closed_at!, since),
    ))
    .groupBy(sql`1`)
    .orderBy(sql`1`),
  ]);

  // ── Scalars ────────────────────────────────────────────────────────────────
  const total_users          = Number(totalUserRows[0]?.count ?? 0);
  const new_signups_in_range = Number(newSignupRows[0]?.count  ?? 0);
  const pre_range_users      = total_users - new_signups_in_range;
  const delta_pct            = pre_range_users > 0
    ? Number(((new_signups_in_range / pre_range_users) * 100).toFixed(1))
    : (new_signups_in_range > 0 ? 100 : 0);

  const mau            = Number(mauRows[0]?.count ?? 0);
  const wau            = Number(wauRows[0]?.count ?? 0);
  const dau            = Number(dauRows[0]?.count ?? 0);
  const stickiness_pct = mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0;

  const total_groups          = Number(totalGroupRows[0]?.count  ?? 0);
  const new_groups_in_range   = Number(newGroupRows[0]?.count    ?? 0);
  const closed_groups_in_range = Number(closedGroupRows[0]?.count ?? 0);
  const net_growth            = new_groups_in_range - closed_groups_in_range;

  // ── Group status breakdown ─────────────────────────────────────────────────
  const group_status_breakdown = { active: 0, closed: 0, pending: 0 };
  for (const row of groupStatusRows) {
    if (row.label === 'active')  group_status_breakdown.active  = Number(row.count);
    if (row.label === 'closed')  group_status_breakdown.closed  = Number(row.count);
    if (row.label === 'pending') group_status_breakdown.pending = Number(row.count);
  }

  // ── Signup velocity series ─────────────────────────────────────────────────
  const signup_velocity_series = signupSeriesRows.map(r => ({
    date:  String(r.date),
    count: Number(r.count),
  }));

  // ── Group lifecycle series (merge created + closed by date bucket) ─────────
  const createdMap = new Map(groupCreatedSeriesRows.map(r => [String(r.date), Number(r.created)]));
  const closedMap  = new Map(groupClosedSeriesRows.map(r  => [String(r.date), Number(r.closed)]));
  const allDates   = [...new Set([...createdMap.keys(), ...closedMap.keys()])].sort();
  const group_lifecycle_series = allDates.map(date => ({
    date,
    created: createdMap.get(date) ?? 0,
    closed:  closedMap.get(date)  ?? 0,
  }));

  return {
    total_users,
    new_signups_in_range,
    delta_pct,
    mau,
    wau,
    dau,
    stickiness_pct,
    total_groups,
    new_groups_in_range,
    closed_groups_in_range,
    net_growth,
    signup_velocity_series,
    group_lifecycle_series,
    group_status_breakdown,
    // These fields require schema additions not yet present:
    dau_wau_mau_series:      [],  // needs historical session snapshots
    signup_source_breakdown: [],  // needs users.signup_source column
  };
}

/**
 * Aggregates platform-wide Engagement tab metrics: payment compliance rates,
 * active defaulters, cycle throughput, and per-group compliance leaderboard.
 *
 * Compliance is measured over payments whose cycle `due_date` falls within the
 * selected range (skip-month cycles excluded). Active defaulters are always a
 * live snapshot regardless of range.
 *
 * @param range - Time window; one of `24h | 7d | 30d | 90d | all` (default `30d`)
 * @throws {AppError} 400 INVALID_RANGE if range is not in the allowed set
 */
export async function getEngagementAnalytics(range: string) {
  if (!VALID_RANGES.has(range)) {
    throw new AppError(400, 'INVALID_RANGE', `range must be one of: ${[...VALID_RANGES].join(', ')}`);
  }

  const rangeStart = getRangeStart(range);
  const gran       = getGranularity(range);
  const since      = rangeStart ?? new Date(0);
  const sinceDate  = since.toISOString().slice(0, 10); // 'YYYY-MM-DD' for date column comparison

  // Subquery: active member count per group (for leaderboard member_count column).
  const memberAgg = db
    .select({
      group_id: memberships.group_id,
      cnt:      sql<number>`COUNT(*)`.as('cnt'),
    })
    .from(memberships)
    .where(eq(memberships.status, 'Active'))
    .groupBy(memberships.group_id)
    .as('member_agg');

  const adminM = alias(memberships, 'admin_m');

  // Core join condition for non-skip cycles whose due_date is within the range.
  // Applied on the monthly_cycles side of every payments→monthly_cycles join.
  const cycleCond = and(
    eq(monthly_cycles.is_skip_month, false),
    gte(monthly_cycles.due_date, sinceDate),
  );

  const [
    complianceRows,
    activeDefaulterRows,
    closedCyclesRows,
    openCyclesRows,
    complianceSeriesRows,
    groupComplianceRows,
  ] = await Promise.all([

    // 1. Platform-wide compliance: payment counts + amounts for cycles in range.
    //    FILTER (WHERE ...) excludes Waived payments from both due and collected.
    db.select({
      due_count:        sql<number>`COUNT(*) FILTER (WHERE ${payments.status} IN ('Paid', 'Unpaid'))`,
      collected_count:  sql<number>`COUNT(*) FILTER (WHERE ${payments.status} = 'Paid')`,
      amount_expected:  sql<number>`COALESCE(SUM(${payments.expected_amount}) FILTER (WHERE ${payments.status} IN ('Paid', 'Unpaid')), 0)`,
      amount_collected: sql<number>`COALESCE(SUM(${payments.paid_amount}) FILTER (WHERE ${payments.status} = 'Paid'), 0)`,
    })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), cycleCond)),

    // 2. Active defaulters — distinct members with Unpaid in currently Open non-skip cycles.
    //    This is always a live snapshot, not range-scoped.
    db.select({ count: sql<number>`COUNT(DISTINCT ${payments.member_user_id})` })
      .from(payments)
      .innerJoin(monthly_cycles, and(
        eq(monthly_cycles.id, payments.cycle_id),
        eq(monthly_cycles.is_skip_month, false),
        eq(monthly_cycles.status, 'Open'),
      ))
      .where(eq(payments.status, 'Unpaid')),

    // 3. Cycles closed in the selected range (skip months excluded)
    db.select({ count: sql<number>`COUNT(*)` })
      .from(monthly_cycles)
      .where(and(
        eq(monthly_cycles.status, 'Closed'),
        eq(monthly_cycles.is_skip_month, false),
        isNotNull(monthly_cycles.closed_at),
        gte(monthly_cycles.closed_at!, since),
      )),

    // 4. Cycles currently open (live snapshot, skip months excluded)
    db.select({ count: sql<number>`COUNT(*)` })
      .from(monthly_cycles)
      .where(and(
        eq(monthly_cycles.status, 'Open'),
        eq(monthly_cycles.is_skip_month, false),
      )),

    // 5. Compliance trend — due vs collected per date bucket (bucketed by cycle due_date)
    //    GROUP/ORDER BY 1 avoids the gran bind-param duplication issue (see Money tab).
    db.select({
      date:      sql<string>`DATE_TRUNC(${gran}, ${monthly_cycles.due_date}::timestamp)`,
      due:       sql<number>`COUNT(*) FILTER (WHERE ${payments.status} IN ('Paid', 'Unpaid'))`,
      collected: sql<number>`COUNT(*) FILTER (WHERE ${payments.status} = 'Paid')`,
    })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), cycleCond))
    .groupBy(sql`1`)
    .orderBy(sql`1`),

    // 6. Per-group compliance in range — used for top/bottom leaderboard.
    //    MAX(memberAgg.cnt) avoids adding the subquery column to GROUP BY.
    db.select({
      group_id:     chit_groups.id,
      name:         chit_groups.name,
      admin_name:   users.name,
      member_count: sql<number>`COALESCE(MAX(${memberAgg.cnt}), 0)`,
      due:          sql<number>`COUNT(*) FILTER (WHERE ${payments.status} IN ('Paid', 'Unpaid'))`,
      collected:    sql<number>`COUNT(*) FILTER (WHERE ${payments.status} = 'Paid')`,
    })
    .from(payments)
    .innerJoin(monthly_cycles, and(eq(monthly_cycles.id, payments.cycle_id), cycleCond))
    .innerJoin(chit_groups, eq(chit_groups.id, monthly_cycles.group_id))
    .innerJoin(adminM, and(
      eq(adminM.group_id, chit_groups.id),
      eq(adminM.role, 'Admin'),
      eq(adminM.status, 'Active'),
    ))
    .innerJoin(users, eq(users.id, adminM.user_id))
    .leftJoin(memberAgg, eq(memberAgg.group_id, chit_groups.id))
    .groupBy(chit_groups.id, chit_groups.name, users.name),
  ]);

  // ── Compliance scalars ─────────────────────────────────────────────────────
  const cr = complianceRows[0];
  const total_payments_due       = Number(cr?.due_count        ?? 0);
  const total_payments_collected = Number(cr?.collected_count  ?? 0);
  const total_amount_expected    = Number(cr?.amount_expected  ?? 0);
  const total_amount_collected   = Number(cr?.amount_collected ?? 0);
  const compliance_rate_pct      = total_payments_due > 0
    ? Number(((total_payments_collected / total_payments_due) * 100).toFixed(1))
    : 0;

  const active_defaulters      = Number(activeDefaulterRows[0]?.count ?? 0);
  const cycles_closed_in_range = Number(closedCyclesRows[0]?.count   ?? 0);
  const cycles_open_now        = Number(openCyclesRows[0]?.count     ?? 0);

  // ── Compliance series ──────────────────────────────────────────────────────
  const compliance_series = complianceSeriesRows.map(r => {
    const d = Number(r.due);
    const c = Number(r.collected);
    return {
      date:      String(r.date),
      due:       d,
      collected: c,
      rate_pct:  d > 0 ? Number(((c / d) * 100).toFixed(1)) : 0,
    };
  });

  // ── Per-group compliance leaderboard ──────────────────────────────────────
  const groupCompliance = groupComplianceRows
    .filter(r => Number(r.due) > 0)
    .map(r => {
      const due  = Number(r.due);
      const coll = Number(r.collected);
      return {
        group_id:       r.group_id,
        name:           r.name,
        admin_name:     r.admin_name,
        member_count:   Number(r.member_count),
        due,
        collected:      coll,
        compliance_pct: due > 0 ? Number(((coll / due) * 100).toFixed(1)) : 0,
      };
    });

  const sorted = [...groupCompliance].sort((a, b) => b.compliance_pct - a.compliance_pct);
  const top_groups_by_compliance    = sorted.slice(0, 5);
  const bottom_groups_by_compliance = [...sorted].reverse().slice(0, 5);

  return {
    total_payments_due,
    total_payments_collected,
    compliance_rate_pct,
    total_amount_expected,
    total_amount_collected,
    active_defaulters,
    cycles_closed_in_range,
    cycles_open_now,
    compliance_series,
    top_groups_by_compliance,
    bottom_groups_by_compliance,
  };
}
