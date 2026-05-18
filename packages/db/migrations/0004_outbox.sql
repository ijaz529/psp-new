-- 0004_outbox.sql
-- Transactional outbox — domain events written inside the same DB transaction
-- as the business state change. A separate process (outbox-relay) drains using
-- SELECT ... FOR UPDATE SKIP LOCKED.

create table paycore.outbox (
  id           text primary key,                 -- oe_<ulid>
  event_type   text not null,
  payload      jsonb not null,
  headers      jsonb,
  resource_id  text,                             -- for per-resource ordering
  created_at   timestamptz not null default now(),
  locked_at    timestamptz,
  delivered_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);

-- Drains pick up undelivered rows oldest-first; resource_id index lets us look
-- up an event by what it's about (debug + audit).
create index outbox_undelivered_idx on paycore.outbox (delivered_at, created_at)
  where delivered_at is null;

create index outbox_resource_idx on paycore.outbox (resource_id)
  where resource_id is not null;
