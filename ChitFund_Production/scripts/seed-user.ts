/**
 * One-time script to insert a user directly into the DB.
 * Run: npx tsx scripts/seed-user.ts
 * Delete this file after use.
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/config/db';
import { users } from '../src/db/schema';

// ── Edit these ────────────────────────────────────────────────
const NAME     = 'Suraj KM';
const MOBILE   = '9999999999';   // must be unique in the DB
const USERNAME = 'suraj';        // optional — remove line if not needed
const PASSWORD = 'yourpassword';
// ─────────────────────────────────────────────────────────────

const hash = await bcrypt.hash(PASSWORD, 10);

await db.insert(users).values({
  name:            NAME,
  mobile_number:   MOBILE,
  username:        USERNAME,
  password_hash:   hash,
  mobile_verified: true,          // true = no OTP required to log in
});

console.log(`✓ User created — mobile: ${MOBILE}  username: ${USERNAME}`);
process.exit(0);
