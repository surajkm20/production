/**
 * @fileoverview Success-response helpers for the ChitFund API. It wraps payloads
 * in the standard `{ data: ... }` envelope and sets the appropriate status code
 * for 200 (success), 201 (created), and 204 (no content) responses. It exists so
 * controllers never hand-build the response shape, keeping the success envelope
 * uniform across every endpoint (the error envelope is owned by `errorHandler`).
 * @module utils/response
 * @author Suraj KM
 */

import { Response } from 'express';

/**
 * Sends a `{ data }` success envelope, defaulting to HTTP 200.
 *
 * @param res - Express response object
 * @param data - Payload to wrap in the `data` envelope
 * @param status - HTTP status code to send (defaults to 200)
 * @returns Nothing; writes the response directly
 */
export function sendSuccess(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

/**
 * Sends a `{ data }` envelope with HTTP 201 for a newly created resource.
 *
 * @param res - Express response object
 * @param data - The created resource to wrap in the `data` envelope
 * @returns Nothing; writes the response directly
 */
export function sendCreated(res: Response, data: unknown): void {
  res.status(201).json({ data });
}

/**
 * Sends an empty HTTP 204 response for a successful action with no body.
 *
 * @param res - Express response object
 * @returns Nothing; writes the response directly
 */
export function sendNoContent(res: Response): void {
  res.status(204).send();
}
