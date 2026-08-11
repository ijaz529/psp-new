import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { newId } from '@psp-new/ids';
import { ensureMerchantAccounts, postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPayout } from './index.js';

/**
 * Phase 43 — a payout must equal the merchant's settlement liability.
 * Reproduces the Phase 42 canary scenario. HAS_DB-gated.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

describe.skipIf(!HAS_DB)('runPayout — nets from the ledger', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'payouts-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMerchant(): Promise<string> {
    const id = newId('merchant');
    await db
      .insertInto('paycore.merchants')
      .values({
        id,
        name: 'Payout Test Inc',
        env: 'test',
        allowed_origins: [],
        reserve_basis_points: 0,
        payout_schedule: 'daily',
        kyb_status: 'approved',
        kyb_data: null,
        created_at: new Date(),
      })
      .execute();
    return id;
  }

  function liabilityBalance(accountId: string): Promise<bigint> {
    return db
      .selectFrom('ledger.journal_lines')
      .select((eb) => eb.fn.sum<bigint | string | null>('amount').as('total'))
      .where('account_id', '=', accountId)
      .executeTakeFirst()
      .then((r) => BigInt((r as { total: bigint | string | null } | undefined)?.total ?? 0n));
  }

  it('pays the full settlement liability after a capture and a partial refund', async () => {
    const merchantId = await makeMerchant();
    const scheduledFor = new Date();

    // Capture 10000 then refund 2500 — the exact Phase 42 canary numbers,
    // postings spelled out (MDR 300bps) so the expected liability is explicit:
    // -(10000-300) + (2500-75) = -7275.
    const recv = schemeAccount('scheme_receivable', 'USD', 'visa');
    const mdr = pspAccount('mdr_revenue', 'USD');
    const accounts = await db.transaction().execute(async (trx) => {
      const a = await ensureMerchantAccounts(trx, merchantId, 'USD');
      await postJournal(trx, {
        externalId: `test_capture:${merchantId}`,
        description: 'test capture',
        occurredAt: new Date(),
        postings: [
          { accountId: recv, amount: 10000n, currency: 'USD' },
          { accountId: a.settlementLiability, amount: -9700n, currency: 'USD' },
          { accountId: mdr, amount: -300n, currency: 'USD' },
        ],
      });
      await postJournal(trx, {
        externalId: `test_refund:${merchantId}`,
        description: 'test refund',
        occurredAt: new Date(),
        postings: [
          { accountId: recv, amount: -2500n, currency: 'USD' },
          { accountId: a.settlementLiability, amount: 2425n, currency: 'USD' },
          { accountId: mdr, amount: 75n, currency: 'USD' },
        ],
      });
      return a;
    });

    expect(await liabilityBalance(accounts.settlementLiability)).toBe(-7275n);

    const r = await runPayout({ db, merchantId, currency: 'USD', scheduledFor });
    expect(r.status).toBe('paid');
    // Before Phase 43 this was 5000: amount_received (already refund-decremented)
    // minus refunds again, and gross rather than MDR-net.
    expect(r.amount).toBe(7275n);

    // The payout drains the liability to exactly zero — the docstring's promise.
    expect(await liabilityBalance(accounts.settlementLiability)).toBe(0n);
  });

  it('skips when the merchant owes us (positive liability balance)', async () => {
    const merchantId = await makeMerchant();
    const accounts = await db.transaction().execute(async (trx) => {
      const a = await ensureMerchantAccounts(trx, merchantId, 'USD');
      // Refund with no prior capture — liability goes positive.
      await postJournal(trx, {
        externalId: `test_refund_only:${merchantId}`,
        description: 'refund only',
        occurredAt: new Date(),
        postings: [
          { accountId: schemeAccount('scheme_receivable', 'USD', 'visa'), amount: -1000n, currency: 'USD' },
          { accountId: a.settlementLiability, amount: 970n, currency: 'USD' },
          { accountId: pspAccount('mdr_revenue', 'USD'), amount: 30n, currency: 'USD' },
        ],
      });
      return a;
    });

    expect(await liabilityBalance(accounts.settlementLiability)).toBe(970n);
    const r = await runPayout({ db, merchantId, currency: 'USD', scheduledFor: new Date() });
    expect(r.status).toBe('skipped');
    expect(r.amount).toBe(0n);
  });
});
