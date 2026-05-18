import { describe, expect, it } from 'vitest';
import { generatePan, isValidLuhn, luhnCheckDigit, panInRange } from './pan.js';

describe('luhnCheckDigit', () => {
  it('matches the standard test vector for visa "4111111111111111"', () => {
    expect(luhnCheckDigit('411111111111111')).toBe('1');
  });

  it('matches the standard test vector for mastercard "5555555555554444"', () => {
    expect(luhnCheckDigit('555555555555444')).toBe('4');
  });

  it('makes the resulting 16-digit number pass isValidLuhn', () => {
    const body = '411111111111111';
    const check = luhnCheckDigit(body);
    expect(isValidLuhn(body + check)).toBe(true);
  });
});

describe('isValidLuhn', () => {
  it('accepts known-good PANs', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true);
    expect(isValidLuhn('5555555555554444')).toBe(true);
  });
  it('rejects PANs with wrong check digit', () => {
    expect(isValidLuhn('4111111111111110')).toBe(false);
  });
  it('rejects non-digit input', () => {
    expect(isValidLuhn('4111 1111 1111 1111')).toBe(false);
    expect(isValidLuhn('')).toBe(false);
    expect(isValidLuhn('1')).toBe(false);
  });
});

describe('generatePan', () => {
  const visaRange = { rangeLow: '411111000', rangeHigh: '411111999' };
  const mcRange = { rangeLow: '555555000', rangeHigh: '555555999' };

  it('produces 16 digits', () => {
    for (let i = 0; i < 50; i++) {
      const pan = generatePan(visaRange);
      expect(pan).toMatch(/^\d{16}$/);
    }
  });

  it('passes Luhn for every generated PAN', () => {
    for (let i = 0; i < 200; i++) {
      const pan = generatePan(visaRange);
      expect(isValidLuhn(pan), `pan ${pan} should be Luhn-valid`).toBe(true);
    }
  });

  it('respects the BIN range — Visa', () => {
    for (let i = 0; i < 100; i++) {
      const pan = generatePan(visaRange);
      const prefix = pan.slice(0, 9);
      expect(prefix >= '411111000' && prefix <= '411111999').toBe(true);
    }
  });

  it('respects the BIN range — Mastercard', () => {
    for (let i = 0; i < 100; i++) {
      const pan = generatePan(mcRange);
      const prefix = pan.slice(0, 9);
      expect(prefix >= '555555000' && prefix <= '555555999').toBe(true);
    }
  });

  it('refuses bad input', () => {
    expect(() => generatePan({ rangeLow: '12345678', rangeHigh: '12345689' })).toThrow();
    expect(() => generatePan({ rangeLow: '999999999', rangeHigh: '000000000' })).toThrow();
  });
});

describe('panInRange', () => {
  it('matches when inside', () => {
    expect(panInRange('4111110011234565', '411111000', '411111999')).toBe(true);
  });
  it('rejects when outside', () => {
    expect(panInRange('5555550001234565', '411111000', '411111999')).toBe(false);
  });
  it('rejects short input', () => {
    expect(panInRange('41111', '411111000', '411111999')).toBe(false);
  });
});
