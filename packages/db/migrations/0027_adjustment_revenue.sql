-- ===========================================================================
-- Phase 24 — auto-sweep clearing_adjustments to revenue.
--
-- New REVENUE account that absorbs the leftover clearing_adjustments
-- balance once the matching scheme settlement (Phase 15) has cleared.
-- Phase 24 worker posts:
--   clearing_adjustments  +delta    (drain to 0)
--   adjustment_revenue    -delta    (recognize as revenue)
-- where delta = -clearing_adjustments.balance (so the clearing balance
-- ends at exactly 0 regardless of sign).
-- ===========================================================================

with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR'))
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id('adjustment_revenue:' || c.code || ':psp:'),
  'adjustment_revenue',
  'REVENUE',
  c.code,
  'psp',
  null
from currencies c;
