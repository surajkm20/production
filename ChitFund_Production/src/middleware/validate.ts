// Express middleware factory that validates req.body against a Zod schema.
// On failure: passes a 400 AppError to next() with field-level error details.
// On success: replaces req.body with the parsed output (strips unknown keys).

import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';
import { AppError } from '../utils/AppError';

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
