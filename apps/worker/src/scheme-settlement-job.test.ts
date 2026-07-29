import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { ensureMerchantAccounts, postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settleSchemeReceivables } from './scheme-settlement-job.js';

/**
 * Phase 15 integration test. Mirrors the auth-expiry + pool-reconciliation
 * test shapes. Gated by DATABASE_URL so it no-ops outside the compose stack.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('scheme-settlement sweeper — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'scheme-settle-test', level: 'warn' });

  // Per-run unique UTC day: the settle job's idempotency key is
  // (day, scheme, currency), so fixed dates would collide with previous
  // runs against the same dev DB.
  const SETTLE_DAY = Date.UTC(2030, 0, 1) + (Date.now() % 2_000_000) * 86_400_000;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'scheme-settle-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function bal(acctId: string): Promise<bigint> {
    // account_balances is a materialized view refreshed by a periodic job in
    // production; tests must refresh it themselves before reading.
    await sql`refresh materialized view ledger.account_balances`.execute(db);
    return db
      .selectFrom('ledger.account_balances')
      .select('balance')
      .where('account_id', '=', acctId)
      .executeTakeFirst()
      .then((r) => (r as { balance: bigint } | undefined)?.balance ?? 0n);
  }

  it('drains positive scheme_receivable into psp_cash_at_bank; re-running same day is no-op', async () => {
    const visaUsdReceivable = schemeAccount('scheme_receivable', 'USD', 'visa');
    const cashUsd = pspAccount('psp_cash_at_bank', 'USD');

    // Earlier test files leave scheme_receivable balances behind; drain them
    // on a different UTC day so the balance deltas below are exact.
    await settleSchemeReceivables({ db, logger }, new Date(SETTLE_DAY - 86_400_000));

    const recBefore = await bal(visaUsdReceivable);
    const cashBefore = await bal(cashUsd);

    // Simulate a successful capture: scheme_receivable +5000, merchant settlement -4850, mdr_revenue -150.
    const merchantId = `mrch_settle_${Date.now()}`;
    await db.transaction().execute(async (trx) => {
      const accts = await ensureMerchantAccounts(trx, merchantId, 'USD');
      await postJournal(trx, {
        externalId: `seed_capture:${merchantId}`,
        description: 'seed capture for scheme settlement test',
        occurredAt: new Date(),
        postings: [
          { accountId: visaUsdReceivable, amount: 5000n, currency: 'USD' },
          { accountId: accts.settlementLiability, amount: -4850n, currency: 'USD' },
          { accountId: pspAccount('mdr_revenue', 'USD'), amount: -150n, currency: 'USD' },
        ],
      });
    });

    const recAfterSeed = await bal(visaUsdReceivable);
    expect(recAfterSeed).toBe(recBefore + 5000n);

    // First run: drains the receivable into cash.
    const fixedAsOf = new Date(SETTLE_DAY);
    const result1 = await settleSchemeReceivables({ db, logger }, fixedAsOf);
    expect(result1.settled).toBeGreaterThanOrEqual(1); // at least the visa/USD combo we just seeded

    expect(await bal(visaUsdReceivable)).toBe(0n);
    expect(await bal(cashUsd)).toBe(cashBefore + 5000n);

    // Second run same UTC day: no new journals (unique externalId), no balance change.
    const result2 = await settleSchemeReceivables({ db, logger }, fixedAsOf);
    expect(result2.settled).toBe(0);

    expect(await bal(visaUsdReceivable)).toBe(0n);
    expect(await bal(cashUsd)).toBe(cashBefore + 5000n);
  });

  it('does not post journals for zero-balance schemes', async () => {
    // After the previous test, visa/USD is 0. Run the sweeper on a different
    // UTC day — there should be nothing to settle (assuming no other test
    // seeded another scheme).
    const fixedAsOf = new Date(SETTLE_DAY + 86_400_000);
    const result = await settleSchemeReceivables({ db, logger }, fixedAsOf);
    // 'scanned' counts rows with balance > 0; if other tests in the suite
    // happened to leave a non-zero balance we just confirm settled === scanned.
    expect(result.settled).toBe(result.scanned);
  });
});
