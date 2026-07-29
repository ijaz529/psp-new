import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { createLogger } from '@psp-new/logger';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepExpiredIdempotencyKeys } from './idempotency-janitor-job.js';

/**
 * Phase 38 integration test. HAS_DB-gated.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('idempotency janitor — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'idempotency-janitor-test', level: 'warn' });

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'idempotency-janitor-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  function keyRow(expiresAt: Date) {
    const now = new Date();
    return {
      key: `ik_${randomUUID()}`,
      method: 'POST',
      path: '/v1/test',
      request_hash: 'hash',
      response_status: 201,
      response_body: JSON.stringify({ ok: true }),
      locked_at: null,
      completed_at: now,
      expires_at: expiresAt,
      created_at: now,
    };
  }

  it('deletes expired rows from both tables, keeps live rows, second run is a no-op', async () => {
    const asOf = new Date();
    const past = new Date(asOf.getTime() - 1000);
    const future = new Date(asOf.getTime() + 3_600_000);

    const merchantId = newId('merchant');
    await db
      .insertInto('paycore.merchants')
      .values({
        id: merchantId,
        name: 'Janitor Test Inc',
        env: 'test',
        allowed_origins: [],
        reserve_basis_points: 0,
        payout_schedule: 'daily',
        kyb_status: 'pending',
        kyb_data: null,
        created_at: new Date(),
      })
      .execute();
    const cardholderId = newId('cardholder');
    await db
      .insertInto('paycore.cardholders')
      .values({
        id: cardholderId,
        email: `${cardholderId}@example.test`,
        full_name: 'Janitor Tester',
        phone: null,
        status: 'active',
        created_at: new Date(),
      })
      .execute();

    const mExpired = keyRow(past);
    const mLive = keyRow(future);
    await db
      .insertInto('paycore.idempotency_keys')
      .values([
        { merchant_id: merchantId, ...mExpired },
        { merchant_id: merchantId, ...mLive },
      ])
      .execute();
    const cExpired = keyRow(past);
    const cLive = keyRow(future);
    await db
      .insertInto('paycore.cardholder_idempotency_keys')
      .values([
        { cardholder_id: cardholderId, ...cExpired },
        { cardholder_id: cardholderId, ...cLive },
      ])
      .execute();

    const first = await sweepExpiredIdempotencyKeys({ db, logger }, asOf);
    expect(first.merchantDeleted).toBeGreaterThanOrEqual(1);
    expect(first.cardholderDeleted).toBeGreaterThanOrEqual(1);

    const mRows = await db
      .selectFrom('paycore.idempotency_keys')
      .select('key')
      .where('merchant_id', '=', merchantId)
      .execute();
    expect(mRows.map((r) => r.key)).toEqual([mLive.key]);
    const cRows = await db
      .selectFrom('paycore.cardholder_idempotency_keys')
      .select('key')
      .where('cardholder_id', '=', cardholderId)
      .execute();
    expect(cRows.map((r) => r.key)).toEqual([cLive.key]);

    const second = await sweepExpiredIdempotencyKeys({ db, logger }, asOf);
    expect(second).toEqual({ merchantDeleted: 0, cardholderDeleted: 0 });
  });
});
