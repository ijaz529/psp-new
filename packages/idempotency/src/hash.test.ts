import { describe, expect, it } from 'vitest';
import { canonicalize, hashRequestBody } from './hash.js';

describe('canonicalize', () => {
  it('sorts object keys recursively', () => {
    const a = canonicalize({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    const b = canonicalize({ a: 1, b: 2, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it('serializes bigint stably', () => {
    expect(canonicalize({ amount: 100n })).toBe('{"amount":"100n"}');
  });

  it('serializes Date as ISO 8601', () => {
    const d = new Date('2026-01-15T10:30:00.000Z');
    expect(canonicalize({ when: d })).toBe('{"when":"2026-01-15T10:30:00.000Z"}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('null and undefined behavior', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize([undefined, 1])).toBe('[null,1]');
  });
});

describe('hashRequestBody', () => {
  it('hash is sha256 hex', () => {
    expect(hashRequestBody({ amount: 100 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('equivalent bodies hash equal', () => {
    expect(hashRequestBody({ amount: 100, currency: 'USD' })).toBe(hashRequestBody({ currency: 'USD', amount: 100 }));
  });

  it('different bodies hash differently', () => {
    expect(hashRequestBody({ amount: 100 })).not.toBe(hashRequestBody({ amount: 101 }));
  });
});
