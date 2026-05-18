import { bigint, char, index, integer, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const ledgerSchema = pgSchema('ledger');

/** ISO 4217 active currencies, seeded by migration 0002 from packages/money. */
export const currencies = ledgerSchema.table('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  numeric: char('numeric', { length: 3 }).notNull(),
  minorUnits: integer('minor_units').notNull(),
  name: text('name').notNull(),
});

/**
 * Skeleton Phase-0 ledger tables. Constraint triggers (balanced-entry enforcement,
 * append-only journal_lines) land in Phase 1's migrations, not here. The columns
 * are stable so apps can already type-import them.
 */
export const accounts = ledgerSchema.table(
  'accounts',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    type: text('type').notNull(), // ASSET | LIABILITY | REVENUE | EXPENSE | EQUITY
    currency: char('currency', { length: 3 }).notNull(),
    /** Owner kind: 'psp' | 'merchant' | 'scheme' | 'issuer' — drives which row owns balances. */
    ownerKind: text('owner_kind').notNull(),
    /** Optional owner FK; merchant id, scheme id, etc. Nullable for psp-owned accounts. */
    ownerId: text('owner_id'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    codeCurrencyIdx: uniqueIndex('accounts_code_currency_owner_idx').on(t.code, t.currency, t.ownerKind, t.ownerId),
  }),
);

export const journalEntries = ledgerSchema.table(
  'journal_entries',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').notNull(), // caller idempotency key
    description: text('description').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdx: uniqueIndex('journal_entries_external_id_idx').on(t.externalId),
    occurredIdx: index('journal_entries_occurred_idx').on(t.occurredAt),
  }),
);

export const journalLines = ledgerSchema.table(
  'journal_lines',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Signed minor units; debit = positive, credit = negative (or vice versa per ADR-0009). */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    entryIdx: index('journal_lines_entry_idx').on(t.entryId),
    accountIdx: index('journal_lines_account_idx').on(t.accountId),
  }),
);
