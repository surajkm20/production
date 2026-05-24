// Zod schemas for membership mutation request bodies.
// initiateTransferAdmin and confirmTransferAdmin have no body / are a stub — no schema.

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

export const addMemberSchema = z.object({
  name:          z.string().min(1).max(100),
  mobile_number: normaliseMobile,
  share_count:   z.number().int().min(1).optional(),
});

// ─── PATCH /groups/:group_id/members/:membership_id ───────────────────────────
// Only share_count is mutable via this endpoint (spec §5).
// min(0) because the admin may set their own share_count to 0 (organizer-only role).
// The service enforces that only Admin role may reach 0.
export const updateMemberSchema = z.object({
  share_count: z.number().int().min(0),
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
