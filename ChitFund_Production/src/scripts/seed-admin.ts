import '../config/env';
import bcrypt from 'bcryptjs';
import { db } from '../config/db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

const MOBILE = '+919999999999';
const PASSWORD = 'Admin@123';
const NAME = 'Super Admin';

async function main() {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.mobile_number, MOBILE))
    .limit(1);

  if (existing) {
    console.log(`User with mobile ${MOBILE} already exists (id: ${existing.id}). Skipping.`);
    process.exit(0);
  }

  const password_hash = await bcrypt.hash(PASSWORD, 10);

  const [user] = await db
    .insert(users)
    .values({ name: NAME, mobile_number: MOBILE, password_hash, mobile_verified: true })
    .returning({ id: users.id });

  console.log(`Admin user created successfully.`);
  console.log(`  Mobile : ${MOBILE}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  User ID : ${user.id}`);
  console.log(`\nChange this password after first login.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
