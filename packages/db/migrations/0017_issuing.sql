-- 0017_issuing.sql
-- Phase 9: issuing side. Card products + cardholders + cards + auth holds,
-- plus an extension to the chart of accounts for cardholder funded balances
-- and authorization holds.

-- ---------------------------------------------------------------------------
-- Card products. MVP seeds two: one Visa-test, one Mastercard-test, both
-- USD. Future products on different schemes / currencies are pure data.
-- ---------------------------------------------------------------------------
create table paycore.card_products (
  id                text primary key,                       -- prod_*
  name              text not null,
  scheme            text not null check (scheme in ('visa', 'mastercard')),
  -- Inclusive [low, high] range over the first 9 PAN digits. 9 is enough
  -- to address any sane test allocation without spilling into the variable
  -- account-id portion. Using char(9) keeps comparisons lexicographic.
  bin_range_low     char(9) not null,
  bin_range_high    char(9) not null,
  currency          char(3) not null references ledger.currencies(code),
  default_controls  jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  check (bin_range_low <= bin_range_high)
);
create index card_products_bin_idx on paycore.card_products (bin_range_low, bin_range_high);

-- ---------------------------------------------------------------------------
-- Cardholders. MVP: standalone individuals, no merchant link. The future
-- B2B card-program variant would add `merchant_id text references ...`.
-- ---------------------------------------------------------------------------
create table paycore.cardholders (
  id           text primary key,                            -- ch_*
  email        citext not null unique,
  full_name    text not null,
  phone        text,
  status       text not null check (status in ('active', 'suspended')) default 'active',
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Cards. PAN lives in vault.tokens (issuer namespace: merchant_id =
-- 'issuer:<product_id>' so issuing and acquiring tokens don't collide on
-- the per-merchant HMAC). `funded_account_id` is the cardholder's available
-- balance; auth holds sit in a sibling account (see below).
-- ---------------------------------------------------------------------------
create table paycore.cards (
  id                 text primary key,                      -- card_*
  product_id         text not null references paycore.card_products(id),
  cardholder_id      text not null references paycore.cardholders(id),
  pan_token          text not null,                         -- vault token id
  bin                char(6) not null,
  last4              char(4) not null,
  exp_month          char(2) not null,
  exp_year           char(4) not null,
  status             text not null check (status in ('active', 'frozen', 'cancelled')) default 'active',
  controls           jsonb not null default '{}'::jsonb,    -- overlay on product.default_controls
  funded_account_id  text not null references ledger.accounts(id),
  holds_account_id   text not null references ledger.accounts(id),
  created_at         timestamptz not null default now()
);
create index cards_bin_idx on paycore.cards (bin);
create index cards_cardholder_idx on paycore.cards (cardholder_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Authorization holds. Open until the acquirer's 0220 clearing arrives
-- (capture) or the auth expires. Composite uniqueness on (stan, rrn) catches
-- duplicate 0100 retransmits — issuer-host can return the same response
-- without double-holding.
-- ---------------------------------------------------------------------------
create table paycore.card_auth_holds (
  id                text primary key,                       -- hold_*
  card_id           text not null references paycore.cards(id),
  stan              char(6) not null,                       -- DE 11
  rrn               char(12) not null,                      -- DE 37
  amount            bigint not null check (amount > 0),
  currency          char(3) not null references ledger.currencies(code),
  merchant_name     text,                                   -- DE 43 acceptor name
  mcc               char(4),                                -- DE 18
  approval_code     char(6),                                -- DE 38 (echo)
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  resolved_reason   text check (resolved_reason in ('captured', 'reversed', 'expired')),
  unique (stan, rrn)
);
create index card_auth_holds_card_idx on paycore.card_auth_holds (card_id, created_at desc);
create index card_auth_holds_open_idx on paycore.card_auth_holds (card_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Issuing chart of accounts (shared, non-per-cardholder).
--   issuer_funded_pool       — where cardholder loads originate
--   issuer_settlement        — captures land here before periodic sweep
-- Per-cardholder accounts (funded balance + open holds) are created by
-- the `card:issue` CLI as part of card creation, mirroring the
-- ensureMerchantAccounts pattern from acquiring.
-- ---------------------------------------------------------------------------
with currencies(code) as (values ('USD'), ('EUR'), ('GBP'), ('AED'), ('INR')),
     specs(code, type, owner_kind) as (values
       ('issuer_funded_pool',  'ASSET',     'psp'),
       ('issuer_settlement',   'LIABILITY', 'psp')
     )
insert into ledger.accounts (id, code, type, currency, owner_kind, owner_id)
select
  ledger._acct_id(s.code || ':' || c.code || ':psp:'),
  s.code,
  s.type,
  c.code,
  s.owner_kind,
  null
from currencies c
cross join specs s;

-- ---------------------------------------------------------------------------
-- Seed: two card products for the MVP demo.
--
-- Visa test BIN  411111000-411111999  (slice of the well-known 4111-11 test BIN)
-- MC test BIN    555555000-555555999  (slice of the well-known 5555-55 test BIN)
--
-- default_controls.daily_limit = 100000 minor units = $1000 USD/day per card
-- default_controls.mcc_blocklist starts empty; per-card overrides go in
-- paycore.cards.controls.
-- ---------------------------------------------------------------------------
insert into paycore.card_products (id, name, scheme, bin_range_low, bin_range_high, currency, default_controls)
values
  ('prod_strawberry_visa_usd', 'Strawberry Test Visa (USD)', 'visa',
   '411111000', '411111999', 'USD',
   '{"daily_limit": 100000, "mcc_blocklist": []}'::jsonb),
  ('prod_strawberry_mc_usd',   'Strawberry Test Mastercard (USD)', 'mastercard',
   '555555000', '555555999', 'USD',
   '{"daily_limit": 100000, "mcc_blocklist": []}'::jsonb);

-- ---------------------------------------------------------------------------
-- Grants for psp_app (api, issuer-host, worker, portal).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  paycore.card_products,
  paycore.cardholders,
  paycore.cards,
  paycore.card_auth_holds
to psp_app;
