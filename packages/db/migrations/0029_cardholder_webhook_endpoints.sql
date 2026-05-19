-- ===========================================================================
-- Phase 26 — Cardholder webhook delivery.
--
-- The events + webhook_endpoints tables were merchant-only since Phase 0.
-- This migration makes both polymorphic: each row carries EXACTLY ONE of
-- merchant_id / cardholder_id (XOR-enforced via check constraint).
--
-- webhook_attempts + webhook_dead_letter need no change — they pivot on
-- endpoint_id, which inherits the polymorphism automatically.
-- ===========================================================================

alter table paycore.events
  alter column merchant_id drop not null,
  add column cardholder_id text references paycore.cardholders(id),
  add constraint events_owner_check
    check ((merchant_id is not null)::int + (cardholder_id is not null)::int = 1);

create index events_cardholder_created_idx
  on paycore.events (cardholder_id, created_at desc)
  where cardholder_id is not null;

alter table paycore.webhook_endpoints
  alter column merchant_id drop not null,
  add column cardholder_id text references paycore.cardholders(id),
  add constraint webhook_endpoints_owner_check
    check ((merchant_id is not null)::int + (cardholder_id is not null)::int = 1);

create index webhook_endpoints_cardholder_idx
  on paycore.webhook_endpoints (cardholder_id, status)
  where cardholder_id is not null;
