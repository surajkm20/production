/**
 * @fileoverview Defines the `AppError` class — the single error type the ChitFund
 * backend throws for all expected, client-facing failures. Each instance carries
 * an HTTP status, a machine-readable code (e.g. `"BASKET_INSUFFICIENT"`), and an
 * optional details object. It exists so that services can signal precise failure
 * conditions while the global `errorHandler` middleware catches these instances
 * and formats them into the standard error envelope (api.md §12), keeping error
 * shaping consistent and decoupled from where the error is raised.
 * @module utils/AppError
 * @author Suraj KM
 */

/**
 * Throwable application error that the global error handler maps to a structured
 * JSON response; use it to signal an expected, client-facing failure.
 *
 * @example
 * throw new AppError(404, 'GROUP_NOT_FOUND', 'No group with that id.');
 */
export class AppError extends Error {
  /**
   * @param statusCode - HTTP status to send (e.g. 400, 403, 404)
   * @param code - Machine-readable error code (e.g. `"BASKET_INSUFFICIENT"`)
   * @param message - Human-readable message safe to expose to the client
   * @param details - Optional structured context (e.g. offending fields)
   */
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
