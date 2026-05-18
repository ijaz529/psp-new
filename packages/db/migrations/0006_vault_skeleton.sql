-- 0006_vault_skeleton.sql
-- Vaultless tokenization skeleton. Phase 2 wires the HMAC tokenize/detokenize logic.
-- Note: we never store the PAN, even encrypted. pan_hmac is the dedup key per merchant.

create table vault.tokens (
  id            text primary key,                    -- tok_<ulid>
  merchant_id   text not null,
  pan_hmac      text not null,                       -- HMAC-SHA256(KMS_key, PAN) hex
  bin           char(6) not null,
  last4         char(4) not null,
  exp_month     text,                                 -- 'MM' or null
  exp_year      text,                                 -- 'YYYY' or null
  scheme        text not null check (scheme in ('visa', 'mastercard', 'amex', 'unknown')),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create unique index tokens_merchant_pan_hmac_idx on vault.tokens (merchant_id, pan_hmac);
create index tokens_bin_idx on vault.tokens (bin);
