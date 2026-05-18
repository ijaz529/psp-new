import { describe, expect, it } from 'vitest';
import { detectScheme } from './scheme.js';

describe('detectScheme', () => {
  it('Visa starts with 4', () => {
    expect(detectScheme('4111111111111111')).toBe('visa');
    expect(detectScheme('4000000000000002')).toBe('visa');
  });

  it('Mastercard legacy 51-55', () => {
    expect(detectScheme('5100000000000000')).toBe('mastercard');
    expect(detectScheme('5555555555554444')).toBe('mastercard');
  });

  it('Mastercard new range 2221-2720', () => {
    expect(detectScheme('2221000000000000')).toBe('mastercard');
    expect(detectScheme('2720990000000000')).toBe('mastercard');
  });

  it('Amex 34, 37', () => {
    expect(detectScheme('378282246310005')).toBe('amex');
    expect(detectScheme('341111111111111')).toBe('amex');
  });

  it('falls back to unknown', () => {
    expect(detectScheme('6011000000000004')).toBe('unknown'); // Discover
    expect(detectScheme('3056930902590')).toBe('unknown'); // Diners
    expect(detectScheme('')).toBe('unknown');
  });
});
