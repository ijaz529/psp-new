-- ===========================================================================
-- Phase 30 — Cardholder REST API: API keys.
--
-- Parallel of paycore.api_keys but cardholder-scoped. Cardholders only
-- get secret keys (no publishable/secret split). prefix + sha256_hash
-- pattern matches the merchant table so existing tooling (hash lookup,
-- "show secret ONCE") carries over verbatim.
-- ===========================================================================

create table paycore.cardholder_api_keys (
  id              text primary key,
  cardholder_id   text not null references paycore.cardholders(id),
  env             text not null check (env in ('test', 'live')),
  prefix          text not null,
  sha256_hash     text not null,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
create index cardholder_api_keys_cardholder_idx
  on paycore.cardholder_api_keys (cardholder_id);
create unique index cardholder_api_keys_hash_idx
  on paycore.cardholder_api_keys (sha256_hash);
