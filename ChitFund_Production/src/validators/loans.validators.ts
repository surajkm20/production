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
// idempotency_key is optional — a client-generated UUID. If provided and the same
// request was already processed successfully, the cached response is returned.
export const repayLoanSchema = z.object({
  principal_repaid: z.number().int().min(0).optional(),
  interest_paid:    z.number().int().min(0).optional(),
  txn_date:         dateString,
  cycle_id:         z.string().uuid().optional(),
  notes:            z.string().optional(),
  idempotency_key:  z.string().uuid('idempotency_key must be a valid UUID').optional(),
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

// ─── POST /groups/:group_id/loans/bulk-repay ─────────────────────────────────
export const bulkRepaySchema = z.object({
  member_user_id:  z.string().uuid(),
  mode:            z.enum(['interest_only', 'principal_only', 'full_settlement']),
  idempotency_key: z.string().uuid('idempotency_key must be a valid UUID').optional(),
});

// ─── PATCH /groups/:group_id/loans/:loan_id ──────────────────────────────────
// Allowed changes:
//   - status = 'WrittenOff'           → write off the loan
//   - principal (positive paise int)  → correct the disbursed principal
//   - expected_close_date             → extend / set the due date
//   - notes                           → update notes (can be standalone)
// At least one field must be present.
export const updateLoanSchema = z.object({
  status:              z.literal('WrittenOff').optional(),
  principal:           z.number().int().positive().optional(),
  expected_close_date: dateString.optional(),
  notes:               z.string().optional(),
}).refine(
  (data) => data.status !== undefined || data.principal !== undefined || data.expected_close_date !== undefined || data.notes !== undefined,
  { message: 'Provide at least one field to update (status, principal, expected_close_date, or notes).' },
);
