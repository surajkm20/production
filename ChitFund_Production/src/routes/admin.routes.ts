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
//   GET /admin/analytics/money          (Money tab — live aggregations via admin.service)
//   GET /admin/analytics/growth         (Growth tab — TODO)
//   GET /admin/analytics/engagement     (Engagement tab — TODO)
//   GET /admin/analytics/reliability    (Reliability tab — TODO)

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin';
import { moneyAnalytics, growthAnalytics, engagementAnalytics, reliabilityAnalytics } from '../controllers/admin.controller';

/** Router for SuperAdmin Admin-Console endpoints, mounted at `/admin`. */
export const adminRouter = Router();

// Every /admin route is gated: must be authenticated AND a platform SuperAdmin.
adminRouter.use(authenticate, requireSuperAdmin);

adminRouter.get('/analytics/growth',      growthAnalytics);
adminRouter.get('/analytics/money',       moneyAnalytics);
adminRouter.get('/analytics/engagement',  engagementAnalytics);
adminRouter.get('/analytics/reliability', reliabilityAnalytics);
