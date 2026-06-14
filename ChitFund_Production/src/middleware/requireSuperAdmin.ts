/**
 * @fileoverview Platform-level SuperAdmin guard for the ChitFund Admin Console.
 * It loads the authenticated caller's `users.role` and allows the request through
 * only when it equals `'SuperAdmin'`, otherwise rejecting with a uniform
 * FORBIDDEN_SUPERADMIN_ONLY (403) error. It exists to protect the cross-group
 * `/admin/*` analytics endpoints — a boundary distinct from the per-group
 * `requireAdmin` guard (which reads `memberships.role`). Stack it after
 * `authenticate`, which populates `req.user`.
 * @module middleware/requireSuperAdmin
 * @author Suraj KM
 */

import { Request, Response, NextFunction } from 'express';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../config/db';
import { users } from '../db/schema';
import { AppError } from '../utils/AppError';

/**
 * Restricts a route to platform SuperAdmins by checking `users.role`; stack it after `authenticate`.
 *
 * @param req - Request providing `req.user.userId`; receives the resolved `req.user.role` on success
 * @param _res - Unused response object
 * @param next - Called with no argument for SuperAdmins, or a FORBIDDEN_SUPERADMIN_ONLY `AppError` (403) otherwise
 * @returns A promise that resolves once the role lookup completes and control has passed via `next`
 */
export async function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;

    const [row] = await db
      .select({ role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deleted_at)))
      .limit(1);

    if (!row || row.role !== 'SuperAdmin') {
      return next(new AppError(403, 'FORBIDDEN_SUPERADMIN_ONLY', 'This action requires platform SuperAdmin access.'));
    }

    // Surface the resolved role for downstream controllers that want it.
    req.user!.role = row.role;
    next();
  } catch (err) {
    next(err);
  }
}
