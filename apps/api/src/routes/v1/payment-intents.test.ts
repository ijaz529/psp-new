/**
 * Phase 33/41 — merchant PaymentIntent lifecycle integration tests.
 * HAS_DB-gated; uses the Phase 31 harness with spy authorizer/settler/
 * reverser so the acquirer wire legs are asserted, not stubbed away.
 */

import { randomUUID } from 'node:crypto';
import type { AuthorizeRequest, ReverseRequest, SettleRequest } from '@psp-new/payment-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiTestHarness,
  HAS_DB,
  createApiTestHarness,
  createTestMerchant,
  createTestPaymentMethod,
} from '../../__tests__/helpers.js';

describe.skipIf(!HAS_DB)('merchant payment_intents lifecycle', () => {
  let h: ApiTestHarness;
  const authorizeCalls: AuthorizeRequest[] = [];
  const settleCalls: SettleRequest[] = [];
  const reverseCalls: ReverseRequest[] = [];
  // Tests flip this to exercise the decline path; reset before each test.
  let approveNext = true;

  beforeAll(async () => {
    h = await createApiTestHarness({
      authorizer: async (req) => {
        authorizeCalls.push(req);
        if (!approveNext) {
          return { approved: false, responseCode: '51', approvalCode: null, declineCode: 'insufficient_funds' };
        }
        return { approved: true, responseCode: '00', approvalCode: 'APPR41', rrn: '000000411041', stan: '410001' };
      },
      settler: async (req) => {
        settleCalls.push(req);
        return { approved: true, responseCode: '00' };
      },
      reverser: async (req) => {
        reverseCalls.push(req);
        return { approved: true, responseCode: '00' };
      },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(() => {
    approveNext = true;
  });

  async function merchantWithPm(): Promise<{ auth: Record<string, string>; merchantId: string; pmId: string }> {
    const m = await createTestMerchant(h.db);
    const pm = await createTestPaymentMethod(h.db, m.id);
    return {
      auth: { authorization: `Bearer ${m.secretKey}`, 'content-type': 'application/json' },
      merchantId: m.id,
      pmId: pm.id,
    };
  }

  const ik = () => ({ 'idempotency-key': `ik_${randomUUID()}` });

  describe('auth gate', () => {
    it('401 api_key_missing without a key', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/v1/payment_intents/pi_missing' });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('api_key_missing');
    });

    it('403 permission_denied when a publishable key hits a secret-key route', async () => {
      const m = await createTestMerchant(h.db);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { authorization: `Bearer ${m.publishableKey}`, 'content-type': 'application/json', ...ik() },
        payload: { amount: 1000, currency: 'USD' },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('permission_denied');
    });
  });

  describe('create', () => {
    it('201 requires_payment_method without a payment_method', async () => {
      const { auth } = await merchantWithPm();
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...auth, ...ik() },
        payload: { amount: 1000, currency: 'USD' },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { status: string }).status).toBe('requires_payment_method');
    });

    it('create with confirm: true drives the authorizer and persists rrn/stan', async () => {
      const { auth, pmId } = await merchantWithPm();
      const before = authorizeCalls.length;
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...auth, ...ik() },
        payload: { amount: 2500, currency: 'USD', payment_method: pmId, confirm: true },
      });
      expect(res.statusCode).toBe(201);
      const pi = res.json() as { id: string; status: string; amount_received: number };
      expect(pi.status).toBe('succeeded');
      expect(authorizeCalls.length).toBe(before + 1);
      const row = await h.db
        .selectFrom('paycore.payment_intents')
        .select(['last_auth_rrn', 'last_auth_stan', 'captured_at'])
        .where('id', '=', pi.id)
        .executeTakeFirstOrThrow();
      expect(row.last_auth_rrn).toBe('000000411041');
      expect(row.last_auth_stan).toBe('410001');
      expect(row.captured_at).not.toBeNull();
    });

    it('decline: authorizer refusal fails the PI with last_payment_error', async () => {
      const { auth, pmId } = await merchantWithPm();
      approveNext = false;
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...auth, ...ik() },
        payload: { amount: 900, currency: 'USD', payment_method: pmId, confirm: true },
      });
      expect(res.statusCode).toBe(201);
      const pi = res.json() as { status: string; last_payment_error: { code: string; decline_code?: string } | null };
      expect(pi.status).toBe('failed');
      expect(pi.last_payment_error?.code).toBe('card_declined');
      expect(pi.last_payment_error?.decline_code).toBe('insufficient_funds');
    });
  });

  describe('manual capture + cancel', () => {
    async function authorizedManualPi(auth: Record<string, string>, pmId: string): Promise<string> {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...auth, ...ik() },
        payload: { amount: 5000, currency: 'USD', payment_method: pmId, capture_method: 'manual', confirm: true },
      });
      expect(res.statusCode).toBe(201);
      const pi = res.json() as { id: string; status: string; amount_capturable: number };
      expect(pi.status).toBe('requires_capture');
      expect(pi.amount_capturable).toBe(5000);
      return pi.id;
    }

    it('capture drives the settler with the auth rrn/stan and succeeds the PI', async () => {
      const { auth, pmId } = await merchantWithPm();
      const piId = await authorizedManualPi(auth, pmId);
      const before = settleCalls.length;
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/payment_intents/${piId}/capture`,
        headers: { ...auth, ...ik() },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const pi = res.json() as { status: string; amount_received: number };
      expect(pi.status).toBe('succeeded');
      expect(pi.amount_received).toBe(5000);
      expect(settleCalls.length).toBe(before + 1);
      expect(settleCalls[settleCalls.length - 1]?.rrn).toBe('000000411041');
      expect(settleCalls[settleCalls.length - 1]?.amountMinor).toBe(5000n);
    });

    it('cancel drives the reverser for the uncaptured remainder', async () => {
      const { auth, pmId } = await merchantWithPm();
      const piId = await authorizedManualPi(auth, pmId);
      const before = reverseCalls.length;
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/payment_intents/${piId}/cancel`,
        headers: { ...auth, ...ik() },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('canceled');
      expect(reverseCalls.length).toBe(before + 1);
      expect(reverseCalls[reverseCalls.length - 1]?.amountMinor).toBe(5000n);
    });
  });

  describe('isolation + idempotency', () => {
    it("404 when merchant B fetches merchant A's payment_intent", async () => {
      const a = await merchantWithPm();
      const b = await createTestMerchant(h.db);
      const created = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...a.auth, ...ik() },
        payload: { amount: 1000, currency: 'USD' },
      });
      const piId = (created.json() as { id: string }).id;
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1/payment_intents/${piId}`,
        headers: { authorization: `Bearer ${b.secretKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('replays the cached response for the same Idempotency-Key + body', async () => {
      const { auth } = await merchantWithPm();
      const headers = { ...auth, ...ik() };
      const payload = { amount: 1234, currency: 'USD' };
      const first = await h.app.inject({ method: 'POST', url: '/v1/payment_intents', headers, payload });
      expect(first.statusCode).toBe(201);
      const second = await h.app.inject({ method: 'POST', url: '/v1/payment_intents', headers, payload });
      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotency-replay']).toBe('true');
      expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    });
  });

  // Phase 33 regression — the standalone confirm route must pass the authorizer.
  describe('POST /v1/payment_intents/:id/confirm', () => {
    it('calls the authorizer and persists last_auth_rrn/last_auth_stan', async () => {
      const { auth, pmId } = await merchantWithPm();
      const created = await h.app.inject({
        method: 'POST',
        url: '/v1/payment_intents',
        headers: { ...auth, ...ik() },
        payload: { amount: 1000, currency: 'USD', payment_method: pmId },
      });
      expect(created.statusCode).toBe(201);
      const pi = created.json() as { id: string; status: string };
      expect(pi.status).toBe('requires_confirmation');

      const before = authorizeCalls.length;
      const confirmed = await h.app.inject({
        method: 'POST',
        url: `/v1/payment_intents/${pi.id}/confirm`,
        headers: { ...auth, ...ik() },
        payload: {},
      });
      expect(confirmed.statusCode).toBe(200);
      expect((confirmed.json() as { status: string }).status).toBe('succeeded');
      expect(authorizeCalls.length).toBe(before + 1);
      expect(authorizeCalls[authorizeCalls.length - 1]?.paymentIntentId).toBe(pi.id);

      const row = await h.db
        .selectFrom('paycore.payment_intents')
        .select(['last_auth_rrn', 'last_auth_stan'])
        .where('id', '=', pi.id)
        .executeTakeFirstOrThrow();
      expect(row.last_auth_rrn).toBe('000000411041');
      expect(row.last_auth_stan).toBe('410001');
    });
  });
});
