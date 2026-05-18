import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  ISO_4217,
  UnsupportedCurrencyError,
  add,
  applyBasisPoints,
  compare,
  format,
  getCurrency,
  isSupportedCurrency,
  money,
  multiplyByInteger,
  negate,
  subtract,
} from './index.js';

describe('money', () => {
  it('rejects unsupported currencies', () => {
    expect(() => money(100n, 'XYZ')).toThrow(UnsupportedCurrencyError);
  });

  it('uppercases currency on construction', () => {
    expect(money(100n, 'usd').currency).toBe('USD');
  });

  it('add / subtract enforce same currency', () => {
    const a = money(100n, 'USD');
    const b = money(50n, 'EUR');
    expect(() => add(a, b)).toThrow(CurrencyMismatchError);
    expect(() => subtract(a, b)).toThrow(CurrencyMismatchError);
  });

  it('add and subtract are exact', () => {
    expect(add(money(100n, 'USD'), money(250n, 'USD')).amount).toBe(350n);
    expect(subtract(money(1_000_000_000_000_000_000n, 'USD'), money(1n, 'USD')).amount).toBe(999_999_999_999_999_999n);
  });

  it('multiplyByInteger', () => {
    expect(multiplyByInteger(money(10n, 'USD'), 7).amount).toBe(70n);
  });

  it('applyBasisPoints floors toward -Infinity', () => {
    expect(applyBasisPoints(money(10_000n, 'EUR'), 250).amount).toBe(250n);
    // 100 USD at 30 bp = 0.30 USD = 30 cents
    expect(applyBasisPoints(money(10_000n, 'USD'), 30).amount).toBe(30n);
    // 333 cents at 250 bp = 8.325 cents → floor 8
    expect(applyBasisPoints(money(333n, 'USD'), 250).amount).toBe(8n);
    // negative with fraction: -333 cents at 250 bp → -8.325 → -9 (floor)
    expect(applyBasisPoints(negate(money(333n, 'USD')), 250).amount).toBe(-9n);
  });

  it('applyBasisPoints rejects fractional bps', () => {
    expect(() => applyBasisPoints(money(100n, 'USD'), 2.5)).toThrow(RangeError);
    expect(() => applyBasisPoints(money(100n, 'USD'), -1)).toThrow(RangeError);
  });

  it('compare returns -1, 0, 1', () => {
    expect(compare(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
    expect(compare(money(2n, 'USD'), money(2n, 'USD'))).toBe(0);
    expect(compare(money(3n, 'USD'), money(2n, 'USD'))).toBe(1);
  });

  it('format respects currency minor units', () => {
    expect(format(money(12345n, 'USD'))).toBe('123.45 USD');
    expect(format(money(12345n, 'JPY'))).toBe('12345 JPY'); // 0 minor units
    expect(format(money(12345n, 'BHD'))).toBe('12.345 BHD'); // 3 minor units
    expect(format(money(-12345n, 'USD'))).toBe('-123.45 USD');
    expect(format(money(5n, 'USD'))).toBe('0.05 USD');
    expect(format(money(0n, 'USD'))).toBe('0.00 USD');
  });
});

describe('currencies (ISO 4217)', () => {
  it('JPY=0, USD=2, BHD=3', () => {
    expect(getCurrency('JPY')?.minorUnits).toBe(0);
    expect(getCurrency('USD')?.minorUnits).toBe(2);
    expect(getCurrency('BHD')?.minorUnits).toBe(3);
  });

  it('is case-insensitive on lookup', () => {
    expect(getCurrency('usd')?.code).toBe('USD');
    expect(isSupportedCurrency('eur')).toBe(true);
  });

  it('returns undefined for unknown codes', () => {
    expect(getCurrency('XYZ')).toBeUndefined();
    expect(isSupportedCurrency('XYZ')).toBe(false);
  });

  it('has unique codes and numerics', () => {
    const codes = new Set(ISO_4217.map((c) => c.code));
    const numerics = new Set(ISO_4217.map((c) => c.numeric));
    expect(codes.size).toBe(ISO_4217.length);
    expect(numerics.size).toBe(ISO_4217.length);
  });
});
