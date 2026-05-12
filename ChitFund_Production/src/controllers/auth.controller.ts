// Handles HTTP layer for authentication requests.
// Extracts and validates fields from req.body, calls auth.service / otp.service,
// and sends back the standard { data: ... } response envelope.
// No business logic here — if it can't fit in a line, it belongs in the service.

import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/auth.service';
import * as otpService from '../services/otp.service';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import {
  signupSchema,
  verifyOtpSchema,
  resendOtpSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/auth.validators';

export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body   = signupSchema.parse(req.body);
    const result = await authService.signup(body);
    sendCreated(res, result);
  } catch (err) {
    next(err);
  }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mobile_number, otp, purpose } = verifyOtpSchema.parse(req.body);
    const deviceInfo = req.headers['user-agent'];

    if (purpose === 'signup') {
      const result = await authService.verifySignupOtp(mobile_number, otp, deviceInfo);
      sendSuccess(res, result);
      return;
    }

    // password_reset and admin_transfer: mark OTP as verified, caller proceeds independently
    await otpService.verifyOtp(mobile_number, otp, purpose);
    sendSuccess(res, { success: true });
  } catch (err) {
    next(err);
  }
}

export async function resendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mobile_number, purpose } = resendOtpSchema.parse(req.body);
    const { otp_expires_at }         = await otpService.sendOtp(mobile_number, purpose);
    const next_resend_at             = new Date(Date.now() + 30 * 1000); // 30-second cooldown
    sendSuccess(res, { otp_sent: true, otp_expires_at, next_resend_at });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { identifier, password } = loginSchema.parse(req.body);
    const deviceInfo               = req.headers['user-agent'];
    const result                   = await authService.login(identifier, password, deviceInfo);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refresh_token } = refreshSchema.parse(req.body);
    const result            = await authService.refreshAccessToken(refresh_token);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refresh_token } = logoutSchema.parse(req.body);
    await authService.logout(refresh_token);
    sendNoContent(res);
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mobile_number } = forgotPasswordSchema.parse(req.body);
    const result            = await authService.forgotPassword(mobile_number);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { mobile_number, otp, new_password } = resetPasswordSchema.parse(req.body);
    const result = await authService.resetPassword(mobile_number, otp, new_password);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
