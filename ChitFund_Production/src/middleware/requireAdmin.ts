// Admin role guard middleware. Runs after requireMember on admin-only routes.
// Checks that req.membership.role === 'Admin'.
// Throws ADMIN_ONLY (403) if the caller is a regular member.
// Always stack after requireMember — this middleware assumes req.membership is already set.

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.membership?.role !== 'Admin') {
    return next(new AppError(403, 'ADMIN_ONLY', 'This action requires admin role.'));
  }
  next();
}
