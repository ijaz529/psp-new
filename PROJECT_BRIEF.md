# Project: PayCore — A Payment Service Provider Platform (MVP)

## 1. What I am building and why

I am a solo founder with a fintech background (Checkout.com, Wirecard, Foodpanda) transitioning into Product Owner roles. I want to build a working software system that demonstrates and exercises the full architecture of a modern Payment Service Provider — acquiring side first, issuing side later.

**Real-world constraint, stated up front:** A live PSP requires scheme membership (Visa/Mastercard), an EMI/PI license, a sponsor bank, PCI DSS Level 1, and EMVCo/scheme certifications. I do not have these. I am NOT building a system that will move real money. I AM building a system that is architecturally and behaviorally correct end-to-end, with the card scheme leg replaced by a local **scheme simulator** that speaks ISO 8583 the way VisaNet and Banknet do. Everything else — API, gateway, vault, ledger, clearing, settlement, reconciliation, dispute handling, merchant onboarding, dashboards — must be real, production-quality code.

**Success criteria for the MVP:** I can run the system locally, onboard a test merchant, send a card-not-present payment through a hosted-fields checkout, watch it traverse gateway → tokenization vault → risk → 3DS server → acquirer host → scheme simulator → (simulated) issuer, see a double-entry ledger update atomically, run end-of-day clearing, run settlement, watch a webhook fire, and reconcile the result against a generated scheme report. Refunds, captures, voids, chargebacks, and partial reversals all work. Idempotency, retries, and webhook signatures all work.

## 2. Operating principles (Karpathy-style — these are non-negotiable)

1. **Think before coding.** State assumptions explicitly. When confused, ask. Never silently guess at a payment-domain rule (e.g. "do reversals decrement the ledger or post a reverse pair?" — ask, don't assume).
2. **Simplicity first.** Minimum code that solves the problem. No speculative features. No premature microservices — start with a modular monolith; we'll extract services only when a real boundary appears.
3. **Surgical changes.** Only touch what the task requires. Do not "improve" adjacent code.
4. **Goal-driven execution.** Each phase has verifiable success criteria. Loop until met. Run the tests. Show me green.
5. **Money is integers.** Never floats. Amounts are stored as minor units (cents/pence) in `BIGINT`. Currency is always carried alongside.
6. **Every state change is an event.** Append-only event log + idempotent projections into read models. Never mutate financial state in place.
7. **Double-entry or it didn't happen.** Every money movement posts at least one balanced journal entry (debits = credits, exactly). Balances are derived, not stored, until a snapshot is needed for performance.
8. **Idempotency everywhere.** Every state-changing API endpoint requires an `Idempotency-Key` header. Every webhook delivery includes a unique event ID. Every scheme message has a STAN (Systems Trace Audit Number).

## 3. Domain scope

### Phase 0 — Foundations (do this first, in full, before anything else)
- Monorepo structure, language/runtime choice (propose options, default to **TypeScript on Node.js with Fastify** for API, **PostgreSQL** for transactional store, **Redis** for idempotency cache and rate limiting), justify the choice in one paragraph
- Docker Compose for local dev (Postgres, Redis, the app, the scheme simulator)
- Migration tooling, seed data
- Logging (structured JSON, request IDs, correlation IDs propagated across all layers), metrics (Prometheus-compatible), tracing hooks
- Error taxonomy: distinguish **content errors** (4xx, don't retry), **idempotency cache hits**, **network/timeout** (retry-safe), **provider errors** (route around), and **system errors** (5xx, indeterminate — must be reconciled)
- CI scaffolding, lint, format, type-check, test runner

### Phase 1 — The ledger (the heart of the system)
Build this BEFORE the gateway. Everything else depends on it.
- Double-entry ledger with: `accounts`, `journal_entries`, `journal_lines` tables
- Account types: ASSET, LIABILITY, REVENUE, EXPENSE, EQUITY
- Per-currency sub-ledgers (multi-currency support — never mix currencies in one entry)
- Every entry is atomic and balanced (DB-enforced via constraint trigger: sum of lines per entry per currency = 0)
- Append-only — no UPDATE or DELETE on journal_lines, ever
- Account balance is a `SUM()` query, optionally cached via a materialized view refreshed by background job
- A reference Chart of Accounts seeded for a PSP: Merchant Settlement Liability, Scheme Receivable, Interchange Expense, Scheme Fee Expense, PSP Revenue (MDR), Refund Reserve, Chargeback Liability, FX P&L, etc.
- Reconciliation primitive: given two sets of entries (internal + external), find unmatched lines

### Phase 2 — Tokenization vault and PCI scope isolation
- Separate service (own process, own DB schema, own secrets) — even in the monolith, treat it as a hard boundary. This is the only thing that ever sees a raw PAN.
- Format-preserving tokens (16-digit token replacing 16-digit PAN), or vaultless (HMAC-based) — propose both, default to vaultless with KMS-managed key
- AES-256-GCM at rest, TLS 1.3 in transit, mTLS for service-to-service
- A `detokenize()` call is the only path back to a PAN, and it is only called by the acquirer host at the moment of sending to the scheme simulator
- All other services see only tokens. The API NEVER stores, logs, or returns a full PAN. Last 4 + BIN only.
- **PAN is never logged. Ever. Build a logger that strips it at the source.**

### Phase 3 — Public API (Stripe-style)
- REST + JSON. Versioned (`/v1/`). API key auth (publishable + secret), HMAC request signing optional.
- Resources: `PaymentIntent`, `PaymentMethod`, `Customer`, `Refund`, `Dispute`, `Payout`, `Merchant`, `Webhook`, `Event`
- `PaymentIntent` state machine: `requires_payment_method` → `requires_confirmation` → `requires_action` (3DS challenge) → `processing` → `succeeded` | `requires_capture` (for auth-only) → `canceled` | `failed`
- Idempotency-Key handling: cache request + response for 24h, return cached response on retry, race-condition safe (DB unique constraint, not just Redis check)
- Webhook delivery: signed (HMAC-SHA256 with timestamp), retried with exponential backoff + jitter (1m, 5m, 30m, 2h, 12h, 24h, then dead-letter), guaranteed at-least-once, ordered per resource
- OpenAPI 3.1 spec generated from code, not hand-maintained

### Phase 4 — Checkout: hosted fields + 3DS2
- Hosted fields: a tiny JS bundle the merchant embeds, which renders an iframe served from the PSP domain. The merchant page never sees the PAN. (This is what keeps integrating merchants on PCI SAQ-A.)
- 3DS2 flow: implement the 3DS Server role. The Directory Server and ACS are simulated. Support frictionless flow (low risk, no challenge) and challenge flow (OTP shown in the simulator UI). Carry the `transStatus`, ECI, CAVV through to authorization.
- Mobile and browser device fingerprint collection (the data points required by EMV 3DS 2.2 — IP, accept headers, screen res, timezone, language, color depth)

### Phase 5 — Acquirer host and scheme simulator (ISO 8583)
This is the heart of the technical learning. **Do not skip the realism.**
- Implement an **ISO 8583:1987 message codec** in code from scratch (no third-party black box). Support MTI, primary + secondary bitmap, common data elements (2, 3, 4, 7, 11, 12, 13, 14, 22, 32, 35, 37, 38, 39, 41, 42, 49, 52, 55, 62, 63, 90, 102, 103). Support length-prefix TCP framing (4-byte ASCII length header).
- Implement an **Acquirer Host** service that:
  - Receives authorization requests from the orchestration layer
  - Constructs the appropriate ISO 8583 MTI (0100 auth, 0200 financial, 0400 reversal, 0420 reversal advice, 0500 reconciliation, 0800 network management) per scheme
  - Opens a persistent TCP connection to the scheme simulator
  - Handles timeouts (15s default), automatic reversals (0400) on timeout, STAN management, RRN generation
- Implement a **Scheme Simulator** (separate process, listens on TCP):
  - Parses ISO 8583 messages and routes by BIN to a simulated issuer
  - Simulated issuer applies configurable decline rules (insufficient funds, do not honor, expired, soft decline triggering step-up, etc. — full ISO 8583 response code table)
  - Returns 0110/0210 response messages
  - Generates end-of-day **clearing files** in a TC33-like CSV format (Mastercard IPM-style) and a Visa Base II-like format
  - Generates **settlement reports** showing gross, interchange, scheme fees, net
- The simulator is the boundary. Beyond it is "the card networks." Everything inside is your code.

### Phase 6 — Clearing and settlement
- End-of-day clearing job: pulls the day's authorizations and captures, generates outbound clearing records, posts pending-settlement journal entries
- Settlement job: ingests the scheme simulator's settlement file, matches each line to internal records, posts the actual settlement journal entries (Scheme Receivable → Merchant Settlement Liability, minus MDR to PSP Revenue, minus interchange/scheme fees to Expense), surfaces exceptions
- Merchant payout job: runs on configurable schedule (T+1, T+2, weekly), nets out refunds, holds for reserves, generates a Payout object, simulates the SEPA/Faster Payments push, posts ledger entries
- Reconciliation report at every hop, exceptions queue for manual review

### Phase 7 — Risk, fraud, disputes
- Rules engine (declarative, hot-reloadable): velocity (count/amount per card/IP/email per window), BIN country mismatch, amount threshold, MCC restrictions, AVS/CVV result handling
- A `RiskDecision` is logged on every auth with score, triggered rules, and outcome
- Dispute lifecycle: retrieval request → first chargeback → representment → pre-arbitration → arbitration. State machine + evidence document store + scheme-style reason codes (Visa 10.4, Mastercard 4837, etc.)

### Phase 8 — Merchant portal and admin
- Merchant onboarding: KYB form, document upload, simulated underwriting decision, MID assignment, BIN/MCC config, fee schedule
- Merchant dashboard: transactions, payouts, disputes, balance, API keys, webhook config
- Internal admin: ops console, manual reconciliation, dispute resolution, merchant lifecycle

### Phase 9 (later, optional) — Issuing side
- Card program management, BIN range, virtual card issuance, authorization controls, spending controls
- The same scheme simulator now plays the role the issuer plays — receives auths, applies controls, returns approval/decline

## 4. Architecture rules

- Modular monolith deployed as one binary; internal module boundaries enforced by linter (no cross-module imports except through public interfaces). Vault, scheme simulator, and acquirer host run as separate processes from day one.
- All money fields: `BIGINT` minor units + ISO 4217 currency code. Never floats. Never mixed currencies in a single computation without an explicit FX entry.
- All timestamps: UTC, microsecond precision, ISO 8601 in API responses.
- All IDs: prefixed ULIDs (`pi_…`, `pm_…`, `ch_…`, `re_…`, `dp_…`, `po_…`, `evt_…`) — Stripe convention. Sortable, opaque, no information leaks.
- All cross-service calls: mTLS, request signing, structured error responses with a stable `error.code` taxonomy.
- All state changes: emit a domain event, persist to outbox table in same DB transaction, separate process drains outbox to subscribers (transactional outbox pattern — solves dual-write problem).

## 5. Testing rules

- Unit tests for every pure function. Integration tests for every API endpoint. End-to-end tests for every happy-path and the five most important failure paths (timeout + reversal, decline + retry with different card, partial capture, refund exceeds capture, chargeback during refund window).
- A `make e2e` target spins up Docker Compose, runs a full payment from API call → ledger entry → settlement → payout, and asserts the ledger sums to zero per currency at the end. This is the canary.
- Property-based tests on the ISO 8583 codec: round-trip every message type with random valid field combinations, assert decode(encode(x)) == x.
- Chaos: a test mode where the scheme simulator randomly drops, delays, or duplicates responses. The system must converge to a correct final state.

## 6. Out of scope (do not build, do not propose)

- Real connectivity to Visa, Mastercard, Amex, or any real card network
- Real KYC/AML provider integrations (mock the interface, fake the responses)
- Real banking rails (SEPA, FedACH, SWIFT) — mock with a payout simulator
- Real HSM (use software KMS abstraction with a clear interface for future HSM swap-in)
- Mobile SDKs (web hosted fields only for now)
- Multi-acquirer routing (one simulated acquirer is enough for MVP)
- Crypto / stablecoin rails
- Marketplace / split payments / Connect-style sub-merchants (Phase 10+)

## 7. How I want you to work

- **Start by asking me clarifying questions.** Read this whole document, then list everything ambiguous before writing code. I would rather answer 20 questions up front than fix wrong assumptions later.
- **Propose Phase 0 in detail** — repo layout, tech choices with one-paragraph justification, the Docker Compose, the migration tool, the logger interface, the error taxonomy. Wait for my approval. Then build it.
- **One phase at a time.** Don't get ahead. At the end of each phase, produce: (a) a `PHASE_N_DONE.md` summarizing what was built, what was deferred, what was discovered, (b) a demo script I can run, (c) the next phase's detailed plan for my review.
- **When you hit a real domain question** (e.g. "should partial captures generate one journal entry per capture or aggregate?"), stop and ask. Don't guess. Reference the relevant scheme spec or accounting principle in your question.
- **Show me red before green.** Write the failing test first, then make it pass.
- **Keep a `DECISIONS.md` log.** Every non-trivial design decision: context, options considered, choice, rationale, date. Architecture Decision Records, lightweight.
- **Keep a `GLOSSARY.md`.** Payment domain terms get muddled (clearing vs settlement, capture vs settlement, authorization vs auth-hold, void vs reversal vs refund). Define them as we go.

## 8. References to consult (you may need to web-fetch or web-search these as you build)

- ISO 8583:1987 and 2003 field definitions (Wikipedia is fine for v1; the ISO PDF is paywalled)
- EMV 3DS 2.2.0 / 2.3.1 specifications (EMVCo white paper is the accessible summary)
- PCI DSS v4.0 requirements and the PCI Tokenization Guidelines info supplement
- Stripe API documentation for resource naming and state machine conventions (don't copy, learn the patterns)
- Adyen's "Notification webhooks" and "Modification" patterns for capture/refund/cancel
- Visa Base II clearing file format documentation (publicly available scheme excerpts)
- Mastercard IPM (Integrated Product Messages) clearing file format

## 9. First action

Read this document end to end. Then ask me your clarifying questions, numbered, grouped by phase. I'll answer them, then you propose Phase 0.