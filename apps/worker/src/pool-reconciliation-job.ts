import type { Database } from '@psp-new/db';
import { postJournal, pspAccount } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 14 — pool reconciliation sweeper.
 *
 * Phase 11 deferred the acquiring-side accounting for card loads. The single
 * journal it posts (`cardholder_funded +X / issuer_funded_pool -X`) drains
 * the pool on every load. Without this sweeper, the pool deficit grows
 * unbounded.
 *
 * Per-row reconciliation journal:
 *   issuer_funded_pool   +X   (pool deficit recovers)
 *   psp_cash_at_bank     -X   (PSP cash funds the pool)
 *
 * Same 2-leg pattern Phase 6 payouts use to settle merchant liabilities. In
 * real life `psp_cash_at_bank` would be replenished by scheme settlement
 * files for the load 0200s — that stays deferred (Phase 11 §Out of scope,
 * Phase 14 §Out of scope).
 *
 * Idempotency: each posted journal uses externalId
 * `card_load_recon:${load.id}` which is unique-indexed in
 * `ledger.journal_entries`. A second sweep over an already-reconciled row
 * also fails the `reconciled_at IS NULL` predicate in the SELECT, so it
 * isn't even considered. Per-row transactions so one bad row doesn't poison
 * the run.
 */

export interface ReconcileDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface ReconcileResult {
  readonly scanned: number;
  readonly reconciled: number;
}

interface UnreconciledLoadRow {
  id: string;
  amount: bigint;
  currency: string;
  card_id: string;
}

export async function reconcileCardLoads(deps: ReconcileDeps, asOf: Date = new Date()): Promise<ReconcileResult> {
  const rows = (await deps.db
    .selectFrom('paycore.card_loads')
    .where('status', '=', 'succeeded')
    .where('reconciled_at', 'is', null)
    .select(['id', 'amount', 'currency', 'card_id'])
    .execute()) as UnreconciledLoadRow[];

  let reconciled = 0;
  for (const load of rows) {
    try {
      await deps.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `card_load_recon:${load.id}`,
          description: `pool reconciliation for card_load ${load.id}`,
          occurredAt: asOf,
          postings: [
            {
              accountId: pspAccount('issuer_funded_pool', load.currency),
              amount: load.amount,
              currency: load.currency,
            },
            {
              accountId: pspAccount('psp_cash_at_bank', load.currency),
              amount: -load.amount,
              currency: load.currency,
            },
          ],
        });
        await trx
          .updateTable('paycore.card_loads')
          .set({ reconciled_at: asOf })
          .where('id', '=', load.id)
          .where('reconciled_at', 'is', null)
          .execute();
      });
      reconciled++;
      deps.logger.info({ load: load.id, amount: load.amount.toString(), currency: load.currency }, 'pool reconciled');
    } catch (err) {
      deps.logger.warn({ err, load: load.id }, 'pool reconciliation skipped (likely already reconciled)');
    }
  }

  return { scanned: rows.length, reconciled };
}
