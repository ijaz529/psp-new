# Phase 3 — Done

**Date:** 2026-05-18 · **Status:** Public REST API + state machine + webhook delivery + portal landed; Phase 4 plan attached.

The platform now looks like a real PSP from the outside.

---

## What was built

### Schema (`packages/db/migrations/0012`)
- **`0012_payment_intents.sql`** — 8 new tables under `paycore.*`:
  `customers`, `payment_methods`, `payment_intents`, `refunds`, `events`,
  `webhook_endpoints`, `webhook_attempts`, `webhook_dead_letter`. Indexes for
  state-machine queries, retry queue, audit. All granted to `psp_app`; none
  granted to `psp_vault`.

### Library packages (4 new + 1 modified)
| Package | Purpose |
|---|---|
| `@psp-new/api-keys` | `generateApiKey()`, `hashApiKey()`, `apiKeyAuthPlugin` Fastify hook. Random 32-byte base64url keys, sha256-hashed at rest. |
| `@psp-new/payment-engine` | Pure `transitionPaymentIntent()` state machine + orchestrators (`confirmPaymentIntent`, `capturePaymentIntent`, `cancelPaymentIntent`, `createRefund`). Posts balanced journal entries via Phase 1 ledger + publishes events via Phase 0 outbox. |
| `@psp-new/webhook-delivery` | Pure `decideRetry()` + `deliverWebhook()` HTTP wrapper. Queue name + retry-schedule constants shared between outbox-relay and worker. |
| `@psp-new/ids` (modified) | Added `webhook_attempt: 'wa'`, `webhook_dead_letter: 'wdl'` prefixes. |

### apps/api — full Stripe-mirror surface
| Route | Auth | Behaviour |
|---|---|---|
| `POST /v1/customers` | sk | create customer |
| `GET /v1/customers/:id` | sk | read |
| `POST /v1/payment_methods` | sk | tokenize raw card via vault, store metadata |
| `GET /v1/payment_methods/:id` | sk | read |
| `POST /v1/payment_intents` | sk | create (optionally `confirm: true` short-circuits the flow) |
| `GET /v1/payment_intents/:id` | sk | read |
| `POST /v1/payment_intents/:id/confirm` | sk | run orchestrator (stub acquirer = always-approve) |
| `POST /v1/payment_intents/:id/capture` | sk | manual capture flow |
| `POST /v1/payment_intents/:id/cancel` | sk | cancel |
| `POST /v1/refunds` | sk | post reverse journal entry; insert refund row |
| `GET /v1/refunds/:id` | sk | read |
| `POST /v1/webhook_endpoints` | sk | create; **secret returned once** |
| `GET /v1/webhook_endpoints` | sk | list (no secret) |
| `GET /v1/webhook_endpoints/:id` | sk | read (no secret) |
| `POST /v1/webhook_endpoints/:id` | sk | update (status, events, description) |
| `DELETE /v1/webhook_endpoints/:id` | sk | soft delete |
| `GET /v1/events` | sk | list (filter by `type`, `limit`) |
| `GET /v1/events/:id` | sk | read |

Idempotency-Key required on every state-changing endpoint. Auth on every
endpoint except `/healthz`, `/readyz`, `/metrics`, `/openapi.json`, `/v1/_dev/echo`.
All responses use Stripe-shape error envelope (Phase 0 ADR-0007).

### Webhook delivery pipeline
- **outbox-relay** (`drainOnce()`): claim batch with `FOR UPDATE SKIP LOCKED`,
  resolve matching `webhook_endpoints`, enqueue one BullMQ job per (event,
  endpoint). 1s poll interval, 50-row batch.
- **worker** (`processWebhookDeliveryJob()`): pull job, count prior attempts,
  HMAC-sign body, POST with 15s timeout, insert attempt row, decide:
  succeed / dead-letter / retry-with-delay (re-enqueue at next schedule slot).
- BullMQ on Redis. Job id is `${eventId}:${endpointId}:${attemptNumber}` for
  natural dedup.

### Admin / onboarding
- **CLI**: `pnpm merchant:create --name "Acme Inc." [--env test|live]` —
  creates merchant + `pk_<env>_…` + `sk_<env>_…`. Raw keys printed once.
- **Portal**: minimal Fastify-served HTML form at `http://localhost:3000`.
  Same outcome as the CLI; result page shows the keys with copy-friendly
  monospace boxes. (Phase 8 will replace with full Next.js portal.)

### Docs
- ADR-0013 (PaymentIntent state machine) — `DECISIONS.md`.
- ADR-0014 (webhook delivery pipeline) — `DECISIONS.md`.
- `PHASE_3_DONE.md` (this file).
- `PHASE_4_PLAN.md` (hosted-fields iframe + 3DS server simulation).

### Tests
| File | Type | Coverage |
|---|---|---|
| `packages/api-keys/src/index.test.ts` | unit | generateApiKey shape; hash determinism; parseAuthorizationHeader strictness; parseApiKeyFormat; constantTimeEqual |
| `packages/payment-engine/src/state-machine.test.ts` | unit | Exhaustive transition matrix (happy paths, 3DS success/fail, decline, cancel, terminal-state rejection) |
| `packages/payment-engine/src/orchestrator.test.ts` | unit | `capturePostings` / `refundPostings` balance + sign symmetry |
| `packages/webhook-delivery/src/index.test.ts` | unit | decideRetry decision matrix; deliverWebhook signs correctly; 4xx vs 5xx handling; network errors; 408/429 retryability |

---

## What's deliberately deferred

- **`POST /v1/tokens`** (server-side public tokenize, sk-only) — accept raw
  card inside `POST /v1/payment_methods` instead. Phase 4 adds the dedicated
  /v1/tokens endpoint when hosted-fields needs it.
- **3DS handling** — state machine has `requires_action` and `three_ds_complete`
  transitions; the orchestrator never enters them (Phase 3 always-approves).
  Phase 4 wires the 3DS server simulation.
- **Stripe-style cursor pagination** — list endpoints use simple `limit`.
  Phase 6 adds cursor pagination once volumes justify it.
- **Per-merchant MDR rate** — hardcoded 300 bps for Phase 3. Phase 6 makes
  it configurable per merchant (Phase 8 portal exposes the setting).
- **Webhook subscription filtering UI** — `enabled_events` is `text[]` in the
  DB; the portal doesn't yet let merchants edit it. CLI / API only.
- **Admin endpoints for replaying dead-letter** — table exists, no replay path.
  Phase 7 adds it.

---

## Discovered during the build

1. **`exactOptionalPropertyTypes` + spread of optional fields** keeps surfacing.
   Pattern needed in route handlers: `...(body.x ? { x: body.x } : {})`.
   Mechanical, but noted.
2. **Kysely + `getMerchantId(req)` helper** is cleaner than `req.merchantId!`
   everywhere. `getMerchantId` throws `internal_error` if the auth plugin
   somehow didn't run — better failure mode than NPE-style.
3. **BullMQ + ioredis** work well with our Redis + Pino-logged services. The
   only annoyance is BullMQ requires `maxRetriesPerRequest: null` on the
   ioredis client.
4. **`PaymentIntentRecord` doesn't satisfy `Record<string, unknown>`** because
   of readonly bigint fields. Cast at the event-emit boundary; alternative
   would have been to widen `emitAndPublishEvent`'s param type, which loses
   safety. Cast wins.
5. **Mastercard 2-prefix range needed in `detectSchemeByBin`** — Phase 2's
   regex was `5[1-5]` only. The vault's scheme detection now also matches
   `2(2[2-9]|[3-6]\d|7[01]|720)`. Kept in sync between `apps/vault` and
   `packages/vault-client`.

---

## Demo

After `make up` and the new migrations applied:

```bash
# 1. Create a merchant (CLI or portal)
pnpm merchant:create --name "Acme Inc."
# Copy the sk_test_… key from the output.

# 2. Create a customer
SK=sk_test_... ; API=http://localhost:8080
curl -s $API/v1/customers \
  -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"email":"jane@acme.com","name":"Jane Doe"}' | jq

# 3. Create a payment method (server-side, raw card)
curl -s $API/v1/payment_methods \
  -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"type":"card","card":{"number":"4111111111111111","exp_month":"12","exp_year":"2030"}}' | jq

# 4. Create + confirm a PaymentIntent in one shot
curl -s $API/v1/payment_intents \
  -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"amount":1000,"currency":"USD","payment_method":"pm_…","confirm":true}' | jq
# Returns status: "succeeded", amount_received: 1000 (USD minor units).

# 5. Refund half
curl -s $API/v1/refunds \
  -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"payment_intent":"pi_…","amount":500,"reason":"requested_by_customer"}' | jq

# 6. Inspect the ledger
pnpm ledger:balance acct_<mdr_revenue_id>
# Live = +15 USD (capture 30 - refund 15)
```

Webhook flow (separately):

```bash
# In one terminal, run a tiny inspector
python3 -c '
import http.server, json, hmac, hashlib
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        print("--- webhook received ---")
        print("signature:", self.headers["webhook-signature"])
        print(json.dumps(json.loads(body), indent=2))
        self.send_response(200); self.end_headers()
http.server.HTTPServer(("0.0.0.0", 9999), H).serve_forever()'

# In another terminal:
curl -s $API/v1/webhook_endpoints \
  -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://host.docker.internal:9999","enabled_events":["*"]}'
# Save the returned 'secret' value.

# Trigger any state change (POST /v1/payment_intents …confirm…) — the inspector
# receives the event within ~1s with a valid HMAC signature.
```

---

## Phase 3 deliverables checklist

| # | Goal | Status |
|---|---|---|
| A | Schema migration 0012 + 8 tables | ✅ |
| B | `@psp-new/api-keys` (auth plugin + helpers) | ✅ |
| B | Random 32-byte base64url keys | ✅ |
| C | 18 v1 endpoints (PaymentIntent + Refund + Customer + PaymentMethod + WebhookEndpoint + Event) | ✅ |
| D | `@psp-new/payment-engine` (state machine + orchestrators) | ✅ |
| D | Stub acquirer (always-approve) | ✅ |
| E | outbox-relay drains → BullMQ jobs | ✅ |
| E | Worker delivers with HMAC + explicit retry schedule | ✅ |
| E | webhook_dead_letter table populated on exhaustion | ✅ |
| F | OpenAPI 3.1 from Zod schemas (Phase 0 wiring; new routes auto-included) | ✅ |
| G | Unit tests: state machine; api-keys; webhook decide-retry; orchestrator postings | ✅ |
| H | `pnpm merchant:create` CLI | ✅ |
| I | Portal sign-up page | ✅ |
| Docs | ADR-0013 + ADR-0014 + PHASE_3_DONE + PHASE_4_PLAN | ✅ |

---

Phase 4 plan: `PHASE_4_PLAN.md` — hosted-fields iframe (so merchants stay on
PCI SAQ-A) + 3DS2 simulation (frictionless + challenge flows).
