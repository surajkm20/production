import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { db } from '../../src/config/db';
import { users, baskets, monthly_cycles, payments } from '../../src/db/schema';
import { env } from '../../src/config/env';
import { app } from '../../src/app';

function nextMonthStart(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── createUser ──────────────────────────────────────────────────────────────
// Inserts a user directly into the DB (faster than going through the auth API).
// Returns the user row + a valid access token for that user.
export async function createUser(overrides: Partial<{
  name: string;
  mobile_number: string;
  role: string;
}> = {}) {
  const passwordHash = await bcrypt.hash('Test@1234', 10);

  const [user] = await db.insert(users).values({
    name:             overrides.name          ?? 'Test User',
    mobile_number:    overrides.mobile_number ?? `+91${Math.floor(9000000000 + Math.random() * 999999999)}`,
    password_hash:    passwordHash,
    mobile_verified:  true,
    role:             overrides.role          ?? 'User',
  }).returning({ id: users.id, name: users.name, mobile_number: users.mobile_number, role: users.role });

  const token = jwt.sign({ userId: user.id, jti: 'test-session' }, env.JWT_ACCESS_SECRET, {
    expiresIn: '1h',
  });

  return { ...user, token };
}

// ─── createGroup ─────────────────────────────────────────────────────────────
// Creates a group via the real API endpoint so all side-effects happen
// (basket creation, monthly_cycles pre-generation, admin membership row).
// Returns the group_id and basket_id.
export async function createGroup(adminToken: string, overrides: Partial<{
  name: string;
  pool_amount: number;
  monthly_contribution: number;
  total_shares: number;
  total_months: number;
  start_month: string;
  payment_due_day: number;
  admin_commission_rate: number;
  monthly_interest_rate: number;
  admin_share_count: number;
}> = {}) {
  const res = await request(app)
    .post('/v1/groups')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      name:                  overrides.name                  ?? 'Test Group',
      pool_amount:           overrides.pool_amount           ?? 120000,
      monthly_contribution:  overrides.monthly_contribution  ?? 10000,
      total_shares:          overrides.total_shares          ?? 12,
      total_months:          overrides.total_months          ?? 12,
      start_month:           overrides.start_month           ?? nextMonthStart(),
      payment_due_day:       overrides.payment_due_day       ?? 10,
      admin_commission_rate: overrides.admin_commission_rate ?? 0,
      monthly_interest_rate: overrides.monthly_interest_rate ?? 5,
      ...(overrides.admin_share_count != null ? { admin_share_count: overrides.admin_share_count } : {}),
    });

  if (res.status !== 201) {
    throw new Error(`createGroup failed: ${JSON.stringify(res.body)}`);
  }

  const group_id        = res.body.data.group_id as string;
  const invitation_code = res.body.data.invitation_code as string;

  const [basketRow] = await db
    .select({ id: baskets.id })
    .from(baskets)
    .where(eq(baskets.group_id, group_id))
    .limit(1);

  return { group_id, basket_id: basketRow.id, invitation_code };
}

// ─── makeInterestAccrue ───────────────────────────────────────────────────────
// Simulates the group advancing past the loan's disbursement cycle so interest
// accrues under the deployed (derived) model. The "current active cycle" is
// min(open cycle that has payment rows); a loan disbursed in a not-yet-started
// group gets disbursement_month_number = 1. Seeding a payment on a later open
// cycle makes THAT month the active cycle, so cyclesElapsed = month − 1 and that
// many months of interest become owed (principal × rate per elapsed cycle).
//
// Used by repay tests because exercising real accrual otherwise requires running
// a full group lifecycle (start → winner → mark paid → close cycle) just to
// advance one month.
export async function makeInterestAccrue(
  group_id: string,
  member_user_id: string,
  monthNumber = 2,
) {
  const [cycle] = await db
    .select({ id: monthly_cycles.id })
    .from(monthly_cycles)
    .where(and(eq(monthly_cycles.group_id, group_id), eq(monthly_cycles.month_number, monthNumber)))
    .limit(1);

  await db.insert(payments).values({
    cycle_id:        cycle.id,
    member_user_id,
    expected_amount: 10000,
  });

  return cycle.id;
}
