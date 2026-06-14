/**
 * @fileoverview Zod request-body schemas for the membership endpoints of the
 * ChitFund API — add member, update share count, remove member, remind, confirm
 * admin transfer, approve/reject join requests, and edit a member's profile. It
 * normalises loosely-formatted mobile numbers (bare 10-digit and `91`-prefixed
 * forms) to Indian E.164 before validating, and enforces cross-field rules such
 * as requiring at least one of name/phone on a profile edit. State-dependent
 * checks (e.g. the active-cycle removal confirmation) live in the service.
 * @module validators/memberships
 * @author Suraj KM
 */

import { z } from 'zod';

// ─── POST /groups/:group_id/members ───────────────────────────────────────────
// Normalises mobile_number before validation:
//   9876543210      → +919876543210  (bare 10-digit Indian number)
//   919876543210    → +919876543210  (91-prefixed without +)
//   +919876543210   → +919876543210  (already correct, left unchanged)
// Anything else is rejected with a clear error.
const normaliseMobile = z
  .string()
  .transform((val) => {
    const stripped = val.replace(/\s+/g, '');
    if (stripped.startsWith('+')) return stripped;            // already has +, pass through
    if (/^91[6-9]\d{9}$/.test(stripped)) return '+' + stripped; // 91XXXXXXXXXX → +91XXXXXXXXXX
    if (/^[6-9]\d{9}$/.test(stripped)) return '+91' + stripped; // XXXXXXXXXX   → +91XXXXXXXXXX
    return stripped; // unrecognised — pass through and let .regex() reject it
  })
  .pipe(z.string().regex(/^\+91[6-9]\d{9}$/, 'mobile_number must be a valid 10-digit Indian number (e.g. 9876543210 or +919876543210)'));

/** Validates the add-member body (name, normalised Indian mobile, optional share count). */
export const addMemberSchema = z.object({
  name:          z.string().min(1).max(100),
  mobile_number: normaliseMobile,
  share_count:   z.number().int().min(1).optional(),
});

// ─── PATCH /groups/:group_id/members/:membership_id ───────────────────────────
// Only share_count is mutable via this endpoint (spec §5).
// min(0) because the admin may set their own share_count to 0 (organizer-only role).
// The service enforces that only Admin role may reach 0.
/** Validates the update-member body (share_count; 0 allowed, but only for the admin per service rules). */
export const updateMemberSchema = z.object({
  share_count: z.number().int().min(0),
});

// ─── DELETE /groups/:group_id/members/:membership_id ─────────────────────────
// confirm_active_cycle: the service requires this to be true when the group has
// an active cycle — the validator just ensures the type is correct if sent.
/** Validates the remove-member body (optional reason and active-cycle confirmation flag). */
export const removeMemberSchema = z.object({
  reason:               z.string().optional(),
  confirm_active_cycle: z.boolean().optional(),
});

// ─── POST /groups/:group_id/members/:membership_id/remind ────────────────────
/** Validates the remind-member body (optional push/sms channels and custom message). */
export const remindMemberSchema = z.object({
  channels: z.array(z.enum(['push', 'sms'])).min(1).optional(),
  message:  z.string().optional(),
});

// ─── POST /groups/:group_id/transfer-admin/:transfer_id/confirm ───────────────
/** Validates the confirm-admin-transfer body (6-digit OTP). */
export const confirmTransferAdminSchema = z.object({
  otp: z.string().length(6).regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

// ─── POST /groups/:group_id/join-requests/:membership_id/approve ─────────────
// share_count is optional — if omitted, the requested_share_count is used as-is.
/** Validates the approve-join-request body (optional override share count). */
export const approveJoinRequestSchema = z.object({
  share_count: z.number().int().min(1).optional(),
});

// ─── POST /groups/:group_id/join-requests/:membership_id/reject ──────────────
/** Validates the reject-join-request body (optional reason). */
export const rejectJoinRequestSchema = z.object({
  reason: z.string().optional(),
});

// ─── PATCH /groups/:group_id/members/:user_id/profile ────────────────────────
// At least one of name or phone is required (enforced via .refine).
// phone accepts the same normalisation as addMemberSchema and must be a valid Indian number.
/** Validates the update-member-profile body (optional name and/or normalised phone — at least one required). */
export const updateMemberProfileSchema = z
  .object({
    name:  z.string().trim().min(1).max(100).optional(),
    phone: normaliseMobile.optional(),
  })
  .refine((d) => d.name !== undefined || d.phone !== undefined, {
    message: 'At least one of name or phone must be provided.',
  });
