// Extends the Express Request type to include fields attached by middleware.
// req.user       — set by authenticate middleware after JWT verification.
// req.membership — set by requireMember middleware (role, share_count, wins_count for the current group).
// Without this file TypeScript would error on req.user / req.membership everywhere they're used.

import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        jti: string;  // JWT ID — links the access token to a refresh_tokens.session_id row
      };
      membership?: {
        id: string;
        role: string;
        shareCount: number;
        winsCount: number;
      };
    }
  }
}
