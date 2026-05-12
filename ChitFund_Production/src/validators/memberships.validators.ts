// Zod schemas for membership mutation request bodies.
// initiateTransferAdmin and confirmTransferAdmin have no body / are a stub — no schema.

import { z } from 'zod';

// ─── POST /groups/:group_id/members ───────────────────────────────────────────
// mobile_number regex mirrors the E.164 check in addMember service so the
// error is surfaced before any DB work rather than inside the transaction.
export const addMemberSchema = z.object({
  name:          z.string().min(1).max(100),
  mobile_number: z.string().regex(/^\+\d{10,15}$/, 'mobile_number must be in E.164 format (e.g. +919812345678)'),
  share_count:   z.number().int().min(1).optional(),
});

// ─── PATCH /groups/:group_id/members/:membership_id ───────────────────────────
// Only share_count is mutable via this endpoint (spec §5).
export const updateMemberSchema = z.object({
  share_count: z.number().int().min(1),
});

// ─── DELETE /groups/:group_id/members/:membership_id ─────────────────────────
// confirm_active_cycle: the service requires this to be true when the group has
// an active cycle — the validator just ensures the type is correct if sent.
export const removeMemberSchema = z.object({
  reason:               z.string().optional(),
  confirm_active_cycle: z.boolean().optional(),
});

// ─── POST /groups/:group_id/members/:membership_id/remind ────────────────────
export const remindMemberSchema = z.object({
  channels: z.array(z.enum(['push', 'sms'])).min(1).optional(),
  message:  z.string().optional(),
});

// ─── POST /groups/:group_id/transfer-admin/:transfer_id/confirm ───────────────
export const confirmTransferAdminSchema = z.object({
  otp: z.string().length(6).regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

// ─── POST /groups/:group_id/join-requests/:membership_id/approve ─────────────
// share_count is optional — if omitted, the requested_share_count is used as-is.
export const approveJoinRequestSchema = z.object({
  share_count: z.number().int().min(1).optional(),
});

// ─── POST /groups/:group_id/join-requests/:membership_id/reject ──────────────
export const rejectJoinRequestSchema = z.object({
  reason: z.string().optional(),
});
