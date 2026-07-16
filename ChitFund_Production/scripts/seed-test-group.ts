/**
 * Seeds a "test" chit group with 40 dummy members for local UI testing.
 * Run: npx tsx scripts/seed-test-group.ts
 *
 * Group spec:
 *   name: test | contribution: ₹2,50,000/share/month | shares: 40 | months: 10
 *   admin_share_count: 2 | maintenance fee: ₹10,000 (0.4% of pool)
 *
 * Members created: member01–member40
 *   mobile: +919100000001 … +919100000040
 *   password: Test@1234
 */

import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import { db } from '../src/config/db';
import { users } from '../src/db/schema';
import { inArray } from 'drizzle-orm';

const BASE_URL   = 'http://localhost:3000/v1';
const JWT_SECRET = 'f181ba9aee55eca5f313eae8e62adc1267854cf0260e22113cee0f94cc2f7e48dae2e3b701877e8fb77136c34edaa1dc7f041e6324d57407612fa777cf56f5d1';
const ADMIN_ID   = '338f2d94-8308-48fd-9cf7-8f956b415aa1'; // Suraj

// ── helpers ───────────────────────────────────────────────────────────────────

function makeToken(userId: string): string {
  return jwt.sign({ userId, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' });
}

async function apiPost<T>(path: string, body: unknown, token: string): Promise<T> {
  const res  = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  });
  const json = await res.json() as { data: T; message?: string };
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

// ── 1. Create group as admin ──────────────────────────────────────────────────
//
// monthly_contribution: ₹2,50,000 = 25_000_000 paise
// pool_amount          = 25_000_000 × 10 months = 250_000_000 paise (₹25,00,000)
// admin_commission     = ₹10,000 = 1_000_000 paise
// rate                 = 1_000_000 / 250_000_000 × 100 = 0.4 %

const adminToken = makeToken(ADMIN_ID);
const group = await apiPost<{ group_id: string; invitation_code: string }>('/groups', {
  name:                  'test',
  monthly_contribution:  25_000_000,   // paise
  total_shares:          40,
  total_months:          10,
  start_month:           '2026-08-01',
  payment_due_day:       10,
  admin_share_count:     2,
  admin_commission_rate: 0.4,
  monthly_interest_rate: 2,
}, adminToken);

console.log(`✓ Group created`);
console.log(`  group_id:        ${group.group_id}`);
console.log(`  invitation_code: ${group.invitation_code}`);

// ── 2. Ensure all 40 member accounts exist in the DB ─────────────────────────

const MEMBER_COUNT  = 40;
const PASSWORD_HASH = await bcrypt.hash('Test@1234', 10);

const memberDefs = Array.from({ length: MEMBER_COUNT }, (_, i) => {
  const n   = i + 1;
  const num = String(n).padStart(2, '0');
  return {
    name:   `member${num}`,
    mobile: `+9191${String(n).padStart(8, '0')}`, // +919100000001 … +919100000040
  };
});

// Find which mobiles already have accounts
const existingRows = await db
  .select({ id: users.id, mobile_number: users.mobile_number })
  .from(users)
  .where(inArray(users.mobile_number, memberDefs.map(m => m.mobile)));

const existingMobiles = new Set(existingRows.map(u => u.mobile_number));

let created = 0;
for (const m of memberDefs) {
  if (!existingMobiles.has(m.mobile)) {
    await db.insert(users).values({
      name:            m.name,
      mobile_number:   m.mobile,
      password_hash:   PASSWORD_HASH,
      mobile_verified: true,
    });
    created++;
  }
}
console.log(`✓ Members in DB — ${created} created, ${existingMobiles.size} already existed`);

// ── 3. Each member joins the group ────────────────────────────────────────────

const allMemberRows = await db
  .select({ id: users.id, name: users.name, mobile_number: users.mobile_number })
  .from(users)
  .where(inArray(users.mobile_number, memberDefs.map(m => m.mobile)));

let joined = 0;
let failed = 0;

for (const member of allMemberRows) {
  try {
    const token = makeToken(member.id);
    await apiPost('/groups/join', {
      invitation_code:       group.invitation_code,
      requested_share_count: 1,
    }, token);
    joined++;
    process.stdout.write(`\r  joining… ${joined}/${MEMBER_COUNT}`);
  } catch (err) {
    console.warn(`\n  ⚠ ${member.name} (${member.mobile_number}): ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n✓ Join complete — ${joined} joined, ${failed} failed`);
console.log('\nLogin credentials for any member:');
console.log('  mobile: +9191000000XX  (01–40)');
console.log('  password: Test@1234');
process.exit(0);
