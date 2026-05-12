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
import { otpLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  signupSchema, verifyOtpSchema, resendOtpSchema, loginSchema,
  refreshSchema, logoutSchema, forgotPasswordSchema, resetPasswordSchema,
} from '../validators/auth.validators';
import * as auth from '../controllers/auth.controller';

export const authRouter = Router();

authRouter.post('/signup',          otpLimiter, validate(signupSchema),          auth.signup);
authRouter.post('/verify-otp',                  validate(verifyOtpSchema),        auth.verifyOtp);
authRouter.post('/resend-otp',      otpLimiter, validate(resendOtpSchema),        auth.resendOtp);
authRouter.post('/login',                       validate(loginSchema),             auth.login);
authRouter.post('/refresh',                     validate(refreshSchema),           auth.refresh);
authRouter.post('/logout',                      validate(logoutSchema),            auth.logout);
authRouter.post('/forgot-password', otpLimiter, validate(forgotPasswordSchema),   auth.forgotPassword);
authRouter.post('/reset-password',              validate(resetPasswordSchema),     auth.resetPassword);
