// Utility helpers for money arithmetic in paise (BIGINT integers).
// Never use floats for money. All values entering or leaving the DB are integer paise.
// Helpers here: paiseToRupeeDisplay (for logs/errors only), validatePaise (throws if not
// a safe positive integer), and proportionalSplit (for closure split with rounding).

import { AppError } from './AppError';

export function paiseToRupeeDisplay(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

export function validatePaise(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', `${fieldName} must be a positive integer in paise.`);
  }
  return value as number;
}

// Splits totalPaise into n equal integer shares.
// Any remainder (due to indivisibility) is added to the last element.
export function proportionalSplit(totalPaise: number, n: number): number[] {
  const base = Math.floor(totalPaise / n);
  const remainder = totalPaise - base * n;
  const shares = Array<number>(n).fill(base);
  shares[n - 1] += remainder;
  return shares;
}
