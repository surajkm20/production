// Handles HTTP layer for payment endpoints.
// Extracts group_id / cycle_id / payment_id from req.params, body from req.body, caller from req.user.
// All business logic lives in payments.service.ts.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/response';
import * as PaymentsService from '../services/payments.service';

export async function listPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const { status } = req.query as Record<string, string | undefined>;
    const result = await PaymentsService.listPayments(req.user!.userId, group_id, cycle_id, { status });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updatePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id   = req.params.group_id   as string;
    const payment_id = req.params.payment_id as string;
    const result = await PaymentsService.updatePayment(req.user!.userId, group_id, payment_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function bulkMarkPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await PaymentsService.bulkMarkPayments(req.user!.userId, group_id, cycle_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function remindDefaulters(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await PaymentsService.remindDefaulters(req.user!.userId, group_id, cycle_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function memberPaymentHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id       = req.params.group_id as string;
    const target_user_id = req.params.user_id  as string;
    const result = await PaymentsService.memberPaymentHistory(req.user!.userId, group_id, target_user_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
