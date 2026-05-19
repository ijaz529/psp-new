-- ===========================================================================
-- Phase 21 — opt-in auto-adjust on clearing ingest.
--
-- New per-currency holding account that absorbs adjustments posted when
-- an operator runs `pnpm clearing:ingest --auto-adjust` against a file
-- whose totals disagree with paycore.clearing_records. The journal pair
-- per (scheme, currency) is:
--
--   scheme_receivable  +delta
--   clearing_adjustments -delta
--
-- delta = Σ file_amount − Σ ledger_amount; positive means ledger needs
-- adjusting up to match the file.
--
-- Operators sweep clearing_adjustments to psp_cash_at_bank manually when
-- they're satisfied the adjustment was correct (future phase may automate).
-- ===========================================================================

with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR'))
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id('clearing_adjustments:' || c.code || ':psp:'),
  'clearing_adjustments',
  'LIABILITY',
  c.code,
  'psp',
  null
from currencies c;
