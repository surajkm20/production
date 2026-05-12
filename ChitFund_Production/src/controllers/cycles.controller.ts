// Handles HTTP layer for monthly cycle endpoints.
// Extracts group_id / cycle_id from req.params, body from req.body, caller from req.user.
// All business logic lives in cycles.service.ts.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/response';
import * as CyclesService from '../services/cycles.service';

export async function listCycles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const { status } = req.query as Record<string, string | undefined>;
    const result = await CyclesService.listCycles(req.user!.userId, group_id, { status });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getCycle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await CyclesService.getCycle(req.user!.userId, group_id, cycle_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function recordWinner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await CyclesService.recordWinner(req.user!.userId, group_id, cycle_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function declareSkipMonth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await CyclesService.declareSkipMonth(req.user!.userId, group_id, cycle_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateCycle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await CyclesService.updateCycle(req.user!.userId, group_id, cycle_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function closeCycle(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const result = await CyclesService.closeCycle(req.user!.userId, group_id, cycle_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
