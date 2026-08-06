/**
 * Phase 31 — API test harness.
 *
 * Boots a real Fastify instance via buildApi() against a real Postgres
 * (HAS_DB-gated). Stubs out the acquirer-host HTTP dependency since
 * cardholder routes don't authorize on the wire.
 *
 * Pattern is reusable for future merchant route tests — just copy
 * `createApiTestHarness` and use `.app.inject()` to fire requests.
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiKey, generateCardholderApiKey } from '@psp-new/api-keys';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import type { Authorizer, Reverser, Settler } from '@psp-new/payment-engine';
import { createServiceAuth } from '@psp-new/service-auth';
import { createVaultClient } from '@psp-new/vault-client';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { buildApi } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations');

export const HAS_DB = !!process.env.DATABASE_URL;

const stubAuthorizer: Authorizer = async () => {
  throw new Error('stubAuthorizer: tests should not exercise the acquirer-host path');
};
const stubSettler: Settler = async () => {
  throw new Error('stubSettler: tests should not exercise the acquirer-host path');
};
const stubReverser: Reverser = async () => {
  throw new Error('stubReverser: tests should not exercise the acquirer-host path');
};

export interface ApiTestHarness {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Create a test harness. Call once per test suite (in beforeAll), close
 * in afterAll. Migrations are idempotent so each suite can call this.
 *
 * Phase 33/41: pass `overrides.authorizer`/`settler`/`reverser` to spy on
 * the acquirer path; the default stubs throw so tests that shouldn't hit
 * the wire fail loudly.
 */
export async function createApiTestHarness(
  overrides: { authorizer?: Authorizer; settler?: Settler; reverser?: Reverser } = {},
): Promise<ApiTestHarness> {
  if (!process.env.SERVICE_AUTH_SECRET) {
    process.env.SERVICE_AUTH_SECRET = 'test-secret-do-not-use-in-prod';
  }
  const pool = createPool({ ...dbConfigFromEnv(), applicationName: `api-test-${randomUUID().slice(0, 8)}` });
  await migrateUp(pool, MIGRATIONS_DIR);
  const db = createKysely(pool);

  const serviceAuth = createServiceAuth({
    secretsBySender: new Map([
      ['api', process.env.SERVICE_AUTH_SECRET],
      ['acquirer-host', process.env.SERVICE_AUTH_SECRET],
      ['worker', process.env.SERVICE_AUTH_SECRET],
      ['outbox-relay', process.env.SERVICE_AUTH_SECRET],
      ['vault', process.env.SERVICE_AUTH_SECRET],
    ]),
  });
  const vault = createVaultClient({ baseUrl: 'http://vault-stub.invalid', serviceAuth, senderId: 'api' });

  const app = await buildApi({
    pool,
    serviceAuth,
    vault,
    schemeSimulatorPublicUrl: 'http://scheme-simulator-stub.invalid',
    authorizer: overrides.authorizer ?? stubAuthorizer,
    settler: overrides.settler ?? stubSettler,
    reverser: overrides.reverser ?? stubReverser,
  });
  await app.ready();

  return {
    app,
    db,
    pool,
    async close() {
      await app.close();
      // buildApi attaches onClose → pool.end(); avoid double-close.
    },
  };
}

/* ---------- fixture factories ------------------------------------------- */

export async function createTestCardholder(
  db: Kysely<Database>,
  overrides: Partial<{ email: string; full_name: string; phone: string | null }> = {},
): Promise<{ id: string; email: string }> {
  const id = newId('cardholder');
  const email = overrides.email ?? `${id}@example.test`;
  await db
    .insertInto('paycore.cardholders')
    .values({
      id,
      email,
      full_name: overrides.full_name ?? 'Test Cardholder',
      phone: overrides.phone ?? null,
      status: 'active',
      created_at: new Date(),
    })
    .execute();
  return { id, email };
}

/** Phase 41 — merchant + both API keys. Extracted from the Phase 33 test's inline setup. */
export async function createTestMerchant(
  db: Kysely<Database>,
): Promise<{ id: string; secretKey: string; publishableKey: string }> {
  const merchantId = newId('merchant');
  await db
    .insertInto('paycore.merchants')
    .values({
      id: merchantId,
      name: 'Harness Test Inc',
      env: 'test',
      allowed_origins: [],
      reserve_basis_points: 0,
      payout_schedule: 'daily',
      kyb_status: 'pending',
      kyb_data: null,
      created_at: new Date(),
    })
    .execute();
  const sk = generateApiKey({ kind: 'secret', env: 'test' });
  const pk = generateApiKey({ kind: 'publishable', env: 'test' });
  await db
    .insertInto('paycore.api_keys')
    .values(
      [sk, pk].map((k) => ({
        id: k.id,
        merchant_id: merchantId,
        kind: k.kind,
        env: 'test' as const,
        prefix: k.prefix,
        sha256_hash: k.sha256Hash,
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      })),
    )
    .execute();
  return { id: merchantId, secretKey: sk.raw, publishableKey: pk.raw };
}

/** Phase 41 — visa payment method, BIN 411111 (outside the Phase 4 demo 3DS policy). */
export async function createTestPaymentMethod(db: Kysely<Database>, merchantId: string): Promise<{ id: string }> {
  const id = newId('payment_method');
  await db
    .insertInto('paycore.payment_methods')
    .values({
      id,
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
  return { id };
}

/** Phase 40 — minimal card fixture: two ledger accounts + a card on the seeded visa product. */
export async function createTestCard(db: Kysely<Database>, cardholderId: string): Promise<{ id: string }> {
  const cardId = newId('card');
  const fundedAcctId = newId('account');
  const holdsAcctId = newId('account');
  await db
    .insertInto('ledger.accounts')
    .values([
      {
        id: fundedAcctId,
        code: 'cardholder_funded',
        type: 'ASSET',
        currency: 'USD',
        owner_kind: 'issuer',
        owner_id: cardId,
        metadata: null,
        created_at: new Date(),
      },
      {
        id: holdsAcctId,
        code: 'cardholder_holds',
        type: 'ASSET',
        currency: 'USD',
        owner_kind: 'issuer',
        owner_id: cardId,
        metadata: null,
        created_at: new Date(),
      },
    ])
    .execute();
  await db
    .insertInto('paycore.cards')
    .values({
      id: cardId,
      product_id: 'prod_strawberry_visa_usd',
      cardholder_id: cardholderId,
      pan_token: newId('token'),
      bin: '411111',
      last4: '4242',
      exp_month: '12',
      exp_year: '2031',
      status: 'active',
      controls: {},
      funded_account_id: fundedAcctId,
      holds_account_id: holdsAcctId,
      stored_value_account_id: null,
      created_at: new Date(),
    })
    .execute();
  return { id: cardId };
}

export async function createTestCardholderKey(
  db: Kysely<Database>,
  cardholderId: string,
  opts: { env?: 'test' | 'live'; revoked?: boolean } = {},
): Promise<{ raw: string; id: string }> {
  const key = generateCardholderApiKey({ env: opts.env ?? 'test' });
  await db
    .insertInto('paycore.cardholder_api_keys')
    .values({
      id: key.id,
      cardholder_id: cardholderId,
      env: key.env,
      prefix: key.prefix,
      sha256_hash: key.sha256Hash,
      created_at: new Date(),
      last_used_at: null,
      revoked_at: opts.revoked ? new Date() : null,
    })
    .execute();
  return { raw: key.raw, id: key.id };
}
