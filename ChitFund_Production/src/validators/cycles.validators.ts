// Zod schemas for cycle mutation request bodies.
// GET endpoints and closeCycle (no body) have no schema.

import { z } from 'zod';

// ─── POST /cycles/:cycle_id/record-winner ─────────────────────────────────────
// bid_amount is validated as a positive integer (paise) here. The service adds
// business-rule checks (> 0, ≤ pool_amount) that depend on DB state, so those
// stay in the service and are not duplicated here.
export const recordWinnerSchema = z.object({
  winner_user_id: z.string().uuid(),
  bid_amount:     z.number().int().positive(),
  notes:          z.string().optional(),
});

// ─── POST /cycles/:cycle_id/declare-skip-month ────────────────────────────────
export const declareSkipMonthSchema = z.object({
  winner_user_id: z.string().uuid(),
  notes:          z.string().optional(),
});

// ─── PATCH /cycles/:cycle_id ──────────────────────────────────────────────────
// Edits the recorded bid within the 24-hour window. Only bid_amount is mutable
// via this endpoint; winner_user_id changes are not supported (spec §6).
export const updateCycleSchema = z.object({
  bid_amount: z.number().int().positive(),
  notes:      z.string().optional(),
});
