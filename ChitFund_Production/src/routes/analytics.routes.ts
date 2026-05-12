// Routes for per-group analytics (all require JWT + group membership):
//   GET /groups/:group_id/analytics/overview                        [admin]
//   GET /groups/:group_id/analytics/winners-ledger
//   GET /groups/:group_id/analytics/member-balance-sheet/:user_id   (member sees own; admin sees any)
//   GET /groups/:group_id/analytics/bid-trend
//   GET /groups/:group_id/analytics/basket-growth

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireMember } from '../middleware/requireMember';
import { requireAdmin } from '../middleware/requireAdmin';
import * as analytics from '../controllers/analytics.controller';

export const analyticsRouter = Router();

analyticsRouter.use('/:group_id/analytics', authenticate, requireMember);

analyticsRouter.get('/:group_id/analytics/overview',                            requireAdmin, analytics.overview);
analyticsRouter.get('/:group_id/analytics/winners-ledger',                                    analytics.winnersLedger);
analyticsRouter.get('/:group_id/analytics/member-balance-sheet/:user_id',                     analytics.memberBalanceSheet);
analyticsRouter.get('/:group_id/analytics/bid-trend',                                         analytics.bidTrend);
analyticsRouter.get('/:group_id/analytics/basket-growth',                                     analytics.basketGrowth);
