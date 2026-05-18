import { createHash } from 'node:crypto';
import { createServiceAuth } from '@psp-new/service-auth';
import { describe, expect, it, vi } from 'vitest';
import { VaultClientError, createVaultClient, detectSchemeByBin } from './index.js';

const SECRET = 'shared-secret-32-chars-minimum-aaaaaaaaaaaaaaaa';
const auth = createServiceAuth({
  secretsBySender: new Map([
    ['api', SECRET],
    ['acquirer-host', SECRET],
    ['worker', SECRET],
  ]),
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {})),
  ) as unknown as typeof fetch;
}

describe('VaultClient', () => {
  it('signs each request with X-Service-Auth using the configured sender', async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = mockFetch((url, init) => {
      captured = {
        url,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: init.body as string,
      };
      return new Response(JSON.stringify({ token: 'tok_x', bin: '411111', last4: '1111', scheme: 'visa' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const c = createVaultClient({ baseUrl: 'http://vault:8081', serviceAuth: auth, senderId: 'api', fetchImpl });
    await c.tokenize({ pan: '4111111111111111', merchantId: 'mrch_1' });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('http://vault:8081/internal/v1/tokenize');
    const header = captured!.headers['x-service-auth'];
    expect(header).toBeTruthy();
    expect(header).toMatch(/^t=\d+,s=api,v1=/);
    // Verify the signature is the expected HMAC of the right payload.
    const bodySha = createHash('sha256').update(captured!.body).digest('hex');
    const verified = auth.verify({
      header: header!,
      method: 'POST',
      path: '/internal/v1/tokenize',
      bodySha256: bodySha,
    });
    expect(verified.sender).toBe('api');
  });

  it('detokenize uses the configured sender (acquirer-host)', async () => {
    let captured = '';
    const fetchImpl = mockFetch((_url, init) => {
      captured = (init.headers as Record<string, string>)['x-service-auth'] ?? '';
      return new Response(JSON.stringify({ pan: '4111111111111111', expMonth: '12', expYear: '2030' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const c = createVaultClient({
      baseUrl: 'http://vault:8081',
      serviceAuth: auth,
      senderId: 'acquirer-host',
      fetchImpl,
    });
    await c.detokenize({ token: 'tok_x', merchantId: 'mrch_1', reason: 'authorization' });
    expect(captured).toMatch(/^t=\d+,s=acquirer-host,v1=/);
  });

  it('throws VaultClientError on non-2xx', async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'nope' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const c = createVaultClient({
      baseUrl: 'http://vault:8081',
      serviceAuth: auth,
      senderId: 'api',
      fetchImpl,
    });
    await expect(c.tokenize({ pan: '4111111111111111', merchantId: 'mrch_1' })).rejects.toBeInstanceOf(
      VaultClientError,
    );
  });
});

describe('detectSchemeByBin', () => {
  it('classifies visa', () => {
    expect(detectSchemeByBin('411111')).toBe('visa');
    expect(detectSchemeByBin('4242')).toBe('visa');
  });
  it('classifies mastercard (legacy 5xxxxx)', () => {
    expect(detectSchemeByBin('510000')).toBe('mastercard');
    expect(detectSchemeByBin('550000')).toBe('mastercard');
  });
  it('classifies mastercard (new 2xxxxx range)', () => {
    expect(detectSchemeByBin('222100')).toBe('mastercard');
    expect(detectSchemeByBin('272099')).toBe('mastercard');
  });
  it('classifies amex', () => {
    expect(detectSchemeByBin('378282')).toBe('amex');
    expect(detectSchemeByBin('371449')).toBe('amex');
  });
  it('falls back to unknown', () => {
    expect(detectSchemeByBin('601100')).toBe('unknown'); // discover
    expect(detectSchemeByBin('305693')).toBe('unknown'); // diners
    expect(detectSchemeByBin('xxx')).toBe('unknown');
  });
});
