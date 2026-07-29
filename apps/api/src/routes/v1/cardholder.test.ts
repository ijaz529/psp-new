/**
 * Phase 31 — Cardholder REST API integration tests (retroactive
 * coverage for Phase 30). HAS_DB-gated; uses the harness from
 * src/__tests__/helpers.ts.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiTestHarness,
  HAS_DB,
  createApiTestHarness,
  createTestCard,
  createTestCardholder,
  createTestCardholderKey,
} from '../../__tests__/helpers.js';

describe.skipIf(!HAS_DB)('cardholder REST API', () => {
  let h: ApiTestHarness;

  beforeAll(async () => {
    h = await createApiTestHarness();
  }, 30_000);

  afterAll(async () => {
    await h?.close();
  });

  describe('auth gate', () => {
    it('401 api_key_missing when no Authorization header', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/v1/cardholder/me' });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('api_key_missing');
    });

    it('401 api_key_invalid when bearer is garbage', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/me',
        headers: { authorization: 'Bearer garbage' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('api_key_invalid');
    });

    it('401 api_key_invalid when key shape valid but not in DB', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/me',
        headers: { authorization: 'Bearer csk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('api_key_invalid');
    });

    it('401 api_key_revoked when key is revoked', async () => {
      const ch = await createTestCardholder(h.db);
      const key = await createTestCardholderKey(h.db, ch.id, { revoked: true });
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/me',
        headers: { authorization: `Bearer ${key.raw}` },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('api_key_revoked');
    });
  });

  describe('/v1/cardholder/me', () => {
    it('returns the signed-in cardholder profile', async () => {
      const ch = await createTestCardholder(h.db, { full_name: 'Alice Tester' });
      const key = await createTestCardholderKey(h.db, ch.id);
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/me',
        headers: { authorization: `Bearer ${key.raw}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; object: string; email: string; full_name: string; status: string };
      expect(body.id).toBe(ch.id);
      expect(body.object).toBe('cardholder');
      expect(body.email).toBe(ch.email);
      expect(body.full_name).toBe('Alice Tester');
      expect(body.status).toBe('active');
    });
  });

  describe('cross-cardholder isolation', () => {
    it("/v1/cardholder/webhook_endpoints does not return another cardholder's endpoints", async () => {
      const alice = await createTestCardholder(h.db);
      const bob = await createTestCardholder(h.db);
      const aliceKey = await createTestCardholderKey(h.db, alice.id);

      // Insert a webhook endpoint owned by Bob.
      const { newId } = await import('@psp-new/ids');
      const bobEndpointId = newId('webhook_endpoint');
      await h.db
        .insertInto('paycore.webhook_endpoints')
        .values({
          id: bobEndpointId,
          merchant_id: null,
          cardholder_id: bob.id,
          url: 'https://bob.example/wh',
          description: null,
          enabled_events: ['*'],
          signing_secret: 'whsec_bob',
          status: 'enabled',
          created_at: new Date(),
          disabled_at: null,
        })
        .execute();

      // Alice's list call must NOT include Bob's endpoint.
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/webhook_endpoints',
        headers: { authorization: `Bearer ${aliceKey.raw}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { object: string; data: Array<{ id: string }> };
      expect(body.object).toBe('list');
      expect(body.data.some((e) => e.id === bobEndpointId)).toBe(false);
    });
  });

  describe('POST /v1/cardholder/webhook_endpoints', () => {
    it('creates an endpoint and returns the signing secret ONCE', async () => {
      const ch = await createTestCardholder(h.db);
      const key = await createTestCardholderKey(h.db, ch.id);
      // randomUUID rather than Date.now: the logger's PAN redactor would mask
      // any 12+ consecutive-digit run between non-alphanumerics and mutate
      // req.headers in place, corrupting the key before idempotency reads it.
      const ik = `ik_${randomUUID()}`;
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/cardholder/webhook_endpoints',
        headers: { authorization: `Bearer ${key.raw}`, 'content-type': 'application/json', 'idempotency-key': ik },
        payload: { url: 'https://example.test/wh', enabled_events: ['card_load.*'] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; secret: string; url: string; enabled_events: string[] };
      expect(body.url).toBe('https://example.test/wh');
      expect(body.enabled_events).toEqual(['card_load.*']);
      expect(body.secret).toMatch(/^whsec_[a-f0-9]{64}$/);

      // Detail fetch (list) must NOT return the secret.
      const list = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/webhook_endpoints',
        headers: { authorization: `Bearer ${key.raw}` },
      });
      const row = (list.json() as { data: Array<{ id: string; secret?: string }> }).data.find((d) => d.id === body.id);
      expect(row).toBeDefined();
      expect(row?.secret).toBeUndefined();
    });

    it('replays the cached response when the same Idempotency-Key + body is sent again', async () => {
      const ch = await createTestCardholder(h.db);
      const key = await createTestCardholderKey(h.db, ch.id);
      const ik = `ik_${randomUUID()}`;
      const headers = { authorization: `Bearer ${key.raw}`, 'content-type': 'application/json', 'idempotency-key': ik };
      const payload = { url: 'https://example.test/wh-replay', enabled_events: ['*'] };

      const first = await h.app.inject({ method: 'POST', url: '/v1/cardholder/webhook_endpoints', headers, payload });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as { id: string; secret: string };

      const second = await h.app.inject({ method: 'POST', url: '/v1/cardholder/webhook_endpoints', headers, payload });
      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotency-replay']).toBe('true');
      const secondBody = second.json() as { id: string; secret: string };
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.secret).toBe(firstBody.secret);
    });

    it('creates a card-scoped endpoint when the card belongs to the caller (Phase 40)', async () => {
      const ch = await createTestCardholder(h.db);
      const key = await createTestCardholderKey(h.db, ch.id);
      const card = await createTestCard(h.db, ch.id);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/cardholder/webhook_endpoints',
        headers: {
          authorization: `Bearer ${key.raw}`,
          'content-type': 'application/json',
          'idempotency-key': `ik_${randomUUID()}`,
        },
        payload: { url: 'https://example.test/wh-scoped', card: card.id },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; card: string | null };
      expect(body.card).toBe(card.id);

      const list = await h.app.inject({
        method: 'GET',
        url: '/v1/cardholder/webhook_endpoints',
        headers: { authorization: `Bearer ${key.raw}` },
      });
      const row = (list.json() as { data: Array<{ id: string; card: string | null }> }).data.find(
        (d) => d.id === body.id,
      );
      expect(row?.card).toBe(card.id);
    });

    it("404s when scoping to another cardholder's card (Phase 40)", async () => {
      const alice = await createTestCardholder(h.db);
      const bob = await createTestCardholder(h.db);
      const aliceKey = await createTestCardholderKey(h.db, alice.id);
      const bobCard = await createTestCard(h.db, bob.id);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/cardholder/webhook_endpoints',
        headers: {
          authorization: `Bearer ${aliceKey.raw}`,
          'content-type': 'application/json',
          'idempotency-key': `ik_${randomUUID()}`,
        },
        payload: { url: 'https://example.test/wh-foreign', card: bobCard.id },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error?: { code?: string } }).error?.code).toBe('resource_missing');
    });
  });
});
