import type { Database } from '@psp-new/db';
import type { ResourceId } from '@psp-new/ids';
import { postJournal } from '@psp-new/ledger';
import type { Logger } from '@psp-new/logger';
import type { Kysely } from 'kysely';

/**
 * Phase 13 — auth-expiry sweeper.
 *
 * Walks `paycore.card_auth_holds` rows where `resolved_at IS NULL` and
 * `created_at < asOf - windowMs`. For each, posts the same reversal-shaped
 * journal as a Phase 10 0420 (holds → funded) and marks the row
 * `resolved_reason='expired'`. The `card_auth_holds_open_idx` partial index
 * (added in 0017) makes the scan cheap.
 *
 * Idempotency: each posted journal uses externalId `auth_expire:${hold.id}`
 * which is unique-indexed in `ledger.journal_entries`. A second sweep over a
 * row that already got expired will hit the unique violation; we swallow it
 * (the row's `resolved_at` is also already non-null so a re-run would not
 * select it anyway).
 *
 * Per-row transactions, not a batched one — a single bad row should not
 * poison the run.
 */

export interface AuthExpiryDeps {
  readonly db: Kysely<Database>;
  readonly logger: Logger;
}

export interface AuthExpiryConfig {
  /** How stale (in ms) a hold must be to count as expired. Default in the worker wiring: 7 days. */
  readonly windowMs: number;
}

export interface AuthExpiryResult {
  readonly scanned: number;
  readonly expired: number;
}

interface StaleHoldRow {
  id: string;
  amount: bigint;
  currency: string;
  funded_account_id: string;
  holds_account_id: string;
}

export async function expireStaleAuthHolds(
  deps: AuthExpiryDeps,
  config: AuthExpiryConfig,
  asOf: Date = new Date(),
): Promise<AuthExpiryResult> {
  const cutoff = new Date(asOf.getTime() - config.windowMs);
  const rows = (await deps.db
    .selectFrom('paycore.card_auth_holds')
    .innerJoin('paycore.cards', 'paycore.cards.id', 'paycore.card_auth_holds.card_id')
    .where('paycore.card_auth_holds.resolved_at', 'is', null)
    .where('paycore.card_auth_holds.created_at', '<', cutoff)
    .select([
      'paycore.card_auth_holds.id as id',
      'paycore.card_auth_holds.amount as amount',
      'paycore.card_auth_holds.currency as currency',
      'paycore.cards.funded_account_id as funded_account_id',
      'paycore.cards.holds_account_id as holds_account_id',
    ])
    .execute()) as StaleHoldRow[];

  let expired = 0;
  for (const hold of rows) {
    try {
      await deps.db.transaction().execute(async (trx) => {
        await postJournal(trx, {
          externalId: `auth_expire:${hold.id}`,
          description: `auth expired ${hold.id} ${hold.currency} ${hold.amount}`,
          occurredAt: asOf,
          postings: [
            {
              accountId: hold.holds_account_id as ResourceId<'account'>,
              amount: -hold.amount,
              currency: hold.currency,
            },
            {
              accountId: hold.funded_account_id as ResourceId<'account'>,
              amount: hold.amount,
              currency: hold.currency,
            },
          ],
        });
        await trx
          .updateTable('paycore.card_auth_holds')
          .set({ resolved_at: asOf, resolved_reason: 'expired' })
          .where('id', '=', hold.id)
          .where('resolved_at', 'is', null)
          .execute();
      });
      expired++;
      deps.logger.info({ hold: hold.id, amount: hold.amount.toString(), currency: hold.currency }, 'auth expired');
    } catch (err) {
      deps.logger.warn({ err, hold: hold.id }, 'auth expiry skipped (likely already resolved)');
    }
  }

  return { scanned: rows.length, expired };
}
