// Helper functions for sending standard response envelopes.
// sendSuccess(res, data, status?)  → { data: ... }  with 200 or specified status.
// sendCreated(res, data)           → { data: ... }  with 201.
// sendNoContent(res)               → empty body     with 204.
// Centralises the envelope shape so controllers never construct it manually.

import { Response } from 'express';

export function sendSuccess(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

export function sendCreated(res: Response, data: unknown): void {
  res.status(201).json({ data });
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}
