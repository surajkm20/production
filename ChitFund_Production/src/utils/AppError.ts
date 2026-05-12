// Custom error class used throughout the codebase.
// Carries a machine-readable `code` (e.g. "BASKET_INSUFFICIENT"), an HTTP status,
// and an optional `details` object for extra context.
// The global errorHandler middleware catches AppError instances and formats them
// into the standard error response envelope defined in api.md §12.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
