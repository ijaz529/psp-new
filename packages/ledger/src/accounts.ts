import { createHash } from 'node:crypto';
import type { Database } from '@psp-new/db';
import { PspError } from '@psp-new/errors';
import type { ResourceId } from '@psp-new/ids';
import type { Kysely, Transaction } from 'kysely';
import type { AccountRow, AccountType } from './types.js';

/**
 * Compute the deterministic account id used by 0009_chart_of_accounts.sql.
 * Mirrors `ledger._acct_id(parts)` (md5 of a canonical key) — keep in sync.
 *
 * Format: `acct_<32-hex>` (md5 hex). The migration uses the same hash so app
 * code can look up CoA accounts by name without round-tripping.
 */
export function deterministicAccountId(parts: string): ResourceId<'account'> {
  const md5 = createHash('md5').update(parts).digest('hex');
  return `acct_${md5}` as ResourceId<'account'>;
}

/** PSP-owned account, scoped to (code, currency). */
export function pspAccount(code: string, currency: string): ResourceId<'account'> {
  return deterministicAccountId(`${code}:${currency}:psp:`);
}

/** Scheme-scoped account, e.g. `scheme_receivable` for visa/USD. */
export function schemeAccount(
  code: string,
  currency: string,
  scheme: 'visa' | 'mastercard' | 'amex',
): ResourceId<'account'> {
  return deterministicAccountId(`${code}:${currency}:scheme:${scheme}`);
}

/** Per-merchant account id; the row may not exist yet — see {@link ensureMerchantAccounts}. */
export function merchantAccount(code: string, currency: string, merchantId: string): ResourceId<'account'> {
  return deterministicAccountId(`${code}:${currency}:merchant:${merchantId}`);
}

/**
 * Per-merchant account codes — must match the CoA in PHASE_1_DONE.md.
 * Adding a new per-merchant account: append here AND in ensureMerchantAccounts.
 */
export const MERCHANT_ACCOUNT_SPECS: ReadonlyArray<{ code: string; type: AccountType }> = [
  { code: 'merchant_settlement_liability', type: 'LIABILITY' },
  { code: 'refund_reserve', type: 'LIABILITY' },
  { code: 'chargeback_liability', type: 'LIABILITY' },
  { code: 'merchant_payout_clearing', type: 'ASSET' },
];

export interface MerchantAccountSet {
  readonly settlementLiability: ResourceId<'account'>;
  readonly refundReserve: ResourceId<'account'>;
  readonly chargebackLiability: ResourceId<'account'>;
  readonly payoutClearing: ResourceId<'account'>;
}

/**
 * Upsert the four per-merchant accounts for a (merchant, currency) pair. Safe
 * to call repeatedly — returns the existing rows on conflict. Idempotent.
 */
export async function ensureMerchantAccounts(
  trx: Transaction<Database>,
  merchantId: string,
  currency: string,
): Promise<MerchantAccountSet> {
  const result: MerchantAccountSet = {
    settlementLiability: merchantAccount('merchant_settlement_liability', currency, merchantId),
    refundReserve: merchantAccount('refund_reserve', currency, merchantId),
    chargebackLiability: merchantAccount('chargeback_liability', currency, merchantId),
    payoutClearing: merchantAccount('merchant_payout_clearing', currency, merchantId),
  };
  const inserts: ReadonlyArray<{ id: ResourceId<'account'>; code: string; type: AccountType }> = [
    { id: result.settlementLiability, code: 'merchant_settlement_liability', type: 'LIABILITY' },
    { id: result.refundReserve, code: 'refund_reserve', type: 'LIABILITY' },
    { id: result.chargebackLiability, code: 'chargeback_liability', type: 'LIABILITY' },
    { id: result.payoutClearing, code: 'merchant_payout_clearing', type: 'ASSET' },
  ];
  const now = new Date();
  for (const { id, code, type } of inserts) {
    await trx
      .insertInto('ledger.accounts')
      .values({
        id,
        code,
        type,
        currency,
        owner_kind: 'merchant',
        owner_id: merchantId,
        metadata: null,
        created_at: now,
      })
      .onConflict((b) => b.doNothing())
      .execute();
  }
  return result;
}

/** Read an account row. */
export async function getAccount(db: Kysely<Database>, accountId: string): Promise<AccountRow> {
  const row = await db
    .selectFrom('ledger.accounts')
    .select(['id', 'code', 'type', 'currency', 'owner_kind', 'owner_id'])
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) {
    throw new PspError('resource_missing', {
      message: `account ${accountId} not found`,
      internal: { accountId },
    });
  }
  return {
    id: row.id as ResourceId<'account'>,
    code: row.code,
    type: row.type as AccountType,
    currency: row.currency,
    ownerKind: row.owner_kind as AccountRow['ownerKind'],
    ownerId: row.owner_id,
  };
}
