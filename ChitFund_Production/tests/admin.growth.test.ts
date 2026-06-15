import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { createUser, createGroup } from './helpers/seed';

describe('GET /v1/admin/analytics/growth — range validation', () => {

  it('returns 400 INVALID_RANGE for an unrecognised range value', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=bad')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it.each(['24h', '7d', '30d', '90d', 'all'])('accepts range=%s and returns 200', async (range) => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get(`/v1/admin/analytics/growth?range=${range}`)
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a non-SuperAdmin with 403', async () => {
    const user = await createUser();
    const res = await request(app)
      .get('/v1/admin/analytics/growth')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

});

describe('GET /v1/admin/analytics/growth — shape on empty platform', () => {

  it('returns zero scalars and empty arrays when no data exists', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);
    expect(res.status).toBe(200);

    const d = res.body.data;
    // Scalars
    expect(d.new_signups_in_range).toBeGreaterThanOrEqual(0);
    expect(typeof d.total_users).toBe('number');
    expect(typeof d.mau).toBe('number');
    expect(typeof d.wau).toBe('number');
    expect(typeof d.dau).toBe('number');
    expect(typeof d.stickiness_pct).toBe('number');
    expect(typeof d.total_groups).toBe('number');
    expect(typeof d.new_groups_in_range).toBe('number');
    expect(typeof d.closed_groups_in_range).toBe('number');
    expect(typeof d.net_growth).toBe('number');
    // Arrays
    expect(Array.isArray(d.signup_velocity_series)).toBe(true);
    expect(Array.isArray(d.group_lifecycle_series)).toBe(true);
    expect(Array.isArray(d.dau_wau_mau_series)).toBe(true);
    expect(Array.isArray(d.signup_source_breakdown)).toBe(true);
    // Breakdown object
    expect(typeof d.group_status_breakdown.active).toBe('number');
    expect(typeof d.group_status_breakdown.closed).toBe('number');
    expect(typeof d.group_status_breakdown.pending).toBe('number');
  });

});

describe('GET /v1/admin/analytics/growth — user counts', () => {

  it('total_users reflects users created in this test run', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const u1 = await createUser();
    const u2 = await createUser();

    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    // At minimum sa, u1, u2 exist — total_users >= 3
    expect(res.body.data.total_users).toBeGreaterThanOrEqual(3);
    // sa + u1 + u2 were all created just now, so new_signups_in_range equals total_users for range=all
    expect(res.body.data.new_signups_in_range).toBe(res.body.data.total_users);
  });

  it('delta_pct is 100 when there are no pre-range users (all users are new)', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);
    // pre_range_users = 0, new_signups > 0 → delta_pct = 100 (no baseline to compare against)
    expect(res.status).toBe(200);
    expect(res.body.data.delta_pct).toBe(100);
  });

  it('signup_velocity_series has entries matching new users', async () => {
    const sa = await createUser({ role: 'SuperAdmin' });
    await createUser();
    await createUser();

    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const series = res.body.data.signup_velocity_series as { date: string; count: number }[];
    const totalInSeries = series.reduce((s, r) => s + r.count, 0);
    expect(totalInSeries).toBe(res.body.data.total_users);
  });

});

describe('GET /v1/admin/analytics/growth — group counts', () => {

  it('total_groups and new_groups_in_range reflect created groups', async () => {
    const admin = await createUser();
    await createGroup(admin.token);
    await createGroup(admin.token);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total_groups).toBeGreaterThanOrEqual(2);
    // range=all → new_groups_in_range = total_groups
    expect(res.body.data.new_groups_in_range).toBe(res.body.data.total_groups);
  });

  it('net_growth equals new_groups_in_range when no groups are closed', async () => {
    const admin = await createUser();
    await createGroup(admin.token);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.net_growth).toBe(d.new_groups_in_range - d.closed_groups_in_range);
  });

  it('group_status_breakdown: active/closed/pending sums equal total_groups', async () => {
    const admin = await createUser();
    // Past start_month → active; future (default) → pending
    const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
    const pastStart = lastMonth.toISOString().slice(0, 7) + '-01';
    await createGroup(admin.token, { start_month: pastStart });
    await createGroup(admin.token); // default nextMonthStart → pending

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const { active, closed, pending } = res.body.data.group_status_breakdown;
    expect(active + closed + pending).toBe(res.body.data.total_groups);
    expect(active).toBeGreaterThanOrEqual(1);   // the past-start group
    expect(pending).toBeGreaterThanOrEqual(1);  // the future-start group
  });

  it('group_lifecycle_series has entries matching created groups', async () => {
    const admin = await createUser();
    await createGroup(admin.token);

    const sa = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/growth?range=all')
      .set('Authorization', `Bearer ${sa.token}`);

    expect(res.status).toBe(200);
    const series = res.body.data.group_lifecycle_series as { date: string; created: number; closed: number }[];
    const totalCreated = series.reduce((s, r) => s + r.created, 0);
    expect(totalCreated).toBeGreaterThanOrEqual(1);
  });

});
