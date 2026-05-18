import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { type Money, money } from '@psp-new/money';
import type { Kysely } from 'kysely';

/**
 * Return the current balance for an account.
 *
 * Source order:
 *   1. `ledger.account_balances` materialized view (fast, may be stale).
 *   2. `SUM(amount) FROM journal_lines` (slow, always live).
 *
 * The view is refreshed by a periodic job (Phase 6). For hot-path reads where
 * staleness is unacceptable (e.g. before authorizing a capture against a
 * reserve), pass `freshness: 'live'` to skip the view.
 */
export interface BalanceOptions {
  readonly freshness?: 'view' | 'live';
}

export async function balance(db: Kysely<Database>, accountId: string, opts: BalanceOptions = {}): Promise<Money> {
  const freshness = opts.freshness ?? 'view';

  if (freshness === 'view') {
    const row = await db
      .selectFrom('ledger.account_balances')
      .select(['balance', 'currency'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (row) return money(row.balance, row.currency);
    // Fall through to live read if the view row is missing (e.g. account
    // created since the last REFRESH).
  }

  const acct = await db.selectFrom('ledger.accounts').select('currency').where('id', '=', accountId).executeTakeFirst();
  if (!acct) {
    throw new PspError('resource_missing', {
      message: `account ${accountId} not found`,
      internal: { accountId },
    });
  }

  const sumRow = await db
    .selectFrom('ledger.journal_lines')
    .select((eb) => eb.fn.sum<bigint | string | null>('amount').as('total'))
    .where('account_id', '=', accountId)
    .executeTakeFirst();

  // pg returns sum as numeric; depending on pg-types config it may be bigint,
  // string, or null. Normalize.
  const total = sumRow?.total ?? 0n;
  const amount = typeof total === 'bigint' ? total : BigInt(total ?? 0);
  return money(amount, acct.currency);
}
