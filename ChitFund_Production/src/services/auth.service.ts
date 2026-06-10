// Business logic for authentication flows.
// Responsibilities: create user on signup, hash and verify passwords (bcrypt),
// issue and verify JWTs, store and rotate refresh tokens, and orchestrate
// the forgot-password reset flow. No req/res — receives plain data, returns results or throws AppError.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, or, gt, isNull, isNotNull, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { users, refresh_tokens, otp_verifications, memberships } from '../db/schema';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import * as otpService from './otp.service';

// ─── helpers ────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Parses "15m" → 900, "1h" → 3600, "30d" → 2592000, plain number string → itself
function parseExpiresInSeconds(val: string): number {
  if (val.endsWith('m')) return parseInt(val) * 60;
  if (val.endsWith('h')) return parseInt(val) * 3600;
  if (val.endsWith('d')) return parseInt(val) * 86400;
  return parseInt(val);
}

async function issueTokenPair(
  userId: string,
  deviceInfo?: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  // jti (JWT ID) links this access token to its refresh_tokens row for listSessions
  const jti = crypto.randomUUID();

  const access_token = jwt.sign({ userId, jti }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  // Refresh token: high-entropy random hex, stored as SHA-256 hash
  const rawRefresh  = crypto.randomBytes(32).toString('hex');
  const tokenHash   = hashToken(rawRefresh);
  const expiresAt   = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 86400 * 1000);

  await db.insert(refresh_tokens).values({
    user_id:     userId,
    token_hash:  tokenHash,
    session_id:  jti,
    device_info: deviceInfo,
    expires_at:  expiresAt,
  });

  return {
    access_token,
    refresh_token: rawRefresh,
    expires_in:    parseExpiresInSeconds(env.JWT_ACCESS_EXPIRES_IN),
  };
}

// ─── exported service functions ─────────────────────────────────────────────

export async function signup(data: {
  name: string;
  mobile_number: string;
  password: string;
  username?: string;
}): Promise<{ user_id?: string; otp_sent: boolean; otp_expires_at: Date }> {
  const [existingMobile] = await db
    .select({ id: users.id, password_hash: users.password_hash, mobile_verified: users.mobile_verified })
    .from(users)
    .where(and(eq(users.mobile_number, data.mobile_number), isNull(users.deleted_at)))
    .limit(1);

  if (existingMobile) {
    if (existingMobile.mobile_verified) {
      throw new AppError(409, 'MOBILE_TAKEN', 'This mobile number is already registered.');
    }

    // Stub: created by admin via addMember — non-bcrypt placeholder hash, may have group memberships.
    // Orphan: leftover from a previous incomplete signup — bcrypt hash, should have no memberships.
    const isStub = !existingMobile.password_hash.startsWith('$2');

    // For an orphan, check whether an admin linked it to a group before signup completed.
    // If so, treat it like a stub (update in-place) to keep memberships intact.
    let orphanHasMembership = false;
    if (!isStub) {
      const [m] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.user_id, existingMobile.id))
        .limit(1);
      orphanHasMembership = !!m;
    }

    if (isStub || orphanHasMembership) {
      // Claimable record: update in-place so existing memberships keep referencing this user_id.
      if (data.username) {
        const [existingUsername] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.username, data.username), isNull(users.deleted_at)))
          .limit(1);
        if (existingUsername) throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken.');
      }
      const password_hash = await bcrypt.hash(data.password, 10);
      await db
        .update(users)
        .set({ name: data.name, password_hash, username: data.username ?? null, updated_at: new Date() })
        .where(eq(users.id, existingMobile.id));
      // No pending_data — user already exists; verifySignupOtp will find the row and mark it verified.
      const { otp_expires_at } = await otpService.sendOtp(data.mobile_number, 'signup');
      return { user_id: existingMobile.id, otp_sent: true, otp_expires_at };
    }

    // Plain orphan (no memberships): hard-delete so the mobile_number unique slot is freed.
    // Soft-delete would leave a ghost row that blocks the INSERT in verifySignupOtp.
    await db.delete(users).where(eq(users.id, existingMobile.id));
  }

  // New user path — no existing record (or orphan was just soft-deleted above).
  if (data.username) {
    const [existingUsername] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, data.username), isNull(users.deleted_at)))
      .limit(1);
    if (existingUsername) throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken.');
  }

  const password_hash = await bcrypt.hash(data.password, 10);
  // Store user fields in the OTP row; the actual users row is created only after OTP is confirmed.
  const pendingData = JSON.stringify({ name: data.name, password_hash, username: data.username ?? null });
  const { otp_expires_at } = await otpService.sendOtp(data.mobile_number, 'signup', pendingData);
  return { otp_sent: true, otp_expires_at };
}

export async function verifySignupOtp(
  mobileNumber: string,
  otp: string,
  deviceInfo?: string,
): Promise<{ user_id: string; access_token: string; refresh_token: string; expires_in: number }> {
  await otpService.verifyOtp(mobileNumber, otp, 'signup');

  // Fetch the OTP row that was just verified to check for pending_data.
  const [otpRow] = await db
    .select({ pending_data: otp_verifications.pending_data })
    .from(otp_verifications)
    .where(
      and(
        eq(otp_verifications.mobile_number, mobileNumber),
        eq(otp_verifications.purpose, 'signup'),
        isNotNull(otp_verifications.verified_at),
      ),
    )
    .orderBy(desc(otp_verifications.created_at))
    .limit(1);

  let userId: string;

  if (otpRow?.pending_data) {
    // New-user path: create the user row now that OTP is confirmed.
    const pending = JSON.parse(otpRow.pending_data) as {
      name: string;
      password_hash: string;
      username: string | null;
    };
    const [newUser] = await db
      .insert(users)
      .values({
        name:            pending.name,
        mobile_number:   mobileNumber,
        password_hash:   pending.password_hash,
        username:        pending.username,
        mobile_verified: true,
      })
      .returning({ id: users.id });
    userId = newUser.id;
  } else {
    // Stub / orphan-with-membership path: user row already exists, just mark it verified.
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.mobile_number, mobileNumber), isNull(users.deleted_at)))
      .limit(1);

    if (!existingUser) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    await db
      .update(users)
      .set({ mobile_verified: true, updated_at: new Date() })
      .where(eq(users.id, existingUser.id));

    userId = existingUser.id;
  }

  const tokens = await issueTokenPair(userId, deviceInfo);
  return { user_id: userId, ...tokens };
}

export async function login(
  identifier: string,
  password: string,
  deviceInfo?: string,
): Promise<{ user_id: string; access_token: string; refresh_token: string; expires_in: number }> {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        or(eq(users.mobile_number, identifier), eq(users.username, identifier)),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'No account found. Please sign up first.');
  }

  if (!user.mobile_verified) {
    throw new AppError(401, 'MOBILE_NOT_VERIFIED', 'Please verify your mobile number first.');
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid mobile/username or password.');
  }

  const tokens = await issueTokenPair(user.id, deviceInfo);
  return { user_id: user.id, ...tokens };
}

export async function refreshAccessToken(
  rawToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(refresh_tokens)
    .where(eq(refresh_tokens.token_hash, tokenHash))
    .limit(1);

  if (!row) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Invalid refresh token.');
  }
  if (row.revoked_at) {
    throw new AppError(401, 'REFRESH_TOKEN_REVOKED', 'Refresh token has been revoked.');
  }
  if (row.expires_at < new Date()) {
    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token has expired.');
  }

  // New jti on every refresh — keeps session_id in sync with the current access token
  const jti = crypto.randomUUID();

  await db
    .update(refresh_tokens)
    .set({ last_used_at: new Date(), session_id: jti })
    .where(eq(refresh_tokens.id, row.id));

  const access_token = jwt.sign({ userId: row.user_id, jti }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  return { access_token, expires_in: parseExpiresInSeconds(env.JWT_ACCESS_EXPIRES_IN) };
}

export async function logout(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);

  await db
    .update(refresh_tokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(refresh_tokens.token_hash, tokenHash), isNull(refresh_tokens.revoked_at)));
}

export async function forgotPassword(
  mobileNumber: string,
): Promise<{ otp_sent: boolean; otp_expires_at: Date }> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.mobile_number, mobileNumber), isNull(users.deleted_at)))
    .limit(1);

  // Always return the same response shape — don't reveal whether mobile exists
  if (!user) {
    const fakeExpiry = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);
    return { otp_sent: true, otp_expires_at: fakeExpiry };
  }

  const { otp_expires_at } = await otpService.sendOtp(mobileNumber, 'password_reset');
  return { otp_sent: true, otp_expires_at };
}

export async function resetPassword(
  mobileNumber: string,
  submittedOtp: string,
  newPassword: string,
): Promise<{ success: boolean }> {
  const now = new Date();

  // Accepts the OTP row whether or not verify-otp was called first (covers both UX flows)
  const [otpRow] = await db
    .select()
    .from(otp_verifications)
    .where(
      and(
        eq(otp_verifications.mobile_number, mobileNumber),
        eq(otp_verifications.purpose, 'password_reset'),
        gt(otp_verifications.expires_at, now),
      ),
    )
    .orderBy(desc(otp_verifications.created_at))
    .limit(1);

  if (!otpRow) {
    throw new AppError(401, 'OTP_EXPIRED', 'OTP has expired. Please request a new one.');
  }

  // Only enforce attempt limit on unverified rows (verified rows were already checked)
  if (!otpRow.verified_at && otpRow.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Too many incorrect attempts. Please request a new OTP.');
  }

  const isValid = await bcrypt.compare(submittedOtp, otpRow.otp_hash);
  if (!isValid) {
    if (!otpRow.verified_at) {
      await db
        .update(otp_verifications)
        .set({ attempts: otpRow.attempts + 1 })
        .where(eq(otp_verifications.id, otpRow.id));
    }
    throw new AppError(401, 'OTP_INVALID', 'Incorrect OTP.');
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.mobile_number, mobileNumber), isNull(users.deleted_at)))
    .limit(1);

  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found.');
  }

  const newHash = await bcrypt.hash(newPassword, 10);

  await db
    .update(users)
    .set({ password_hash: newHash, updated_at: new Date() })
    .where(eq(users.id, user.id));

  // Expire the OTP row to prevent reuse
  await db
    .update(otp_verifications)
    .set({ expires_at: now })
    .where(eq(otp_verifications.id, otpRow.id));

  // Revoke all active refresh tokens — forces re-login on all devices after password change
  await db
    .update(refresh_tokens)
    .set({ revoked_at: now })
    .where(and(eq(refresh_tokens.user_id, user.id), isNull(refresh_tokens.revoked_at)));

  return { success: true };
}
