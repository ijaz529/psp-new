-- 0009_chart_of_accounts.sql
-- Reference Chart of Accounts seed for a PSP.
--
-- Two kinds of accounts:
--   1. (currency)-scoped         — one row per (code, currency).
--   2. (scheme, currency)-scoped — one row per (code, scheme, currency).
--
-- Per-merchant accounts (settlement liability, refund reserve, chargeback
-- liability, payout clearing) are NOT seeded here — they're created lazily
-- by `ensureMerchantAccounts(merchantId, currency)` in @psp-new/ledger when
-- a merchant first transacts in that currency. See DECISIONS.md ADR-0010.
--
-- Active currencies seeded in Phase 1: USD, EUR, GBP, AED, INR.
-- Active schemes seeded:               visa, mastercard, amex.
--
-- Account IDs are deterministic strings (`acct_<scope-hash>`) so we can
-- reference them by name in code without round-trip lookups. Future
-- additions: keep the deterministic-ID pattern so migrations are idempotent.

-- A helper to compute a stable account id from its scope. We use md5 of a
-- canonical key so it's reproducible across migration re-runs. Not for
-- security; just for stable identifiers.
create or replace function ledger._acct_id(parts text) returns text
language sql immutable as $$
  select 'acct_' || md5(parts)
$$;

-- ---------------------------------------------------------------------------
-- (currency)-scoped accounts — one per (code, currency) for 5 currencies.
-- ---------------------------------------------------------------------------
with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR')),
     specs(code, type, owner_kind) as (values
       ('acquirer_clearing_account',  'ASSET',     'psp'),
       ('mdr_revenue',                 'REVENUE',   'psp'),
       ('fx_pnl',                      'REVENUE',   'psp'),
       ('psp_cash_at_bank',            'ASSET',     'psp'),
       ('disputes_in_progress',        'ASSET',     'psp'),
       ('refund_clearing',             'LIABILITY', 'psp'),
       ('unallocated_settlements',     'LIABILITY', 'psp')
     )
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id(s.code || ':' || c.code || ':psp:'),
  s.code,
  s.type,
  c.code,
  s.owner_kind,
  null
from currencies c
cross join specs s;

-- ---------------------------------------------------------------------------
-- (scheme, currency)-scoped accounts — one per (code, scheme, currency).
-- ---------------------------------------------------------------------------
with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR')),
     schemes(code) as (values ('visa'), ('mastercard'), ('amex')),
     specs(code, type) as (values
       ('scheme_receivable',     'ASSET'),
       ('interchange_expense',   'EXPENSE'),
       ('scheme_fee_expense',    'EXPENSE')
     )
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id(s.code || ':' || c.code || ':scheme:' || sch.code),
  s.code,
  s.type,
  c.code,
  'scheme',
  sch.code
from currencies c
cross join schemes sch
cross join specs s;

-- Refresh the balances materialized view so it reflects the seeded accounts.
refresh materialized view ledger.account_balances;
