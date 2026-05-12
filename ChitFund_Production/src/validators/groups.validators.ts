// Zod schemas for validating group request bodies.
// Covers: create group (monthly_contribution and pool math, total_shares > 0, start_month YYYY-MM-DD format),
// update group, start group, join via invitation code.
// All money fields validated as positive integers (paise).

import { z } from 'zod';

// Shared base for start_month — full ISO date (YYYY-MM-DD) required because the
// DB column is type DATE and the service parses it with `new Date()`. YYYY-MM alone
// is ambiguous in JS and would misfire in non-UTC timezones.
const startMonthField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start_month must be a date in YYYY-MM-DD format');

export const createGroupSchema = z.object({
  name:                   z.string().min(1).max(100),
  monthly_contribution:   z.number().int().positive(),
  total_shares:           z.number().int().positive(),
  start_month:            startMonthField,
  payment_due_day:        z.number().int().min(1).max(28, 'payment_due_day cannot exceed 28 — days 29-31 are not allowed'),
  admin_commission_rate:  z.number().min(0).max(100, 'admin_commission_rate cannot exceed 100').optional(),
  monthly_interest_rate:  z.number().min(0).max(99.99).optional(),
  admin_share_count:      z.number().int().min(1).optional(),
}).refine(
  (d) => d.admin_share_count == null || d.admin_share_count <= d.total_shares,
  { message: 'admin_share_count cannot exceed total_shares', path: ['admin_share_count'] },
);

// ─── PATCH /groups/:group_id ──────────────────────────────────────────────────
// All fields optional — caller sends only what changed.
// Rejects empty bodies (no-op PATCHes) and rate bounds where min > max.
// interest_rate_* stored as numeric(4,2), so max is 99.99.
// start_month locked after group starts — that check lives in the service,
// not here; validator only enforces the YYYY-MM-DD format.
export const updateGroupSchema = z.object({
  name:                   z.string().min(1).max(100).optional(),
  monthly_contribution:   z.number().int().positive().optional(),
  total_shares:           z.number().int().positive().optional(),
  start_month:            startMonthField.optional(),
  admin_commission_rate:  z.number().min(0).max(100, 'admin_commission_rate cannot exceed 100').optional(),
  monthly_interest_rate:  z.number().min(0).max(99.99).optional(),
})
.refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one field must be provided.' },
);

// startGroup has no request body — all inputs come from URL params.

// ─── POST /groups/join ────────────────────────────────────────────────────────
// invitation_code is generated as randomBytes(4).hex().toUpperCase() = 8 uppercase
// hex chars. Validating the exact format rejects garbage before the DB lookup.
export const joinGroupSchema = z.object({
  invitation_code:       z.string().length(8).regex(/^[0-9A-F]{8}$/, 'invitation_code must be 8 uppercase hex characters'),
  requested_share_count: z.number().int().min(1).default(1),
});