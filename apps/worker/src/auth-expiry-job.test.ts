import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { postJournal } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireStaleAuthHolds } from './auth-expiry-job.js';

/**
 * Phase 13 integration test. Mirrors the issuer-host test shape from Phase 10.
 * Gated by DATABASE_URL so it no-ops outside the compose stack.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe.skipIf(!HAS_DB)('auth-expiry sweeper — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'auth-expiry-test', level: 'warn' });

  let cardId: string;
  let fundedAcct: string;
  let holdsAcct: string;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'auth-expiry-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);

    const cardholderId = newId('cardholder');
    cardId = newId('card');
    fundedAcct = newId('account');
    holdsAcct = newId('account');
    const now = new Date();

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.cardholders')
        .values({
          id: cardholderId,
          email: `expire-${Date.now()}@e.com`,
          full_name: 'Expire Test',
          phone: null,
          status: 'active',
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('ledger.accounts')
        .values([
          {
            id: fundedAcct,
            code: 'cardholder_funded',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: cardId,
            metadata: null,
            created_at: now,
          },
          {
            id: holdsAcct,
            code: 'cardholder_holds',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: cardId,
            metadata: null,
            created_at: now,
          },
        ])
        .execute();
      await trx
        .insertInto('paycore.cards')
        .values({
          id: cardId,
          product_id: 'prod_strawberry_visa_usd',
          cardholder_id: cardholderId,
          pan_token: newId('token'),
          bin: '411111',
          last4: '0042',
          exp_month: '12',
          exp_year: '2030',
          status: 'active',
          controls: {},
          funded_account_id: fundedAcct,
          holds_account_id: holdsAcct,
          created_at: now,
        })
        .execute();
    });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  function bal(acct: string): Promise<bigint> {
    return db
      .selectFrom('ledger.account_balances')
      .select('balance')
      .where('account_id', '=', acct)
      .executeTakeFirst()
      .then((r) => (r as { balance: bigint } | undefined)?.balance ?? 0n);
  }

  async function seedOpenHold(amount: bigint, createdAt: Date, suffix: string): Promise<string> {
    const id = newId('card_auth_hold');
    await db.transaction().execute(async (trx) => {
      // Mirror the issuer-host AUTH posting (funded → holds) so the ledger is consistent.
      await postJournal(trx, {
        externalId: `seed_hold:${id}`,
        description: `seed open hold ${id}`,
        occurredAt: createdAt,
        postings: [
          { accountId: fundedAcct as never, amount: -amount, currency: 'USD' },
          { accountId: holdsAcct as never, amount: amount, currency: 'USD' },
        ],
      });
      await trx
        .insertInto('paycore.card_auth_holds')
        .values({
          id,
          card_id: cardId,
          stan: `9${suffix.padStart(5, '0')}`.slice(0, 6),
          rrn: `9${suffix.padStart(11, '0')}`.slice(0, 12),
          amount,
          currency: 'USD',
          merchant_name: 'expiry-test',
          mcc: null,
          approval_code: 'APPR00',
          created_at: createdAt,
          resolved_at: null,
          resolved_reason: null,
        })
        .execute();
    });
    return id;
  }

  it('expires holds older than the window; leaves fresh holds alone', async () => {
    const fundedBefore = await bal(fundedAcct);
    const holdsBefore = await bal(holdsAcct);

    const staleHoldId = await seedOpenHold(700n, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), '1001');
    const freshHoldId = await seedOpenHold(300n, new Date(), '1002');

    const fundedAfterSeed = await bal(fundedAcct);
    const holdsAfterSeed = await bal(holdsAcct);
    expect(fundedAfterSeed).toBe(fundedBefore - 1000n);
    expect(holdsAfterSeed).toBe(holdsBefore + 1000n);

    const result = await expireStaleAuthHolds({ db, logger }, { windowMs: SEVEN_DAYS_MS });
    expect(result.scanned).toBe(1);
    expect(result.expired).toBe(1);

    // Funded returned by the stale hold amount (700); fresh hold untouched.
    expect(await bal(fundedAcct)).toBe(fundedAfterSeed + 700n);
    expect(await bal(holdsAcct)).toBe(holdsAfterSeed - 700n);

    const stale = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('id', '=', staleHoldId)
      .executeTakeFirstOrThrow();
    expect(stale.resolved_reason).toBe('expired');
    expect(stale.resolved_at).not.toBeNull();

    const fresh = await db
      .selectFrom('paycore.card_auth_holds')
      .selectAll()
      .where('id', '=', freshHoldId)
      .executeTakeFirstOrThrow();
    expect(fresh.resolved_at).toBeNull();
  });

  it('re-running the sweeper is a no-op for already-expired holds', async () => {
    const fundedBefore = await bal(fundedAcct);
    const holdsBefore = await bal(holdsAcct);

    const result = await expireStaleAuthHolds({ db, logger }, { windowMs: SEVEN_DAYS_MS });
    expect(result.scanned).toBe(0); // first test already cleared the stale row
    expect(result.expired).toBe(0);

    expect(await bal(fundedAcct)).toBe(fundedBefore);
    expect(await bal(holdsAcct)).toBe(holdsBefore);
  });
});
