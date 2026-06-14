/**
 * @fileoverview JWT authentication middleware for the ChitFund API. Verifies the
 * incoming `Authorization: Bearer <token>` header, validates the access token's
 * signature and expiry, and attaches the decoded identity to `req.user` so that
 * downstream guards and controllers can trust the caller. It exists to centralise
 * token verification in one place, ensuring every protected route enforces
 * authentication consistently and rejects missing, malformed, or expired tokens
 * with a uniform UNAUTHENTICATED (401) error.
 * @module middleware/authenticate
 * @author TODO
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

interface JwtPayload {
  userId: string;
  jti: string;
}

/**
 * Guards protected routes by verifying the Bearer JWT and attaching `req.user`.
 *
 * @param req - Incoming request; reads the `Authorization: Bearer <token>` header and sets `req.user`
 * @param _res - Unused response object
 * @param next - Called with no argument on success, or an UNAUTHENTICATED `AppError` (401) when the token is missing, malformed, or expired
 * @returns Nothing; control passes via `next`
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Access token is required.'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    req.user = { userId: payload.userId, jti: payload.jti };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'UNAUTHENTICATED', 'Access token has expired.'));
    }
    next(new AppError(401, 'UNAUTHENTICATED', 'Invalid access token.'));
  }
}
