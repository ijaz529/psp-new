# Phase 36 — Done

**Date:** 2026-07-28 · **Status:** clearing collects by capture time.
Plan: `PHASE_36_PLAN.md`.

`collectClearingTransactionsForDate` windowed on `created_at` while
filtering `status = 'succeeded'`, so a PI authorized day N and
captured day N+2 never cleared: day N's nightly job ran before it
succeeded, and day N+2's window excluded its `created_at`.

## What shipped

### Migration `0032_payment_intents_captured_at.sql`

Nullable `captured_at timestamptz` on `paycore.payment_intents`.
Plain column, no backfill — same pattern and rationale as 0018's
`last_auth_*`. Mirrored in the Kysely `Database` interface.

### `packages/payment-engine/src/orchestrator.ts`

`captured_at` stamped at both succeeded-transition sites:
- `runAuthorizeAndPost` — auto-capture at confirm, when
  `nextStatus === 'succeeded'`;
- `capturePaymentIntent` — when `isFinal`. Partial captures don't
  stamp; the PI clears once, in full, on the day capturing finishes
  (consistent with collection reading total `amount_received`).

### `packages/clearing-files/src/index.ts`

`collectClearingTransactionsForDate` windows both bounds on
`coalesce(captured_at, created_at)` and carries the same value as the
record's `occurred_at`. Legacy/NULL rows behave exactly as before.

### `packages/clearing-files/src/index.test.ts`

Two new unit tests on the mapping: `occurred_at` prefers
`captured_at` (red before the change), NULL falls back to
`created_at`.

## Verify

| Check | Result |
|---|---|
| occurred_at-preference test before fix | red |
| `pnpm --filter @psp-new/clearing-files exec vitest --run` | 21/21 green |
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |

**Live-DB result (2026-07-29):** migration 0032 applied cleanly via
`make migrate` (0001–0033 in order) and a second run reported
"skipped (already applied)" for all 33 — idempotency confirmed. The
`coalesce` window ran live as part of the Phase 37 fan-out demo
(nightly job collected presentments/chargebacks against real
Postgres without error).

## What did NOT change

- `paymentIntentToWire` — `captured_at` is not exposed on the API.
- No backfill of historical rows; they clear by `created_at` as
  before.
- Partial-capture journal entries — still one per capture with the
  Phase 16 externalId scheme; only the final capture stamps the PI.

## Open list (Phase 35's list, one item closed)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- TC 25 / MTI 1442 chargeback scheme-file fan-out from Phase 25.
- Merchant route integration tests — broader coverage still open.
- Janitor sweep for expired `paycore.cardholder_idempotency_keys`.
- Run the Phase 33 DB-gated confirm test + migration 0032 against a
  live Postgres and record the result.
- ~~Window clearing on capture time~~ — closed this phase.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  now unblocked design-wise; needs a bootable stack.
