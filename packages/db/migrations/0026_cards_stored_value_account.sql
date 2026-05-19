-- ===========================================================================
-- Phase 23 — per-card cardholder_stored_value LIABILITY.
--
-- Each new card gets its own stored_value LIABILITY account at issue time
-- (created by the card-issue CLI alongside the existing funded + holds
-- accounts). This column links the card to that account so the phase 17
-- acquiring-leg sweeper can route the credit leg to a per-card book
-- instead of the aggregate PSP-level external_load_clearing.
--
-- Nullable: existing cards (phases 9-22) stay NULL and keep using the
-- PSP-level clearing via the sweeper's fallback path. New cards get
-- per-card accounts. No backfill — historical data stays where it is.
-- ===========================================================================

alter table paycore.cards
  add column stored_value_account_id text references ledger.accounts(id);
