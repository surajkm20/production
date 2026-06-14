/**
 * @fileoverview HTTP layer for the SuperAdmin Admin Console analytics endpoints.
 * Controllers here are thin: they parse query params, delegate to the admin service,
 * and send the standard response envelope. All routes are already gated by
 * `authenticate + requireSuperAdmin` in the router, so no auth checks belong here.
 * @module controllers/admin
 * @author Suraj KM
 */

import { Request, Response, NextFunction } from 'express';
import { getMoneyAnalytics } from '../services/admin.service';
import { sendSuccess } from '../utils/response';

/**
 * Handles GET /admin/analytics/money — returns platform-wide Money tab aggregations.
 *
 * @param req - Request with optional `?range=24h|7d|30d|90d|all` query param (default `30d`)
 * @param res - Response carrying the Money tab payload
 * @param next - Forwards AppError(400 INVALID_RANGE) or unexpected errors
 */
export async function moneyAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const range = (req.query.range as string) || '30d';
    const data  = await getMoneyAnalytics(range);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
