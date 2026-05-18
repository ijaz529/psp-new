-- 0012_payment_intents.sql
-- Phase 3: public API resources. PaymentIntent state machine + supporting
-- tables. Money columns are bigint minor units (see ADR-0009).

-- ---------------------------------------------------------------------------
-- Customers (tenant: merchant_id)
-- ---------------------------------------------------------------------------
create table paycore.customers (
  id           text primary key,
  merchant_id  text not null,
  email        citext,
  name         text,
  description  text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);
create index customers_merchant_idx on paycore.customers (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Payment methods — references a vault token. We do NOT replicate PAN data
-- here; the BIN/last4/scheme are denormalized for display + routing only.
-- ---------------------------------------------------------------------------
create table paycore.payment_methods (
  id            text primary key,
  merchant_id   text not null,
  customer_id   text references paycore.customers(id),
  token_id      text not null,
  bin           char(6) not null,
  last4         char(4) not null,
  scheme        text not null check (scheme in ('visa', 'mastercard', 'amex', 'unknown')),
  exp_month     text,
  exp_year      text,
  created_at    timestamptz not null default now()
);
create index payment_methods_merchant_idx on paycore.payment_methods (merchant_id, created_at desc);
create index payment_methods_customer_idx on paycore.payment_methods (customer_id);

-- ---------------------------------------------------------------------------
-- Payment intents — the heart of Phase 3.
-- ---------------------------------------------------------------------------
create table paycore.payment_intents (
  id                 text primary key,
  merchant_id        text not null,
  customer_id        text references paycore.customers(id),
  payment_method_id  text references paycore.payment_methods(id),
  amount             bigint not null check (amount > 0),
  amount_received    bigint not null default 0,
  amount_capturable  bigint not null default 0,
  currency           char(3) not null references ledger.currencies(code),
  status             text not null check (status in (
                       'requires_payment_method',
                       'requires_confirmation',
                       'requires_action',
                       'processing',
                       'requires_capture',
                       'succeeded',
                       'canceled',
                       'failed'
                     )),
  capture_method     text not null check (capture_method in ('automatic', 'manual')),
  confirmation_method text not null check (confirmation_method in ('automatic', 'manual')),
  client_secret      text not null,
  last_payment_error_code         text,
  last_payment_error_message      text,
  last_payment_error_decline_code text,
  metadata           jsonb,
  livemode           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index payment_intents_merchant_status_idx on paycore.payment_intents (merchant_id, status, created_at desc);
create index payment_intents_merchant_created_idx on paycore.payment_intents (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Refunds. The journal_entry_id links to ledger.journal_entries — the
-- "money side" of the refund.
-- ---------------------------------------------------------------------------
create table paycore.refunds (
  id                 text primary key,
  merchant_id        text not null,
  payment_intent_id  text not null references paycore.payment_intents(id),
  amount             bigint not null check (amount > 0),
  currency           char(3) not null references ledger.currencies(code),
  status             text not null check (status in ('pending', 'succeeded', 'failed')),
  reason             text check (reason in ('requested_by_customer', 'duplicate', 'fraudulent', 'expired_uncaptured_charge')),
  journal_entry_id   text not null references ledger.journal_entries(id),
  metadata           jsonb,
  created_at         timestamptz not null default now()
);
create index refunds_intent_idx on paycore.refunds (payment_intent_id);
create index refunds_merchant_idx on paycore.refunds (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Events — the merchant-visible audit log. Appended by the gateway,
-- queried by the merchant via /v1/events.
-- ---------------------------------------------------------------------------
create table paycore.events (
  id           text primary key,
  merchant_id  text not null,
  type         text not null,
  api_version  text not null default '2026-01-01',
  resource_id  text,
  data         jsonb not null,
  livemode     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index events_merchant_created_idx on paycore.events (merchant_id, created_at desc);
create index events_merchant_type_idx on paycore.events (merchant_id, type, created_at desc);
create index events_resource_idx on paycore.events (resource_id) where resource_id is not null;

-- ---------------------------------------------------------------------------
-- Webhook endpoints (merchant-configured)
-- ---------------------------------------------------------------------------
create table paycore.webhook_endpoints (
  id              text primary key,
  merchant_id     text not null,
  url             text not null,
  description     text,
  enabled_events  text[] not null default array['*'],
  signing_secret  text not null,
  status          text not null check (status in ('enabled', 'disabled', 'deleted')) default 'enabled',
  created_at      timestamptz not null default now(),
  disabled_at     timestamptz
);
create index webhook_endpoints_merchant_idx on paycore.webhook_endpoints (merchant_id, status);

-- ---------------------------------------------------------------------------
-- Webhook attempts — one row per delivery attempt.
-- ---------------------------------------------------------------------------
create table paycore.webhook_attempts (
  id              text primary key,
  event_id        text not null references paycore.events(id),
  endpoint_id     text not null references paycore.webhook_endpoints(id),
  attempt_number  int not null,
  http_status     int,
  response_body   text,
  error           text,
  delivered_at    timestamptz,
  next_retry_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index webhook_attempts_event_endpoint_idx on paycore.webhook_attempts (event_id, endpoint_id);
create index webhook_attempts_pending_idx on paycore.webhook_attempts (next_retry_at) where delivered_at is null and next_retry_at is not null;

-- ---------------------------------------------------------------------------
-- Webhook dead-letter — permanently-failed deliveries. Queryable from admin
-- with a `retried_at` column so we can manually replay.
-- ---------------------------------------------------------------------------
create table paycore.webhook_dead_letter (
  id                     text primary key,
  event_id               text not null references paycore.events(id),
  endpoint_id            text not null references paycore.webhook_endpoints(id),
  reason                 text not null check (reason in ('exceeded_retries', 'non_retryable_status', 'endpoint_deleted')),
  last_error             text,
  failed_after_attempts  int not null,
  created_at             timestamptz not null default now(),
  retried_at             timestamptz
);
create index webhook_dead_letter_merchant_idx on paycore.webhook_dead_letter (endpoint_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grant the new tables to psp_app (the role used by api/worker/outbox-relay).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  paycore.customers,
  paycore.payment_methods,
  paycore.payment_intents,
  paycore.refunds,
  paycore.events,
  paycore.webhook_endpoints,
  paycore.webhook_attempts,
  paycore.webhook_dead_letter
to psp_app;
