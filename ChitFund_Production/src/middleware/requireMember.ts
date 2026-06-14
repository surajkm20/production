/**
 * @fileoverview Group-membership guard middleware for the ChitFund API. For any
 * group-scoped route it reads the `:group_id` param, confirms the authenticated
 * `req.user` holds an active membership in that group, and attaches the resolved
 * `req.membership` (id, role, share/wins counts) for downstream guards and
 * controllers. It exists to enforce per-group access control in one place —
 * blocking non-members with a uniform NOT_A_MEMBER (403) error and sparing every
 * controller from repeating the same membership lookup.
 * @module middleware/requireMember
 * @author TODO
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../config/db';
import { memberships } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../utils/AppError';

/**
 * Guards group-scoped routes by confirming the caller is an active member and attaching `req.membership`; stack it after `authenticate`.
 *
 * @param req - Request providing `req.user.userId` and the `:group_id` route param; receives the resolved `req.membership`
 * @param _res - Unused response object
 * @param next - Called with no argument when an active membership exists, or a NOT_A_MEMBER `AppError` (403) otherwise
 * @returns A promise that resolves once the membership lookup completes and control has passed via `next`
 */
export async function requireMember(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.user!.userId;
  // req.params values are always strings at runtime; cast to satisfy Drizzle's eq() overload
  const groupId = req.params.group_id as string;

  const [membership] = await db
    .select({
      id: memberships.id,
      role: memberships.role,
      shareCount: memberships.share_count,
      winsCount: memberships.wins_count,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.group_id, groupId),
        eq(memberships.user_id, userId),
        eq(memberships.status, 'Active'),
      ),
    )
    .limit(1);

  if (!membership) {
    return next(new AppError(403, 'NOT_A_MEMBER', 'You are not an active member of this group.'));
  }

  req.membership = membership;
  next();
}
