/**
 * @fileoverview Zod request-body schemas for the payment-tracking endpoints of
 * the ChitFund API — update a single payment, bulk-mark payments, and remind
 * defaulters. It validates the status enum (Paid/Unpaid/Waived), amounts as
 * integer paise, timestamps as full ISO 8601, and the bulk `payment_ids` union
 * (an array of UUIDs or the `'all_unpaid'` sentinel the service expands). The
 * update schema also requires at least one field so no-op PATCHes are rejected.
 * @module validators/payments
 * @author Suraj KM
 */

import { z } from 'zod';

// ─── PATCH /groups/:group_id/payments/:payment_id ────────────────────────────
// All fields optional — caller sends only what changed.
// paid_amount min is 0 (Unpaid resets it to 0; Waived leaves it).
// paid_at uses z.string().datetime() which validates full ISO 8601 format.
/** Validates the update-payment body (optional status/amount/paid-at/notes — at least one required). */
export const updatePaymentSchema = z.object({
  status:      z.enum(['Paid', 'Unpaid', 'Waived']).optional(),
  paid_amount: z.number().int().min(0).optional(),
  paid_at:     z.string().datetime({ offset: true }).optional(),
  notes:       z.string().optional(),
}).refine(
  (data) => data.status !== undefined || data.paid_amount !== undefined || data.notes !== undefined,
  { message: 'At least one field must be provided.' },
);

// ─── POST /groups/:group_id/cycles/:cycle_id/payments/bulk ───────────────────
// payment_ids is a union: either an array of UUIDs (min 1) or the sentinel
// string "all_unpaid" which the controller resolves to all Unpaid IDs in the cycle.
/** Validates the bulk-mark-payments body (payment id array or `'all_unpaid'`, target status, optional paid-at). */
export const bulkMarkPaymentsSchema = z.object({
  payment_ids: z.union([
    z.array(z.string().uuid()).min(1, 'payment_ids array must contain at least one ID'),
    z.literal('all_unpaid'),
  ]),
  status:  z.enum(['Paid', 'Unpaid', 'Waived']),
  paid_at: z.string().datetime({ offset: true }).optional(),
});

// ─── POST /groups/:group_id/cycles/:cycle_id/remind-defaulters ───────────────
// channels defaults to ['push'] in the controller if omitted.
/** Validates the remind-defaulters body (optional push/sms channels). */
export const remindDefaultersSchema = z.object({
  channels: z.array(z.enum(['push', 'sms'])).min(1).optional(),
});
