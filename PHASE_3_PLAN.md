# Phase 3 — Public REST API (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 2 (`PHASE_2_DONE.md`).

> REST + JSON. Versioned (`/v1/`). API key auth (publishable + secret), HMAC
> request signing optional. Resources: PaymentIntent, PaymentMethod, Customer,
> Refund, Dispute, Payout, Merchant, Webhook, Event.
> — PROJECT_BRIEF.md §3 Phase 3

This is where the platform starts looking like a real PSP from the outside.

---

## Goal

A Stripe-shape public API where:

1. A merchant can authenticate with a secret API key (`sk_test_…`).
2. They can `POST /v1/payment_intents` and walk a state machine:
   `requires_payment_method` → `requires_confirmation` → `requires_action` (3DS) → `processing` → `succeeded`
3. Auth-only flow: `requires_payment_method` → `requires_confirmation` → `requires_capture` (auth held) → capture or cancel.
4. Every state change emits a domain event into the outbox.
5. Outbox-relay drains events → webhook delivery to merchant URLs with retries + HMAC signatures (Phase 0 events package ready).
6. Idempotency on every state-changing endpoint (Phase 0 plugin ready).
7. OpenAPI 3.1 spec auto-generated from Zod schemas.

**Out of scope for Phase 3:** the actual acquirer/scheme leg (that's Phase 5).
Phase 3 stops at "PaymentIntent transitions to a terminal state" — for now
the transition is driven by a stub that flips status to `succeeded` directly,
so the rest of the platform can be exercised. Phase 5 replaces the stub with
the real ISO 8583 round-trip.

---

## Resource model

### Merchant onboarding (minimum for Phase 3)
A merchant must exist before any API call lands. For Phase 3 we ship a small
admin CLI: `pnpm merchant:create --name "…" --env test`. Full self-service
onboarding is Phase 8.

The CLI generates:
- A merchant id (`mrch_<ulid>`)
- An api key pair: `pk_test_<32>` + `sk_test_<32>`
- Hashes the secret key with SHA-256, stores hash in `paycore.api_keys`
- Prints the raw keys ONCE so the operator can copy them

### PaymentIntent
```ts
{
  id: 'pi_<ulid>',
  object: 'payment_intent',
  amount: bigint,         // minor units
  currency: 'USD',
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' |
          'processing' | 'requires_capture' | 'succeeded' | 'canceled' | 'failed',
  payment_method: 'tok_…' | null,
  client_secret: 'pi_<ulid>_secret_<...>',  // used by hosted-fields to confirm
  capture_method: 'automatic' | 'manual',
  confirmation_method: 'automatic' | 'manual',
  amount_received: bigint,
  amount_capturable: bigint,
  last_payment_error: PspError | null,
  metadata: Record<string, string>,
  livemode: boolean,
  created: number,
}
```

### Refund, Customer, PaymentMethod
Standard Stripe shapes. Refund posts a reverse journal entry (using Phase 1's
`postJournal`). PaymentMethod is a token reference. Customer is a saved-card
container.

---

## State machine

```
                     ┌────────────────────┐
                     │ requires_payment_  │
                     │      method        │
                     └──────────┬─────────┘
                                │ attach payment_method
                                ▼
                     ┌────────────────────┐
                     │ requires_          │
                     │ confirmation       │
                     └──────────┬─────────┘
                                │ confirm
                                ▼
                     ┌────────────────────┐
                     │ requires_action    │◀──── 3DS challenge
                     │     (3DS)          │
                     └──────────┬─────────┘
                                │ 3DS done (Phase 4)
                                ▼
                     ┌────────────────────┐
                     │   processing       │
                     └──────────┬─────────┘
                                │
                ┌───────────────┴───────────────┐
        capture │                               │ auth-only
                ▼                               ▼
       ┌──────────────┐               ┌──────────────────┐
       │  succeeded   │               │ requires_capture │
       └──────────────┘               └────────┬─────────┘
                                               │ capture()
                                               ▼
                                       ┌──────────────┐
                                       │  succeeded   │
                                       └──────────────┘

       any non-terminal → canceled (via cancel())
       any provider failure → failed
```

All transitions go through one `transitionPaymentIntent(currentState, action) → nextState | PspError` pure function — easy to unit-test exhaustively.

---

## Phase 3 deliverables (in build order)

### A. Schema migration `0012_payment_intents.sql`
- `paycore.payment_intents` table.
- `paycore.payment_methods` table.
- `paycore.refunds` table.
- `paycore.customers` table.
- `paycore.events` (audit-friendly immutable event log).
- `paycore.webhook_endpoints` (merchant-configured URLs + signing secret).

### B. API key auth plugin (`packages/api-keys`)
- Parse `Authorization: Bearer sk_test_…` (or pk_test_… for hosted-fields tokenize calls).
- Look up sha256 hash; reject if missing/revoked.
- Set `req.merchantId` + `req.apiKeyEnv` for downstream plugins (idempotency etc.).
- Add `pk_test_…` whitelist for `/v1/tokens` only.

### C. Endpoints (`apps/api/src/routes/v1/*.ts`)
- `POST /v1/payment_intents` — create
- `POST /v1/payment_intents/:id/confirm`
- `POST /v1/payment_intents/:id/capture`
- `POST /v1/payment_intents/:id/cancel`
- `GET  /v1/payment_intents/:id`
- `POST /v1/refunds` — create
- `GET  /v1/refunds/:id`
- `POST /v1/customers`, `GET /v1/customers/:id`
- `POST /v1/payment_methods` (server-side; Phase 4 adds hosted-fields path)
- `POST /v1/webhook_endpoints`, list, delete
- `GET  /v1/events/:id`, list
- All endpoints behind api-key auth + idempotency-key on state-changing ones.

### D. State machine + posting orchestration (`packages/payment-engine`)
- Pure `transitionPaymentIntent()` state machine function.
- `confirmPaymentIntent()` orchestrator: transitions state, posts a balanced
  capture journal entry, emits `payment_intent.succeeded` event in the same tx
  (uses `@psp-new/ledger.postJournal` + `@psp-new/outbox.publish`).
- For Phase 3, the "acquirer call" is stubbed: a synchronous "approve all"
  decision. Phase 5 replaces this with the ISO 8583 round-trip.

### E. Webhook delivery (`apps/worker` gets its first job)
- Outbox-relay drains events to a BullMQ queue.
- Worker registers a `webhook-delivery` job processor.
- For each event, look up `webhook_endpoints` for the merchant, sign with the
  endpoint's secret (using `@psp-new/events.signWebhook`), POST to the URL.
- Retry schedule: 1m, 5m, 30m, 2h, 12h, 24h, then dead-letter.
- Per-endpoint failure mode: 4xx → don't retry (dead-letter), 5xx/network → retry.

### F. OpenAPI 3.1 emitted from Zod schemas
- `@fastify/swagger` already wired in Phase 0. Each endpoint registers its
  Zod body + response. `/openapi.json` returns the generated doc.

### G. Tests
- Unit: state machine exhaustive transition matrix; api-key auth parser;
  webhook delivery retry decision matrix.
- Integration: full CRUD on each resource; idempotency replay; webhook
  delivery against a mock-server endpoint that asserts HMAC signature.

### H. Admin CLI `pnpm merchant:create`
- New small file under `apps/api/cli/merchant-create.ts` (we can also use
  `packages/admin-cli` if we end up with more admin commands).

---

## Estimated scope

| Item | LOC | Time |
|---|---|---|
| Schema migration 0012 | ~250 SQL | 0.5 day |
| API key auth plugin | ~200 TS | 0.5 day |
| Endpoint routes (8 resources, ~20 endpoints) | ~1,200 TS | 2.5 days |
| `packages/payment-engine` state machine + orchestration | ~600 TS | 1.5 days |
| BullMQ webhook delivery worker | ~400 TS | 1 day |
| Tests (unit + integration) | ~1,500 TS | 2 days |
| OpenAPI wiring (per-endpoint schemas) | ~200 TS | 0.5 day |
| Admin CLI | ~100 TS | 0.25 day |
| Docs + ADRs (Stripe-shape resource bodies, state machine, webhook retries) | ~150 MD | 0.5 day |

**Total:** ~9 days of focused work for a solo dev. Phase 3 is the biggest
single phase before the 8583 work in Phase 5.

---

## Open questions for you

1. **Merchant onboarding for Phase 3**: ship `pnpm merchant:create` CLI only,
   or also a one-page sign-up form in the (currently scaffold-only) portal?
   My recommendation: **CLI only** in Phase 3 — Portal is Phase 8.
2. **API key format**: `sk_test_<base32-ULID>` (Stripe-style, sortable secret
   value) or `sk_test_<random-32-byte-base64>` (no ordering)? My
   recommendation: **random 32 bytes base64url** — secret values shouldn't
   leak creation time.
3. **Idempotency-Key required on `POST /v1/payment_intents`?** Stripe makes
   it optional. PROJECT_BRIEF.md §3 Phase 3 says "every state-changing API
   endpoint requires an Idempotency-Key." My recommendation: **required**
   (consistent with the brief; merchants who don't supply one get a 400).
4. **Refunds against original PAN vs reverse ledger entry only?** Phase 3
   posts the reverse journal entry; the actual scheme refund happens in
   Phase 5 over 8583. Confirm this is fine, or do you want a deeper Phase 3
   refund mechanic?
5. **Webhook dead-letter destination**: a `paycore.webhook_dead_letter` table
   (queryable, retryable from admin) or just log + Prom alert? My
   recommendation: **dedicated table** so we can retry manually.

Answer those and I execute Phase 3.
