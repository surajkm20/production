// Cursor-based pagination helpers.
// encodeCursor: serialises { id, created_at } → opaque base64 string sent to client.
// decodeCursor: reverses it for use in WHERE clauses.
// Cursor pagination is preferred over offset pagination for consistency
// when rows are inserted between requests.

import { AppError } from './AppError';

export interface CursorPayload {
  id: string;
  created_at: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

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
