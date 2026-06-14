/**
 * @fileoverview OTP lifecycle service for the ChitFund API. It generates a
 * cryptographically random 6-digit code, stores only its bcrypt hash in
 * `otp_verifications`, delivers it via the MSG91 SMS provider, and verifies
 * submitted codes while enforcing expiry and a max-attempt limit. It is kept
 * separate from `auth.service` because the same OTP flow is reused across signup,
 * password reset, and admin-transfer confirmation.
 * @module services/otp
 * @author Suraj KM
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq, and, gt, isNull, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { otp_verifications, sms_logs } from '../db/schema';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

/** The flow an OTP is issued for, which scopes verification lookups. */
export type OtpPurpose = 'signup' | 'password_reset' | 'admin_transfer';

// crypto.randomInt gives a cryptographically secure, unbiased integer
function generateOtp(): string {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

/**
 * Issues a fresh OTP for a mobile number, persisting its hash and delivering the code by SMS.
 *
 * @param mobileNumber - Recipient mobile number in `+<country><number>` form
 * @param purpose - The flow this OTP authorises
 * @param pendingData - Serialised signup payload to carry until verification; on a signup resend with this omitted, it is recovered from the most recent signup OTP
 * @returns A promise resolving to the OTP's expiry timestamp
 */
export async function sendOtp(
  mobileNumber: string,
  purpose: OtpPurpose,
  pendingData?: string,
): Promise<{ otp_expires_at: Date }> {
  const otp        = generateOtp();
  const otp_hash   = await bcrypt.hash(otp, 10);
  const expires_at = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

  // On a resend (no pendingData passed), carry forward pending_data from the
  // most recent signup OTP so verifySignupOtp can still create the user row.
  let resolvedPendingData = pendingData ?? null;
  if (purpose === 'signup' && pendingData === undefined) {
    const [prev] = await db
      .select({ pending_data: otp_verifications.pending_data })
      .from(otp_verifications)
      .where(
        and(
          eq(otp_verifications.mobile_number, mobileNumber),
          eq(otp_verifications.purpose, 'signup'),
        ),
      )
      .orderBy(desc(otp_verifications.created_at))
      .limit(1);
    resolvedPendingData = prev?.pending_data ?? null;
  }

  await db.insert(otp_verifications).values({
    mobile_number: mobileNumber,
    otp_hash,
    purpose,
    expires_at,
    pending_data: resolvedPendingData,
  });

  await deliverSms(mobileNumber, otp);

  return { otp_expires_at: expires_at };
}

/**
 * Verifies a submitted OTP against the latest unused, unexpired code for a mobile number and purpose, marking it verified on success.
 *
 * @param mobileNumber - Mobile number the OTP was sent to
 * @param submittedOtp - The code the user entered
 * @param purpose - The flow being verified; must match the issued OTP's purpose
 * @returns A promise that resolves when verification succeeds
 * @throws {AppError} 401 OTP_EXPIRED if no valid unverified OTP exists
 * @throws {AppError} 429 OTP_MAX_ATTEMPTS if the attempt limit was already reached
 * @throws {AppError} 401 OTP_INVALID if the submitted code does not match
 */
export async function verifyOtp(
  mobileNumber: string,
  submittedOtp: string,
  purpose: OtpPurpose,
): Promise<void> {
  const now = new Date();

  const [row] = await db
    .select()
    .from(otp_verifications)
    .where(
      and(
        eq(otp_verifications.mobile_number, mobileNumber),
        eq(otp_verifications.purpose, purpose),
        gt(otp_verifications.expires_at, now),
        isNull(otp_verifications.verified_at),
      ),
    )
    .orderBy(desc(otp_verifications.created_at))
    .limit(1);

  if (!row) {
    throw new AppError(401, 'OTP_EXPIRED', 'OTP has expired or does not exist. Please request a new one.');
  }

  if (row.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new AppError(429, 'OTP_MAX_ATTEMPTS', 'Too many incorrect attempts. Please request a new OTP.');
  }

  // Increment attempts before comparing — counts failed tries fairly
  await db
    .update(otp_verifications)
    .set({ attempts: row.attempts + 1 })
    .where(eq(otp_verifications.id, row.id));

  const isValid = await bcrypt.compare(submittedOtp, row.otp_hash);
  if (!isValid) {
    throw new AppError(401, 'OTP_INVALID', 'Incorrect OTP.');
  }

  await db
    .update(otp_verifications)
    .set({ verified_at: new Date() })
    .where(eq(otp_verifications.id, row.id));
}

async function deliverSms(mobileNumber: string, otp: string): Promise<void> {
  let status: 'Sent' | 'Failed' = 'Sent';
  let errorMessage: string | undefined;
  let providerMsgId: string | undefined;

  if (env.NODE_ENV !== 'production') {
    // Skip real SMS in dev/test
    console.log(`[OTP] ${mobileNumber} → ${otp}`);
  } else {
    try {
      const payload = {
        template_id: env.MSG91_TEMPLATE_ID,
        recipients: [
          {
            mobiles: mobileNumber.replace('+', ''),
            var1:    otp,
          },
        ],
      };
      console.log(JSON.stringify(payload, null, 2));
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          accept:           'application/json',
          'content-type':   'application/json',
          authkey:          env.MSG91_AUTH_KEY,
        },
        body: JSON.stringify(payload),
      });

      const responseText = await res.text();
      console.log('MSG91 Status:', res.status);
      console.log('MSG91 Response:', responseText);
      let data: { request_id?: string; message?: string; type?: string } = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { message: responseText };
      }
      if (!res.ok || data.type === 'error') {
        status       = 'Failed';
        errorMessage = data.message ?? `HTTP ${res.status}`;
      } else {
        providerMsgId = data.request_id;
      }
    } catch (err) {
      status       = 'Failed';
      errorMessage = err instanceof Error ? err.message : 'Network error';
    }
  }

  await db.insert(sms_logs).values({
    mobile_number:    mobileNumber,
    purpose:          'OTP',
    provider:         'MSG91',
    provider_msg_id:  providerMsgId,
    status,
    error_message:    errorMessage,
  });
}
