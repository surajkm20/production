// Idempotency helper for mutation endpoints.
//
// Usage in a service function:
//   const cached = await checkIdempotency(userId, key, 'LOAN_REPAY');
//   if (cached) return JSON.parse(cached);
//   ... do the work ...
//   await storeIdempotency(userId, key, 'LOAN_REPAY', result);
//   return result;

import { eq, and, gt } from 'drizzle-orm';
import { db } from '../config/db';
import { idempotency_keys } from '../db/schema';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if a valid (non-expired) idempotency record exists for this key + endpoint.
 * Returns the stored response body string if found, otherwise null.
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
 * Store a successful response for deduplication.
 * The key is scoped to (key, endpoint) with a 24-hour TTL.
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
