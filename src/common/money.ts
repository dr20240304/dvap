/** All money is integer micro-USDC (1 USDC = 1_000_000). Amounts cross the wire as decimal strings (x402-style). */
export const MICROS_PER_USD = 1_000_000;

/** Strict parse: positive integer, no sign, no decimals, no exponent, no leading zeros, safe-integer range. */
export function parseMicros(v: unknown, field = 'amount'): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${field} must be a positive safe integer of micro-USDC`);
    return v;
  }
  if (typeof v !== 'string' || !/^[1-9]\d{0,15}$/.test(v)) {
    throw new Error(`${field} must be a positive integer string of micro-USDC`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`${field} out of range`);
  return n;
}

export const usd = (micros: number): string =>
  '$' + (micros / MICROS_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const dollars = (n: number): number => Math.round(n * MICROS_PER_USD);
