-- ===========================================================================
-- Phase 17 — close the phase 11 acquiring-side deferral.
--
-- Adds the missing-piece liability account that records the PSP's running
-- obligation toward cardholders for loads funded via the acquiring side.
-- After phase 17's sweeper runs, each card_load lands a balanced books:
--   cardholder_funded[card]        +X    (ASSET, cardholder display)
--   external_load_clearing[ccy]    -X    (LIABILITY, PSP-owes-cardholder)
-- All intermediates (issuer_funded_pool, psp_cash_at_bank,
-- scheme_receivable) net to zero across phase 11 + 14 + 15 + 17.
-- ===========================================================================

with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR'))
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id('external_load_clearing:' || c.code || ':psp:'),
  'external_load_clearing',
  'LIABILITY',
  c.code,
  'psp',
  null
from currencies c;

alter table paycore.card_loads
  add column acquiring_reconciled_at timestamptz;

create index card_loads_acquiring_unreconciled_idx
  on paycore.card_loads (created_at)
  where acquiring_reconciled_at is null and status = 'succeeded';
