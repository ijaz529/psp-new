/**
 * Phase 41 — merchant refund integration tests. HAS_DB-gated.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiTestHarness,
  HAS_DB,
  createApiTestHarness,
  createTestMerchant,
  createTestPaymentMethod,
} from '../../__tests__/helpers.js';

describe.skipIf(!HAS_DB)('merchant refunds', () => {
  let h: ApiTestHarness;

  beforeAll(async () => {
    h = await createApiTestHarness({
      authorizer: async () => ({
        approved: true,
        responseCode: '00',
        approvalCode: 'APPR41',
        rrn: '000000411042',
        stan: '410002',
      }),
    });
  }, 30_000);

  afterAll(async () => {
    await h?.close();
  });

  const ik = () => ({ 'idempotency-key': `ik_${randomUUID()}` });

  /** Create + auto-confirm a 10.00 USD PI; returns its id and the auth headers. */
  async function succeededPi(): Promise<{ auth: Record<string, string>; piId: string }> {
    const m = await createTestMerchant(h.db);
    const pm = await createTestPaymentMethod(h.db, m.id);
    const auth = { authorization: `Bearer ${m.secretKey}`, 'content-type': 'application/json' };
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth, ...ik() },
      payload: { amount: 1000, currency: 'USD', payment_method: pm.id, confirm: true },
    });
    expect(res.statusCode).toBe(201);
    const pi = res.json() as { id: string; status: string };
    expect(pi.status).toBe('succeeded');
    return { auth, piId: pi.id };
  }

  it('full refund succeeds and is fetchable', async () => {
    const { auth, piId } = await succeededPi();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId, reason: 'requested_by_customer' },
    });
    expect(res.statusCode).toBe(201);
    const refund = res.json() as { id: string; amount: number; status: string };
    expect(refund.status).toBe('succeeded');
    expect(refund.amount).toBe(1000);

    const got = await h.app.inject({ method: 'GET', url: `/v1/refunds/${refund.id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { id: string }).id).toBe(refund.id);
  });

  it('partial refund reduces amount_received', async () => {
    const { auth, piId } = await succeededPi();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId, amount: 400 },
    });
    expect(res.statusCode).toBe(201);
    const row = await h.db
      .selectFrom('paycore.payment_intents')
      .select('amount_received')
      .where('id', '=', piId)
      .executeTakeFirstOrThrow();
    expect(row.amount_received).toBe(600n);
  });

  it('409 refund_exceeds_capture when refunds outrun the capture', async () => {
    const { auth, piId } = await succeededPi();
    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId, amount: 800 },
    });
    expect(first.statusCode).toBe(201);
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId, amount: 800 },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error?: { code?: string } }).error?.code).toBe('refund_exceeds_capture');
  });

  it('409 payment_intent_unexpected_state for a PI that never succeeded', async () => {
    const m = await createTestMerchant(h.db);
    const auth = { authorization: `Bearer ${m.secretKey}`, 'content-type': 'application/json' };
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth, ...ik() },
      payload: { amount: 1000, currency: 'USD' },
    });
    const piId = (created.json() as { id: string }).id;
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('payment_intent_unexpected_state');
  });

  it("404 when merchant B fetches merchant A's refund", async () => {
    const { auth, piId } = await succeededPi();
    const refund = await h.app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth, ...ik() },
      payload: { payment_intent: piId },
    });
    const refundId = (refund.json() as { id: string }).id;
    const b = await createTestMerchant(h.db);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/refunds/${refundId}`,
      headers: { authorization: `Bearer ${b.secretKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
