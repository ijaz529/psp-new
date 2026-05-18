# Phase 2 — Tokenization Vault (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 1 (see `PHASE_1_DONE.md`).

> Separate service (own process, own DB schema, own secrets) — even in the
> monolith, treat it as a hard boundary. This is the only thing that ever sees
> a raw PAN.
> — PROJECT_BRIEF.md §3 Phase 2

The `apps/vault` Fastify service is already scaffolded (`/healthz` + stub
`POST /internal/v1/tokenize`). Phase 2 fills in the actual tokenization logic.

---

## Goal

A vault service that:

1. **Accepts a raw PAN** at `POST /internal/v1/tokenize` (called from the API
   when it receives PAN from the hosted-fields iframe in Phase 4 — until then,
   from internal tests).
2. **Returns an opaque token** `tok_<ulid>` plus `bin` (first 6) + `last4` +
   detected `scheme`.
3. **Detokenizes** at `POST /internal/v1/detokenize` — ONLY callable from the
   `acquirer-host` service (HMAC `X-Service-Auth` sender = `acquirer-host`).
   This is the only path back to the PAN, and it's only called at the moment
   of sending an 8583 message to the scheme simulator.
4. **Stores zero PAN data at rest.** Even encrypted. The vault table stores
   only an HMAC of the PAN (the dedup key) + BIN + last4 + scheme.
5. **Logs no PAN, ever.** Pino redaction layer 1 + layer 2 already in place.
6. **mTLS-style boundary in code** even though we stub with HMAC service auth.

When Phase 2 is done, you can curl `POST /internal/v1/tokenize` with a PAN and
get a token back; the response never contains the PAN; the database has only
the HMAC + masked-form metadata. Then curl `/internal/v1/detokenize` from
the acquirer-host context and get the PAN back. No other service can call
detokenize.

---

## Vaultless HMAC tokenization

This is the design from PROJECT_BRIEF.md §3 Phase 2 + ADR-0004.

```
                       merchant-supplied PAN
                              │
                              ▼
                  ┌──────────────────────────┐
                  │  KMS HMAC-SHA256(key, PAN)│
                  └──────────────────────────┘
                              │
                              ▼
                          pan_hmac (hex)
                              │
                              ▼
           ┌───────────────────────────────────────────┐
           │ vault.tokens                              │
           │   id          tok_<ulid>                  │
           │   merchant_id mrch_...                    │
           │   pan_hmac    <— UNIQUE per merchant      │
           │   bin         char(6)                     │
           │   last4       char(4)                     │
           │   scheme      visa | mastercard | amex |  │
           │   exp_month, exp_year                     │
           └───────────────────────────────────────────┘
                              │
                              ▼
                  return { id, bin, last4, scheme }
```

Re-tokenizing the same PAN for the same merchant returns the SAME token
(deterministic HMAC + unique constraint). Re-tokenizing for a different
merchant returns a NEW token (different HMAC scope).

**Detokenize is the missing piece** — HMAC is one-way, so we can't recover the
PAN from `pan_hmac`. For detokenize, we DO need to store the PAN somewhere
reversible. Two options:

### Option A — true vaultless (read-only detokenize via merchant resupply)
The PAN is never stored. Detokenize is not possible; the merchant must re-tokenize
the PAN through hosted-fields each time.

Pros: smallest blast radius — no PAN ever exists at rest.
Cons: every charge needs the merchant's hosted-fields re-tokenization. No
"saved card" experience. Recurring billing impossible. Refunds need a separate
flow.

### Option B — hybrid (HMAC dedup + KMS-encrypted PAN for detokenize)
The PAN is stored encrypted by KMS with the merchant + token id as AAD, so a
key-id rotation invalidates it. Detokenize is only callable by `acquirer-host`.

Pros: enables saved cards, recurring billing, refunds against original PAN if
the scheme requires it.
Cons: the PAN does live at rest (encrypted). Compliance scope larger.

**My recommendation:** start with **Option B (hybrid)**. Real PSPs do this.
The encryption + service-auth-gated detokenize keeps us PCI-honest.

**Open question for you:** confirm Option B, or push back if you prefer the
purer Option A. Affects: schema, detokenize API, gateway flow in Phase 3.

---

## Schema upgrade

Migration `0010_vault_tokens_encrypted_pan.sql`:

- Add `pan_ciphertext bytea` column to `vault.tokens` (encrypted PAN).
- Add `kms_key_id text` column (which KMS key encrypted it — supports rotation).
- Add a CHECK constraint that `pan_ciphertext` is non-null when `scheme` is
  non-null (i.e., we never have a half-tokenized record).
- Add a row-level security policy that only `vault` Postgres role can SELECT
  the encrypted PAN — even an accidental query from the api or worker role
  would fail.

(If you pick Option A, this migration is a no-op and we skip the column.)

---

## Library (`packages/vault-client`)

A thin typed client used by the API + acquirer-host:

```ts
export interface TokenizeRequest {
  pan: string;                      // 12-19 digits
  expMonth?: string;                // 'MM'
  expYear?: string;                 // 'YYYY'
  merchantId: string;
}

export interface TokenizeResponse {
  token: string;                    // tok_<ulid>
  bin: string;                      // first 6 digits
  last4: string;
  scheme: 'visa' | 'mastercard' | 'amex' | 'unknown';
}

export interface DetokenizeRequest {
  token: string;
  merchantId: string;
  reason: 'authorization' | 'capture' | 'refund' | 'audit';
}

export interface DetokenizeResponse {
  pan: string;                      // returned ONLY over the internal service network
  expMonth: string | null;
  expYear: string | null;
}

export interface VaultClient {
  tokenize(req: TokenizeRequest): Promise<TokenizeResponse>;
  detokenize(req: DetokenizeRequest): Promise<DetokenizeResponse>;
}
```

The client signs every call with `X-Service-Auth` (sender = `api` for tokenize,
sender = `acquirer-host` for detokenize). The vault rejects detokenize from
any other sender.

---

## Vault routes (apps/vault)

- `POST /internal/v1/tokenize`
  - Auth: HMAC `X-Service-Auth` from any internal service.
  - Validates PAN (12-19 digits, Luhn check optional — schemes do their own).
  - Detects scheme from BIN.
  - HMAC the PAN with KMS key, look up existing token, or insert new.
  - Encrypt PAN with KMS (Option B) and store ciphertext.
  - Return `tok_…` + bin + last4 + scheme.
- `POST /internal/v1/detokenize`
  - Auth: HMAC `X-Service-Auth` with `sender === 'acquirer-host'` ONLY.
  - Reject all other senders with `permission_denied`.
  - Look up token, decrypt PAN with KMS, return PAN + exp.
  - Log the call (without PAN, of course) — every detokenize is auditable.

---

## Tests

- Unit (`packages/vault-client`):
  - Mock HTTP, assert correct `X-Service-Auth` header is set.
  - Detokenize uses `acquirer-host` sender.
- Integration (DB-gated):
  - End-to-end: tokenize → detokenize round-trip recovers the PAN.
  - Tokenize twice with the same (merchant, PAN) → same token.
  - Tokenize same PAN under different merchants → different tokens.
  - Detokenize with wrong sender → 403 `permission_denied`.
  - **Adversarial logging test:** generate fake "this is what the upstream
    response looked like" payload and feed it into the vault's logger; assert
    `assertNoPan` finds nothing.
- Security review:
  - Try `SELECT pan_ciphertext FROM vault.tokens` as the `psp` (api) user → must fail.
  - Try `SELECT pan_ciphertext FROM vault.tokens` as the `vault` user → succeeds.

---

## Estimated scope

| Item | LOC | Time |
|---|---|---|
| Schema migration | ~50 | 0.25 day |
| Vault routes (tokenize + detokenize) | ~250 | 1 day |
| `packages/vault-client` typed client | ~150 | 0.5 day |
| KMS encrypt/decrypt with AAD wired in vault | ~100 | 0.25 day |
| Postgres role + RLS policy for vault.tokens | ~50 | 0.5 day |
| Tests (unit + integration + adversarial + security) | ~400 | 1 day |
| Docs + ADR-0011 (Option A vs B rationale) | ~50 | 0.25 day |

**Total:** ~3.75 days for a solo dev.

---

## Open questions for you

1. **Option A (purist vaultless, no detokenize) vs Option B (hybrid with KMS-encrypted PAN at rest)** — my recommendation is B. Affects PCI scope.
2. **Should the vault have its own Postgres role + RLS policy?** Adds ops complexity; gains a real isolation layer even within a single DB. My recommendation: yes — it's the spirit of the "hard boundary" rule.
3. **PAN validation in vault**: just length (12–19 digits) or also Luhn check? Schemes ultimately do their own Luhn; we could skip it. My recommendation: Luhn check anyway, reject early.
4. **Detokenize audit log**: structured row in `vault.detokenize_audit` table (with sender + token id + reason + timestamp, no PAN of course), or rely solely on Pino logs? My recommendation: dedicated table, queryable.

Sign off on these and I execute Phase 2 following the same Phase 0/1 pattern.
