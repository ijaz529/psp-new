-- 0014_clearing_and_payouts.sql
-- Phase 6: clearing file emission + merchant payouts.
--
-- - paycore.merchants.reserve_basis_points   — configurable but no holdback math in MVP
-- - paycore.clearing_files                   — one row per emitted CSV
-- - paycore.clearing_records                 — one row per cleared transaction (joins to PI)
-- - paycore.payouts                          — one row per merchant payout cycle

alter table paycore.merchants
  add column reserve_basis_points int not null default 0
    check (reserve_basis_points >= 0 and reserve_basis_points <= 10000),
  add column payout_schedule text not null default 'daily'
    check (payout_schedule in ('daily', 'weekly', 'manual'));

create table paycore.clearing_files (
  id            text primary key,                -- cf_<ulid>
  scheme        text not null check (scheme in ('visa', 'mastercard', 'amex')),
  currency      char(3) not null references ledger.currencies(code),
  file_date     date not null,
  format        text not null check (format in ('visa_base2', 'mc_ipm')),
  record_count  int not null,
  total_amount  bigint not null,
  path          text not null,
  created_at    timestamptz not null default now()
);
create unique index clearing_files_scheme_date_idx
  on paycore.clearing_files (scheme, currency, file_date, format);

create table paycore.clearing_records (
  id                  text primary key,           -- cr_<ulid>
  clearing_file_id    text not null references paycore.clearing_files(id),
  payment_intent_id   text not null references paycore.payment_intents(id),
  merchant_id         text not null,
  scheme              text not null,
  currency            char(3) not null,
  amount              bigint not null,
  rrn                 char(12) not null,
  occurred_at         timestamptz not null,
  created_at          timestamptz not null default now()
);
create index clearing_records_pi_idx on paycore.clearing_records (payment_intent_id);
create index clearing_records_file_idx on paycore.clearing_records (clearing_file_id);

create table paycore.payouts (
  id                text primary key,             -- po_<ulid>
  merchant_id       text not null,
  currency          char(3) not null references ledger.currencies(code),
  amount            bigint not null check (amount > 0),
  status            text not null check (status in ('pending', 'paid', 'failed', 'canceled')),
  journal_entry_id  text not null references ledger.journal_entries(id),
  scheduled_for     date not null,
  paid_at           timestamptz,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);
create index payouts_merchant_idx on paycore.payouts (merchant_id, scheduled_for desc);
create index payouts_status_idx on paycore.payouts (status, scheduled_for);

grant select, insert, update on
  paycore.clearing_files,
  paycore.clearing_records,
  paycore.payouts
to psp_app;
