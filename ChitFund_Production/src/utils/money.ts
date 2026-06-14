/**
 * @fileoverview Money arithmetic helpers for the ChitFund backend, where every
 * monetary value is stored and computed as integer paise (never floats). It
 * provides display formatting for logs/errors, strict validation that an
 * incoming amount is a positive integer in paise, and a remainder-safe split
 * used when dividing a pot into equal shares. It exists to keep currency handling
 * exact and consistent across services, avoiding the sub-paise drift that float
 * math would introduce.
 * @module utils/money
 * @author Suraj KM
 */

import { AppError } from './AppError';

/**
 * Formats an integer paise amount as a ₹ rupee string for logs and error messages only — not for API responses.
 *
 * @param paise - Amount in integer paise
 * @returns The amount as a `₹X.XX` rupee string
 */
export function paiseToRupeeDisplay(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

/**
 * Asserts that an untrusted value is a positive integer amount in paise, returning it narrowed to `number`.
 *
 * @param value - The value to validate (typically from request input)
 * @param fieldName - Field name used in the error message for context
 * @returns The validated amount as a `number`
 * @throws {AppError} 400 INVALID_AMOUNT if the value is not a positive integer
 */
export function validatePaise(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', `${fieldName} must be a positive integer in paise.`);
  }
  return value as number;
}

/**
 * Splits a paise total into `n` equal integer shares, adding any indivisible remainder to the last share so the parts sum exactly to the total.
 *
 * @param totalPaise - The total amount in paise to divide
 * @param n - The number of shares to split into
 * @returns An array of `n` integer paise shares that sum to `totalPaise`
 * @example
 * proportionalSplit(1000, 3); // [333, 333, 334]
 */
export function proportionalSplit(totalPaise: number, n: number): number[] {
  const base = Math.floor(totalPaise / n);
  const remainder = totalPaise - base * n;
  const shares = Array<number>(n).fill(base);
  shares[n - 1] += remainder;
  return shares;
}
