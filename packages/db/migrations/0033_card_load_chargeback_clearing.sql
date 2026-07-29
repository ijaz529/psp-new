-- ===========================================================================
-- Phase 37 — Card-load chargeback fan-out to scheme files.
--
-- 1. card_loads.refunded_at: Phase 25's refund was a bare status flip, so
--    the nightly clearing job had no timestamp to window chargeback
--    fan-out on. Nullable, no backfill — loads refunded before this column
--    existed are never fanned out (their scheme-side deltas already flowed
--    through the Phase 21/24 adjustment chain).
--
-- 2. Drop the clearing_records.payment_intent_id → payment_intents FK.
--    Chargeback records carry the card_load id (cl_…) in that slot. Real
--    clearing records reference opaque scheme transactions, not one
--    internal table. Column name and index stay.
-- ===========================================================================

alter table paycore.card_loads
  add column refunded_at timestamptz;

alter table paycore.clearing_records
  drop constraint if exists clearing_records_payment_intent_id_fkey;
