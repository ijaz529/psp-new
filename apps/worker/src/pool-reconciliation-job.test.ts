import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { postJournal, pspAccount } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileCardLoads } from './pool-reconciliation-job.js';

/**
 * Phase 14 integration test. Mirrors the auth-expiry test shape from Phase 13.
 * Gated by DATABASE_URL so it no-ops outside the compose stack.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('pool-reconciliation sweeper — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'pool-recon-test', level: 'warn' });

  let cardId: string;
  let cardholderId: string;
  let fundedAcct: string;
  let holdsAcct: string;
  let merchantId: string;
  let paymentMethodId: string;
  let customerId: string;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'pool-recon-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);

    cardholderId = newId('cardholder');
    cardId = newId('card');
    fundedAcct = newId('account');
    holdsAcct = newId('account');
    merchantId = `mrch_recon_${Date.now()}`;
    customerId = newId('customer');
    paymentMethodId = newId('payment_method');
    const now = new Date();

    await db.transaction().execute(async (trx) => {
      // Cardholder + card
      await trx
        .insertInto('paycore.cardholders')
        .values({
          id: cardholderId,
          email: `recon-${Date.now()}@e.com`,
          full_name: 'Recon Test',
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
          last4: '0043',
          exp_month: '12',
          exp_year: '2030',
          status: 'active',
          controls: {},
          funded_account_id: fundedAcct,
          holds_account_id: holdsAcct,
          created_at: now,
        })
        .execute();

      // Minimal merchant + payment_method so the card_loads FK satisfies.
      await trx
        .insertInto('paycore.merchants')
        .values({
          id: merchantId,
          name: 'recon-test',
          env: 'test',
          allowed_origins: [],
          reserve_basis_points: 0,
          payout_schedule: 'daily',
          kyb_status: 'approved',
          kyb_data: null,
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('paycore.customers')
        .values({
          id: customerId,
          merchant_id: merchantId,
          email: null,
          name: null,
          description: null,
          metadata: null,
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('paycore.payment_methods')
        .values({
          id: paymentMethodId,
          merchant_id: merchantId,
          customer_id: customerId,
          token_id: newId('token'),
          bin: '411111',
          last4: '1111',
          scheme: 'visa',
          exp_month: '12',
          exp_year: '2030',
          created_at: now,
        })
        .execute();
    });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function bal(acct: string): Promise<bigint> {
    // account_balances is a materialized view refreshed by a periodic job in
    // production; tests must refresh it themselves before reading.
    await sql`refresh materialized view ledger.account_balances`.execute(db);
    return db
      .selectFrom('ledger.account_balances')
      .select('balance')
      .where('account_id', '=', acct)
      .executeTakeFirst()
      .then((r) => (r as { balance: bigint } | undefined)?.balance ?? 0n);
  }

  async function seedSucceededLoad(amount: bigint): Promise<string> {
    const loadId = newId('card_load');
    await db.transaction().execute(async (trx) => {
      // Mirror Phase 11's load journal: cardholder_funded +X, issuer_funded_pool -X.
      const poolAcct = pspAccount('issuer_funded_pool', 'USD');
      const entry = await postJournal(trx, {
        externalId: `test_load:${loadId}`,
        description: `seed succeeded card_load ${loadId}`,
        occurredAt: new Date(),
        postings: [
          { accountId: fundedAcct as never, amount, currency: 'USD' },
          { accountId: poolAcct, amount: -amount, currency: 'USD' },
        ],
      });
      await trx
        .insertInto('paycore.card_loads')
        .values({
          id: loadId,
          card_id: cardId,
          payment_method_id: paymentMethodId,
          amount,
          currency: 'USD',
          status: 'succeeded',
          response_code: '00',
          rrn: '601201000001',
          stan: '000001',
          failure_code: null,
          failure_message: null,
          journal_entry_id: entry.id,
          reconciled_at: null,
          created_at: new Date(),
        })
        .execute();
    });
    return loadId;
  }

  async function seedFailedLoad(amount: bigint): Promise<string> {
    const loadId = newId('card_load');
    await db
      .insertInto('paycore.card_loads')
      .values({
        id: loadId,
        card_id: cardId,
        payment_method_id: paymentMethodId,
        amount,
        currency: 'USD',
        status: 'failed',
        response_code: '51',
        rrn: null,
        stan: null,
        failure_code: 'card_declined',
        failure_message: 'insufficient funds',
        journal_entry_id: null,
        reconciled_at: null,
        created_at: new Date(),
      })
      .execute();
    return loadId;
  }

  it('reconciles succeeded loads: pool refilled, cash drained, row marked; ignores failed loads', async () => {
    const poolAcct = pspAccount('issuer_funded_pool', 'USD');
    const cashAcct = pspAccount('psp_cash_at_bank', 'USD');

    // Earlier test files leave unreconciled card_loads behind; drain them so
    // the scanned/reconciled counts and balance deltas below are exact.
    await reconcileCardLoads({ db, logger });

    const poolBefore = await bal(poolAcct);
    const cashBefore = await bal(cashAcct);

    const succeededId = await seedSucceededLoad(2500n);
    const failedId = await seedFailedLoad(1500n);

    const poolAfterSeed = await bal(poolAcct);
    expect(poolAfterSeed).toBe(poolBefore - 2500n);

    const result = await reconcileCardLoads({ db, logger });
    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);

    // Pool refilled to pre-load level; cash drained by the load amount.
    expect(await bal(poolAcct)).toBe(poolBefore);
    expect(await bal(cashAcct)).toBe(cashBefore - 2500n);

    const succeededRow = await db
      .selectFrom('paycore.card_loads')
      .selectAll()
      .where('id', '=', succeededId)
      .executeTakeFirstOrThrow();
    expect(succeededRow.reconciled_at).not.toBeNull();

    // Failed load is unchanged.
    const failedRow = await db
      .selectFrom('paycore.card_loads')
      .selectAll()
      .where('id', '=', failedId)
      .executeTakeFirstOrThrow();
    expect(failedRow.reconciled_at).toBeNull();
  });

  it('re-running the sweeper is a no-op', async () => {
    const poolAcct = pspAccount('issuer_funded_pool', 'USD');
    const cashAcct = pspAccount('psp_cash_at_bank', 'USD');
    const poolBefore = await bal(poolAcct);
    const cashBefore = await bal(cashAcct);

    const result = await reconcileCardLoads({ db, logger });
    expect(result.scanned).toBe(0); // first test already cleared the only succeeded row
    expect(result.reconciled).toBe(0);

    expect(await bal(poolAcct)).toBe(poolBefore);
    expect(await bal(cashAcct)).toBe(cashBefore);
  });
});
