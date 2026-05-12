// Rate limiting middleware factory. Returns pre-configured limiters for specific routes.
// Used on OTP resend (1 per 30s, 5 per hour) and general API abuse prevention.
// Built on top of express-rate-limit.

import { rateLimit } from 'express-rate-limit';

// General API limiter: 100 req / 15 min per IP.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: () => process.env.NODE_ENV !== 'production',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } },
});

// OTP send/resend limiter: 5 OTPs / 1 hour per mobile number (keyed by body.mobile_number).
// Used on POST /auth/signup, POST /auth/login, POST /auth/resend-otp.
export const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.body as { mobile_number?: string }).mobile_number ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'OTP_RATE_LIMITED', message: 'Too many OTP requests. Try again in an hour.' } },
});
