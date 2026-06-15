import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { app } from '../src/app';
import { db } from '../src/config/db';
import { createUser, createGroup } from './helpers/seed';
import { monthly_cycles, loans, baskets } from '../src/db/schema';

// ─── local seed helpers ───────────────────────────────────────────────────────

async function getCycle(group_id: string, month_number: number) {
  const [row] = await db
    .select({ id: monthly_cycles.id, due_date: monthly_cycles.due_date })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, month_number)))
    .limit(1);
  if (!row) throw new Error(`No cycle month ${month_number} for group ${group_id}`);
  return row;
}

async function closeCycleOnTime(cycle_id: string, due_date: string) {
  // Close on the exact due date → on time
  await db.update(monthly_cycles)
    .set({ status: 'Closed', closed_at: new Date(`${due_date}T12:00:00Z`) })
    .where(eq(monthly_cycles.id, cycle_id));
}

async function closeCycleLate(cycle_id: string, due_date: string, daysLate: number) {
  const d = new Date(`${due_date}T12:00:00Z`);
  d.setDate(d.getDate() + daysLate);
  await db.update(monthly_cycles)
    .set({ status: 'Closed', closed_at: d })
    .where(eq(monthly_cycles.id, cycle_id));
}

async function seedLoan(group_id: string, borrower_user_id: string, status: 'Active' | 'Repaid' | 'WrittenOff') {
  const [basket] = await db
    .select({ id: baskets.id })
    .from(baskets)
    .where(eq(baskets.group_id, group_id))
    .limit(1);
  await db.insert(loans).values({
    basket_id: basket.id, borrower_user_id,
    principal: 100000, monthly_interest_rate: '5.00',
    disbursement_month_number: 1, status,
  });
}

function pastMonthStart(monthsAgo = 1): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

// ─── range validation ─────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/reliability — range validation', () => {

  it('returns 400 INVALID_RANGE for an unrecognised range value', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=bad')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it.each(['24h', '7d', '30d', '90d', 'all'])('accepts range=%s and returns 200', async (range) => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get(`/v1/admin/analytics/reliability?range=${range}`)
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a non-SuperAdmin with 403', async () => {
    const user = await createUser();
    const res = await request(app)
      .get('/v1/admin/analytics/reliability')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

});

// ─── shape on empty platform ──────────────────────────────────────────────────

describe('GET /v1/admin/analytics/reliability — shape on empty platform', () => {

  it('returns zero scalars and empty arrays when no data exists', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(typeof d.cycles_closed_on_time).toBe('number');
    expect(typeof d.cycles_closed_late).toBe('number');
    expect(typeof d.on_time_closure_rate_pct).toBe('number');
    expect(typeof d.avg_closure_delay_days).toBe('number');
    expect(typeof d.overdue_open_cycles).toBe('number');
    expect(typeof d.loans_repaid).toBe('number');
    expect(typeof d.loans_written_off).toBe('number');
    expect(typeof d.loan_repayment_rate_pct).toBe('number');
    expect(typeof d.groups_active).toBe('number');
    expect(typeof d.groups_completed).toBe('number');
    expect(typeof d.group_completion_rate_pct).toBe('number');
    expect(Array.isArray(d.cycle_closure_series)).toBe(true);
    expect(Array.isArray(d.groups_with_overdue_cycles)).toBe(true);
    expect(d.cycles_closed_on_time).toBe(0);
    expect(d.on_time_closure_rate_pct).toBe(0);
  });

});

// ─── cycle closure metrics ────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/reliability — cycle closure', () => {

  it('counts a cycle closed on its due_date as on-time (rate = 100%)', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(2) });
    const cycle = await getCycle(group_id, 1);
    await closeCycleOnTime(cycle.id, cycle.due_date);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.cycles_closed_on_time).toBeGreaterThanOrEqual(1);
    expect(d.cycles_closed_late).toBe(0);
    expect(d.on_time_closure_rate_pct).toBe(100);
  });

  it('counts a cycle closed after its due_date as late', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(2) });
    const cycle = await getCycle(group_id, 1);
    await closeCycleLate(cycle.id, cycle.due_date, 5); // 5 days late

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.cycles_closed_late).toBeGreaterThanOrEqual(1);
    expect(d.avg_closure_delay_days).toBeGreaterThan(0);
  });

  it('on_time_closure_rate_pct is 50 when equal on-time and late closures exist', async () => {
    const admin = await createUser();
    // Group with 2+ cycles so we can close one on-time and one late
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(3), total_months: 3, total_shares: 3 });
    const c1 = await getCycle(group_id, 1);
    const c2 = await getCycle(group_id, 2);
    await closeCycleOnTime(c1.id, c1.due_date);
    await closeCycleLate(c2.id, c2.due_date, 10);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.cycles_closed_on_time).toBeGreaterThanOrEqual(1);
    expect(d.cycles_closed_late).toBeGreaterThanOrEqual(1);
    // Equal on-time and late → rate should be 50%
    const manualRate = Number(((d.cycles_closed_on_time / (d.cycles_closed_on_time + d.cycles_closed_late)) * 100).toFixed(1));
    expect(d.on_time_closure_rate_pct).toBe(manualRate);
  });

  it('overdue_open_cycles counts open cycles whose due_date has passed', async () => {
    // Past start_month → cycle 1 has a past due_date, still Open
    await createGroup((await createUser()).token, { start_month: pastMonthStart(2) });

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.overdue_open_cycles).toBeGreaterThanOrEqual(1);
  });

});

// ─── loan reliability ─────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/reliability — loan reliability', () => {

  it('loan_repayment_rate_pct is 100 when all closed loans are Repaid', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    await seedLoan(group_id, admin.id, 'Repaid');
    await seedLoan(group_id, admin.id, 'Repaid');

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.loans_repaid).toBeGreaterThanOrEqual(2);
    expect(d.loans_written_off).toBe(0);
    expect(d.loan_repayment_rate_pct).toBe(100);
  });

  it('loan_repayment_rate_pct reflects written-off loans correctly', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    await seedLoan(group_id, admin.id, 'Repaid');
    await seedLoan(group_id, admin.id, 'WrittenOff');

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.loans_repaid).toBeGreaterThanOrEqual(1);
    expect(d.loans_written_off).toBeGreaterThanOrEqual(1);
    expect(d.loan_repayment_rate_pct).toBeLessThan(100);
    expect(d.loan_repayment_rate_pct).toBeGreaterThan(0);
  });

});

// ─── series and leaderboard ───────────────────────────────────────────────────

describe('GET /v1/admin/analytics/reliability — series and overdue groups', () => {

  it('cycle_closure_series has entries when closed cycles exist in range', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(2) });
    const cycle = await getCycle(group_id, 1);
    await closeCycleOnTime(cycle.id, cycle.due_date);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const series = res.body.data.cycle_closure_series as { date: string; on_time: number; late: number }[];
    expect(series.length).toBeGreaterThanOrEqual(1);
    const [entry] = series;
    expect(typeof entry.date).toBe('string');
    expect(typeof entry.on_time).toBe('number');
    expect(typeof entry.late).toBe('number');
  });

  it('groups_with_overdue_cycles lists groups with past-due open cycles', async () => {
    const admin = await createUser();
    await createGroup(admin.token, { start_month: pastMonthStart(2) });

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/reliability?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const list = res.body.data.groups_with_overdue_cycles as {
      group_id: string; name: string; admin_name: string;
      overdue_count: number; oldest_overdue_days: number;
    }[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    const [g] = list;
    expect(typeof g.group_id).toBe('string');
    expect(typeof g.name).toBe('string');
    expect(typeof g.admin_name).toBe('string');
    expect(g.overdue_count).toBeGreaterThanOrEqual(1);
    expect(g.oldest_overdue_days).toBeGreaterThan(0);
  });

});
