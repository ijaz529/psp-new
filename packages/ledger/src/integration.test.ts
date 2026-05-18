import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import type { Database } from '@psp-new/db';
import { format, money } from '@psp-new/money';
import * as fc from 'fast-check';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureMerchantAccounts, pspAccount, schemeAccount } from './accounts.js';
import { balance } from './balance.js';
import { postJournal } from './post.js';
import type { Posting } from './types.js';

/**
 * Integration tests against a real Postgres. Run when `DATABASE_URL` is set
 * (compose-up locally, or the postgres service in CI). Skipped otherwise.
 *
 * Migrations are applied at suite start; the migrator is idempotent so this is
 * safe to re-run.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

describe.skipIf(!HAS_DB)('@psp-new/ledger — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'ledger-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('seeded chart of accounts is queryable', async () => {
    const row = await db
      .selectFrom('ledger.accounts')
      .selectAll()
      .where('code', '=', 'mdr_revenue')
      .where('currency', '=', 'USD')
      .where('owner_kind', '=', 'psp')
      .executeTakeFirst();
    expect(row?.id).toBe(pspAccount('mdr_revenue', 'USD'));
  });

  it('postJournal: balanced 3-line entry succeeds', async () => {
    const merchantId = `mrch_test_${unique()}`;
    await db.transaction().execute(async (trx) => {
      const m = await ensureMerchantAccounts(trx, merchantId, 'USD');
      await postJournal(trx, {
        externalId: `ext_${unique()}`,
        description: 'capture 1000 USD',
        occurredAt: new Date(),
        postings: [
          { accountId: schemeAccount('scheme_receivable', 'USD', 'visa'), amount: 1000n, currency: 'USD' },
          { accountId: m.settlementLiability, amount: -970n, currency: 'USD' },
          { accountId: pspAccount('mdr_revenue', 'USD'), amount: -30n, currency: 'USD' },
        ],
      });
    });
  });

  it('DB-level: balanced-entry trigger REJECTS an unbalanced commit', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        const merchantId = `mrch_bad_${unique()}`;
        const m = await ensureMerchantAccounts(trx, merchantId, 'USD');
        // Bypass app-side validation by calling Kysely directly — DB trigger must catch it at commit.
        const entryId = `je_test_${unique()}`;
        await trx
          .insertInto('ledger.journal_entries')
          .values({
            id: entryId,
            external_id: `ext_unbalanced_${unique()}`,
            description: 'evil',
            occurred_at: new Date(),
            created_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('ledger.journal_lines')
          .values([
            {
              id: `jl_a_${unique()}`,
              entry_id: entryId,
              account_id: pspAccount('mdr_revenue', 'USD'),
              amount: 100n,
              currency: 'USD',
              created_at: new Date(),
            },
            {
              id: `jl_b_${unique()}`,
              entry_id: entryId,
              account_id: m.settlementLiability,
              amount: -50n, // intentionally wrong — should not commit
              currency: 'USD',
              created_at: new Date(),
            },
          ])
          .execute();
      }),
    ).rejects.toThrowError(/unbalanced/);
  });

  it("DB-level: currency-mismatch trigger REJECTS line that doesn't match account currency", async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        const merchantId = `mrch_cur_${unique()}`;
        const m = await ensureMerchantAccounts(trx, merchantId, 'USD');
        const entryId = `je_cur_${unique()}`;
        await trx
          .insertInto('ledger.journal_entries')
          .values({
            id: entryId,
            external_id: `ext_cur_${unique()}`,
            description: 'wrong currency',
            occurred_at: new Date(),
            created_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('ledger.journal_lines')
          .values({
            id: `jl_cur_${unique()}`,
            entry_id: entryId,
            account_id: m.settlementLiability, // USD account
            amount: 100n,
            currency: 'EUR', // mismatch
            created_at: new Date(),
          })
          .execute();
      }),
    ).rejects.toThrowError(/does not match account currency/);
  });

  it('DB-level: journal_lines.amount = 0 is rejected by check constraint', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        const merchantId = `mrch_zero_${unique()}`;
        const m = await ensureMerchantAccounts(trx, merchantId, 'USD');
        const entryId = `je_zero_${unique()}`;
        await trx
          .insertInto('ledger.journal_entries')
          .values({
            id: entryId,
            external_id: `ext_zero_${unique()}`,
            description: 'zero',
            occurred_at: new Date(),
            created_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('ledger.journal_lines')
          .values({
            id: `jl_zero_${unique()}`,
            entry_id: entryId,
            account_id: m.settlementLiability,
            amount: 0n,
            currency: 'USD',
            created_at: new Date(),
          })
          .execute();
      }),
    ).rejects.toThrowError(/journal_lines_amount_nonzero|check/);
  });

  it('DB-level: append-only — UPDATE on journal_lines fails', async () => {
    const merchantId = `mrch_ap_${unique()}`;
    let lineId = '';
    await db.transaction().execute(async (trx) => {
      const m = await ensureMerchantAccounts(trx, merchantId, 'USD');
      const r = await postJournal(trx, {
        externalId: `ext_ap_${unique()}`,
        description: 'capture for append-only test',
        occurredAt: new Date(),
        postings: [
          { accountId: schemeAccount('scheme_receivable', 'USD', 'visa'), amount: 50n, currency: 'USD' },
          { accountId: m.settlementLiability, amount: -50n, currency: 'USD' },
        ],
      });
      const line = await trx
        .selectFrom('ledger.journal_lines')
        .select('id')
        .where('entry_id', '=', r.id)
        .executeTakeFirstOrThrow();
      lineId = line.id;
    });
    await expect(
      db.updateTable('ledger.journal_lines').set({ amount: 9999n }).where('id', '=', lineId).execute(),
    ).rejects.toThrowError(/append-only/);
    await expect(db.deleteFrom('ledger.journal_lines').where('id', '=', lineId).execute()).rejects.toThrowError(
      /append-only/,
    );
  });

  it('property: a random sequence of balanced postings sums to 0 across all generated accounts', async () => {
    const merchantId = `mrch_prop_${unique()}`;
    let accts: ReturnType<Awaited<typeof ensureMerchantAccounts>> extends never
      ? never
      : Awaited<ReturnType<typeof ensureMerchantAccounts>>;
    await db.transaction().execute(async (trx) => {
      accts = await ensureMerchantAccounts(trx, merchantId, 'USD');
    });
    const accountPool: Array<Posting['accountId']> = [
      pspAccount('mdr_revenue', 'USD'),
      pspAccount('acquirer_clearing_account', 'USD'),
      pspAccount('refund_clearing', 'USD'),
      schemeAccount('scheme_receivable', 'USD', 'visa'),
      schemeAccount('interchange_expense', 'USD', 'visa'),
      accts!.settlementLiability,
      accts!.refundReserve,
    ];

    const entryArb = fc
      .tuple(
        fc.array(fc.integer({ min: -10_000, max: 10_000 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: accountPool.length - 1 }), { minLength: 1, maxLength: 5 }),
      )
      .map(([amounts, ixs]): Posting[] => {
        // Make N postings then balance with one final closing posting.
        const n = Math.min(amounts.length, ixs.length);
        if (n === 0) return [];
        let sum = 0n;
        const postings: Posting[] = [];
        for (let i = 0; i < n; i++) {
          const amt = BigInt(amounts[i] ?? 1);
          if (amt === 0n) continue;
          sum += amt;
          postings.push({ accountId: accountPool[ixs[i] ?? 0]!, amount: amt, currency: 'USD' });
        }
        if (sum === 0n || postings.length === 0) return [];
        // Closing posting on a distinct account so we don't violate the no-zero-amount rule.
        postings.push({ accountId: accountPool[(ixs[0]! + 1) % accountPool.length]!, amount: -sum, currency: 'USD' });
        return postings;
      })
      .filter((ps) => ps.length >= 2);

    const writtenEntries: string[] = [];
    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { minLength: 1, maxLength: 30 }), async (entries) => {
        for (const postings of entries) {
          const externalId = `ext_prop_${unique()}`;
          await db.transaction().execute(async (trx) => {
            await postJournal(trx, {
              externalId,
              description: 'property',
              occurredAt: new Date(),
              postings,
            });
          });
          writtenEntries.push(externalId);
        }
      }),
      { numRuns: 5 }, // keep DB cost low; each run posts up to 30 entries
    );

    // Now read back all lines we wrote and assert sum = 0.
    const rows = await db
      .selectFrom('ledger.journal_lines')
      .innerJoin('ledger.journal_entries', 'ledger.journal_entries.id', 'ledger.journal_lines.entry_id')
      .select(['ledger.journal_lines.amount as amount', 'ledger.journal_lines.currency as currency'])
      .where('ledger.journal_entries.external_id', 'in', writtenEntries)
      .execute();
    const sumByCurrency = new Map<string, bigint>();
    for (const r of rows) {
      const a = typeof r.amount === 'bigint' ? r.amount : BigInt(r.amount as unknown as string);
      sumByCurrency.set(r.currency, (sumByCurrency.get(r.currency) ?? 0n) + a);
    }
    for (const [cur, sum] of sumByCurrency) {
      expect({ currency: cur, sum: sum.toString() }).toEqual({ currency: cur, sum: '0' });
    }
  }, 60_000);

  it('demo — capture + refund prints a Ledger Tape and asserts balances', async () => {
    const merchantId = `mrch_demo_${unique()}`;
    let m!: Awaited<ReturnType<typeof ensureMerchantAccounts>>;
    let captureId: string;
    let refundId: string;
    await db.transaction().execute(async (trx) => {
      m = await ensureMerchantAccounts(trx, merchantId, 'USD');
      const capture = await postJournal(trx, {
        externalId: `ext_demo_capture_${unique()}`,
        description: 'capture 1000 USD on visa for merchant',
        occurredAt: new Date(),
        postings: [
          { accountId: schemeAccount('scheme_receivable', 'USD', 'visa'), amount: 1000n, currency: 'USD' },
          { accountId: m.settlementLiability, amount: -970n, currency: 'USD' },
          { accountId: pspAccount('mdr_revenue', 'USD'), amount: -30n, currency: 'USD' },
        ],
      });
      captureId = capture.id;
      const refund = await postJournal(trx, {
        externalId: `ext_demo_refund_${unique()}`,
        description: 'refund 200 USD on visa for merchant',
        occurredAt: new Date(),
        postings: [
          { accountId: schemeAccount('scheme_receivable', 'USD', 'visa'), amount: -200n, currency: 'USD' },
          { accountId: m.settlementLiability, amount: 194n, currency: 'USD' },
          { accountId: pspAccount('mdr_revenue', 'USD'), amount: 6n, currency: 'USD' },
        ],
      });
      refundId = refund.id;
    });

    const settlementBal = await balance(db, m.settlementLiability, { freshness: 'live' });
    // Net settlement liability for this merchant in this test: -970 + 194 = -776 USD
    expect(settlementBal.amount).toBe(-776n);
    expect(settlementBal.currency).toBe('USD');

    const tape = [
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      '┃                       LEDGER TAPE  (phase-1 demo)              ┃',
      '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫',
      `┃ merchant:                 ${merchantId.padEnd(34)} ┃`,
      `┃ capture entry:            ${captureId!.padEnd(34)} ┃`,
      `┃   Dr scheme_receivable (visa, USD)           ${format(money(1000n, 'USD')).padStart(14)} ┃`,
      `┃   Cr merchant_settlement_liability           ${format(money(-970n, 'USD')).padStart(14)} ┃`,
      `┃   Cr mdr_revenue (psp, USD)                  ${format(money(-30n, 'USD')).padStart(14)} ┃`,
      '┃                                                                ┃',
      `┃ refund entry:             ${refundId!.padEnd(34)} ┃`,
      `┃   Cr scheme_receivable (visa, USD)           ${format(money(-200n, 'USD')).padStart(14)} ┃`,
      `┃   Dr merchant_settlement_liability           ${format(money(194n, 'USD')).padStart(14)} ┃`,
      `┃   Dr mdr_revenue (psp, USD)                  ${format(money(6n, 'USD')).padStart(14)} ┃`,
      '┃                                                                ┃',
      `┃ net settlement liability: ${format(settlementBal).padStart(34)} ┃`,
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    ].join('\n');
    console.log(`\n${tape}\n`);
  });
});

let counter = 0n;
function unique(): string {
  counter += 1n;
  return `${Date.now().toString(36)}_${counter.toString(36)}`;
}
