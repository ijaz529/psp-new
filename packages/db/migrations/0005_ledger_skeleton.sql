-- 0005_ledger_skeleton.sql
-- Skeleton tables for the double-entry ledger. NO business constraints yet —
-- the balanced-entry constraint trigger and the append-only enforcement land
-- in Phase 1 in their own migrations. Phase 0 just ships the columns so apps
-- can type-import them.

create table ledger.accounts (
  id          text primary key,                -- acct_<ulid>
  code        text not null,                    -- e.g. 'merchant_settlement_liability'
  type        text not null check (type in ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY')),
  currency    char(3) not null references ledger.currencies(code),
  owner_kind  text not null check (owner_kind in ('psp', 'merchant', 'scheme', 'issuer')),
  owner_id    text,
  metadata    text,
  created_at  timestamptz not null default now()
);

-- Account uniqueness: same code+currency+owner can only exist once.
-- owner_id is nullable; we coalesce to '' for index uniqueness.
create unique index accounts_code_currency_owner_idx
  on ledger.accounts (code, currency, owner_kind, coalesce(owner_id, ''));

create table ledger.journal_entries (
  id           text primary key,                -- je_<ulid>
  external_id  text not null unique,             -- caller's idempotency anchor
  description  text not null,
  occurred_at  timestamptz not null,
  created_at   timestamptz not null default now()
);

create index journal_entries_occurred_idx on ledger.journal_entries (occurred_at);

create table ledger.journal_lines (
  id          text primary key,                 -- jl_<ulid>
  entry_id    text not null references ledger.journal_entries(id),
  account_id  text not null references ledger.accounts(id),
  amount      bigint not null,                  -- signed minor units
  currency    char(3) not null references ledger.currencies(code),
  created_at  timestamptz not null default now()
);

create index journal_lines_entry_idx on ledger.journal_lines (entry_id);
create index journal_lines_account_idx on ledger.journal_lines (account_id);

-- Phase 1 will add:
--   - constraint trigger enforcing SUM(amount) = 0 per currency per entry
--   - rule/trigger blocking UPDATE and DELETE on journal_lines and journal_entries
--   - account balance materialized view + refresh job
