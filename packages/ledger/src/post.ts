import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import { type ResourceId, newId } from '@psp-new/ids';
import type { Transaction } from 'kysely';
import type { JournalEntryRecord, PostJournalInput } from './types.js';

/**
 * Post a balanced double-entry journal. The ONLY writer to ledger.journal_entries
 * and ledger.journal_lines. Caller wraps in a transaction so the entry can be
 * atomically paired with business-state writes + outbox publishes.
 *
 * Validations (cheap, app-side, before any DB roundtrip):
 *   - ≥ 2 postings
 *   - exactly one currency across all postings (single-currency-per-entry)
 *   - sum of amounts = 0 (balanced)
 *   - no zero-amount postings
 *
 * DB-side guarantees (cannot be bypassed by app code):
 *   - balanced-entry constraint trigger (deferred to commit)
 *   - currency matches account.currency
 *   - append-only on both tables
 *   - external_id unique → second post with same id raises unique-violation
 *
 * Errors raised by this function:
 *   - `parameter_invalid` for ≥2 / balance / zero-amount violations
 *   - `currency_mismatch` for mixed-currency postings
 *   - whatever the DB raises on a missing/wrong-currency account or duplicate external_id
 */
export async function postJournal(trx: Transaction<Database>, input: PostJournalInput): Promise<JournalEntryRecord> {
  validate(input);

  const entryId: ResourceId<'journal_entry'> = newId('journal_entry');
  const now = new Date();

  await trx
    .insertInto('ledger.journal_entries')
    .values({
      id: entryId,
      external_id: input.externalId,
      description: input.description,
      occurred_at: input.occurredAt,
      created_at: now,
    })
    .execute();

  await trx
    .insertInto('ledger.journal_lines')
    .values(
      input.postings.map((p) => ({
        id: newId('journal_line'),
        entry_id: entryId,
        account_id: p.accountId,
        amount: p.amount,
        currency: p.currency,
        created_at: now,
      })),
    )
    .execute();

  return {
    id: entryId,
    externalId: input.externalId,
    description: input.description,
    occurredAt: input.occurredAt,
    createdAt: now,
    postings: input.postings,
  };
}

/** Exported separately so unit tests can hit the validation surface without a DB. */
export function validate(input: PostJournalInput): void {
  if (input.postings.length < 2) {
    throw new PspError('parameter_invalid', {
      message: `journal entry requires at least 2 postings (got ${input.postings.length})`,
      param: 'postings',
    });
  }

  const currencies = new Set<string>();
  let sum = 0n;
  for (const p of input.postings) {
    currencies.add(p.currency);
    if (p.amount === 0n) {
      throw new PspError('parameter_invalid', {
        message: 'zero-amount posting not allowed',
        param: 'postings',
      });
    }
    sum += p.amount;
  }

  if (currencies.size > 1) {
    throw new PspError('currency_mismatch', {
      message: `journal entry mixes currencies: ${[...currencies].sort().join(', ')}`,
      param: 'postings',
    });
  }

  if (sum !== 0n) {
    throw new PspError('parameter_invalid', {
      message: `unbalanced journal entry: sum = ${sum} (must be 0)`,
      param: 'postings',
    });
  }
}
