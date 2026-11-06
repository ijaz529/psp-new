import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClearingTransaction, collectClearingTransactionsForDate, emitClearingFiles } from './index.js';

/**
 * Phase 46/47 integration tests. HAS_DB-gated.
 *
 * The unit tests mock Kysely, so they cannot prove the `clearing_files`
 * lookup matches a row Postgres stored in a `date` column, nor that the
 * collector's `not exists` actually excludes what has already cleared.
 * Only a real database proves either.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

/** A UTC day nothing else has used, so the unique index cannot collide. */
function uniqueDay(offsetDays = 0): Date {
  return new Date(Date.UTC(2040, 0, 1) + ((Date.now() % 1_000_000) + offsetDays) * 86_400_000);
}
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

describe.skipIf(!HAS_DB)('clearing files against a real database', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;

  beforeAll(async () => {
    pool = createPool({ ...dbConfigFromEnv(), applicationName: 'clearing-rerun-test' });
    db = createKysely(pool);
    await migrateUp(pool, MIGRATIONS_DIR);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('cuts a supplementary file rather than rewriting the one already submitted', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'clearing-seq-db-'));
    try {
      const fileDate = uniqueDay();
      const dateStr = ymd(fileDate);
      const stamp = Date.now();

      const first: ClearingTransaction = {
        paymentIntentId: `pi_seq_a_${stamp}`,
        merchantId: 'mrch_seq',
        scheme: 'visa',
        currency: 'USD',
        amount: 7500n,
        rrn: '631001000001',
        occurredAt: fileDate,
      };
      const straggler: ClearingTransaction = {
        paymentIntentId: `pi_seq_b_${stamp}`,
        merchantId: 'mrch_seq',
        scheme: 'visa',
        currency: 'USD',
        amount: 3300n,
        rrn: '631001000003',
        occurredAt: fileDate,
      };
      const eur: ClearingTransaction = {
        paymentIntentId: `pi_seq_c_${stamp}`,
        merchantId: 'mrch_seq',
        scheme: 'visa',
        currency: 'EUR',
        amount: 4500n,
        rrn: '631001000002',
        occurredAt: fileDate,
      };

      // Run 1 — the day's first submission.
      const run1 = await emitClearingFiles({ db, transactions: [first], fileDate, outputDir: tmp });
      expect(run1).toHaveLength(1);
      expect(run1[0]?.sequence).toBe(1);
      const path1 = join(tmp, `visa_usd_${dateStr}_001.b2`);
      expect(run1[0]?.path).toBe(path1);
      const contentAfterRun1 = await readFile(path1, 'utf8');

      // Run 2 — the straggler plus a currency that has never been cut. The
      // caller passes only uncleared transactions, so `first` is absent.
      const run2 = await emitClearingFiles({ db, transactions: [straggler, eur], fileDate, outputDir: tmp });

      // USD continues at 002, carrying only the straggler. 001 is untouched.
      const usd2 = run2.find((f) => f.currency === 'USD');
      expect(usd2?.sequence).toBe(2);
      expect(usd2?.recordCount).toBe(1);
      expect(usd2?.totalAmount).toBe(3300n);
      expect(await readFile(path1, 'utf8')).toBe(contentAfterRun1);
      const content2 = await readFile(join(tmp, `visa_usd_${dateStr}_002.b2`), 'utf8');
      expect(content2).toContain(straggler.paymentIntentId);
      expect(content2).not.toContain(first.paymentIntentId);

      // EUR has no file for the day, so it starts at 1.
      expect(run2.find((f) => f.currency === 'EUR')?.sequence).toBe(1);

      // Three rows, and each describes the file actually on disk.
      const rows = await db
        .selectFrom('paycore.clearing_files')
        .select(['id', 'currency', 'sequence', 'record_count', 'total_amount', 'path'])
        .where('file_date', '=', fileDate)
        .where('scheme', '=', 'visa')
        .orderBy('currency')
        .orderBy('sequence')
        .execute();
      expect(rows.map((r) => `${r.currency}#${r.sequence}`)).toEqual(['EUR#1', 'USD#1', 'USD#2']);

      for (const row of rows) {
        const content = await readFile(row.path, 'utf8');
        // Base II trailer: TC 90 TCR 1, record count then total amount.
        const trailer = content.trim().split('\n').at(-1) ?? '';
        expect(trailer.startsWith('901')).toBe(true);
        expect(trailer).toContain(String(row.record_count).padStart(10, '0'));
        expect(trailer).toContain(BigInt(row.total_amount).toString().padStart(12, '0'));

        const recs = await db
          .selectFrom('paycore.clearing_records')
          .select('id')
          .where('clearing_file_id', '=', row.id)
          .execute();
        expect(recs).toHaveLength(row.record_count);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('never offers a transaction that is already in a clearing record', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'clearing-notexists-'));
    try {
      const day = uniqueDay(1);
      const stamp = Date.now();
      const merchantId = `mrch_ne_${stamp}`;
      const pmId = `pm_ne_${stamp}`;
      const cleared = `pi_ne_cleared_${stamp}`;
      const straggler = `pi_ne_straggler_${stamp}`;

      await db
        .insertInto('paycore.merchants')
        .values({
          id: merchantId,
          name: 'Not-Exists Test',
          env: 'test',
          allowed_origins: [],
          reserve_basis_points: 0,
          payout_schedule: 'daily',
          kyb_status: 'approved',
          kyb_data: null,
          created_at: day,
        })
        .execute();
      await db
        .insertInto('paycore.payment_methods')
        .values({
          id: pmId,
          merchant_id: merchantId,
          customer_id: null,
          token_id: `tok_ne_${stamp}`,
          bin: '424242',
          last4: '4242',
          scheme: 'visa',
          exp_month: '12',
          exp_year: '2031',
          created_at: day,
        })
        .execute();
      for (const [id, amount, rrn] of [
        [cleared, 1000n, '631009000001'],
        [straggler, 2000n, '631009000002'],
      ] as const) {
        await db
          .insertInto('paycore.payment_intents')
          .values({
            id,
            merchant_id: merchantId,
            customer_id: null,
            payment_method_id: pmId,
            amount,
            amount_received: amount,
            amount_capturable: 0n,
            currency: 'USD',
            status: 'succeeded',
            capture_method: 'automatic',
            confirmation_method: 'automatic',
            client_secret: `${id}_secret_x`,
            last_payment_error_code: null,
            last_payment_error_message: null,
            last_payment_error_decline_code: null,
            metadata: null,
            livemode: false,
            next_action: null,
            request_three_d_secure: 'automatic',
            last_auth_rrn: rrn,
            last_auth_stan: '000001',
            captured_at: day,
            created_at: day,
            updated_at: day,
          })
          .execute();
      }

      // Both are uncleared, so both are offered.
      const before = await collectClearingTransactionsForDate(db, day);
      expect(before.map((t) => t.paymentIntentId).sort()).toEqual([cleared, straggler].sort());

      // Cut a file holding only the first one.
      const emitted = await emitClearingFiles({
        db,
        transactions: before.filter((t) => t.paymentIntentId === cleared),
        fileDate: day,
        outputDir: tmp,
      });
      expect(emitted).toHaveLength(1);

      // Now only the straggler is offered — this is what lets a re-run cut a
      // supplementary file instead of re-presenting what already cleared.
      const after = await collectClearingTransactionsForDate(db, day);
      expect(after.map((t) => t.paymentIntentId)).toEqual([straggler]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
