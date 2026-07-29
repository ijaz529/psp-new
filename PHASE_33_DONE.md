# Phase 33 — Done

**Date:** 2026-07-28 · **Status:** confirm route drives the real
acquirer. Plan: `PHASE_33_PLAN.md`.

`POST /v1/payment_intents/:id/confirm` called `confirmPaymentIntent`
without `authorizer: ctx.authorizer`, so it fell back to the Phase 3
always-approve stub: every standalone confirm succeeded with no
ISO 8583 exchange, and `last_auth_rrn` / `last_auth_stan` stayed NULL —
silently disabling the 0220 capture and 0420 reversal wire legs for
those PIs. The create-with-`confirm: true` and 3DS-callback paths were
unaffected (they already passed the authorizer), which is why demos
never surfaced it.

## What shipped

### `apps/api/src/routes/v1/payment-intents.ts`

One line: the confirm route now passes `authorizer: ctx.authorizer`,
matching the create path.

### `apps/api/src/__tests__/helpers.ts`

`createApiTestHarness(overrides?)` accepts an optional `authorizer`
so a suite can inject a spy on the acquirer path. Default behavior
unchanged — the throwing stubs still guard suites that shouldn't hit
the wire.

### `apps/api/src/routes/v1/payment-intents.test.ts` (new)

DB-gated regression test: merchant + `sk_test_` key + payment method
(BIN 411111 — outside the Phase 4 demo 3DS policy) → create PI →
`POST /:id/confirm` with a spy authorizer that approves with RRN/STAN.
Asserts the spy was called exactly once for the confirm (zero on
create), the PI reaches `succeeded`, and `last_auth_rrn` /
`last_auth_stan` are persisted. Against the pre-fix code these
assertions fail (stub approval, no call, NULL columns).

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` (no DB) | 60/60 — new suite skips cleanly (1 test, 1 skipped) |
| `DATABASE_URL=… pnpm --filter @psp-new/api test --run` | **9/9 green** (run 2026-07-29, live Postgres) |

**Live-DB result (2026-07-29):** Docker recovered; the DB-gated run
was executed against a real Postgres. The route fix itself was
correct, but the confirm test initially hung: it was the first code
path ever to exercise merchant event emission against a live DB, and
`emitAndPublishEvent` passed raw BigInt amounts into the jsonb
`paycore.events.data` / outbox payload — node-postgres cannot
serialize BigInt and wedged the connection mid-query. Fixed in
`fix(payment-engine): convert bigint amounts before jsonb event
payloads` (jsonSafe conversion to Number, matching `bigintToWire`).
After that fix: 9/9 (8 cardholder + 1 confirm), rrn/stan assertions
green.

## What did NOT change

- `confirmPaymentIntent` and the optional-authorizer fallback — the
  stub path still exists for callers that genuinely don't pass one.
- Create-with-`confirm: true` and 3DS callback paths — already correct.
- Capture/cancel routes — they already pass `settler`/`reverser`.

## Open list (Phase 32's list, one item closed, one new)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- TC 25 / MTI 1442 chargeback scheme-file fan-out from Phase 25.
- Merchant route integration tests — **partially opened**: first
  merchant-route test landed here; broader coverage still open.
- Fix logger redaction to not mutate request headers in place
  (Phase 32 latent bug).
- Janitor sweep for expired `paycore.cardholder_idempotency_keys`.
- **NEW:** run the Phase 33 DB-gated test against a live Postgres and
  record the result (blocked in the authoring session — see Verify).
- **NEW (from 2026-07-28 audit):** clearing files synthesize RRNs via
  `deterministicRrn(pi_id)` even though `payment_intents.last_auth_rrn`
  has held the real DE 37 value since Phase 10 — switch clearing to
  the real RRN, then build the `make e2e` payment canary the brief
  always wanted.
