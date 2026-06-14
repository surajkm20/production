/**
 * @fileoverview SuperAdmin Admin-Console route definitions for the ChitFund API.
 * It mounts the platform-wide, cross-group analytics endpoints under `/admin`,
 * every one guarded by `authenticate` then `requireSuperAdmin` so only users with
 * `users.role = 'SuperAdmin'` can reach them. It exists to keep the platform-owner
 * surface isolated from the per-group consumer API; in v1 these endpoints back a
 * guarded `/admin` route inside the existing PWA (see requirements §8.1).
 * @module routes/admin
 * @author Suraj KM
 */

// Routes for the SuperAdmin Admin Console (all require JWT + users.role = 'SuperAdmin'):
//   GET /admin/analytics/money          (Money tab — placeholder until Step 1 lands the aggregations)
//   GET /admin/analytics/growth         (Growth tab — TODO)
//   GET /admin/analytics/engagement     (Engagement tab — TODO)
//   GET /admin/analytics/reliability    (Reliability tab — TODO)

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin';
import { sendSuccess } from '../utils/response';

/** Router for SuperAdmin Admin-Console endpoints, mounted at `/admin`. */
export const adminRouter = Router();

// Every /admin route is gated: must be authenticated AND a platform SuperAdmin.
adminRouter.use(authenticate, requireSuperAdmin);

// Placeholder so the SuperAdmin security boundary is wired and testable now.
// Replaced by the real Money-tab aggregation controller in the next step.
adminRouter.get('/analytics/money', (_req: Request, res: Response) => {
  sendSuccess(res, { tab: 'money', status: 'not_implemented' });
});
