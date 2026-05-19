import type { Database } from '@psp-new/db';
import { postJournal, pspAccount, schemeAccount } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 15 — scheme settlement sweeper.
 *
 * Drains positive `scheme_receivable[scheme, currency]` balances into
 * `psp_cash_at_bank[currency]`. Models the daily Visa/MC/Amex
 * net-settlement to the PSP. Heals the Phase 6 merchant-payout cash drift.
 *
 * Does NOT heal the Phase 14 pool-reconciliation cash drift — that path
 * never posts to scheme_receivable in the first place because Phase 11's
 * acquiring-side accounting is still deferred. See PHASE_15_PLAN.md
 * §Honest scope for the full picture.
 *
 * Posting (per (scheme, currency) combo with balance > 0):
 *   scheme_receivable  -balance
 *   psp_cash_at_bank   +balance
 *
 * Idempotency rides externalId `scheme_settle:${yyyymmdd}:${scheme}:${currency}`.
 * Re-running within the same UTC day for the same combo hits the unique
 * constraint and is swallowed.
 *
 * Per-combo transaction so one bad row doesn't poison the run.
 */

type Scheme = 'visa' | 'mastercard' | 'amex';

export interface SchemeSettlementDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface SchemeSettlementResult {
  readonly scanned: number;
  readonly settled: number;
}

interface ReceivableRow {
  owner_id: string;
  currency: string;
  balance: bigint;
}

const KNOWN_SCHEMES: ReadonlySet<Scheme> = new Set(['visa', 'mastercard', 'amex']);

export async function settleSchemeReceivables(
  deps: SchemeSettlementDeps,
  asOf: Date = new Date(),
): Promise<SchemeSettlementResult> {
  const rows = (await deps.db
    .selectFrom('ledger.account_balances')
    .innerJoin('ledger.accounts', 'ledger.accounts.id', 'ledger.account_balances.account_id')
    .where('ledger.accounts.code', '=', 'scheme_receivable')
    .where('ledger.account_balances.balance', '>', 0n)
    .select([
      'ledger.accounts.owner_id as owner_id', // scheme code
      'ledger.accounts.currency as currency',
      'ledger.account_balances.balance as balance',
    ])
    .execute()) as ReceivableRow[];

  const day = utcYyyymmdd(asOf);
  let settled = 0;

  for (const row of rows) {
    if (!row.owner_id || !KNOWN_SCHEMES.has(row.owner_id as Scheme)) {
      deps.logger.warn({ owner_id: row.owner_id, currency: row.currency }, 'unknown scheme on receivable; skipped');
      continue;
    }
    const scheme = row.owner_id as Scheme;
    try {
      await deps.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `scheme_settle:${day}:${scheme}:${row.currency}`,
          description: `scheme settlement ${scheme} ${row.currency} ${row.balance}`,
          occurredAt: asOf,
          postings: [
            {
              accountId: schemeAccount('scheme_receivable', row.currency, scheme),
              amount: -row.balance,
              currency: row.currency,
            },
            {
              accountId: pspAccount('psp_cash_at_bank', row.currency),
              amount: row.balance,
              currency: row.currency,
            },
          ],
        });
      });
      settled++;
      deps.logger.info(
        { scheme, currency: row.currency, amount: row.balance.toString(), day },
        'scheme settlement posted',
      );
    } catch (err) {
      deps.logger.warn(
        { err, scheme, currency: row.currency, day },
        'scheme settlement skipped (likely already posted today)',
      );
    }
  }

  return { scanned: rows.length, settled };
}

function utcYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}${m.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
}
