import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, createKysely, createPool, dbConfigFromEnv, migrateUp } from '@psp-new/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClearingTransaction, emitClearingFiles } from './index.js';

/**
 * Phase 46 integration test. HAS_DB-gated.
 *
 * The unit tests mock Kysely, so they cannot prove the `clearing_files`
 * lookup actually matches a row Postgres stored in a `date` column — which
 * is the whole mechanism keeping a same-day re-run from corrupting state.
 * Only a real database proves that.
 */
const HAS_DB = !!process.env.DATABASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations');

describe.skipIf(!HAS_DB)('emitClearingFiles — same-day re-run against a real database', () => {
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

  it('cuts each file once, keeps disk and rows in step, and still emits later groups', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'clearing-rerun-db-'));
    try {
      // A per-run UTC day: the unique index is (scheme, currency, file_date,
      // format), so a fixed date would collide with earlier runs against the
      // same dev database.
      const fileDate = new Date(Date.UTC(2040, 0, 1) + (Date.now() % 1_000_000) * 86_400_000);
      const dateStr = fileDate.toISOString().slice(0, 10).replace(/-/g, '');

      const usd: ClearingTransaction = {
        paymentIntentId: `pi_rerun_usd_${Date.now()}`,
        merchantId: 'mrch_rerun',
        scheme: 'visa',
        currency: 'USD',
        amount: 7500n,
        rrn: '631001000001',
        occurredAt: fileDate,
      };
      const eur: ClearingTransaction = {
        paymentIntentId: `pi_rerun_eur_${Date.now()}`,
        merchantId: 'mrch_rerun',
        scheme: 'visa',
        currency: 'EUR',
        amount: 4500n,
        rrn: '631001000002',
        occurredAt: fileDate,
      };

      // Run 1: USD only — the state a first nightly pass leaves behind.
      const first = await emitClearingFiles({ db, transactions: [usd], fileDate, outputDir: tmp });
      expect(first).toHaveLength(1);
      const usdPath = join(tmp, `visa_usd_${dateStr}.b2`);
      expect(first[0]?.path).toBe(usdPath);
      const usdAfterFirst = await readFile(usdPath, 'utf8');

      // Run 2: the same USD transaction plus a later EUR one. Before this
      // phase, USD's file was rewritten, its row was left stale, and the
      // throw meant EUR never got a file at all.
      const second = await emitClearingFiles({ db, transactions: [usd, eur], fileDate, outputDir: tmp });

      // USD was already cut: not re-emitted, and its file is byte-identical.
      expect(second.find((f) => f.currency === 'USD')).toBeUndefined();
      expect(await readFile(usdPath, 'utf8')).toBe(usdAfterFirst);

      // EUR is new, so it still gets emitted — the bug's real damage.
      expect(second).toHaveLength(1);
      expect(second[0]?.currency).toBe('EUR');
      expect(await readFile(join(tmp, `visa_eur_${dateStr}.b2`), 'utf8')).toContain(eur.paymentIntentId);

      // Exactly one row per (scheme, currency), and each one describes the
      // file that is actually on disk.
      const rows = await db
        .selectFrom('paycore.clearing_files')
        .select(['id', 'currency', 'record_count', 'total_amount', 'path'])
        .where('file_date', '=', fileDate)
        .where('scheme', '=', 'visa')
        .orderBy('currency')
        .execute();
      expect(rows.map((r) => r.currency)).toEqual(['EUR', 'USD']);
      for (const row of rows) {
        const trailerTotal = row.currency === 'USD' ? 7500n : 4500n;
        expect(row.record_count).toBe(1);
        expect(BigInt(row.total_amount)).toBe(trailerTotal);
        const content = await readFile(row.path, 'utf8');
        // Base II trailer: TC 90 TCR 1, record count then total amount.
        const trailer = content.trim().split('\n').at(-1) ?? '';
        expect(trailer.startsWith('901')).toBe(true);
        expect(trailer).toContain(String(row.record_count).padStart(10, '0'));
        expect(trailer).toContain(trailerTotal.toString().padStart(12, '0'));
      }

      // And a record row per file, none orphaned or duplicated.
      for (const row of rows) {
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
});
