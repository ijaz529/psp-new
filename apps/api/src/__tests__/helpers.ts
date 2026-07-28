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
import { generateCardholderApiKey } from '@psp-new/api-keys';
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
 * Phase 33: pass `overrides.authorizer` to spy on the acquirer path;
 * the default stubs throw so tests that shouldn't hit the wire fail loudly.
 */
export async function createApiTestHarness(overrides: { authorizer?: Authorizer } = {}): Promise<ApiTestHarness> {
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
    settler: stubSettler,
    reverser: stubReverser,
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
