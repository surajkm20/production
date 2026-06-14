/**
 * @fileoverview Authentication route definitions for the ChitFund API. It wires
 * up the public, JWT-free auth flow — signup with OTP verification, login,
 * token refresh, logout, and password reset — attaching the appropriate rate
 * limiters and Zod validators to each endpoint before delegating to the auth
 * controller. It exists to declare the full set of credential and session
 * endpoints in one place and to enforce abuse protection (OTP/login throttling)
 * and input validation at the route boundary.
 * @module routes/auth
 * @author Suraj KM
 */

// Routes for authentication endpoints (all public — no JWT required):
//   POST /auth/signup
//   POST /auth/verify-otp
//   POST /auth/resend-otp
//   POST /auth/login
//   POST /auth/refresh
//   POST /auth/logout
//   POST /auth/forgot-password
//   POST /auth/reset-password

import { Router } from 'express';
import { otpLimiter, loginLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  signupSchema, verifyOtpSchema, resendOtpSchema, loginSchema,
  refreshSchema, logoutSchema, forgotPasswordSchema, resetPasswordSchema,
} from '../validators/auth.validators';
import * as auth from '../controllers/auth.controller';

/** Router for public authentication endpoints, mounted at `/auth`. */
export const authRouter = Router();

authRouter.post('/signup',          otpLimiter, validate(signupSchema),          auth.signup);
authRouter.post('/verify-otp',                  validate(verifyOtpSchema),        auth.verifyOtp);
authRouter.post('/resend-otp',      otpLimiter, validate(resendOtpSchema),        auth.resendOtp);
authRouter.post('/login',           loginLimiter, validate(loginSchema),            auth.login);
authRouter.post('/refresh',                     validate(refreshSchema),           auth.refresh);
authRouter.post('/logout',                      validate(logoutSchema),            auth.logout);
authRouter.post('/forgot-password', otpLimiter, validate(forgotPasswordSchema),   auth.forgotPassword);
authRouter.post('/reset-password',              validate(resetPasswordSchema),     auth.resetPassword);
