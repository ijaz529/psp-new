import { describe, expect, it, vi } from 'vitest';
import { RETRY_DELAYS_MS, decideRetry, deliverWebhook } from './index.js';

describe('decideRetry', () => {
  it('success → success', () => {
    expect(decideRetry({ outcome: { kind: 'success', httpStatus: 200 }, priorAttempts: 0 })).toEqual({
      kind: 'success',
    });
  });

  it('4xx → dead_letter (non_retryable_status)', () => {
    expect(decideRetry({ outcome: { kind: 'non_retryable_4xx', httpStatus: 400 }, priorAttempts: 0 })).toEqual({
      kind: 'dead_letter',
      reason: 'non_retryable_status',
    });
  });

  it('5xx on first attempt → retry with 1m delay', () => {
    const r = decideRetry({ outcome: { kind: 'retryable_5xx', httpStatus: 503 }, priorAttempts: 0 });
    expect(r).toEqual({ kind: 'retry', delayMs: 60_000 });
  });

  it('5xx after max attempts → dead_letter (exceeded_retries)', () => {
    const r = decideRetry({
      outcome: { kind: 'retryable_5xx', httpStatus: 503 },
      priorAttempts: RETRY_DELAYS_MS.length,
    });
    expect(r).toEqual({ kind: 'dead_letter', reason: 'exceeded_retries' });
  });

  it('network error → retry on the same schedule as 5xx', () => {
    const r = decideRetry({ outcome: { kind: 'network_error', error: 'ECONNRESET' }, priorAttempts: 1 });
    expect(r).toEqual({ kind: 'retry', delayMs: 300_000 });
  });

  it('schedule matches brief (1m, 5m, 30m, 2h, 12h, 24h)', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000]);
  });
});

describe('deliverWebhook', () => {
  it('2xx → success with body slice', async () => {
    const fetchImpl = (async () => new Response('thanks', { status: 200 })) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{"a":1}',
      fetchImpl,
      now: () => 1_700_000_000,
    });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.httpStatus).toBe(200);
      expect(r.responseBody).toBe('thanks');
    }
  });

  it('400 → non_retryable_4xx', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{}',
      fetchImpl,
      now: () => 1,
    });
    expect(r.kind).toBe('non_retryable_4xx');
  });

  it('408 timeout treated as retryable_5xx', async () => {
    const fetchImpl = (async () => new Response('', { status: 408 })) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{}',
      fetchImpl,
      now: () => 1,
    });
    expect(r.kind).toBe('retryable_5xx');
  });

  it('429 rate limit treated as retryable_5xx', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{}',
      fetchImpl,
      now: () => 1,
    });
    expect(r.kind).toBe('retryable_5xx');
  });

  it('503 → retryable_5xx', async () => {
    const fetchImpl = (async () => new Response('overloaded', { status: 503 })) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{}',
      fetchImpl,
      now: () => 1,
    });
    expect(r.kind).toBe('retryable_5xx');
  });

  it('network error → network_error outcome', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_x',
      bodyJson: '{}',
      fetchImpl,
      now: () => 1,
    });
    expect(r.kind).toBe('network_error');
  });

  it('signs body with Webhook-Signature header', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await deliverWebhook({
      url: 'http://example/wh',
      secret: 'whsec_test',
      bodyJson: '{"event":"x"}',
      fetchImpl,
      now: () => 1_700_000_000,
    });
    expect(captured['webhook-signature']).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });
});
