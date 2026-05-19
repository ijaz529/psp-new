-- ===========================================================================
-- Phase 22 — cardholder identity surface.
--
-- Adds a password column to paycore.cardholders and a sessions table mirror
-- of paycore.portal_sessions, scoped to cardholders. Distinct cookie name
-- and distinct table so admin + cardholder sessions can coexist without
-- collision.
--
-- Bootstrap: existing cardholders have password_hash = NULL until admin
-- runs `pnpm cardholder:set-password --email X --password Y`. Sign-in
-- rejects any cardholder with NULL password_hash.
-- ===========================================================================

alter table paycore.cardholders
  add column password_hash text;

create table paycore.cardholder_sessions (
  id              text primary key,                -- chs_<ulid>
  cardholder_id   text not null references paycore.cardholders(id) on delete cascade,
  token_hash      text not null unique,            -- sha256(raw cookie token)
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index cardholder_sessions_cardholder_idx
  on paycore.cardholder_sessions (cardholder_id);
create index cardholder_sessions_active_idx
  on paycore.cardholder_sessions (token_hash)
  where revoked_at is null;

grant select, insert, update on paycore.cardholder_sessions to psp_app;
