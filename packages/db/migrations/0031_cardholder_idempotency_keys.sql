-- 0031_cardholder_idempotency_keys.sql
-- Mirror of paycore.idempotency_keys, keyed by cardholder_id. Phase 32 made the
-- idempotency plugin cardholder-aware; the data shape is the same but the
-- principal is the cardholder, so we keep the tables parallel (matching the
-- 0030 cardholder_api_keys / api_keys split).

create table paycore.cardholder_idempotency_keys (
  cardholder_id   text not null,
  key             text not null,
  method          text not null,
  path            text not null,
  request_hash    text not null,
  response_status int,
  response_body   jsonb,
  locked_at       timestamptz,
  completed_at    timestamptz,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  primary key (cardholder_id, key)
);

create index cardholder_idempotency_keys_expires_idx
  on paycore.cardholder_idempotency_keys (expires_at);
