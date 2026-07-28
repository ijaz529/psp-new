# Phase 33 — Plan

**Goal:** make `POST /v1/payment_intents/:id/confirm` drive the real
acquirer path. Today the route calls `confirmPaymentIntent` without
passing `authorizer: ctx.authorizer`, so the orchestrator falls back to
the Phase 3 always-approve stub: no ISO 8583 traffic, every confirm
succeeds, and `last_auth_rrn` / `last_auth_stan` stay NULL — which in
turn silently disables the 0220 capture and 0420 reversal legs for any
PI confirmed through this route.

## Why this is a bug, not a missing feature

- `POST /v1/payment_intents` with `confirm: true`
  (`apps/api/src/routes/v1/payment-intents.ts:83`) passes
  `authorizer: ctx.authorizer`. The 3DS callback path does too. Only
  the standalone confirm route omits it.
- `confirmPaymentIntent`'s `authorizer` is optional by design
  (`packages/payment-engine/src/orchestrator.ts:359`): absent means
  "Phase 3 stub, always approve". The confirm route was never updated
  when Phase 5 wired the real authorizer into the create path.
- Consequence chain: stub approval posts the capture journal with no
  wire exchange, `last_auth_rrn`/`last_auth_stan` remain NULL, and
  later capture/cancel skip their 0220/0420 sends because the RRN
  lookup finds nothing.

## Scope

- `apps/api/src/routes/v1/payment-intents.ts` — add
  `authorizer: ctx.authorizer` to the `confirmPaymentIntent` call in
  the confirm route. One line.
- `apps/api/src/routes/v1/payment-intents.test.ts` — new DB-gated
  integration test (Phase 31 harness):
  - Harness gains an optional `overrides` parameter so a test can
    inject a spy authorizer (default stubs still throw).
  - Test: create merchant + secret key + payment method + PI via the
    API, then `POST /v1/payment_intents/:id/confirm` with a spy
    authorizer that approves with an RRN/STAN. Assert the spy was
    called once and `last_auth_rrn` is persisted. This fails against
    the current code (spy never called, RRN NULL) and passes after
    the fix.
- `apps/api/src/__tests__/helpers.ts` — the `overrides` parameter
  described above.

## Out of scope

- The other findings from the 2026-07-28 audit (synthetic clearing
  RRNs, missing 0400/0800, `make e2e` canary, logger header mutation).
- Any change to `confirmPaymentIntent` itself or the stub-authorizer
  fallback semantics.
- Merchant-route test coverage beyond this one regression test.

## Files touched

| File | Change |
|---|---|
| `apps/api/src/routes/v1/payment-intents.ts` | + `authorizer: ctx.authorizer` |
| `apps/api/src/__tests__/helpers.ts` | optional harness overrides |
| `apps/api/src/routes/v1/payment-intents.test.ts` | new |

No migrations, no new packages, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `pnpm typecheck` | `Tasks: 60 successful, 60 total` |
| `pnpm test` (no DB) | `Tasks: 60 successful, 60 total` (DB suites skip) |
| `DATABASE_URL=… pnpm --filter @psp-new/api test --run` | all green, incl. new confirm test |

Note: no local Postgres is reachable in the authoring session (Docker
registry pulls failing), so the DB-gated test is written red-first by
inspection but must be executed on the next boot of the stack before
this phase is considered fully verified. `PHASE_33_DONE.md` will state
the actual result honestly.
