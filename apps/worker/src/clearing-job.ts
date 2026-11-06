import {
  collectCardLoadChargebacksForDate,
  collectClearingTransactionsForDate,
  emitClearingFiles,
} from '@psp-new/clearing-files';
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
 *   - a file already cut is never rewritten (Phase 46 — before that a re-run
 *     rewrote the file, left the row stale, and aborted every later group).
 *     Phase 47: a re-run cuts the next sequence instead, carrying only what
 *     has no clearing_records row yet, so nothing is both re-presented and
 *     left uncleared.
 *   - payouts use a deterministic `externalId` on the journal entry
 *     → second run hits the unique-on-externalId constraint.
 */
export async function runNightlyJobs(deps: NightlyJobsDeps, asOf: Date): Promise<void> {
  const yesterday = new Date(asOf.getTime() - 86_400_000);
  deps.logger.info({ for_date: yesterday.toISOString().slice(0, 10) }, 'nightly: starting');

  try {
    const presentments = await collectClearingTransactionsForDate(deps.db, yesterday);
    const chargebacks = await collectCardLoadChargebacksForDate(deps.db, yesterday);
    const txs = [...presentments, ...chargebacks];
    if (txs.length > 0) {
      const files = await emitClearingFiles({
        db: deps.db,
        transactions: txs,
        fileDate: yesterday,
        ...(deps.outputDir ? { outputDir: deps.outputDir } : {}),
      });
      // Name the sequences: on a re-run these are supplementary files, and
      // `count` alone would not say that.
      deps.logger.info(
        {
          count: files.length,
          files: files.map((f) => `${f.scheme}_${f.currency.toLowerCase()}#${f.sequence}`),
          presentments: presentments.length,
          chargebacks: chargebacks.length,
        },
        'nightly: clearing files emitted',
      );
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
