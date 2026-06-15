import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { app } from '../src/app';
import { db } from '../src/config/db';
import { createUser, createGroup } from './helpers/seed';
import { payments, monthly_cycles } from '../src/db/schema';

// ─── local seed helpers ───────────────────────────────────────────────────────

async function getCycleId(group_id: string, month_number: number): Promise<string> {
  const [row] = await db
    .select({ id: monthly_cycles.id })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, month_number)))
    .limit(1);
  if (!row) throw new Error(`No cycle month ${month_number} for group ${group_id}`);
  return row.id;
}

async function seedPaidPayment(cycle_id: string, member_user_id: string, amount: number, marker_id: string) {
  await db.insert(payments).values({
    cycle_id, member_user_id,
    expected_amount: amount, paid_amount: amount,
    status: 'Paid', paid_at: new Date(), marked_by: marker_id,
  });
}

async function seedUnpaidPayment(cycle_id: string, member_user_id: string, amount: number) {
  await db.insert(payments).values({
    cycle_id, member_user_id,
    expected_amount: amount, paid_amount: 0,
    status: 'Unpaid',
  });
}

function pastMonthStart(monthsAgo = 1): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

// ─── range validation ─────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — range validation', () => {

  it('returns 400 INVALID_RANGE for an unrecognised range value', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=bad')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it.each(['24h', '7d', '30d', '90d', 'all'])('accepts range=%s and returns 200', async (range) => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get(`/v1/admin/analytics/engagement?range=${range}`)
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a non-SuperAdmin with 403', async () => {
    const user = await createUser();
    const res = await request(app)
      .get('/v1/admin/analytics/engagement')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

});

// ─── shape on empty platform ──────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — shape on empty platform', () => {

  it('returns zero scalars and empty arrays when no payment data exists', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(typeof d.total_payments_due).toBe('number');
    expect(typeof d.total_payments_collected).toBe('number');
    expect(typeof d.compliance_rate_pct).toBe('number');
    expect(typeof d.total_amount_expected).toBe('number');
    expect(typeof d.total_amount_collected).toBe('number');
    expect(typeof d.active_defaulters).toBe('number');
    expect(typeof d.cycles_closed_in_range).toBe('number');
    expect(typeof d.cycles_open_now).toBe('number');
    expect(Array.isArray(d.compliance_series)).toBe(true);
    expect(Array.isArray(d.top_groups_by_compliance)).toBe(true);
    expect(Array.isArray(d.bottom_groups_by_compliance)).toBe(true);
    // With no payments, all zeros
    expect(d.total_payments_due).toBe(0);
    expect(d.compliance_rate_pct).toBe(0);
  });

});

// ─── compliance counts ────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — compliance counts', () => {

  it('counts Paid payments as collected and Unpaid as due-but-not-collected', async () => {
    const admin  = await createUser();
    const member = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });

    const cycle_id = await getCycleId(group_id, 1);
    await seedPaidPayment(cycle_id, admin.id,  10000, admin.id);
    await seedUnpaidPayment(cycle_id, member.id, 10000);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    // 2 due (Paid + Unpaid), 1 collected
    expect(d.total_payments_due).toBeGreaterThanOrEqual(2);
    expect(d.total_payments_collected).toBeGreaterThanOrEqual(1);
    expect(d.total_payments_collected).toBeLessThan(d.total_payments_due);
  });

  it('compliance_rate_pct is 100 when all payments are Paid', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    await seedPaidPayment(cycle_id, admin.id, 10000, admin.id);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.compliance_rate_pct).toBe(100);
  });

  it('amount fields reflect expected vs collected in paise', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    // 10000 paise paid, 10000 paise expected but unpaid
    await seedPaidPayment(cycle_id, admin.id,       10000, admin.id);
    const member = await createUser();
    await seedUnpaidPayment(cycle_id, member.id, 10000);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total_amount_collected).toBeGreaterThanOrEqual(10000);
    expect(d.total_amount_expected).toBeGreaterThanOrEqual(20000);
    expect(d.total_amount_collected).toBeLessThan(d.total_amount_expected);
  });

  it('Waived payments are excluded from both due and collected', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    // 1 Paid + 1 Waived
    await seedPaidPayment(cycle_id, admin.id, 10000, admin.id);
    const member = await createUser();
    await db.insert(payments).values({
      cycle_id, member_user_id: member.id,
      expected_amount: 10000, paid_amount: 0,
      status: 'Waived',
    });

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    // Only the Paid row counts — 1 due, 1 collected → 100%
    expect(d.compliance_rate_pct).toBe(100);
    expect(d.total_payments_due).toBeGreaterThanOrEqual(1);
  });

});

// ─── active defaulters ────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — active defaulters', () => {

  it('counts members with Unpaid in currently Open non-skip cycles', async () => {
    const admin  = await createUser();
    const member = await createUser();
    // Group with future start_month → cycle is Open (not yet started)
    const { group_id } = await createGroup(admin.token);
    const cycle_id = await getCycleId(group_id, 1);
    await seedUnpaidPayment(cycle_id, member.id, 10000);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.active_defaulters).toBeGreaterThanOrEqual(1);
  });

});

// ─── compliance series ────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — compliance series', () => {

  it('compliance_series has at least one bucket when payments exist in range', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    await seedPaidPayment(cycle_id, admin.id, 10000, admin.id);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const series = res.body.data.compliance_series as { date: string; due: number; collected: number; rate_pct: number }[];
    expect(series.length).toBeGreaterThanOrEqual(1);
    const totalDue = series.reduce((s, r) => s + r.due, 0);
    expect(totalDue).toBeGreaterThanOrEqual(1);
  });

  it('compliance_series entries have correct shape', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    await seedPaidPayment(cycle_id, admin.id, 10000, admin.id);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const [entry] = res.body.data.compliance_series;
    expect(typeof entry.date).toBe('string');
    expect(typeof entry.due).toBe('number');
    expect(typeof entry.collected).toBe('number');
    expect(typeof entry.rate_pct).toBe('number');
  });

});

// ─── group leaderboard ────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/engagement — group leaderboard', () => {

  it('top_groups_by_compliance has the fully-paid group ranked first', async () => {
    const admin1 = await createUser();
    const admin2 = await createUser();

    // Group A: 1 paid → 100%
    const { group_id: gA } = await createGroup(admin1.token, { start_month: pastMonthStart(1) });
    const cycleA = await getCycleId(gA, 1);
    await seedPaidPayment(cycleA, admin1.id, 10000, admin1.id);

    // Group B: 0 paid, 1 unpaid → 0%
    const { group_id: gB } = await createGroup(admin2.token, { start_month: pastMonthStart(1) });
    const cycleB = await getCycleId(gB, 1);
    await seedUnpaidPayment(cycleB, admin2.id, 10000);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const top = res.body.data.top_groups_by_compliance as { group_id: string; compliance_pct: number }[];
    expect(top.length).toBeGreaterThanOrEqual(1);
    expect(top[0].compliance_pct).toBeGreaterThan(top[top.length - 1].compliance_pct);
  });

  it('bottom_groups_by_compliance entries have correct shape', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token, { start_month: pastMonthStart(1) });
    const cycle_id = await getCycleId(group_id, 1);
    await seedUnpaidPayment(cycle_id, admin.id, 10000);

    const sa  = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/engagement?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const bottom = res.body.data.bottom_groups_by_compliance as {
      group_id: string; name: string; admin_name: string;
      member_count: number; due: number; collected: number; compliance_pct: number;
    }[];
    expect(bottom.length).toBeGreaterThanOrEqual(1);
    const [g] = bottom;
    expect(typeof g.group_id).toBe('string');
    expect(typeof g.name).toBe('string');
    expect(typeof g.admin_name).toBe('string');
    expect(typeof g.due).toBe('number');
    expect(typeof g.collected).toBe('number');
    expect(typeof g.compliance_pct).toBe('number');
  });

});
