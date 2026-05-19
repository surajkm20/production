// Business logic for authentication flows.
// Responsibilities: create user on signup, hash and verify passwords (bcrypt),
// issue and verify JWTs, store and rotate refresh tokens, and orchestrate
// the forgot-password reset flow. No req/res — receives plain data, returns results or throws AppError.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, or, gt, isNull, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { users, refresh_tokens, otp_verifications } from '../db/schema';
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
}): Promise<{ user_id: string; otp_sent: boolean; otp_expires_at: Date }> {
  // Check mobile not already taken
  const [existingMobile] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.mobile_number, data.mobile_number), isNull(users.deleted_at)))
    .limit(1);
  if (existingMobile) {
    throw new AppError(409, 'MOBILE_TAKEN', 'This mobile number is already registered.');
  }

  // Check username not already taken (if provided)
  if (data.username) {
    const [existingUsername] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, data.username), isNull(users.deleted_at)))
      .limit(1);
    if (existingUsername) {
      throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken.');
    }
  }

  const password_hash = await bcrypt.hash(data.password, 10);

  const [user] = await db
    .insert(users)
    .values({
      name:          data.name,
      mobile_number: data.mobile_number,
      password_hash,
      username:      data.username,
      mobile_verified: true, // OTP_BYPASS: remove this line when OTP is enabled
    })
    .returning({ id: users.id });

  // OTP_BYPASS: uncomment below and remove mobile_verified:true above when MSG91/DLT is ready
  // const { otp_expires_at } = await otpService.sendOtp(data.mobile_number, 'signup');
  // return { user_id: user.id, otp_sent: true, otp_expires_at };

  const otp_expires_at = new Date();
  return { user_id: user.id, otp_sent: false, otp_expires_at };
}

export async function verifySignupOtp(
  mobileNumber: string,
  otp: string,
  deviceInfo?: string,
): Promise<{ user_id: string; access_token: string; refresh_token: string; expires_in: number }> {
  await otpService.verifyOtp(mobileNumber, otp, 'signup');

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.mobile_number, mobileNumber), isNull(users.deleted_at)))
    .limit(1);

  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found.');
  }

  await db
    .update(users)
    .set({ mobile_verified: true, updated_at: new Date() })
    .where(eq(users.id, user.id));

  const tokens = await issueTokenPair(user.id, deviceInfo);
  return { user_id: user.id, ...tokens };
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

  // OTP_BYPASS: uncomment below when OTP is enabled
  // if (!user.mobile_verified) {
  //   throw new AppError(401, 'MOBILE_NOT_VERIFIED', 'Please verify your mobile number first.');
  // }

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
    return { otp_sent: false, otp_expires_at: fakeExpiry };
  }

  // OTP_BYPASS: skip OTP when MSG91 is not configured
  if (!env.MSG91_AUTH_KEY) {
    const fakeExpiry = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);
    return { otp_sent: false, otp_expires_at: fakeExpiry };
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

  // OTP_BYPASS: skip OTP verification when MSG91 is not configured
  if (!env.MSG91_AUTH_KEY) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.mobile_number, mobileNumber), isNull(users.deleted_at)))
      .limit(1);
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ password_hash: newHash, updated_at: now }).where(eq(users.id, user.id));
    await db.update(refresh_tokens).set({ revoked_at: now }).where(and(eq(refresh_tokens.user_id, user.id), isNull(refresh_tokens.revoked_at)));
    return { success: true };
  }

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
