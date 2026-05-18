import { describe, expect, it } from 'vitest';
import { constantTimeEqual, generateApiKey, hashApiKey, parseApiKeyFormat, parseAuthorizationHeader } from './index.js';

describe('generateApiKey', () => {
  it('publishable test key has correct shape', () => {
    const k = generateApiKey({ kind: 'publishable', env: 'test' });
    expect(k.raw).toMatch(/^pk_test_[A-Za-z0-9_-]{43}$/);
    expect(k.prefix).toBe(k.raw.slice(0, 12));
    expect(k.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    expect(k.kind).toBe('publishable');
    expect(k.env).toBe('test');
    expect(k.id).toMatch(/^ak_/);
  });

  it('secret live key has correct shape', () => {
    const k = generateApiKey({ kind: 'secret', env: 'live' });
    expect(k.raw).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
  });

  it('generated keys are unique across many invocations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateApiKey({ kind: 'secret', env: 'test' }).raw);
    expect(seen.size).toBe(1000);
  });

  it('hashApiKey round-trips deterministically', () => {
    const k = generateApiKey({ kind: 'secret', env: 'test' });
    expect(hashApiKey(k.raw)).toBe(k.sha256Hash);
  });
});

describe('parseAuthorizationHeader', () => {
  it('extracts the token', () => {
    expect(parseAuthorizationHeader('Bearer sk_test_abc')).toBe('sk_test_abc');
  });
  it('rejects malformed', () => {
    expect(parseAuthorizationHeader('Basic abc')).toBeNull();
    expect(parseAuthorizationHeader('bearer abc')).toBeNull(); // case-sensitive
    expect(parseAuthorizationHeader('Bearer ')).toBeNull();
    expect(parseAuthorizationHeader(undefined)).toBeNull();
    expect(parseAuthorizationHeader('')).toBeNull();
  });
});

describe('parseApiKeyFormat', () => {
  it('parses pk_test', () => {
    expect(parseApiKeyFormat('pk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      kind: 'publishable',
      env: 'test',
    });
  });
  it('parses sk_live', () => {
    expect(parseApiKeyFormat('sk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      kind: 'secret',
      env: 'live',
    });
  });
  it('rejects junk', () => {
    expect(parseApiKeyFormat('garbage')).toBeNull();
    expect(parseApiKeyFormat('pk_test_short')).toBeNull();
    expect(parseApiKeyFormat('xx_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('equal strings → true', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
  });
  it('different strings → false', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });
  it('different lengths → false (no length leak)', () => {
    expect(constantTimeEqual('a', 'ab')).toBe(false);
  });
});
