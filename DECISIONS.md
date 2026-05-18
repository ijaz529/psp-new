# Decisions — Architecture Decision Records

Lightweight ADRs. Each entry: context, options considered, choice, rationale, date.
Add new decisions to the **bottom**; never edit a closed one — supersede it with a
new ADR that links back.

---

## ADR-0001 — TypeScript on Node.js with Fastify
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 0 defaults to TypeScript on Node.js with
Fastify. We need to confirm the choice and write down what we're rejecting.

**Options.**
- TS/Node/Fastify (chosen).
- Go (chi/echo) — strong stdlib, great concurrency, but doubles the surface area
  the solo founder must own. ISO 8583 ecosystem is thinner in Go.
- Rust (axum) — best correctness story for money, but the velocity tax for a
  solo MVP is too high.

**Choice.** Node.js 22 LTS + TypeScript 5.7 strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `isolatedModules`). Fastify 5. Zod for DTOs everywhere.

**Rationale.** The founder's edge is the payments domain knowledge; the tech stack
should minimize cognitive overhead. TS strict prevents the "money was undefined"
class of bugs; Fastify gives best-in-class observability hooks and validation.

---

## ADR-0002 — Postgres + Drizzle Kit (migrations) + Kysely (runtime)
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** We need typed DB access and ergonomic migrations. The ledger code
will heavily lean on `SELECT … FOR UPDATE`, recursive CTEs, constraint triggers,
and `FOR UPDATE SKIP LOCKED` (outbox drainer).

**Options.**
- Prisma — abstractions hurt with triggers, the ledger's balanced-entry rule
  needs a DB constraint that Prisma's schema language doesn't express cleanly.
- Drizzle for both schema + runtime — works, but Drizzle's query builder makes
  recursive CTEs and explicit lock hints awkward.
- Drizzle Kit (schema → migrations) **+ Kysely (runtime)** (chosen).
- node-pg-migrate + raw pg — works but loses the typed schema benefits.

**Choice.** Drizzle Kit generates SQL we commit; Kysely consumes a hand-written
Database interface that mirrors the Drizzle schema. Two libraries, one source of
truth (the SQL migration files).

**Rationale.** Tool-fit at design time (Drizzle's schema DSL) and tool-fit at
runtime (Kysely's raw-SQL ergonomics). The small duplication of maintaining the
Kysely Database interface is paid in tests + lint at typecheck time. We will
revisit if Drizzle's query builder ever covers the lock/CTE needs.

---

## ADR-0003 — Pino logger with two-layer PCI redaction
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §2 #6 + §3 Phase 2: PAN must never be logged. Building
a logger that strips at the source is mandatory.

**Choice.** `@psp-new/logger` wraps Pino with:
- **Layer 1 — Pino `redact`:** append-only list of known PCI field paths.
- **Layer 2 — Recursive value scanner:** walks every string in every log record
  and masks any 12–19 digit run (with optional spaces/hyphens), keeping BIN + last4.

A test helper `assertNoPan(value)` is exported so app-level tests can lock down
specific code paths.

**Rationale.** Layer 1 is fast and deterministic but only as good as the path
list. Layer 2 catches the "PAN in an unanticipated field" case. We accept the
small false-positive risk (long numeric IDs) because the asymmetric cost favors
masking too eagerly over leaking a PAN.

---

## ADR-0004 — Vaultless HMAC tokenization (forward-looking; Phase 2 builds)
**Date:** 2026-05-18 · **Status:** Accepted (target for Phase 2)

**Context.** PROJECT_BRIEF.md §3 Phase 2 asks us to propose both vaultless and
vaultful, and default to vaultless with KMS-managed key.

**Choice.** Tokens are deterministic HMAC-SHA256 over the PAN with a KMS-managed
key, returned to the API as opaque prefixed strings (`tok_<ulid>`). The BIN is
stored separately so routing works without inferring it from the token.

**Rejected alternative.** Format-preserving 16-digit tokens. BIN routing would
work without a separate column, but tokens visually indistinguishable from PANs
are a log/regex hazard — and our log redaction would mask them, breaking debug
ergonomics.

**Why HMAC over a vault table.** No raw PAN ever lands at rest (not even
encrypted), shrinking PCI scope. Trade-off: re-tokenizing the same PAN within a
merchant always yields the same token, which is intended behaviour.

---

## ADR-0005 — Modular monolith, hard process boundaries for vault/acquirer/simulator
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §4: "Modular monolith deployed as one binary;
internal module boundaries enforced by linter. Vault, scheme simulator, and
acquirer host run as separate processes from day one."

**Choice.** Apps share one repo and one Postgres, but vault, acquirer-host, and
scheme-simulator are physically separate Docker services with their own images
and their own network exposure (or lack thereof). The shared deployable today
is the same image; entrypoint differs.

**Rationale.** The PCI boundary (vault) and the scheme-traffic boundary
(acquirer-host ↔ scheme-simulator) must be physically real from day one so the
threat model doesn't lie. The "monolith" benefit comes from sharing packages,
deps, and observability — not from co-locating processes.

---

## ADR-0006 — Idempotency-Key: Postgres truth, Redis hot-cache, four-path semantics
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 3 requires Idempotency-Key on every
state-changing endpoint, 24h TTL, race-condition safe.

**Choice.** `paycore.idempotency_keys` table is the source of truth. Algorithm
under `SELECT … FOR UPDATE` on `(merchant_id, key)`:

| Existing row | request_hash | Behaviour |
|---|---|---|
| completed | matches | replay cached response with `Idempotency-Replay: true` |
| locked + not expired | matches | 409 `idempotency_key_in_use` |
| any | differs | 422 `idempotency_key_reused_with_different_body` |
| (none) | n/a | insert + lock → run handler → write response |

Redis is later added as a hot-cache for the "completed → replay" case (Phase 3+);
it is **not** the source of truth.

---

## ADR-0007 — Stripe-mirror error envelope
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 3: Stripe-style API; merchants will
borrow Stripe's mental model.

**Choice.** Wire shape:
```json
{ "error": { "type": "...", "code": "...", "decline_code": "...",
             "message": "...", "param": "...", "request_id": "..." } }
```
Stable `error.code` enum defined up front in `@psp-new/errors`. Adding a code is
non-breaking; renaming or removing is a versioned breaking change.

**Rationale.** Merchants integrating with Strawberry should be able to copy patterns
from Stripe integration code. Mirror the envelope, don't innovate on it.

---

## ADR-0008 — HMAC service-to-service auth; mTLS deferred
**Date:** 2026-05-18 · **Status:** Accepted (mTLS deferred to Phase 5+)

**Context.** PROJECT_BRIEF.md §4 mandates mTLS for cross-service calls.
Implementing real mTLS in local dev adds significant setup cost (local CA, cert
mounts, rotation tooling) for Phase 0.

**Choice.** `@psp-new/service-auth` ships an HMAC-signed `X-Service-Auth` header
(timestamp + sender + payload-hash signature). The same `ServiceAuth` interface
will back an mTLS implementation when we adopt real mTLS in Phase 5+.

**Trade-off.** Symmetric secrets shared across services inside the compose
network. Acceptable because nothing inside the network is reachable from the
public internet; the surface that matters (API → merchant) uses publishable +
secret API keys (Phase 3).

---

## ADR-0009 — Ledger sign convention: debit positive, credit negative (single signed column)
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PHASE_1_PLAN.md asked: should `journal_lines` use a single signed
`amount` column or split debit/credit columns?

**Options.**
- Two columns (`debit`, `credit`), both non-negative — classical bookkeeping shape.
- Single signed `amount` column with a convention.

**Choice.** Single signed `bigint amount` column. **Debit = positive, credit = negative.**

**Rationale.**
- Balanced-entry check becomes `SUM(amount) = 0` per currency per entry — one SQL
  expression, trivial trigger.
- Aggregation queries (account balance = `SUM(amount)`) are one column, no `CASE`.
- BigInt holds both signs natively; no need to split.
- The traditional debit/credit columns are a notation, not a constraint — the
  invariant is "sum to zero per currency."

**Trade-off.** Reports rendered for an accountant might need a `CASE WHEN amount > 0
THEN amount ELSE 0 END` to surface debit-side and credit-side totals separately.
The materialized view `ledger.account_balances` exposes `debit_total` and
`credit_total` precomputed (see migration 0008) so the reporting layer doesn't
have to do this math repeatedly.

---

## ADR-0010 — Per-merchant ledger accounts created lazily, not at seed
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** The Chart of Accounts has four account codes that vary per merchant:
`merchant_settlement_liability`, `refund_reserve`, `chargeback_liability`,
`merchant_payout_clearing`. Seeding them at migration 0009 would either require
no merchants exist at seed time (true at Phase 1) or require us to know which
merchants are active.

**Options.**
- Seed for "all" merchants → impossible at migration time, merchants don't exist.
- Create on first transaction → lazy, requires an `ensureMerchantAccounts()` helper.
- Create at merchant onboarding (Phase 8) → forces ordering: onboarding must
  complete before any ledger write for that merchant. Works but couples phases.

**Choice.** Lazy. `ensureMerchantAccounts(trx, merchantId, currency)` upserts the
four per-merchant accounts inside the same transaction as the first journal entry
for that (merchant, currency). Account IDs are deterministic (md5 of
`<code>:<currency>:merchant:<merchantId>`) so app code can reference them by
construction.

**Rationale.**
- Decouples Phase 1 (ledger) from Phase 8 (merchant onboarding).
- The first write to a new (merchant, currency) costs four extra inserts; all
  subsequent writes hit the `ON CONFLICT DO NOTHING` path which is a single
  index probe per account. Acceptable.
- Deterministic IDs mean the gateway code can write the journal entry without a
  prior round-trip to look up account IDs.

---

## ADR-0011 — Vaultless tokenization: hybrid (HMAC dedup + KMS-encrypted PAN)
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 2 proposes "vaultless with KMS-managed
key." PHASE_2_PLAN.md surfaced the trade-off between pure-vaultless (no
detokenize, merchant re-tokenizes every charge) and hybrid (KMS-encrypted PAN
at rest, detokenize gated to acquirer-host).

**Choice.** Hybrid. The vault stores:
- `pan_hmac` (merchant-scoped HMAC) as the dedup key, unique-indexed on
  `(merchant_id, pan_hmac)`. Same merchant + same PAN → same token.
- `pan_ciphertext` (KMS-encrypted PAN, AES-256-GCM with `merchant_id` as AAD)
  + `kms_key_id` for rotation.

Detokenize is gated to senders with `X-Service-Auth.sender === 'acquirer-host'`
at the application layer (ADR-0008) AND to the `psp_vault` Postgres role at
the database layer (ADR-0012). Defence in depth.

**Why hybrid over pure vaultless.**
- Pure vaultless makes saved cards impossible. Recurring billing requires the
  customer's interaction every time. Refunds against an original PAN force
  the merchant to retain PAN, which moves PCI scope onto the merchant —
  exactly what hosted-fields is supposed to prevent.
- Hybrid puts the PAN in the highest-blast-radius location of the system
  (vault), encrypted, fenced by both auth layers, and audited on every
  detokenize. This is what real PSPs do.

**Cross-merchant correlation.** The HMAC is prefixed by `merchantId|` before
hashing — same PAN under two merchants yields two different HMACs. An
attacker with raw access to `pan_hmac` values cannot link cardholders across
merchants.

**Trade-off.** The PAN does live at rest (encrypted). PCI scope is larger than
pure vaultless. Acceptable because:
- All access is gated (HMAC service-auth + Postgres role).
- Detokenize is audited row-by-row (`vault.detokenize_audit`).
- KMS key rotation is straightforward via `kms_key_id` versioning per row.

---

## ADR-0012 — Vault isolated by Postgres role (psp_vault + psp_app)
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 2 mandates the vault is a "hard
boundary." An application-layer guard (X-Service-Auth) alone isn't enough —
a SQL injection in the api or a misrouted query could still hit
`vault.tokens.pan_ciphertext` if every service runs as the same DB user.

**Choice.** Two Postgres roles, two login users:
- `psp_vault` (role) ⇐ `vault_user` (login)
- `psp_app`  (role) ⇐ `app_user`   (login)

**Grants** (migration `0011_vault_role_isolation.sql`):
- `vault.*`: `psp_vault` only. `psp_app` is default-denied.
- `paycore.*` + `ledger.*`: `psp_app` has standard CRUD. (`ledger.*` is
  append-only by trigger; we deliberately don't GRANT DELETE either, belt-and-
  braces.)

The migrator continues to run as the `psp` superuser via `DATABASE_URL`. App
processes use a per-service connection string (set in compose `environment:`
blocks).

**Why grants and not RLS.** `pan_ciphertext` is a **column**, not a row
attribute. Column-level access is enforced via `GRANT/REVOKE`; RLS is for
row-level filtering. We can layer RLS in later for per-merchant row isolation
if needed, but column-grants are the right tool today.

**Trade-off.** Three DB users to manage (psp / app_user / vault_user). Two
extra connection strings to keep in sync. In dev they live in `.env.example`;
in production they belong in a secrets manager. The isolation buys "even a
code bug in api can't accidentally read PAN ciphertext" — worth it.

---

## ADR-0013 — PaymentIntent state machine + Stripe-mirror API surface
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 3 defines a PaymentIntent state machine
mirroring Stripe's. Phase 3 ships the full state machine with the acquirer
call stubbed (always-approve); Phase 5 replaces the stub with real ISO 8583.

**Choice.**
- Pure-function `transitionPaymentIntent(from, action, ctx)` exhaustively
  handles every (status, action) pair. Returns `{ ok: true, next }` or
  `{ ok: false, reason }`.
- Orchestrator functions (`confirmPaymentIntent`, `capturePaymentIntent`,
  `cancelPaymentIntent`, `createRefund`) wrap a DB transaction:
  `SELECT FOR UPDATE` → transition → post journal entry (Phase 1 `postJournal`)
  → update row → insert event row → publish to outbox (Phase 0 `outbox`).
- The acquirer call is a single function call site that today returns "approved"
  synchronously. Phase 5 replaces only this call site; the rest of the
  orchestrator is unchanged.

**Single-currency-per-entry is preserved** — every journal entry posted by the
orchestrator has all postings in one currency (the payment intent's currency).

**Why the orchestrator pattern.** Idempotency is end-to-end:
- API edge: idempotency-key plugin (Phase 0).
- Domain edge: each capture's `journal_entries.external_id` is `capture:<pi_id>`,
  unique-indexed — retrying confirm twice can't double-post.
- Wire idempotency for the merchant: cached response from the Phase 0 plugin.

---

## ADR-0014 — Webhook delivery: BullMQ + explicit retry schedule + dead-letter
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 3: at-least-once delivery, exponential
schedule (1m → 5m → 30m → 2h → 12h → 24h → dead-letter), HMAC-signed, ordered
by `event.created` (no head-of-line blocking — Phase 0 Q21).

**Pipeline.**
1. State change → orchestrator inserts `paycore.events` row + publishes to
   `paycore.outbox` inside the same DB transaction.
2. `outbox-relay` polls `paycore.outbox` with `FOR UPDATE SKIP LOCKED`,
   resolves matching `paycore.webhook_endpoints`, enqueues one BullMQ
   `webhook-delivery` job per (event, endpoint).
3. `worker` processes the BullMQ job: HMAC-signs the body with the
   endpoint's secret, POSTs with a 15s timeout. Outcome decides next action
   via `decideRetry()`.

**Why explicit retry decisions** (not BullMQ's `backoff` config). Our retry
schedule is non-exponential (1m / 5m / 30m / 2h / 12h / 24h). The worker
records each attempt in `paycore.webhook_attempts`, counts prior attempts,
and *re-enqueues* the next attempt with `delay: nextDelayMs`. This keeps the
retry policy auditable and decoupled from BullMQ internals.

**Failure taxonomy** (in `@psp-new/webhook-delivery#decideRetry`):
- `2xx` → success
- `4xx` (except `408`, `429`) → `dead_letter (non_retryable_status)` immediately
- `408 / 429 / 5xx / network_error` → retry per schedule; once exhausted →
  `dead_letter (exceeded_retries)`

**Dead-letter table** (`paycore.webhook_dead_letter`) holds permanent failures
with a `retried_at` column so ops can manually replay (Phase 7+ adds an admin
endpoint).

---

## ADR-0015 — 3DS2 contract: simulated wire, real carry-through fields
**Date:** 2026-05-18 · **Status:** Accepted

**Context.** PROJECT_BRIEF.md §3 Phase 4 Q22: implement actual 3DS2 message
structures (AReq/ARes/CReq/CRes) or simulate the contract. User confirmed
the latter "as long as we can make it fully realistic later."

**Choice.** Phase 4 simulates the wire but the *carry-through fields are real*:

- **transStatus** (`Y` / `A` / `N` / `U` / `R` / `C`) returned from the simulated ACS
- **ECI** values per-scheme: Visa `05/06/07`, Mastercard `02/01/00`
- **CAVV** synthetic 20-byte base64 (real value comes from the issuer ACS in production)
- **3DS Server Trans ID** = our session id (`tds_<ulid>`)

These fields are stored on `paycore.three_ds_sessions`. Phase 5 reads them and
populates the corresponding 8583 DEs in the authorization message — exactly
what a real PSP does.

**Why not full AReq/ARes/CReq/CRes JSON envelopes today.** The brief's Phase 4
goal is end-to-end flow, not message-format conformance. Wiring the JSON envelope
adds ~1.5 days that pay off only when we eventually connect to a real
Directory Server. We can layer that on later without changing the carry-through.

### Flow

1. Merchant page calls `Strawberry.fields({ container, publishableKey })`.
2. Iframe POSTs `/v1/tokens` (pk-only) → token via `postMessage`.
3. Merchant server posts to `/v1/payment_intents` with `confirm: true`.
4. `decideThreeDs(bin, scheme, requestThreeDSecure)` returns `none | frictionless | challenge`.
5. Frictionless / no-3DS → stub acquirer approves → post journal entry → `succeeded`.
6. Challenge → insert `three_ds_sessions` row, set `next_action.redirect_url`, transition PI → `requires_action`.
7. Customer hits redirect → simulator's `/3ds/challenge/:id` page → clicks Approve/Decline.
8. Simulator POSTs `/v1/_internal/three_ds/callback` to api → `completeThreeDs()` → success path posts journal → `succeeded`; failure → `failed`.

### 3DS policy (Phase 4 — Q2 recommendation)

- `request_three_d_secure: 'automatic'` → BIN-based:
  - BIN `400000` → challenge required
  - BIN `555555` → frictionless (auto-approve)
  - everything else → no 3DS
- `request_three_d_secure: 'any'` → always challenge
- `request_three_d_secure: 'never'` → bypass

Phase 7 risk engine replaces this with rule-driven decisions.

### Iframe / CORS security model (Q1 + Q3 recommendations)

- **CORS on `/v1/tokens`:** open in Phase 4. The pk-only auth gate (`pk_*`
  scoped to one merchant) is the primary control. Per-merchant origin
  whitelist ships in Phase 7 risk.
- **Frame ancestors:** Phase 4 iframe uses `frame-ancestors *`. Phase 8 reads
  `merchant.allowed_origins` (column shipped in 0013) and emits a tightened CSP.
- **Iframe theming:** locked Phase-4 default. Per-merchant theming via
  `style` postMessage lands in Phase 8 with the full portal UI.

---
