/**
 * @fileoverview Pre-configured rate limiters for the ChitFund API, built on
 * `express-rate-limit`. It bundles a general IP-based API limiter alongside
 * abuse-specific limiters keyed by mobile number for OTP issuance and login
 * attempts. It exists to protect sensitive auth flows from brute-force and
 * spam — capping password guessing and SMS/OTP costs — while keeping all
 * throttling policy in one place so routes can simply import and apply the
 * limiter they need.
 * @module middleware/rateLimiter
 * @author TODO
 */

import { rateLimit } from 'express-rate-limit';

/**
 * General-purpose IP-based limiter (500 requests / 15 min) for blanket API abuse prevention; disabled outside production.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  skip: () => process.env.NODE_ENV !== 'production',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } },
});

/**
 * Caps OTP issuance at 5 / hour per mobile number; apply to `POST /auth/signup`, `/auth/resend-otp`, and `/auth/forgot-password`.
 */
export const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.body as { mobile_number?: string }).mobile_number ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'OTP_RATE_LIMITED', message: 'Too many OTP requests. Try again in an hour.' } },
});

/**
 * Throttles password guessing at 10 attempts / 15 min per mobile number; apply to `POST /auth/login`.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body as { mobile_number?: string }).mobile_number ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' } },
});
