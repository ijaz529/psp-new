import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import { postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import { createLogger } from '@psp-new/logger';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepClearingAdjustments } from './clearing-adjustments-sweep-job.js';

/**
 * Phase 24 integration test. HAS_DB-gated.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('clearing-adjustments sweep — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  const logger = createLogger({ service: 'clearing-sweep-test', level: 'warn' });

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'clearing-sweep-test' });
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

  it('sweeps non-zero clearing balances to adjustment_revenue; re-run same day is no-op', async () => {
    const clearingAcct = pspAccount('clearing_adjustments', 'USD');
    const revenueAcct = pspAccount('adjustment_revenue', 'USD');
    const visaRecv = schemeAccount('scheme_receivable', 'USD', 'visa');

    // Per-run unique UTC day: the sweep's idempotency key is (day, currency),
    // so a fixed date would collide with previous runs against the same dev DB.
    const fixedAsOf = new Date(Date.UTC(2030, 0, 1) + (Date.now() % 2_000_000) * 86_400_000);

    // The sweep drains the ENTIRE clearing balance, so any leftover from a
    // previous aborted run would skew the deltas below. Drain it first on a
    // different UTC day.
    await sweepClearingAdjustments({ db, logger }, new Date(fixedAsOf.getTime() - 86_400_000));

    const clearingBefore = await bal(clearingAcct);
    const revenueBefore = await bal(revenueAcct);

    // Seed a Phase 21-shaped adjustment: scheme_receivable +700 / clearing_adjustments -700.
    await db.transaction().execute(async (trx) => {
      await postJournal(trx, {
        externalId: `seed_adjust:${Date.now()}`,
        description: 'seed clearing adjust',
        occurredAt: new Date(),
        postings: [
          { accountId: visaRecv, amount: 700n, currency: 'USD' },
          { accountId: clearingAcct, amount: -700n, currency: 'USD' },
        ],
      });
    });
    expect(await bal(clearingAcct)).toBe(clearingBefore - 700n);

    const result1 = await sweepClearingAdjustments({ db, logger }, fixedAsOf);
    expect(result1.swept).toBeGreaterThanOrEqual(1);

    // clearing_adjustments back to whatever it was before the seed (delta drained).
    expect(await bal(clearingAcct)).toBe(clearingBefore);
    // adjustment_revenue moved by -delta = +700 in the negation pattern. The
    // sweep posts adjustment_revenue: -delta = -(-(-700)) = -700 (negative
    // posting on REVENUE = balance more negative = more revenue earned).
    expect(await bal(revenueAcct)).toBe(revenueBefore - 700n);

    // Re-run same UTC day for the same currency: no-op (unique externalId).
    const result2 = await sweepClearingAdjustments({ db, logger }, fixedAsOf);
    expect(result2.swept).toBe(0);
    expect(await bal(clearingAcct)).toBe(clearingBefore);
    expect(await bal(revenueAcct)).toBe(revenueBefore - 700n);
  });
});
