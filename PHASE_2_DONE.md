# Phase 2 — Done

**Date:** 2026-05-18 · **Status:** Vault landed; Phase 3 plan attached as `PHASE_3_PLAN.md`.

---

## What was built

### Schema (`packages/db/migrations/0010-0011`)
- **0010_vault_tokens_encrypted_pan.sql** — added `pan_ciphertext text` +
  `kms_key_id text` columns to `vault.tokens` (with a consistency CHECK that
  both are NULL together or both populated), and a new `vault.detokenize_audit`
  table for compliance-ready audit logs.
- **0011_vault_role_isolation.sql** — `psp_vault` and `psp_app` roles created;
  `vault_user` and `app_user` login users created and granted into those
  roles. `vault.*` is grant-fenced — `app_user` is default-denied. `paycore.*`
  + `ledger.*` get CRUD to `psp_app`; `ledger.*` deliberately doesn't get
  DELETE since the table is append-only by trigger.

### Library (`packages/vault-client`)
| Function | Purpose |
|---|---|
| `createVaultClient(opts)` | Typed HTTP client. Signs every call with `X-Service-Auth` using the configured `senderId`. Injectable `fetchImpl` for tests. |
| `tokenize(req)` | POST `/internal/v1/tokenize` |
| `detokenize(req)` | POST `/internal/v1/detokenize` |
| `detectSchemeByBin(bin6)` | Pure helper for non-vault code (risk evaluation) to classify a token's BIN. Kept in sync with `apps/vault/src/lib/scheme.ts`. |
| `VaultClientError` | Wraps non-2xx responses with status + parsed body. |

### Vault service (`apps/vault`)
| Route | Auth | Behaviour |
|---|---|---|
| `POST /internal/v1/tokenize` | Any sender (via service-auth) | Validates PAN length 12–19 + Luhn; detects scheme by BIN; HMACs PAN scoped to merchant; upserts on `(merchant_id, pan_hmac)`; encrypts PAN with `merchant_id` AAD; returns `token + bin + last4 + scheme`. |
| `POST /internal/v1/detokenize` | **Only** `sender === 'acquirer-host'` | Looks up token, asserts merchant-match, decrypts PAN, writes audit row, returns PAN + exp. |
| `GET /healthz` / `/readyz` / `/metrics` | Open | Standard. |

The PAN never reaches a log line: Pino's two-layer redaction is in place from
Phase 0, and the route handlers deliberately log only `{ token, merchant_id,
bin, last4, scheme, sender, reason }` — never the body or response.

### Tests
| File | Type | What it covers |
|---|---|---|
| `packages/vault-client/src/index.test.ts` | unit | Service-auth header is signed with correct sender; detokenize uses acquirer-host sender; VaultClientError on non-2xx; BIN scheme detection. |
| `apps/vault/src/lib/luhn.test.ts` | unit | Luhn against known good PANs; tamper detection; length limits; formatting; non-digit rejection. |
| `apps/vault/src/lib/scheme.test.ts` | unit | Visa / MC legacy / MC new range / Amex / unknown fallback. |
| `apps/vault/src/lib/kms-pan.test.ts` | unit | HMAC scoping (same merchant + PAN → same; different merchant → different; different PAN → different); encrypt/decrypt roundtrip; cross-merchant ciphertext differs. |
| `apps/vault/src/integration.test.ts` | **DB-gated** | tokenize roundtrip; idempotency; cross-merchant uniqueness; scheme classification; Luhn rejection; detokenize roundtrip via acquirer-host; detokenize rejected for `api` sender; cross-merchant detokenize returns "not found" (no info leak); audit row written; row-level columns clean of PAN; **psp_app role rejected by Postgres when trying to SELECT `vault.tokens`**. |

### Compose
- `vault` service now boots with `DATABASE_URL=postgres://vault_user:vault_dev_password@postgres:5432/psp_new` — physically isolated.
- `api`, `outbox-relay` boot with `DATABASE_URL=postgres://app_user:app_dev_password@postgres:5432/psp_new`.
- Migrator still runs as superuser `psp` via the env at the host.

### Docs
- ADR-0011 (hybrid tokenization + merchant-scoped HMAC) — `DECISIONS.md`.
- ADR-0012 (Postgres role isolation) — `DECISIONS.md`.
- `PHASE_2_DONE.md` (this file).
- `PHASE_3_PLAN.md` (Public REST API + PaymentIntent state machine).

---

## How to exercise

```bash
make up
make migrate
# tokenize via api by curl — or just run the test suite:
DATABASE_URL=postgres://psp:psp_dev_password@localhost:5432/psp_new \
APP_DATABASE_URL=postgres://app_user:app_dev_password@localhost:5432/psp_new \
SERVICE_AUTH_SECRET=dev_only_change_me_in_production_minimum_32_chars \
pnpm --filter @psp-new/vault test
```

The integration tests cover the full tokenize→detokenize roundtrip end-to-end
**including the Postgres-role assertion** that proves the `app_user` cannot
read `vault.tokens`.

---

## What's deliberately deferred

- **AAD verification on decrypt.** Our LocalKmsProvider's `decrypt()` doesn't
  currently accept AAD because it's not required to recover the plaintext —
  the GCM tag was computed with AAD, so a tampered AAD would fail the tag
  check automatically. The current `decryptPan()` passes the merchantId for
  future-proofing but it's not enforced cryptographically per-call.
  *(Note: this is a Phase-2 gap to revisit if we adopt AWS KMS in Phase 4+.)*
- **KMS key rotation flow.** `kms_key_id` is stored per row, so a future
  rotation can re-encrypt in place. No rotation job today.
- **Vault-side rate limiting.** Tokenize is called from internal services
  only; abuse risk is low in MVP. Phase 7 layers risk rules over the API
  edge, not the vault.
- **PAN-data exports for accountants** — still keep accountants out of PAN
  scope. No "give me a CSV of PANs" path.

---

## Discovered during the build

1. **`exactOptionalPropertyTypes` makes optional-field passing awkward at
   the service-auth header parse step.** Pattern needed for several helper
   builders — landed cleanly with explicit `if (x !== undefined) ...`
   assignments.
2. **Fastify 5's `loggerInstance` option** (rather than `logger`) is needed
   when injecting a Pino instance. Set in Phase 0 already; reused here.
3. **The 4-byte ASCII length framing was already in place** in the
   scheme-simulator (Phase 0), so the framing surface needed no work here.
4. **`assertNoPan` test helper proved its worth** — Phase 2's adversarial
   logging test caught a draft of the tokenize handler that had inadvertently
   included the raw PAN in a debug log line. Fixed before commit.
5. **Mastercard's new BIN range (2221–2720)** needed a separate regex; the
   classic `5[1-5]` doesn't cover it. Both ranges supported.

---

## Phase 2 deliverables checklist

| # | Goal | Status |
|---|---|---|
| Schema | `pan_ciphertext`, `kms_key_id`, `vault.detokenize_audit` | ✅ |
| Schema | psp_vault + psp_app roles + grant-fenced vault.* | ✅ |
| Library | `@psp-new/vault-client` (HTTP client + signed auth) | ✅ |
| Vault | `POST /internal/v1/tokenize` (HMAC dedup + encrypt) | ✅ |
| Vault | `POST /internal/v1/detokenize` (acquirer-host only) | ✅ |
| Vault | `vault.detokenize_audit` row per detokenize | ✅ |
| Tests | Unit: Luhn, scheme, HMAC scoping, encrypt/decrypt | ✅ |
| Tests | Integration: roundtrip, idempotency, cross-merchant, rejection, audit | ✅ |
| Tests | **Postgres role isolation** (app_user can't read vault.tokens) | ✅ |
| Tests | Adversarial logging via assertNoPan | ✅ |
| Compose | Per-service DB credentials (vault_user / app_user) | ✅ |
| Docs | ADR-0011, ADR-0012, PHASE_2_DONE, PHASE_3_PLAN | ✅ |

---

Phase 3 plan: `PHASE_3_PLAN.md` — the public REST API surface
(PaymentIntent state machine + idempotency on the edge + webhook delivery).
