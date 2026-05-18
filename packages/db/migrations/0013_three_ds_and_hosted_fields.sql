-- 0013_three_ds_and_hosted_fields.sql
-- Phase 4: hosted-fields iframe + 3DS2 simulation.
--
--   - paycore.three_ds_sessions          — one row per 3DS challenge attempt
--   - paycore.payment_intents.next_action — exposes the 3DS redirect_url to merchants
--   - paycore.payment_intents.request_three_d_secure — Stripe-mirror knob; Phase 4 stores it,
--     Phase 7 risk engine reads it
--   - paycore.merchants.allowed_origins  — CSP frame-ancestors whitelist for the iframe

alter table paycore.merchants
  add column allowed_origins text[] not null default array[]::text[];

alter table paycore.payment_intents
  add column next_action jsonb,
  add column request_three_d_secure text not null default 'automatic'
    check (request_three_d_secure in ('automatic', 'any', 'never'));

create table paycore.three_ds_sessions (
  id                 text primary key,                 -- tds_<ulid>
  merchant_id        text not null,
  payment_intent_id  text not null references paycore.payment_intents(id),
  token_id           text not null,
  scheme             text not null,
  status             text not null check (status in ('pending', 'approved', 'declined', 'expired'))
    default 'pending',
  -- Carry-through fields populated on completion. Phase 5 forwards these
  -- into DE 48.43 of the 8583 authorization.
  eci                text,
  cavv               text,
  trans_status       text,
  redirect_url       text not null,
  expires_at         timestamptz not null,
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
create index three_ds_sessions_intent_idx on paycore.three_ds_sessions (payment_intent_id);
create index three_ds_sessions_status_idx on paycore.three_ds_sessions (status, expires_at);

grant select, insert, update on paycore.three_ds_sessions to psp_app;
