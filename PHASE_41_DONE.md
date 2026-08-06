# Phase 41 — Done

**Date:** 2026-08-06 · **Status:** the merchant money path has API
test coverage, verified against live Postgres. Plan:
`PHASE_41_PLAN.md`.

Session context: the 33–38 live-verification branch
(`claude/intelligent-kalam-678912`) was merged to main first — its
`jsonSafe()` BigInt fix is a hard prerequisite (merchant event
emission wedged the DB connection without it). Postgres was booted,
migrations 0001–**0034** applied and double-run idempotent (0034's
first live application), and the pre-existing api suite passed 11/11
live — including the first live run of Phase 40's scoped-endpoint
tests — before any new tests were written.

## What shipped

### Harness (`apps/api/src/__tests__/helpers.ts`)

- `overrides` now accepts `settler` / `reverser` alongside
  `authorizer`, so capture/cancel tests assert the wire legs.
- `createTestMerchant` (merchant + secret + publishable keys) and
  `createTestPaymentMethod` (visa, BIN 411111) fixtures, extracted
  from the Phase 33 test's inline setup.

### `payment-intents.test.ts` (rewritten around the fixtures, 10 tests)

- Auth gate: 401 `api_key_missing`; 403 `permission_denied` for a
  publishable key on a secret route.
- Create → `requires_payment_method`; create-with-`confirm: true` →
  authorizer called, `succeeded`, RRN/STAN + `captured_at` persisted.
- Decline path: authorizer refusal → `failed` +
  `last_payment_error.decline_code` on the wire.
- Manual capture: confirm → `requires_capture` → capture drives the
  settler with the auth's RRN/STAN → `succeeded`.
- Cancel: reverser called with the uncaptured remainder → `canceled`.
- Cross-merchant GET isolation (404); idempotency replay on create.
- The Phase 33 confirm-route regression test, kept.

### `refunds.test.ts` (new, 5 tests)

Full refund (+ GET), partial refund reduces `amount_received`,
over-refund → 409 `refund_exceeds_capture`, refund of an unconfirmed
PI → 409 `payment_intent_unexpected_state`, cross-merchant GET → 404.

## Verify

| Check | Result |
|---|---|
| `make migrate` ×2 (incl. 0034 first live run) | applied, then all-skip |
| api suite live (`vitest --run`) | **25/25 green**, twice (re-run clean on dirty DB) |
| worker suite live | 10/10 green |
| `pnpm typecheck` / `pnpm test` (no DB) | 60/60 each |

One test-side fix during the run: `POST /:id/cancel` with a
`content-type: application/json` header and no body is rejected by
Fastify's JSON parser — the test now sends `{}`. Not an app bug,
though the resulting status is 500 rather than 400 (Fastify's
empty-body FastifyError isn't mapped by the error handler); noted,
not fixed.

## What did NOT change

- No route or engine code — this phase is coverage only; every test
  passed against existing behavior on first run (except the test-side
  body fix above).
- Vault-dependent routes (`/v1/tokens`, payment-method creation),
  3DS flows, customers/events routes — still untested (out of scope
  per plan).

## Open list

- ~~Merchant route integration tests~~ — money path closed this
  phase; vault/3DS/customers breadth still open (needs
  vault-in-harness).
- Phase 39 portal click-through — still not run (needs full stack,
  not just Postgres).
- Map Fastify's empty-JSON-body error to 400 in the API error
  handler (found this phase).
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  Postgres now boots; the remaining blocker is only the compose app
  images. **This is the next big item.**
