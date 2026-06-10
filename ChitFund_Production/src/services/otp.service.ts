// Handles OTP lifecycle: generate a 6-digit OTP, hash it, persist to otp_verifications,
// verify a submitted OTP against the hash, enforce expiry and max-attempt limits.
// Also calls the SMS provider (MSG91) to deliver the OTP. Separated from auth.service
// because OTP logic is reused across signup, login, password reset, and admin transfer.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq, and, gt, isNull, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { otp_verifications, sms_logs } from '../db/schema';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

export type OtpPurpose = 'signup' | 'password_reset' | 'admin_transfer';

// crypto.randomInt gives a cryptographically secure, unbiased integer
function generateOtp(): string {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

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
      console.log('MSG91 Request', {
        flow_id: env.HORNPAY_OTP,
        sender:  env.MSG91_SENDER_ID,
        mobiles: mobileNumber.replace('+', ''),
        var1:    otp,
      });
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: env.MSG91_AUTH_KEY,
        },
        body: JSON.stringify({
          flow_id: env.HORNPAY_OTP,
          sender:  env.MSG91_SENDER_ID,
          mobiles: mobileNumber.replace('+', ''),
          var1:    otp,
        }),
      });

      const responseText = await res.text();
      console.log('MSG91 Status:', res.status);
      console.log('MSG91 Response:', responseText);
      const data = JSON.parse(responseText) as { request_id?: string; message?: string; type?: string };
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
