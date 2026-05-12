// Zod schemas for validating payment request bodies.
// Covers: mark payment (status enum, paid_amount as positive integer paise, paid_at as ISO datetime),
// bulk-update (payment_ids array or "all_unpaid" literal).

import { z } from 'zod';

// ─── PATCH /groups/:group_id/payments/:payment_id ────────────────────────────
// All fields optional — caller sends only what changed.
// paid_amount min is 0 (Unpaid resets it to 0; Waived leaves it).
// paid_at uses z.string().datetime() which validates full ISO 8601 format.
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
export const remindDefaultersSchema = z.object({
  channels: z.array(z.enum(['push', 'sms'])).min(1).optional(),
});
