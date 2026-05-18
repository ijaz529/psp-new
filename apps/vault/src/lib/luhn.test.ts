import { describe, expect, it } from 'vitest';
import { isValidLuhn } from './luhn.js';

describe('isValidLuhn', () => {
  it('accepts well-known test PANs', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true); // Visa
    expect(isValidLuhn('5555555555554444')).toBe(true); // Mastercard
    expect(isValidLuhn('378282246310005')).toBe(true); // Amex
    expect(isValidLuhn('30569309025904')).toBe(true); // Diners 14-digit
  });

  it('rejects tampered PANs', () => {
    expect(isValidLuhn('4111111111111112')).toBe(false);
    expect(isValidLuhn('0000000000000000')).toBe(true); // technically passes Luhn — vault adds its own length-12+leading-zero check
    expect(isValidLuhn('1234567890123')).toBe(false);
  });

  it('rejects too-short and too-long', () => {
    expect(isValidLuhn('411111')).toBe(false);
    expect(isValidLuhn('41111111111111111111')).toBe(false);
  });

  it('strips formatting', () => {
    expect(isValidLuhn('4111 1111 1111 1111')).toBe(true);
    expect(isValidLuhn('4111-1111-1111-1111')).toBe(true);
  });

  it('rejects non-digit content', () => {
    expect(isValidLuhn('abcd')).toBe(false);
    expect(isValidLuhn('4111-1111-1111-111X')).toBe(false);
  });
});
