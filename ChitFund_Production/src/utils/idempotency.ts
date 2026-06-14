/**
 * @fileoverview Idempotency helpers for mutation endpoints in the ChitFund API.
 * It provides a check/store pair backed by the `idempotency_keys` table so that
 * a client retrying a request with the same `Idempotency-Key` receives the
 * original response instead of performing the operation twice. It exists to make
 * money-moving actions (loan repayments, winner recording, etc.) safe against
 * double-submits and network retries, with records scoped to (key, endpoint,
 * user) and expiring after 24 hours.
 * @module utils/idempotency
 * @author Suraj KM
 */

import { eq, and, gt } from 'drizzle-orm';
import { db } from '../config/db';
import { idempotency_keys } from '../db/schema';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Looks up a previously stored response for a retried request so the operation can be skipped.
 *
 * @param userId - The authenticated user the key is scoped to
 * @param key - The client-supplied idempotency key
 * @param endpoint - Logical endpoint identifier (e.g. `'LOAN_REPAY'`) the key is scoped to
 * @returns The stored response body as a JSON string, or `null` if no valid (non-expired) record exists
 * @example
 * const cached = await checkIdempotency(userId, key, 'LOAN_REPAY');
 * if (cached) return JSON.parse(cached);
 */
export async function checkIdempotency(
  userId:   string,
  key:      string,
  endpoint: string,
): Promise<string | null> {
  const now = new Date();
  const [row] = await db
    .select({ response_body: idempotency_keys.response_body })
    .from(idempotency_keys)
    .where(and(
      eq(idempotency_keys.key, key),
      eq(idempotency_keys.endpoint, endpoint),
      eq(idempotency_keys.user_id, userId),
      gt(idempotency_keys.expires_at, now),
    ))
    .limit(1);

  return row?.response_body ?? null;
}

/**
 * Persists a successful response so an identical retry can be deduplicated within the 24-hour TTL.
 *
 * @param userId - The authenticated user the key is scoped to
 * @param key - The client-supplied idempotency key
 * @param endpoint - Logical endpoint identifier (e.g. `'LOAN_REPAY'`) the key is scoped to
 * @param responseBody - The successful response payload to cache; serialised to JSON
 * @returns A promise that resolves once the record is written (a concurrent duplicate is ignored)
 * @example
 * await storeIdempotency(userId, key, 'LOAN_REPAY', result);
 */
export async function storeIdempotency(
  userId:       string,
  key:          string,
  endpoint:     string,
  responseBody: unknown,
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(idempotency_keys).values({
    key,
    endpoint,
    user_id:       userId,
    response_body: JSON.stringify(responseBody),
    expires_at:    expiresAt,
  }).onConflictDoNothing(); // race-condition safety: if two identical requests land simultaneously
}
