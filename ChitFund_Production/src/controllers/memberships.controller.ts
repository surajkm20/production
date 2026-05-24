// Handles HTTP layer for group membership endpoints.
// Extracts group_id / membership_id from req.params, body from req.body, caller from req.user.
// All business logic lives in memberships.service.ts.

import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendCreated } from '../utils/response';
import * as MembershipsService from '../services/memberships.service';

export async function listMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const { status, q } = req.query as Record<string, string | undefined>;
    const result = await MembershipsService.listMembers(req.user!.userId, group_id, { status, q });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function addMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await MembershipsService.addMember(req.user!.userId, group_id, req.body);
    sendCreated(res, result);
  } catch (err) { next(err); }
}

export async function updateMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.updateMember(req.user!.userId, group_id, membership_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.removeMember(req.user!.userId, group_id, membership_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function initiateTransferAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.initiateTransferAdmin(req.user!.userId, group_id, membership_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function confirmTransferAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transfer_id = req.params.transfer_id as string;
    const result = await MembershipsService.confirmTransferAdmin(transfer_id, req.body.otp, req.user!.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function listJoinRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id = req.params.group_id as string;
    const result = await MembershipsService.listJoinRequests(req.user!.userId, group_id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function approveJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.approveJoinRequest(req.user!.userId, group_id, membership_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function rejectJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.rejectJoinRequest(req.user!.userId, group_id, membership_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getMemberWins(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MembershipsService.getMemberWins(
      req.user!.userId,
      req.params.group_id as string,
      req.params.user_id  as string,
    )
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

export async function updateMemberProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id       = req.params.group_id    as string;
    const target_user_id = req.params.user_id     as string;
    const result = await MembershipsService.updateMemberProfile(req.user!.userId, group_id, target_user_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function remindMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group_id      = req.params.group_id      as string;
    const membership_id = req.params.membership_id as string;
    const result = await MembershipsService.remindMember(req.user!.userId, group_id, membership_id, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
