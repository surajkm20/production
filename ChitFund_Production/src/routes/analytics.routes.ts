/**
 * @fileoverview Per-group analytics route definitions for the ChitFund API. It
 * exposes read-only reporting endpoints — group overview, winners ledger, member
 * balance sheet, bid trend, and basket growth — all guarded by JWT authentication
 * and active group membership. It exists to give members and admins aggregated
 * insight into a group's financial activity while keeping the access-control
 * boundary (authenticate + requireMember) applied uniformly to every analytics
 * route.
 * @module routes/analytics
 * @author Suraj KM
 */

// Routes for per-group analytics (all require JWT + group membership):
//   GET /groups/:group_id/analytics/overview
//   GET /groups/:group_id/analytics/winners-ledger
//   GET /groups/:group_id/analytics/member-balance-sheet/:user_id   (member sees own; admin sees any)
//   GET /groups/:group_id/analytics/bid-trend
//   GET /groups/:group_id/analytics/basket-growth

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';

import * as analytics from '../controllers/analytics.controller';

/** Router for per-group analytics endpoints, mounted under `/groups`. */
export const analyticsRouter = Router();

analyticsRouter.use('/:group_id/analytics', authenticate, requireMember);

analyticsRouter.get('/:group_id/analytics/overview',                                          analytics.overview);
analyticsRouter.get('/:group_id/analytics/winners-ledger',                                    analytics.winnersLedger);
analyticsRouter.get('/:group_id/analytics/member-balance-sheet/:user_id',                     analytics.memberBalanceSheet);
analyticsRouter.get('/:group_id/analytics/bid-trend',                                         analytics.bidTrend);
analyticsRouter.get('/:group_id/analytics/basket-growth',                                     analytics.basketGrowth);
