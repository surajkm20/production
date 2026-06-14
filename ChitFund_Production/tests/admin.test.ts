import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { createUser } from './helpers/seed';

// Step 0 foundation: verifies the SuperAdmin security boundary on /v1/admin/*.
// The Money-tab payload is still a placeholder; these tests lock the gating, not the data.
describe('SuperAdmin admin-console gating', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/v1/admin/analytics/money');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a regular (role=User) caller with 403 FORBIDDEN_SUPERADMIN_ONLY', async () => {
    const user = await createUser(); // defaults to role 'User'
    const res = await request(app)
      .get('/v1/admin/analytics/money')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_SUPERADMIN_ONLY');
  });

  it('allows a SuperAdmin caller through to the endpoint and returns Money tab shape', async () => {
    const superAdmin = await createUser({ role: 'SuperAdmin' });
    const res = await request(app)
      .get('/v1/admin/analytics/money')
      .set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.gmv_lifetime).toBe('number');
    expect(typeof res.body.data.gmv_in_range).toBe('number');
    expect(Array.isArray(res.body.data.top_groups_by_gmv)).toBe(true);
  });
});

// Confirms the platform role is surfaced on /me so the client can render the
// Admin Console entry point and guard the /admin route (requirements §8.1 / 22d).
describe('GET /me exposes platform role', () => {
  it('returns role for a regular user', async () => {
    const user = await createUser();
    const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('User');
  });

  it('returns role=SuperAdmin for a promoted user', async () => {
    const superAdmin = await createUser({ role: 'SuperAdmin' });
    const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('SuperAdmin');
  });
});
