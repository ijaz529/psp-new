-- ===========================================================================
-- Phase 14 — pool reconciliation.
--
-- Phase 11 deferred the acquiring-side accounting for card loads. The pool
-- (issuer_funded_pool) drains on every load and never recovers. Phase 14
-- adds a worker job that sweeps unreconciled loads and posts a refill
-- journal (issuer_funded_pool +X / psp_cash_at_bank -X). The new column
-- here tells the sweep which rows it still needs to process.
--
-- Partial index narrows the scan to status='succeeded' rows that haven't
-- been swept yet — failed loads never posted a journal in the first place,
-- so they don't need reconciliation.
-- ===========================================================================

alter table paycore.card_loads
  add column reconciled_at timestamptz;

create index card_loads_unreconciled_idx
  on paycore.card_loads (created_at)
  where reconciled_at is null and status = 'succeeded';
