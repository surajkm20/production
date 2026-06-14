/**
 * @fileoverview Zod request-body schemas for the authentication endpoints of the
 * ChitFund API. It validates the signup, OTP verify/resend, login, token
 * refresh, logout, and forgot/reset-password payloads, enforcing the shared
 * rules: mobile numbers in Indian E.164 form (`+91XXXXXXXXXX`), 6-digit OTPs,
 * and 8-character-minimum passwords. It exists so the `validate` middleware can
 * reject malformed auth input before it ever reaches the controllers.
 * @module validators/auth
 * @author Suraj KM
 */

import { z } from 'zod';

const E164 = /^\+91[6-9]\d{9}$/;
const mobile = z.string().regex(E164, 'Mobile must be a valid 10-digit Indian number (e.g. +919876543210)');
const otp    = z.string().length(6).regex(/^\d{6}$/, 'OTP must be exactly 6 digits');
const otpPurpose = z.enum(['signup', 'password_reset', 'admin_transfer']);

/** Validates the `POST /auth/signup` body (name, mobile, password, optional username). */
export const signupSchema = z.object({
  name:          z.string().min(1).max(100),
  mobile_number: mobile,
  password:      z.string().min(8, 'Password must be at least 8 characters'),
  username:      z.string().min(3).max(50).regex(/^\w+$/, 'Username may only contain letters, digits, and underscores').optional(),
});

/** Validates the `POST /auth/verify-otp` body (mobile, 6-digit OTP, purpose). */
export const verifyOtpSchema = z.object({
  mobile_number: mobile,
  otp,
  purpose: otpPurpose,
});

/** Validates the `POST /auth/resend-otp` body (mobile, purpose). */
export const resendOtpSchema = z.object({
  mobile_number: mobile,
  purpose:       otpPurpose,
});

/** Validates the `POST /auth/login` body (mobile-or-username identifier, password). */
export const loginSchema = z.object({
  identifier: z.string().min(1),
  password:   z.string().min(1),
});

/** Validates the `POST /auth/refresh` body (refresh token). */
export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/** Validates the `POST /auth/logout` body (refresh token to revoke). */
export const logoutSchema = z.object({
  refresh_token: z.string().min(1),
});

/** Validates the `POST /auth/forgot-password` body (mobile to send a reset OTP to). */
export const forgotPasswordSchema = z.object({
  mobile_number: mobile,
});

/** Validates the `POST /auth/reset-password` body (mobile, OTP, new password). */
export const resetPasswordSchema = z.object({
  mobile_number: mobile,
  otp,
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
});
