import type { Database } from '@psp-new/db';
import { postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 17 — card-load acquiring-leg sweeper.
 *
 * Closes the phase 11 acquiring-side deferral. Phase 11 posts only the
 * cardholder-facing leg (cardholder_funded +X / issuer_funded_pool -X) and
 * skips the acquiring leg entirely (scheme_receivable was never +X for a
 * load). This sweeper writes the missing leg:
 *
 *   scheme_receivable[scheme, currency]  +X    (asset: scheme owes us)
 *   external_load_clearing[currency]     -X    (LIABILITY: PSP owes cardholder)
 *
 * Once this lands AND phase 15 settles scheme_receivable to cash, the net
 * books per load are exactly: cardholder_funded +X / external_load_clearing
 * -X, with all intermediates (pool, cash, receivable) at zero. The clearing
 * balance is the PSP's running cardholder stored-value liability.
 *
 * Idempotency: each journal uses externalId 'card_load_acq:${load.id}'.
 * Second sweep over an already-reconciled row also fails the
 * `acquiring_reconciled_at IS NULL` predicate in the SELECT.
 *
 * Per-row transactions (matches phase 13 / 14 / 15 pattern) so one bad row
 * doesn't poison the whole run.
 */

type Scheme = 'visa' | 'mastercard' | 'amex';

export interface CardLoadAcquiringDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface CardLoadAcquiringResult {
  readonly scanned: number;
  readonly reconciled: number;
}

interface UnreconciledLoadRow {
  id: string;
  amount: bigint;
  currency: string;
  scheme: string;
}

const KNOWN_SCHEMES: ReadonlySet<Scheme> = new Set(['visa', 'mastercard', 'amex']);

export async function reconcileCardLoadAcquiring(
  deps: CardLoadAcquiringDeps,
  asOf: Date = new Date(),
): Promise<CardLoadAcquiringResult> {
  const rows = (await deps.db
    .selectFrom('paycore.card_loads')
    .innerJoin('paycore.payment_methods', 'paycore.payment_methods.id', 'paycore.card_loads.payment_method_id')
    .where('paycore.card_loads.status', '=', 'succeeded')
    .where('paycore.card_loads.acquiring_reconciled_at', 'is', null)
    .select([
      'paycore.card_loads.id as id',
      'paycore.card_loads.amount as amount',
      'paycore.card_loads.currency as currency',
      'paycore.payment_methods.scheme as scheme',
    ])
    .execute()) as UnreconciledLoadRow[];

  let reconciled = 0;
  for (const load of rows) {
    if (!KNOWN_SCHEMES.has(load.scheme as Scheme)) {
      deps.logger.warn({ load: load.id, scheme: load.scheme }, 'unknown scheme on card_load; skipped');
      continue;
    }
    const scheme = load.scheme as Scheme;
    try {
      await deps.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `card_load_acq:${load.id}`,
          description: `card-load acquiring leg ${load.id} ${load.currency} ${load.amount}`,
          occurredAt: asOf,
          postings: [
            {
              accountId: schemeAccount('scheme_receivable', load.currency, scheme),
              amount: load.amount,
              currency: load.currency,
            },
            {
              accountId: pspAccount('external_load_clearing', load.currency),
              amount: -load.amount,
              currency: load.currency,
            },
          ],
        });
        await trx
          .updateTable('paycore.card_loads')
          .set({ acquiring_reconciled_at: asOf })
          .where('id', '=', load.id)
          .where('acquiring_reconciled_at', 'is', null)
          .execute();
      });
      reconciled++;
      deps.logger.info(
        { load: load.id, amount: load.amount.toString(), currency: load.currency, scheme },
        'card-load acquiring leg posted',
      );
    } catch (err) {
      deps.logger.warn({ err, load: load.id }, 'card-load acquiring leg skipped (likely already reconciled)');
    }
  }

  return { scanned: rows.length, reconciled };
}
