import { collectClearingTransactionsForDate, emitClearingFiles } from '@psp-new/clearing-files';
import type { Database } from '@psp-new/db';
import type { Logger } from '@psp-new/logger';
import { listPayoutCandidates, runPayout } from '@psp-new/payouts';
import type { Kysely } from 'kysely';

export interface NightlyJobsDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly outputDir?: string;
}

/**
 * One nightly pass: emit clearing files for yesterday, then run payouts for
 * every (merchant, currency) that had activity. Idempotent because:
 *   - clearing_files has a unique index on (scheme, currency, file_date, format)
 *     → second run for the same date is a no-op insert violation we swallow.
 *   - payouts use a deterministic `externalId` on the journal entry
 *     → second run hits the unique-on-externalId constraint.
 */
export async function runNightlyJobs(deps: NightlyJobsDeps, asOf: Date): Promise<void> {
  const yesterday = new Date(asOf.getTime() - 86_400_000);
  deps.logger.info({ for_date: yesterday.toISOString().slice(0, 10) }, 'nightly: starting');

  try {
    const txs = await collectClearingTransactionsForDate(deps.db, yesterday);
    if (txs.length > 0) {
      const files = await emitClearingFiles({
        db: deps.db,
        transactions: txs,
        fileDate: yesterday,
        ...(deps.outputDir ? { outputDir: deps.outputDir } : {}),
      });
      deps.logger.info({ count: files.length, total_records: txs.length }, 'nightly: clearing files emitted');
    } else {
      deps.logger.info({}, 'nightly: no transactions to clear');
    }
  } catch (err) {
    if (!isDuplicateKey(err)) deps.logger.error({ err }, 'nightly: clearing failed');
  }

  try {
    const candidates = await listPayoutCandidates(deps.db, yesterday);
    let paid = 0;
    for (const c of candidates) {
      try {
        const r = await runPayout({
          db: deps.db,
          merchantId: c.merchantId,
          currency: c.currency,
          scheduledFor: yesterday,
        });
        if (r.status === 'paid') paid += 1;
      } catch (err) {
        if (!isDuplicateKey(err)) deps.logger.error({ err, ...c }, 'nightly: payout failed');
      }
    }
    deps.logger.info({ candidates: candidates.length, paid }, 'nightly: payouts done');
  } catch (err) {
    deps.logger.error({ err }, 'nightly: payouts run failed');
  }
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === '23505';
}

/**
 * Refresh the ledger.account_balances materialized view. Concurrent-safe
 * thanks to the unique index in migration 0008. Called from a low-frequency
 * cron in the worker.
 */
export async function refreshAccountBalances(db: Kysely<Database>, logger: Logger): Promise<void> {
  const { sql } = await import('kysely');
  try {
    await sql`refresh materialized view concurrently ledger.account_balances`.execute(db);
  } catch {
    try {
      await sql`refresh materialized view ledger.account_balances`.execute(db);
    } catch (err) {
      logger.warn({ err }, 'failed to refresh account_balances');
    }
  }
}
