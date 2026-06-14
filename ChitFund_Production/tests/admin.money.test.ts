/**
 * Integration tests for GET /v1/admin/analytics/money (SuperAdmin Money tab).
 * Each describe block is self-contained — beforeEach in setup.ts truncates all
 * tables, so tests cannot bleed into each other.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { app } from '../src/app';
import { db } from '../src/config/db';
import { createUser, createGroup } from './helpers/seed';
import {
  payments, loans, baskets, monthly_cycles,
} from '../src/db/schema';

// ─── local seed helpers ───────────────────────────────────────────────────────

async function getBasketId(group_id: string): Promise<string> {
  const [row] = await db
    .select({ id: baskets.id })
    .from(baskets)
    .where(eq(baskets.group_id, group_id))
    .limit(1);
  return row.id;
}

async function getCycleId(group_id: string, month_number: number): Promise<string> {
  const [row] = await db
    .select({ id: monthly_cycles.id })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, month_number)))
    .limit(1);
  return row.id;
}

async function seedPaidPayment(cycle_id: string, member_user_id: string, amount: number, marker_id: string) {
  await db.insert(payments).values({
    cycle_id, member_user_id,
    expected_amount: amount, paid_amount: amount,
    status: 'Paid', paid_at: new Date(), marked_by: marker_id,
  });
}

async function seedLoan(basket_id: string, borrower_user_id: string, principal: number, status: 'Active' | 'Repaid' | 'WrittenOff') {
  await db.insert(loans).values({
    basket_id, borrower_user_id, principal,
    monthly_interest_rate: '5.00', disbursement_month_number: 1, status,
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('GET /v1/admin/analytics/money — range validation', () => {

  it('returns 400 INVALID_RANGE for an unrecognised range value', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=invalid')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it.each(['24h', '7d', '30d', '90d', 'all'])('accepts range=%s and returns 200', async (range) => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get(`/v1/admin/analytics/money?range=${range}`)
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
  });

});

describe('GET /v1/admin/analytics/money — shape on empty platform', () => {

  it('returns all-zero scalars, empty arrays, and correct loan_portfolio nesting when no data exists', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);

    const d = res.body.data;

    // Scalar fields
    expect(d.gmv_lifetime).toBe(0);
    expect(d.gmv_in_range).toBe(0);
    expect(d.avg_pool_size).toBe(0);
    expect(d.cumulative_basket_value).toBe(0);
    expect(d.default_rate_pct).toBe(0);

    // Array fields
    expect(d.gmv_series).toEqual([]);
    expect(d.pool_size_distribution).toEqual([]);
    expect(d.top_groups_by_gmv).toEqual([]);
    expect(d.basket_aggregate_series).toEqual([]);

    // Loan portfolio structure
    expect(d.loan_portfolio.active.count).toBe(0);
    expect(d.loan_portfolio.active.total_principal).toBe(0);
    expect(d.loan_portfolio.active.avg_interest_rate).toBe(0);
    expect(d.loan_portfolio.active.accrued_interest).toBe(0);
    expect(d.loan_portfolio.closed.repaid_count).toBe(0);
    expect(d.loan_portfolio.closed.written_off_count).toBe(0);
    expect(d.loan_portfolio.closed.default_rate_pct).toBe(0);
  });

});

describe('GET /v1/admin/analytics/money — GMV aggregation', () => {

  it('gmv_lifetime reflects only Paid payments; Unpaid rows are excluded', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    const cycleId = await getCycleId(group_id, 1);

    // Paid payment worth 30 000 paise — should count
    await seedPaidPayment(cycleId, admin.id, 30000, admin.id);

    // A second member with an Unpaid row — should NOT count
    const member = await createUser();
    await db.insert(payments).values({
      cycle_id: cycleId, member_user_id: member.id,
      expected_amount: 10000, paid_amount: 0, status: 'Unpaid',
    });

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.gmv_lifetime).toBe(30000);
  });

  it('gmv_in_range equals gmv_lifetime when range=all (full-history window)', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    const cycleId = await getCycleId(group_id, 1);
    await seedPaidPayment(cycleId, admin.id, 15000, admin.id);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.gmv_in_range).toBe(res.body.data.gmv_lifetime);
  });

});

describe('GET /v1/admin/analytics/money — loan portfolio', () => {

  it('counts Active/Repaid/WrittenOff loans and computes default rates', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    const basketId = await getBasketId(group_id);

    // Seed: 2 Active (total principal 8000), 1 Repaid, 1 WrittenOff
    await seedLoan(basketId, admin.id, 5000, 'Active');
    await seedLoan(basketId, admin.id, 3000, 'Active');
    await seedLoan(basketId, admin.id, 4000, 'Repaid');
    await seedLoan(basketId, admin.id, 2000, 'WrittenOff');

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const { active, closed } = res.body.data.loan_portfolio;

    // Active bucket
    expect(active.count).toBe(2);
    expect(active.total_principal).toBe(8000);
    expect(active.avg_interest_rate).toBe(5);

    // Closed bucket
    expect(closed.repaid_count).toBe(1);
    expect(closed.written_off_count).toBe(1);
    // default_rate_pct inside closed = written_off / (repaid + written_off) = 1/2 = 50.0
    expect(closed.default_rate_pct).toBe(50);

    // Top-level default_rate_pct = written_off / total_loans = 1/4 = 25.0
    expect(res.body.data.default_rate_pct).toBe(25);
  });

  it('default_rate_pct is 0 when no written-off loans exist', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);
    const basketId = await getBasketId(group_id);
    await seedLoan(basketId, admin.id, 5000, 'Active');

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.default_rate_pct).toBe(0);
    expect(res.body.data.loan_portfolio.closed.default_rate_pct).toBe(0);
  });

});

describe('GET /v1/admin/analytics/money — cumulative basket value', () => {

  it('reflects the current sum of all basket balances after a credit adjustment', async () => {
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);

    // Credit the basket via the real API so basket.current_balance is updated
    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 25000, notes: 'Seed credit' });

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.cumulative_basket_value).toBe(25000);
  });

});

describe('GET /v1/admin/analytics/money — pool size distribution', () => {

  it('places a default group (pool_amount = 120 000 paise < ₹1L) in the <1L bucket', async () => {
    const admin = await createUser();
    await createGroup(admin.token); // pool_amount defaults to 120 000 paise

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const dist = res.body.data.pool_size_distribution as { bucket_label: string; count: number }[];
    expect(dist).toHaveLength(1);
    expect(dist[0].bucket_label).toBe('<1L');
    expect(dist[0].count).toBe(1);
  });

  it('avg_pool_size matches the single group pool amount', async () => {
    const admin = await createUser();
    await createGroup(admin.token); // pool_amount = 120 000

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.avg_pool_size).toBe(120000);
  });

});

describe('GET /v1/admin/analytics/money — top groups by GMV', () => {

  it('returns groups ordered by all-time GMV descending', async () => {
    // Group A: 50 000 paise GMV
    const adminA = await createUser();
    const { group_id: gA } = await createGroup(adminA.token);
    const cycleA = await getCycleId(gA, 1);
    await seedPaidPayment(cycleA, adminA.id, 50000, adminA.id);

    // Group B: 20 000 paise GMV
    const adminB = await createUser();
    const { group_id: gB } = await createGroup(adminB.token);
    const cycleB = await getCycleId(gB, 1);
    await seedPaidPayment(cycleB, adminB.id, 20000, adminB.id);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const top = res.body.data.top_groups_by_gmv as { group_id: string; gmv: number }[];
    expect(top).toHaveLength(2);
    expect(top[0].group_id).toBe(gA);
    expect(top[0].gmv).toBe(50000);
    expect(top[1].group_id).toBe(gB);
    expect(top[1].gmv).toBe(20000);
  });

  it('includes member_count, admin_name, and status on each top-groups entry', async () => {
    const admin = await createUser({ name: 'Suraj' });
    const { group_id } = await createGroup(admin.token);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const top = res.body.data.top_groups_by_gmv;
    expect(top).toHaveLength(1);
    expect(top[0].group_id).toBe(group_id);
    expect(top[0].admin_name).toBe('Suraj');
    expect(typeof top[0].member_count).toBe('number');
    expect(top[0].status).toBe('Active');
  });

});
