// Handles HTTP layer for report endpoints.
// Currently returns JSON. To stream PDF/Excel files:
//   npm install pdfkit exceljs && npm install -D @types/pdfkit
// Then replace sendSuccess(res, data) with file streaming using res.setHeader + res.send/pipe.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/response';
import * as ReportsService from '../services/reports.service';

export async function groupLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const data = await ReportsService.getGroupLedger(req.user!.userId, group_id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function cycleSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const cycle_id = req.params.cycle_id as string;
    const data = await ReportsService.getCycleSummary(req.user!.userId, group_id, cycle_id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function memberHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id       = req.params.group_id as string;
    const target_user_id = req.params.user_id  as string;
    const data = await ReportsService.getMemberHistory(req.user!.userId, group_id, target_user_id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function closureReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const data = await ReportsService.getClosureReport(req.user!.userId, group_id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function loanRegister(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const data = await ReportsService.getLoanRegister(req.user!.userId, group_id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
