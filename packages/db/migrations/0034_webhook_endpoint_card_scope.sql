-- ===========================================================================
-- Phase 40 — per-card webhook endpoint scoping.
--
-- A cardholder endpoint may be scoped to one card: it then receives only
-- events carrying that card's id (outbox headers.card_id, stamped by
-- publishCardholderEvent). NULL = unscoped, the status quo for every
-- existing row — merchant endpoints never set it (check constraint).
-- ===========================================================================

alter table paycore.webhook_endpoints
  add column card_id text references paycore.cards(id),
  add constraint webhook_endpoints_card_scope_cardholder_only
    check (card_id is null or cardholder_id is not null);
