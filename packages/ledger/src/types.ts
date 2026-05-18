import type { ResourceId } from '@psp-new/ids';

/**
 * A single posting in a journal entry.
 *
 * Sign convention: **debit > 0, credit < 0.** See DECISIONS.md ADR-0009.
 *
 * The currency must match the parent account's currency (DB-enforced).
 * Zero amounts are rejected at the DB level (a check constraint).
 */
export interface Posting {
  readonly accountId: ResourceId<'account'>;
  /** Signed minor units. Debit > 0, credit < 0. */
  readonly amount: bigint;
  /** ISO 4217. Must match the account's currency. */
  readonly currency: string;
}

export interface PostJournalInput {
  /**
   * Caller-supplied idempotency anchor. Unique-indexed in the DB; second insert
   * with the same external_id will fail with a unique-violation.
   */
  readonly externalId: string;
  readonly description: string;
  readonly occurredAt: Date;
  readonly postings: ReadonlyArray<Posting>;
}

export interface JournalEntryRecord {
  readonly id: ResourceId<'journal_entry'>;
  readonly externalId: string;
  readonly description: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly postings: ReadonlyArray<Posting>;
}

export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'EQUITY';

export type AccountOwnerKind = 'psp' | 'merchant' | 'scheme' | 'issuer';

export interface AccountRow {
  readonly id: ResourceId<'account'>;
  readonly code: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly ownerKind: AccountOwnerKind;
  readonly ownerId: string | null;
}
