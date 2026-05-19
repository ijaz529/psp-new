import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileCardLoadAcquiring } from './card-load-acquiring-job.js';

/**
 * Phase 17 integration test. Mirrors the pool-reconciliation test shape.
 * Gated by DATABASE_URL so it no-ops outside the compose stack.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('card-load-acquiring sweeper — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'card-load-acq-test', level: 'warn' });

  let cardId: string;
  let cardholderId: string;
  let fundedAcct: string;
  let holdsAcct: string;
  let merchantId: string;
  let paymentMethodId: string;
  let customerId: string;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'card-load-acq-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);

    cardholderId = newId('cardholder');
    cardId = newId('card');
    fundedAcct = newId('account');
    holdsAcct = newId('account');
    merchantId = `mrch_acq_${Date.now()}`;
    customerId = newId('customer');
    paymentMethodId = newId('payment_method');
    const now = new Date();

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.cardholders')
        .values({
          id: cardholderId,
          email: `acq-${Date.now()}@e.com`,
          full_name: 'Acquiring Test',
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
          last4: '0044',
          exp_month: '12',
          exp_year: '2030',
          status: 'active',
          controls: {},
          funded_account_id: fundedAcct,
          holds_account_id: holdsAcct,
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('paycore.merchants')
        .values({
          id: merchantId,
          name: 'acq-test',
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

  function bal(acct: string): Promise<bigint> {
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
      // Mirror Phase 11's load journal so the test data matches what real
      // loads look like. The acquiring leg is what THIS sweeper will add.
      const poolAcct = pspAccount('issuer_funded_pool', 'USD');
      const entry = await postJournal(trx, {
        externalId: `test_load_acq:${loadId}`,
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
          acquiring_reconciled_at: null,
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
        acquiring_reconciled_at: null,
        created_at: new Date(),
      })
      .execute();
    return loadId;
  }

  it('posts acquiring leg for succeeded loads; ignores failed; re-run is no-op', async () => {
    const recvAcct = schemeAccount('scheme_receivable', 'USD', 'visa');
    const clearAcct = pspAccount('external_load_clearing', 'USD');

    const recvBefore = await bal(recvAcct);
    const clearBefore = await bal(clearAcct);

    const succeededId = await seedSucceededLoad(2500n);
    const failedId = await seedFailedLoad(1500n);

    const result = await reconcileCardLoadAcquiring({ db, logger });
    expect(result.reconciled).toBe(1);
    expect(result.scanned).toBe(1);

    // Acquiring leg posted: scheme_receivable +2500, external_load_clearing -2500.
    expect(await bal(recvAcct)).toBe(recvBefore + 2500n);
    expect(await bal(clearAcct)).toBe(clearBefore - 2500n);

    // Succeeded row marked reconciled; failed row untouched.
    const succeededRow = await db
      .selectFrom('paycore.card_loads')
      .selectAll()
      .where('id', '=', succeededId)
      .executeTakeFirstOrThrow();
    expect(succeededRow.acquiring_reconciled_at).not.toBeNull();
    const failedRow = await db
      .selectFrom('paycore.card_loads')
      .selectAll()
      .where('id', '=', failedId)
      .executeTakeFirstOrThrow();
    expect(failedRow.acquiring_reconciled_at).toBeNull();

    // Re-run is a clean no-op.
    const result2 = await reconcileCardLoadAcquiring({ db, logger });
    expect(result2.scanned).toBe(0);
    expect(result2.reconciled).toBe(0);
    expect(await bal(recvAcct)).toBe(recvBefore + 2500n);
    expect(await bal(clearAcct)).toBe(clearBefore - 2500n);
  });

  it('Phase 23: posts to per-card stored_value when cards.stored_value_account_id is set', async () => {
    // Seed a second card WITH a per-card stored_value account, and a load
    // against it. The legacy card seeded in beforeAll has stored_value_account_id
    // NULL so it'll keep using PSP-level clearing.
    const newCardId = newId('card');
    const newFundedAcct = newId('account');
    const newHoldsAcct = newId('account');
    const newStoredValueAcct = newId('account');
    const newCardholderId = newId('cardholder');
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('paycore.cardholders')
        .values({
          id: newCardholderId,
          email: `acq2-${Date.now()}@e.com`,
          full_name: 'Per-card Test',
          phone: null,
          status: 'active',
          created_at: now,
        })
        .execute();
      await trx
        .insertInto('ledger.accounts')
        .values([
          {
            id: newFundedAcct,
            code: 'cardholder_funded',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: newCardId,
            metadata: null,
            created_at: now,
          },
          {
            id: newHoldsAcct,
            code: 'cardholder_holds',
            type: 'ASSET',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: newCardId,
            metadata: null,
            created_at: now,
          },
          {
            id: newStoredValueAcct,
            code: 'cardholder_stored_value',
            type: 'LIABILITY',
            currency: 'USD',
            owner_kind: 'issuer',
            owner_id: newCardId,
            metadata: null,
            created_at: now,
          },
        ])
        .execute();
      await trx
        .insertInto('paycore.cards')
        .values({
          id: newCardId,
          product_id: 'prod_strawberry_visa_usd',
          cardholder_id: newCardholderId,
          pan_token: newId('token'),
          bin: '411111',
          last4: '0099',
          exp_month: '12',
          exp_year: '2030',
          status: 'active',
          controls: {},
          funded_account_id: newFundedAcct,
          holds_account_id: newHoldsAcct,
          stored_value_account_id: newStoredValueAcct,
          created_at: now,
        })
        .execute();
    });

    const loadId = newId('card_load');
    await db.transaction().execute(async (trx) => {
      const poolAcct = pspAccount('issuer_funded_pool', 'USD');
      const entry = await postJournal(trx, {
        externalId: `test_load_acq_phase23:${loadId}`,
        description: `seed succeeded card_load ${loadId}`,
        occurredAt: new Date(),
        postings: [
          { accountId: newFundedAcct as never, amount: 4000n, currency: 'USD' },
          { accountId: poolAcct, amount: -4000n, currency: 'USD' },
        ],
      });
      await trx
        .insertInto('paycore.card_loads')
        .values({
          id: loadId,
          card_id: newCardId,
          payment_method_id: paymentMethodId,
          amount: 4000n,
          currency: 'USD',
          status: 'succeeded',
          response_code: '00',
          rrn: '601201000099',
          stan: '000099',
          failure_code: null,
          failure_message: null,
          journal_entry_id: entry.id,
          reconciled_at: null,
          acquiring_reconciled_at: null,
          created_at: new Date(),
        })
        .execute();
    });

    const recvAcct = schemeAccount('scheme_receivable', 'USD', 'visa');
    const pspClearAcct = pspAccount('external_load_clearing', 'USD');
    const recvBefore = await bal(recvAcct);
    const pspClearBefore = await bal(pspClearAcct);
    const perCardBefore = await bal(newStoredValueAcct);

    const result = await reconcileCardLoadAcquiring({ db, logger });
    expect(result.reconciled).toBe(1);

    // scheme_receivable +X (same as legacy path)
    expect(await bal(recvAcct)).toBe(recvBefore + 4000n);
    // PSP-level clearing UNCHANGED — credit went to per-card stored_value instead
    expect(await bal(pspClearAcct)).toBe(pspClearBefore);
    // Per-card stored_value -X (LIABILITY balance more negative)
    expect(await bal(newStoredValueAcct)).toBe(perCardBefore - 4000n);
  });
});
