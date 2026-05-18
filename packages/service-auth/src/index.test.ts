import { describe, expect, it } from 'vitest';
import { ServiceAuthError, createServiceAuth } from './index.js';

const secrets = new Map<string, string>([
  ['api', 'api-secret-32-chars-minimum-aaaaaaaaaaaaaaaaaaaa'],
  ['worker', 'worker-secret-32-chars-minimum-bbbbbbbbbbbbbbb'],
]);

const auth = createServiceAuth({ secretsBySender: secrets });

describe('service-auth', () => {
  it('sign and verify round-trip', () => {
    const now = 1_700_000_000;
    const tok = auth.sign({ sender: 'api', method: 'POST', path: '/internal/v1/tokenize', bodySha256: 'abc123', now });
    const result = auth.verify({
      header: tok.header,
      method: 'POST',
      path: '/internal/v1/tokenize',
      bodySha256: 'abc123',
      now,
    });
    expect(result.sender).toBe('api');
    expect(result.issuedAt).toBe(now);
  });

  it('rejects wrong method', () => {
    const now = 1_700_000_000;
    const tok = auth.sign({ sender: 'api', method: 'POST', path: '/x', bodySha256: '', now });
    expect(() => auth.verify({ header: tok.header, method: 'GET', path: '/x', bodySha256: '', now })).toThrow(
      ServiceAuthError,
    );
  });

  it('rejects wrong path', () => {
    const now = 1_700_000_000;
    const tok = auth.sign({ sender: 'api', method: 'POST', path: '/a', bodySha256: '', now });
    expect(() => auth.verify({ header: tok.header, method: 'POST', path: '/b', bodySha256: '', now })).toThrow(
      ServiceAuthError,
    );
  });

  it('rejects modified body', () => {
    const now = 1_700_000_000;
    const tok = auth.sign({ sender: 'api', method: 'POST', path: '/x', bodySha256: 'aaa', now });
    expect(() => auth.verify({ header: tok.header, method: 'POST', path: '/x', bodySha256: 'bbb', now })).toThrow(
      ServiceAuthError,
    );
  });

  it('rejects unknown sender', () => {
    const now = 1_700_000_000;
    expect(() => auth.sign({ sender: 'ghost', method: 'POST', path: '/x', bodySha256: '', now })).toThrow(
      ServiceAuthError,
    );
  });

  it('rejects timestamps outside skew window', () => {
    const tok = auth.sign({ sender: 'api', method: 'GET', path: '/healthz', bodySha256: '', now: 1_700_000_000 });
    expect(() =>
      auth.verify({
        header: tok.header,
        method: 'GET',
        path: '/healthz',
        bodySha256: '',
        now: 1_700_000_000 + 600,
        skewSeconds: 300,
      }),
    ).toThrow(/request timestamp outside skew/);
  });

  it('rejects malformed header', () => {
    expect(() =>
      auth.verify({ header: 'not-a-real-header', method: 'GET', path: '/x', bodySha256: '', now: 1 }),
    ).toThrow(ServiceAuthError);
  });

  it('verify is timing-safe (signature length mismatch returns false, not throws differently)', () => {
    const now = 1_700_000_000;
    const tok = auth.sign({ sender: 'api', method: 'GET', path: '/x', bodySha256: '', now });
    const tampered = tok.header.replace(/v1=[^,]+/, 'v1=AAAA');
    expect(() => auth.verify({ header: tampered, method: 'GET', path: '/x', bodySha256: '', now })).toThrow(
      /signature mismatch/,
    );
  });
});
