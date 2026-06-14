/**
 * @fileoverview Global Express error-handling middleware for the ChitFund API.
 * It is the single terminal handler (registered last in `app.ts`) that catches
 * everything bubbling out of routes — Zod validation failures, application-level
 * `AppError`s, and unexpected throws — and maps each to the project's standard
 * JSON error envelope `{ error: { code, message, details } }`. It exists so that
 * clients always receive a predictable error shape and so that unexpected
 * failures return a generic INTERNAL_ERROR (500) without leaking stack traces.
 * @module middleware/errorHandler
 * @author TODO
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';

/**
 * Terminal Express error handler that converts thrown errors into the standard JSON error envelope — register it last in `app.ts`, after all routes.
 *
 * @param err - The thrown value; `ZodError` and `AppError` get structured responses, anything else becomes a 500 INTERNAL_ERROR with no stack leak
 * @param req - Unused request object
 * @param res - Response used to send the mapped error status and body
 * @param _next - Unused; present so Express recognises this as an error-handling middleware
 * @returns Nothing; writes the response directly
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Validation failed.',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    },
  });
}
