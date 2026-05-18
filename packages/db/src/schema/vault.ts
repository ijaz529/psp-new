import { char, index, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const vaultSchema = pgSchema('vault');

/**
 * Vault tokens — vaultless HMAC tokenization, Phase 2.
 *
 * For the vaultless scheme: `id` is the public token (`tok_…`), `binSha256` is
 * the HMAC of the PAN (used as the dedup key — same PAN always maps to same
 * token within a merchant). We deliberately do NOT store the PAN itself, even
 * encrypted; the HMAC + last4 + bin are enough for re-tokenization and routing.
 *
 * Schema-level Phase 0 columns; Phase 2 fills in the tokenize/detokenize logic.
 */
export const tokens = vaultSchema.table(
  'tokens',
  {
    id: text('id').primaryKey(), // tok_...
    merchantId: text('merchant_id').notNull(),
    /** HMAC-SHA256(KMS_key, PAN) — hex. Unique per merchant to enable consistent re-tokenization. */
    panHmac: text('pan_hmac').notNull(),
    bin: char('bin', { length: 6 }).notNull(),
    last4: char('last4', { length: 4 }).notNull(),
    expMonth: text('exp_month'), // YYYY-MM stored separately when needed
    expYear: text('exp_year'),
    /** Scheme detected from BIN: 'visa' | 'mastercard' | 'amex' | 'unknown'. */
    scheme: text('scheme').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    merchantHmacIdx: uniqueIndex('tokens_merchant_pan_hmac_idx').on(t.merchantId, t.panHmac),
    binIdx: index('tokens_bin_idx').on(t.bin),
  }),
);
