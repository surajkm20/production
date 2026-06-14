/**
 * @fileoverview Cursor-based pagination helpers for the ChitFund API. It encodes a
 * `{ id, created_at }` keyset into an opaque base64url cursor for the client and
 * decodes it back for use in `WHERE` clauses. It exists because keyset (cursor)
 * pagination stays consistent when rows are inserted between page requests,
 * unlike offset pagination which can skip or repeat rows.
 * @module utils/pagination
 * @author Suraj KM
 */

import { AppError } from './AppError';

/** Keyset carried inside a pagination cursor, identifying the last row of a page. */
export interface CursorPayload {
  /** Primary key of the last row returned. */
  id: string;
  /** ISO timestamp of the last row returned, used as the sort key. */
  created_at: string;
}

/**
 * Serialises a keyset into an opaque base64url cursor to return to the client.
 *
 * @param payload - The `{ id, created_at }` keyset of the last row in the page
 * @returns An opaque base64url-encoded cursor string
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes a client-supplied cursor back into its keyset for use in a query.
 *
 * @param cursor - The opaque base64url cursor previously issued by {@link encodeCursor}
 * @returns The decoded `{ id, created_at }` keyset
 * @throws {AppError} 400 INVALID_REQUEST if the cursor is malformed or missing fields
 */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as CursorPayload;
    if (!parsed.id || !parsed.created_at) throw new Error('bad shape');
    return parsed;
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid pagination cursor.');
  }
}
