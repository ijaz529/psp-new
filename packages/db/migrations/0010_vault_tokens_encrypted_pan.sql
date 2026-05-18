-- 0010_vault_tokens_encrypted_pan.sql
-- Phase 2: hybrid vaultless tokenization. PAN is HMAC-derived for the dedup key
-- (per-merchant) AND stored as KMS-encrypted ciphertext for detokenize. The
-- detokenize path is the only way back to a raw PAN; gated to the
-- `acquirer-host` sender via X-Service-Auth at the application layer, and to
-- the `psp_vault` Postgres role at the database layer (migration 0011).
--
-- ADR-0011 explains the Option A vs B trade-off.

alter table vault.tokens
  add column pan_ciphertext text,
  add column kms_key_id     text;

-- A token must either be a stub (no ciphertext yet, ephemeral state during
-- migration) or fully populated. Enforced at INSERT time when Phase 2 ships.
alter table vault.tokens
  add constraint tokens_ciphertext_consistency
    check ((pan_ciphertext is null and kms_key_id is null)
        or (pan_ciphertext is not null and kms_key_id is not null));

-- ---------------------------------------------------------------------------
-- Detokenize audit log. Every successful detokenize writes one row.
-- Never contains the PAN. Used for ops queries ("who detokenized X?") and for
-- compliance evidence ("show me all detokenizes in the last 30 days").
-- ---------------------------------------------------------------------------
create table vault.detokenize_audit (
  id              text primary key,
  token_id        text not null,
  merchant_id     text not null,
  sender          text not null,
  reason          text not null check (reason in ('authorization', 'capture', 'refund', 'audit')),
  request_id      text,
  detokenized_at  timestamptz not null default now()
);

create index detokenize_audit_token_idx    on vault.detokenize_audit (token_id);
create index detokenize_audit_merchant_idx on vault.detokenize_audit (merchant_id, detokenized_at desc);
create index detokenize_audit_when_idx     on vault.detokenize_audit (detokenized_at desc);
