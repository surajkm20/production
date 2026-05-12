// Handles HTTP layer for basket overview, ledger transactions, and loan lifecycle.
// Extracts group_id / loan_id from req.params, body from req.body, caller from req.user.
// All business logic lives in basket.service.ts.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendCreated } from '../utils/response';
import * as BasketService from '../services/basket.service';

export async function getBasket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await BasketService.getBasket(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function listTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const { type, cycle_id, from, to, cursor, limit: limitStr } = req.query as Record<string, string | undefined>;
    const result = await BasketService.listTransactions(req.user!.userId, group_id, {
      type, cycle_id, from, to, cursor, limit: limitStr ? parseInt(limitStr, 10) : undefined,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function recordAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await BasketService.recordAdjustment(req.user!.userId, group_id, req.body);
    sendCreated(res, result);
  } catch (err) { next(err); }
}

export async function disburseLoan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await BasketService.disburseLoan(req.user!.userId, group_id, req.body);
    sendCreated(res, result);
  } catch (err) { next(err); }
}

export async function listLoans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const { status, borrower_user_id } = req.query as Record<string, string | undefined>;
    const result = await BasketService.listLoans(req.user!.userId, group_id, { status, borrower_user_id });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getLoan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const loan_id  = req.params.loan_id  as string;
    const result = await BasketService.getLoan(req.user!.userId, group_id, loan_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function repayLoan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const loan_id  = req.params.loan_id  as string;
    const result = await BasketService.repayLoan(req.user!.userId, group_id, loan_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateLoan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const loan_id  = req.params.loan_id  as string;
    const result = await BasketService.updateLoan(req.user!.userId, group_id, loan_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
