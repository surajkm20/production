// Zod schemas for validating loan request bodies.
// Covers: disburse loan (principal as positive paise integer, interest_rate within group bounds,
// expected_close_date as future date), record repayment (principal_repaid + interest_paid as paise).

import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format');

// ─── POST /groups/:group_id/loans ────────────────────────────────────────────
// interest_rate is inherited from the group — not accepted in the request body.
export const disburseLoanSchema = z.object({
  borrower_user_id:    z.string().uuid(),
  principal:           z.number().int().positive(),
  expected_close_date: dateString.optional(),
  notes:               z.string().optional(),
});

// ─── POST /groups/:group_id/loans/:loan_id/repay ─────────────────────────────
// Both amounts are optional individually, but at least one must be > 0.
// txn_date is required — the admin records the date the cash was received.
export const repayLoanSchema = z.object({
  principal_repaid: z.number().int().min(0).optional(),
  interest_paid:    z.number().int().min(0).optional(),
  txn_date:         dateString,
  notes:            z.string().optional(),
}).refine(
  (data) => (data.principal_repaid ?? 0) > 0 || (data.interest_paid ?? 0) > 0,
  { message: 'At least one of principal_repaid or interest_paid must be > 0.' },
);

// ─── POST /groups/:group_id/basket/adjustments ───────────────────────────────
export const basketAdjustmentSchema = z.object({
  direction: z.enum(['C', 'D']),
  amount:    z.number().int().positive(),
  notes:     z.string().min(1, 'Notes are required for a basket adjustment.'),
});

// ─── PATCH /groups/:group_id/loans/:loan_id ──────────────────────────────────
// Only two meaningful changes allowed: write-off (status = 'WrittenOff') or
// extending the expected_close_date. notes alone is rejected by the controller.
// status is a literal so the controller's INVALID_TRANSITION check is front-loaded.
export const updateLoanSchema = z.object({
  status:              z.literal('WrittenOff').optional(),
  expected_close_date: dateString.optional(),
  notes:               z.string().optional(),
}).refine(
  (data) => data.status !== undefined || data.expected_close_date !== undefined,
  { message: 'Provide status (WrittenOff) or expected_close_date to update.' },
);
