/**
 * @fileoverview Admin role-guard middleware for the ChitFund API. It checks that
 * the caller's resolved group membership (`req.membership`, set by `requireMember`)
 * carries the `Admin` role before allowing admin-only actions to proceed. It
 * exists to enforce the group's single-admin authorisation boundary at the route
 * layer, rejecting regular members with a uniform ADMIN_ONLY (403) error so that
 * privileged operations cannot be invoked by ordinary participants.
 * @module middleware/requireAdmin
 * @author TODO
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';

/**
 * Restricts a route to group admins; always stack it after `requireMember`, which populates `req.membership`.
 *
 * @param req - Request whose `req.membership.role` must equal `'Admin'`
 * @param _res - Unused response object
 * @param next - Called with no argument for admins, or an ADMIN_ONLY `AppError` (403) for regular members
 * @returns Nothing; control passes via `next`
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.membership?.role !== 'Admin') {
    return next(new AppError(403, 'ADMIN_ONLY', 'This action requires admin role.'));
  }
  next();
}
