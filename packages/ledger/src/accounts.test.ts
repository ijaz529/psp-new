import { describe, expect, it } from 'vitest';
import { deterministicAccountId, merchantAccount, pspAccount, schemeAccount } from './accounts.js';

describe('account id derivation', () => {
  it('deterministicAccountId is stable across calls', () => {
    expect(deterministicAccountId('foo:USD:psp:')).toBe(deterministicAccountId('foo:USD:psp:'));
  });

  it('different inputs → different ids', () => {
    expect(deterministicAccountId('a')).not.toBe(deterministicAccountId('b'));
  });

  it('id is acct_<32 hex>', () => {
    expect(pspAccount('mdr_revenue', 'USD')).toMatch(/^acct_[a-f0-9]{32}$/);
  });

  it('mirrors the SQL `ledger._acct_id` parts-string format', () => {
    // Keep these snapshots in sync with 0009_chart_of_accounts.sql.
    expect(pspAccount('mdr_revenue', 'USD')).toBe(deterministicAccountId('mdr_revenue:USD:psp:'));
    expect(schemeAccount('scheme_receivable', 'EUR', 'visa')).toBe(
      deterministicAccountId('scheme_receivable:EUR:scheme:visa'),
    );
    expect(merchantAccount('merchant_settlement_liability', 'USD', 'mrch_demo')).toBe(
      deterministicAccountId('merchant_settlement_liability:USD:merchant:mrch_demo'),
    );
  });
});
