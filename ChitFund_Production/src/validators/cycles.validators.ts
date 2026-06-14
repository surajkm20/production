/**
 * @fileoverview Zod request-body schemas for the monthly-cycle mutation endpoints
 * of the ChitFund API — record winner, declare skip month, edit the bid within
 * the 24-hour window, and correct a closed cycle. It validates only the
 * structural shape (UUIDs, integer paise, bounds); business rules that depend on
 * DB state (bid ≤ pool, winner eligibility) intentionally live in the service.
 * GET endpoints and `closeCycle` take no body and so have no schema here.
 * @module validators/cycles
 * @author Suraj KM
 */

import { z } from 'zod';

// ─── POST /cycles/:cycle_id/record-winner ─────────────────────────────────────
// bid_amount is validated as a positive integer (paise) here. The service adds
// business-rule checks (> 0, ≤ pool_amount) that depend on DB state, so those
// stay in the service and are not duplicated here.
/** Validates the record-winner body (winner id, bid in paise, optional admin-withdrawal flag/notes). */
export const recordWinnerSchema = z.object({
  winner_user_id:       z.string().uuid(),
  bid_amount:           z.number().int().min(0),
  is_admin_withdrawal:  z.boolean().optional().default(false),
  notes:                z.string().optional(),
});

// ─── POST /cycles/:cycle_id/declare-skip-month ────────────────────────────────
/** Validates the declare-skip-month body (winner id, optional notes). */
export const declareSkipMonthSchema = z.object({
  winner_user_id: z.string().uuid(),
  notes:          z.string().optional(),
});

// ─── PATCH /cycles/:cycle_id ──────────────────────────────────────────────────
// Edits the recorded bid within the 24-hour window. Only bid_amount is mutable
// via this endpoint; winner_user_id changes are not supported (spec §6).
/** Validates the edit-bid body (positive bid in paise, optional notes). */
export const updateCycleSchema = z.object({
  bid_amount: z.number().int().positive(),
  notes:      z.string().optional(),
});

// ─── POST /cycles/:cycle_id/correct ──────────────────────────────────────────
// Admin-only correction of a closed cycle. Allows changing winner and/or bid
// amount after the cycle is closed, with full basket and wins_count rollback.
// bid_amount is optional for skip months (ignored); required for regular months.
/** Validates the correct-closed-cycle body (winner id, optional bid/notes/winner slot). */
export const correctCycleSchema = z.object({
  winner_user_id: z.string().uuid(),
  bid_amount:     z.number().int().positive().optional(),
  notes:          z.string().max(500).optional(),
  winner_number:  z.number().int().min(1).max(2).optional(),
});
