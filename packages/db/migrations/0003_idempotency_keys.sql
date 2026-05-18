-- 0003_idempotency_keys.sql
-- Per merchant + key, holds the cached response for 24h after a state-changing call.
-- Source of truth for idempotency; Redis is only a hot-path cache.

create table paycore.idempotency_keys (
  merchant_id     text not null,
  key             text not null,
  method          text not null,
  path            text not null,
  request_hash    text not null,           -- sha256 of canonicalized request body
  response_status int,
  response_body   jsonb,
  locked_at       timestamptz,
  completed_at    timestamptz,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  primary key (merchant_id, key)
);

create index idempotency_keys_expires_idx on paycore.idempotency_keys (expires_at);
