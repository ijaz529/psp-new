# Phase 41 — Plan

**Goal:** merchant route integration tests — the coverage gap open
since Phase 31 built the harness ("pattern is reusable for future
merchant route tests") and Phase 33 landed only the single
confirm-route regression test. The merchant money path
(`/v1/payment_intents` lifecycle + `/v1/refunds`) has no API-level
test coverage; the Phase-3 curl demos are the only acceptance record.

Unlike Phases 33/36–40, a live Postgres is available this session
(the 33–38 verification branch is merged; migrations 0001–0034
applied and idempotent; existing api suite 11/11 live) — these tests
run green-for-real before the phase closes.

## Scope

### Harness (`apps/api/src/__tests__/helpers.ts`)

- `overrides` gains `settler` / `reverser` (authorizer exists since
  Phase 33) so capture/cancel tests can spy the wire legs.
- New fixtures, extracted from the Phase 33 test's inline setup:
  `createTestMerchant(db)` (merchant + secret + publishable key) and
  `createTestPaymentMethod(db, merchantId)` (visa, BIN 411111 — no
  3DS). The Phase 33 test is refactored onto them.

### `payment-intents.test.ts` (extended)

- Auth gate: 401 with no key; 401/403 when a publishable key hits a
  secret-key route.
- Create without payment_method → 201 `requires_payment_method`.
- Create with `confirm: true` → spy authorizer called, `succeeded`,
  RRN/STAN persisted (the create-path sibling of the Phase 33
  confirm-route test).
- Decline: authorizer returns `approved: false` + decline code → PI
  `failed`, `last_payment_error` surfaced on the wire.
- Manual capture: `capture_method: 'manual'` + confirm →
  `requires_capture`; `POST /:id/capture` → spy settler called with
  the auth's RRN/STAN, `succeeded`, `amount_received` = amount.
- Cancel: manual + confirm → `POST /:id/cancel` → spy reverser called
  with `amount_capturable`, PI `canceled`.
- Cross-merchant isolation: merchant B GETs merchant A's PI → 404.
- Idempotency replay on `POST /v1/payment_intents` (merchant-side
  sibling of the Phase 32 cardholder replay test).

### `refunds.test.ts` (new)

- Full refund of a succeeded PI → 201, `amount` = captured amount.
- Partial refund → PI `amount_received` reduced by the refund.
- Over-refund → `refund_exceeds_capture`.
- Refund of a non-succeeded PI → `payment_intent_unexpected_state`.
- `GET /v1/refunds/:id` cross-merchant isolation → 404.

## Out of scope

- Routes needing the vault (`/v1/tokens`, `/v1/payment_methods`
  create) — the harness stubs vault with an unreachable URL; payment
  methods are fixture-inserted. Vault-in-harness is its own phase.
- 3DS flows (`requires_action` + callback) — simulator-dependent.
- Customers / events / webhook-endpoint merchant routes — nice-to-
  have breadth; the money path is the priority. Left on the open
  list.
- Partial captures via API (Phase 16 semantics) — covered indirectly
  by full capture; explicit partial-capture API tests deferred.

## Files touched

| File | Change |
|---|---|
| `apps/api/src/__tests__/helpers.ts` | settler/reverser overrides + 2 fixtures |
| `apps/api/src/routes/v1/payment-intents.test.ts` | refactor + 8 new tests |
| `apps/api/src/routes/v1/refunds.test.ts` | new |

No migrations, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `DATABASE_URL=… pnpm --filter @psp-new/api exec vitest --run` | all green live (baseline 11 + new) |
| `pnpm typecheck` / `pnpm test` (no DB) | 60/60 each; suites skip cleanly |
