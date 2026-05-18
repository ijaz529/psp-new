import { describe, expect, it } from 'vitest';
import { makeEvent, signWebhook, verifyWebhook } from './index.js';

describe('makeEvent', () => {
  it('builds a stable envelope shape', () => {
    const evt = makeEvent({ type: 'payment_intent.succeeded', data: { id: 'pi_123', amount: 1000n } });
    expect(evt.type).toBe('payment_intent.succeeded');
    expect(evt.id.startsWith('evt_')).toBe(true);
    expect(evt.livemode).toBe(false);
    expect(evt.data.object).toEqual({ id: 'pi_123', amount: 1000n });
    expect(evt.api_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('respects livemode, apiVersion, resourceId, requestIdempotencyKey', () => {
    const evt = makeEvent({
      type: 'refund.created',
      data: { id: 're_1' },
      livemode: true,
      apiVersion: '2026-02-01',
      resourceId: 're_1',
      requestIdempotencyKey: 'idem_abc',
    });
    expect(evt.livemode).toBe(true);
    expect(evt.api_version).toBe('2026-02-01');
    expect(evt.resource_id).toBe('re_1');
    expect(evt.request_idempotency_key).toBe('idem_abc');
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_dev_test_key';
  const body = '{"id":"evt_01","type":"payment_intent.succeeded"}';
  const now = 1_700_000_000;

  it('sign and verify round-trip', () => {
    const header = signWebhook(body, secret, now);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    const r = verifyWebhook({ rawBody: body, header, secret, now });
    expect(r.ok).toBe(true);
  });

  it('rejects modified body', () => {
    const header = signWebhook(body, secret, now);
    const r = verifyWebhook({ rawBody: `${body}-tampered`, header, secret, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature_mismatch');
  });

  it('rejects wrong secret', () => {
    const header = signWebhook(body, secret, now);
    const r = verifyWebhook({ rawBody: body, header, secret: 'whsec_other', now });
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-tolerance timestamps', () => {
    const header = signWebhook(body, secret, now);
    const r = verifyWebhook({ rawBody: body, header, secret, now: now + 1000, toleranceSeconds: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timestamp_outside_tolerance');
  });

  it('rejects malformed header', () => {
    const r = verifyWebhook({ rawBody: body, header: 'not-a-header', secret, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_header');
  });
});
