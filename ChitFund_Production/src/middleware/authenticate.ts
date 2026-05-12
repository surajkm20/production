// JWT authentication middleware. Runs on every protected route.
// Reads the Authorization: Bearer <token> header, verifies the JWT signature and expiry,
// and attaches the decoded payload as req.user = { userId, ... }.
// Throws UNAUTHENTICATED (401) if the token is missing, malformed, or expired.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

interface JwtPayload {
  userId: string;
  jti: string;
}

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
