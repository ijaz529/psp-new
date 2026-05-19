import type { Database } from '@psp-new/db';
import { postJournal, pspAccount } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 24 — sweep clearing_adjustments to adjustment_revenue.
 *
 * After Phase 21 posts an adjustment (scheme_receivable +delta /
 * clearing_adjustments -delta) and Phase 15 settles scheme_receivable
 * to cash, clearing_adjustments is left at -delta. This sweep drains
 * it daily by posting:
 *
 *   clearing_adjustments  +delta    (back to 0)
 *   adjustment_revenue    -delta    (recognize as revenue)
 *
 * where delta = -current_balance, so the formula is "post the exact
 * negation of the current balance". Works for both positive (rare,
 * expense) and negative (typical, revenue) clearing balances.
 *
 * Per-currency txn. Idempotent via daily externalId
 * 'clearing_sweep:${yyyymmdd}:${currency}'. Re-running same UTC day
 * is a unique-violation no-op (matches Phase 15 pattern).
 */

export interface SweepDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface SweepResult {
  readonly scanned: number;
  readonly swept: number;
}

interface ClearingBalanceRow {
  currency: string;
  balance: bigint;
}

export async function sweepClearingAdjustments(deps: SweepDeps, asOf: Date = new Date()): Promise<SweepResult> {
  const rows = (await deps.db
    .selectFrom('ledger.account_balances')
    .innerJoin('ledger.accounts', 'ledger.accounts.id', 'ledger.account_balances.account_id')
    .where('ledger.accounts.code', '=', 'clearing_adjustments')
    .where('ledger.accounts.owner_kind', '=', 'psp')
    .where('ledger.account_balances.balance', '!=', 0n)
    .select(['ledger.accounts.currency as currency', 'ledger.account_balances.balance as balance'])
    .execute()) as ClearingBalanceRow[];

  const day = utcYyyymmdd(asOf);
  let swept = 0;

  for (const row of rows) {
    const delta = -row.balance; // exact negation drains clearing to 0
    try {
      await deps.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `clearing_sweep:${day}:${row.currency}`,
          description: `clearing sweep ${row.currency} delta=${delta}`,
          occurredAt: asOf,
          postings: [
            {
              accountId: pspAccount('clearing_adjustments', row.currency),
              amount: delta,
              currency: row.currency,
            },
            {
              accountId: pspAccount('adjustment_revenue', row.currency),
              amount: -delta,
              currency: row.currency,
            },
          ],
        });
      });
      swept++;
      deps.logger.info({ currency: row.currency, delta: delta.toString(), day }, 'clearing_adjustments swept');
    } catch (err) {
      deps.logger.warn(
        { err, currency: row.currency, day },
        'clearing_adjustments sweep skipped (likely already posted today)',
      );
    }
  }

  return { scanned: rows.length, swept };
}

function utcYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}${m.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
}
