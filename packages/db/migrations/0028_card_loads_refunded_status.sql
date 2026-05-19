-- ===========================================================================
-- Phase 25 — card-load chargeback / refund.
--
-- Extends the card_loads.status check constraint to include 'refunded'.
-- Refunded rows preserve their original response_code + rrn + stan;
-- the status flip is the only field change, with the unwind posted via
-- a separate journal at refund time.
-- ===========================================================================

alter table paycore.card_loads
  drop constraint card_loads_status_check;

alter table paycore.card_loads
  add constraint card_loads_status_check
  check (status in ('succeeded', 'failed', 'refunded'));
