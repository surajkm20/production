// Group membership guard middleware. Runs after authenticate on all group-scoped routes.
// Reads :group_id from req.params, queries the memberships table to confirm req.user
// is an active member of that group, and attaches req.membership to the request.
// Throws NOT_A_MEMBER (403) if no active membership is found.

import { Request, Response, NextFunction } from 'express';
import { db } from '../config/db';
import { memberships } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../utils/AppError';

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
