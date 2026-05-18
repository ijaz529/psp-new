import { describe, expect, it } from 'vitest';
import { VISA_REASON_CODES } from './index.js';

describe('VISA_REASON_CODES', () => {
  it('includes 10.4 fraud', () => {
    expect(VISA_REASON_CODES.has('visa_10.4')).toBe(true);
  });
  it('includes 13.x service codes', () => {
    expect(VISA_REASON_CODES.has('visa_13.1')).toBe(true);
    expect(VISA_REASON_CODES.has('visa_13.3')).toBe(true);
  });
  it('rejects unknown codes', () => {
    expect(VISA_REASON_CODES.has('mc_4837')).toBe(false);
  });
});
