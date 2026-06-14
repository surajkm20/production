/**
 * @fileoverview Request-body validation middleware factory for the ChitFund API.
 * Given a Zod schema it returns an Express middleware that parses `req.body`,
 * replaces it with the validated and unknown-key-stripped output on success, or
 * forwards a VALIDATION_ERROR (400) `AppError` with field-level details on
 * failure. It exists to keep input validation declarative and consistent across
 * routes, guaranteeing controllers only ever receive well-formed, typed payloads.
 * @module middleware/validate
 * @author TODO
 */

import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';
import { AppError } from '../utils/AppError';

/**
 * Builds a middleware that validates `req.body` against a Zod schema, replacing it with the parsed (unknown-key-stripped) output on success.
 *
 * @param schema - Zod schema to validate the request body against
 * @returns An Express middleware that calls `next` on success or forwards a VALIDATION_ERROR `AppError` (400) with field-level details on failure
 * @example
 * router.post('/login', validate(loginSchema), loginController);
 */
export function validate(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const { fieldErrors, formErrors } = result.error.flatten();
      const details: Record<string, unknown> = { fields: fieldErrors };
      if (formErrors.length) details.errors = formErrors;
      const firstMessage = Object.values(fieldErrors).flat()[0] ?? formErrors[0] ?? 'Request body validation failed.';
      next(new AppError(400, 'VALIDATION_ERROR', firstMessage, details));
      return;
    }
    req.body = result.data;
    next();
  };
}
