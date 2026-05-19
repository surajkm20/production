// Zod schemas for validating auth request bodies.
// Covers: signup, verify-otp, resend-otp, login, refresh, forgot-password, reset-password.
// Mobile number must match E.164 format (+91XXXXXXXXXX). Password minimum 8 characters.

import { z } from 'zod';

const E164 = /^\+91[6-9]\d{9}$/;
const mobile = z.string().regex(E164, 'Mobile must be a valid 10-digit Indian number (e.g. +919876543210)');
const otp    = z.string().length(6).regex(/^\d{6}$/, 'OTP must be exactly 6 digits');
const otpPurpose = z.enum(['signup', 'password_reset', 'admin_transfer']);

export const signupSchema = z.object({
  name:          z.string().min(1).max(100),
  mobile_number: mobile,
  password:      z.string().min(8, 'Password must be at least 8 characters'),
  username:      z.string().min(3).max(50).regex(/^\w+$/, 'Username may only contain letters, digits, and underscores').optional(),
});

export const verifyOtpSchema = z.object({
  mobile_number: mobile,
  otp,
  purpose: otpPurpose,
});

export const resendOtpSchema = z.object({
  mobile_number: mobile,
  purpose:       otpPurpose,
});

export const loginSchema = z.object({
  identifier: z.string().min(1),
  password:   z.string().min(1),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export const logoutSchema = z.object({
  refresh_token: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  mobile_number: mobile,
});

export const resetPasswordSchema = z.object({
  mobile_number: mobile,
  otp,
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
});
