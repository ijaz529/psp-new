import { getCurrency, isSupportedCurrency } from './currencies.js';

export * from './currencies.js';

/**
 * Money — an amount in minor units (BIGINT) plus an ISO 4217 currency.
 *
 * Why bigint? JS `number` is IEEE-754, which loses precision above 2^53 - 1.
 * That's fine for retail amounts but it's a trap waiting to happen — bigint is
 * exact, has no API surface that returns float, and forbids silent mixing with
 * floats. We pay the small ergonomic cost (literals must be `5n` or `BigInt(5)`)
 * in exchange for "never lose a cent to floating-point drift."
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(
    public readonly left: string,
    public readonly right: string,
  ) {
    super(`Currency mismatch: ${left} vs ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class UnsupportedCurrencyError extends Error {
  constructor(public readonly code: string) {
    super(`Unsupported currency: ${code}`);
    this.name = 'UnsupportedCurrencyError';
  }
}

export function money(amount: bigint | number | string, currency: string): Money {
  const code = currency.toUpperCase();
  if (!isSupportedCurrency(code)) throw new UnsupportedCurrencyError(currency);
  return { amount: BigInt(amount), currency: code };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate(m: Money): Money {
  return { amount: -m.amount, currency: m.currency };
}

export function isZero(m: Money): boolean {
  return m.amount === 0n;
}

export function isPositive(m: Money): boolean {
  return m.amount > 0n;
}

export function isNegative(m: Money): boolean {
  return m.amount < 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

/**
 * Multiply by an integer factor. For fractional factors (interchange %, MDR %),
 * use {@link applyBasisPoints} so the rounding strategy is explicit.
 */
export function multiplyByInteger(m: Money, factor: bigint | number): Money {
  return { amount: m.amount * BigInt(factor), currency: m.currency };
}

/**
 * Apply a basis-points rate (1 bp = 0.01%). Returns floor-rounded amount.
 *
 * Example: 100 EUR at 250 bp = 2.5 EUR fee → applyBasisPoints(money(10000n, 'EUR'), 250) = 250 cents.
 */
export function applyBasisPoints(m: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`basisPoints must be a non-negative integer, got ${basisPoints}`);
  }
  const product = m.amount * BigInt(basisPoints);
  // Divide by 10_000 with floor (toward -Infinity for negatives).
  const divisor = 10_000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  if (remainder === 0n || product >= 0n) return { amount: quotient, currency: m.currency };
  // Negative with non-zero remainder: bigint truncates toward zero, we want floor.
  return { amount: quotient - 1n, currency: m.currency };
}

/**
 * Render minor units to a human-readable decimal string using the currency's scale.
 * No localization (no thousands separator, no symbol) — keep it boring for logs.
 */
export function format(m: Money): string {
  const currency = getCurrency(m.currency);
  if (!currency) throw new UnsupportedCurrencyError(m.currency);
  const scale = currency.minorUnits;
  if (scale === 0) return `${m.amount} ${m.currency}`;
  const sign = m.amount < 0n ? '-' : '';
  const abs = m.amount < 0n ? -m.amount : m.amount;
  const str = abs.toString().padStart(scale + 1, '0');
  const whole = str.slice(0, -scale);
  const frac = str.slice(-scale);
  return `${sign}${whole}.${frac} ${m.currency}`;
}
