import { describe, expect, it } from 'vitest';
import { assertNoPan, maskPanDeep, maskPanInString } from './redaction.js';

const VISA_TEST_PAN = '4111111111111111'; // 16 digits, well-known test PAN
const AMEX_TEST_PAN = '378282246310005'; // 15 digits
const DINERS_TEST_PAN = '30569309025904'; // 14 digits

describe('maskPanInString', () => {
  it('masks a bare 16-digit Visa PAN', () => {
    expect(maskPanInString(VISA_TEST_PAN)).toBe('411111******1111');
  });

  it('masks 15-digit Amex', () => {
    expect(maskPanInString(AMEX_TEST_PAN)).toBe('378282******0005');
  });

  it('masks 14-digit Diners', () => {
    expect(maskPanInString(DINERS_TEST_PAN)).toBe('305693******5904');
  });

  it('masks PAN with space separators', () => {
    expect(maskPanInString('4111 1111 1111 1111')).toBe('411111******1111');
  });

  it('masks PAN with hyphen separators', () => {
    expect(maskPanInString('4111-1111-1111-1111')).toBe('411111******1111');
  });

  it('preserves surrounding text', () => {
    const input = `Customer card ${VISA_TEST_PAN} declined at MCC 5411`;
    expect(maskPanInString(input)).toBe('Customer card 411111******1111 declined at MCC 5411');
  });

  it('does not touch shorter numbers (under 12 digits)', () => {
    expect(maskPanInString('order 1234567890 fine')).toBe('order 1234567890 fine');
  });

  it('does not touch alphanumeric IDs that contain digits', () => {
    expect(maskPanInString('id_01HXY00000000000000000000Z')).toContain('01HXY00000000000000000000Z');
  });

  it('does not match digits embedded in a longer alphanumeric token', () => {
    // 16 digits glued to letters is not a PAN run.
    expect(maskPanInString('abc4111111111111111xyz')).toBe('abc4111111111111111xyz');
  });
});

describe('maskPanDeep', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      a: VISA_TEST_PAN,
      nested: { b: `prefix ${AMEX_TEST_PAN} suffix`, arr: [VISA_TEST_PAN, 'safe', { c: DINERS_TEST_PAN }] },
    };
    const out = maskPanDeep(input) as typeof input;
    expect(out.a).toBe('411111******1111');
    expect(out.nested.b).toBe('prefix 378282******0005 suffix');
    expect(out.nested.arr[0]).toBe('411111******1111');
    expect((out.nested.arr[2] as { c: string }).c).toBe('305693******5904');
  });

  it('survives self-referential objects without looping', () => {
    const a: Record<string, unknown> = { pan: VISA_TEST_PAN };
    a.self = a;
    const out = maskPanDeep(a) as Record<string, unknown>;
    expect(out.pan).toBe('411111******1111');
  });

  it('returns null/undefined/numbers as-is', () => {
    expect(maskPanDeep(null)).toBeNull();
    expect(maskPanDeep(undefined)).toBeUndefined();
    expect(maskPanDeep(42)).toBe(42);
    expect(maskPanDeep(true)).toBe(true);
  });
});

describe('assertNoPan (test helper)', () => {
  it('passes on clean payloads', () => {
    expect(() => assertNoPan({ amount: 1000, currency: 'USD' })).not.toThrow();
  });

  it('catches PAN in a registered field', () => {
    expect(() => assertNoPan({ pan: VISA_TEST_PAN })).toThrow(/PAN-shaped run/);
  });

  it('catches PAN in an unregistered nested field (adversarial)', () => {
    expect(() => assertNoPan({ surprise: { weirdName: `embedded ${VISA_TEST_PAN}` } })).toThrow();
  });

  it('catches PAN with separators', () => {
    expect(() => assertNoPan({ msg: '4111-1111-1111-1111' })).toThrow();
  });

  it('catches PAN inside an array', () => {
    expect(() => assertNoPan({ history: [{ raw: VISA_TEST_PAN }] })).toThrow();
  });

  it('does not falsely flag a ULID', () => {
    expect(() => assertNoPan({ id: 'pi_01HXY00000000000000000000Z' })).not.toThrow();
  });
});
