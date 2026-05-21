// Handles HTTP layer for group lifecycle endpoints.
// Extracts group_id from req.params, body from req.body, caller from req.user.
// All business logic lives in groups.service.ts.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendCreated } from '../utils/response';
import * as GroupsService from '../services/groups.service';
import * as ActivityService from '../services/activity.service';

export async function createGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await GroupsService.createGroup(req.user!.userId, req.body);
    sendCreated(res, result);
  } catch (err) { next(err); }
}

export async function listGroups(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { role, status, q, cursor, limit: limitStr } = req.query as Record<string, string | undefined>;
    const result = await GroupsService.listGroups(req.user!.userId, {
      role, status, q, cursor, limit: limitStr ? parseInt(limitStr, 10) : undefined,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function joinGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await GroupsService.joinGroup(req.user!.userId, req.body.invitation_code, req.body.requested_share_count ?? 1);
    sendCreated(res, result);
  } catch (err) { next(err); }
}

export async function getGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.getGroup(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.updateGroup(req.user!.userId, group_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function startGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.startGroup(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function closeGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.closeGroup(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function rotateInvitationCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.rotateInvitationCode(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function forceDeleteGroup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await GroupsService.forceDeleteGroup(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getGroupActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const result = await ActivityService.getGroupActivity(req.user!.userId, group_id, limit);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
