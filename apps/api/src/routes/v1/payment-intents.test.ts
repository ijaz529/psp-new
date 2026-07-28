/**
 * Phase 33 — POST /v1/payment_intents/:id/confirm must drive the real
 * authorizer. Regression: the route omitted `authorizer: ctx.authorizer`
 * and fell back to the Phase 3 always-approve stub (no ISO 8583 traffic,
 * last_auth_rrn/stan left NULL). HAS_DB-gated; uses the Phase 31 harness.
 */

import { randomUUID } from 'node:crypto';
import { generateApiKey } from '@psp-new/api-keys';
import { newId } from '@psp-new/ids';
import type { AuthorizeRequest } from '@psp-new/payment-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiTestHarness, HAS_DB, createApiTestHarness } from '../../__tests__/helpers.js';

describe.skipIf(!HAS_DB)('POST /v1/payment_intents/:id/confirm', () => {
  let h: ApiTestHarness;
  const authorizeCalls: AuthorizeRequest[] = [];

  beforeAll(async () => {
    h = await createApiTestHarness({
      authorizer: async (req) => {
        authorizeCalls.push(req);
        return { approved: true, responseCode: '00', approvalCode: 'APPR33', rrn: '000000123456', stan: '123456' };
      },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.close();
  });

  it('calls the authorizer and persists last_auth_rrn/last_auth_stan', async () => {
    const merchantId = newId('merchant');
    await h.db
      .insertInto('paycore.merchants')
      .values({
        id: merchantId,
        name: 'Confirm Test Inc',
        env: 'test',
        allowed_origins: [],
        reserve_basis_points: 0,
        payout_schedule: 'daily',
        kyb_status: 'pending',
        kyb_data: null,
        created_at: new Date(),
      })
      .execute();
    const key = generateApiKey({ kind: 'secret', env: 'test' });
    await h.db
      .insertInto('paycore.api_keys')
      .values({
        id: key.id,
        merchant_id: merchantId,
        kind: 'secret',
        env: 'test',
        prefix: key.prefix,
        sha256_hash: key.sha256Hash,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      })
      .execute();

    // BIN 411111 does not trigger the Phase 4 demo 3DS policy — confirm goes
    // straight to authorization.
    const pmId = newId('payment_method');
    await h.db
      .insertInto('paycore.payment_methods')
      .values({
        id: pmId,
        merchant_id: merchantId,
        customer_id: null,
        token_id: newId('token'),
        bin: '411111',
        last4: '1111',
        scheme: 'visa',
        exp_month: '12',
        exp_year: '2031',
        created_at: new Date(),
      })
      .execute();

    const auth = { authorization: `Bearer ${key.raw}`, 'content-type': 'application/json' };
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth, 'idempotency-key': `ik_${randomUUID()}` },
      payload: { amount: 1000, currency: 'USD', payment_method: pmId },
    });
    expect(created.statusCode).toBe(201);
    const pi = created.json() as { id: string; status: string };
    expect(pi.status).toBe('requires_confirmation');
    expect(authorizeCalls).toHaveLength(0);

    const confirmed = await h.app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${pi.id}/confirm`,
      headers: { ...auth, 'idempotency-key': `ik_${randomUUID()}` },
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string }).status).toBe('succeeded');

    // The regression: without the authorizer wired, the stub approves with no
    // acquirer call and these assertions fail (0 calls, NULL rrn/stan).
    expect(authorizeCalls).toHaveLength(1);
    expect(authorizeCalls[0]?.paymentIntentId).toBe(pi.id);
    expect(authorizeCalls[0]?.paymentMethodId).toBe(pmId);

    const row = await h.db
      .selectFrom('paycore.payment_intents')
      .select(['last_auth_rrn', 'last_auth_stan'])
      .where('id', '=', pi.id)
      .executeTakeFirstOrThrow();
    expect(row.last_auth_rrn).toBe('000000123456');
    expect(row.last_auth_stan).toBe('123456');
  });
});
