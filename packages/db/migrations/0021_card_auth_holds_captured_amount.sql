-- ===========================================================================
-- Phase 16 — partial captures.
--
-- Tracks how much of each authorization has been captured. One auth (0100)
-- can now have multiple 0220 capture messages summing up to `amount`. The
-- hold is only marked `captured` when `captured_amount = amount`. A
-- subsequent 0420 reversal targets only the remaining (amount - captured).
--
-- CHECK constraint enforces 0 ≤ captured_amount ≤ amount at the DB level.
-- Backfill brings existing `captured` rows up to date — `reversed` and
-- `expired` rows keep captured_amount = 0 since nothing was captured.
-- ===========================================================================

alter table paycore.card_auth_holds
  add column captured_amount bigint not null default 0
  check (captured_amount >= 0 and captured_amount <= amount);

update paycore.card_auth_holds
  set captured_amount = amount
  where resolved_reason = 'captured';
