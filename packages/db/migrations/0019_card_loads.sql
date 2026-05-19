-- ===========================================================================
-- Phase 11 — card-load via the acquiring side.
--
-- One row per top-up attempt: status='succeeded' rows have a journal_entry_id
-- pointing at the cardholder_funded ↑ / issuer_funded_pool ↓ posting.
-- status='failed' rows preserve the decline reason for audit + retry analysis
-- but post no journal.
--
-- Idempotency at the API layer rides the existing Idempotency-Key infra; this
-- table is the authoritative record of the wire attempt itself.
-- ===========================================================================

create table paycore.card_loads (
  id                 text primary key,                       -- cl_*
  card_id            text not null references paycore.cards(id),
  payment_method_id  text not null references paycore.payment_methods(id),
  amount             bigint not null check (amount > 0),
  currency           char(3) not null references ledger.currencies(code),
  status             text not null check (status in ('succeeded', 'failed')),
  response_code      char(2) not null,                       -- DE 39
  rrn                char(12),                               -- DE 37 (null when no wire attempt happened)
  stan               char(6),                                -- DE 11
  failure_code       text,                                   -- 'card_declined', 'acquirer_timeout', ...
  failure_message    text,
  journal_entry_id   text references ledger.journal_entries(id),
  created_at         timestamptz not null default now()
);
create index card_loads_card_idx on paycore.card_loads (card_id, created_at desc);

grant select, insert, update on paycore.card_loads to psp_app;
