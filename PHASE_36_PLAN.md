# Phase 36 — Plan

**Goal:** clearing collects by capture time, not creation time.
`collectClearingTransactionsForDate` windows on
`payment_intents.created_at` and filters `status = 'succeeded'`. A PI
authorized on day N and captured on day N+2 is therefore wrong twice:
the nightly job for day N misses it (not yet succeeded when the job
runs), and no later job ever picks it up (day N+2's window excludes
its `created_at`). The transaction never clears. Same defect noted in
the Phase 34 plan as out-of-scope follow-on.

## Design

`payment_intents` has no capture timestamp today (`updated_at` also
moves on refunds and error writes, so it can't stand in). Add one:

- **Migration `0032_payment_intents_captured_at.sql`** — nullable
  `captured_at timestamptz` on `paycore.payment_intents`. Nullable
  plain column, same rationale as 0018's `last_auth_*`: no backfill
  (historical rows keep NULL and fall back to `created_at`).
- **Stamp it at both `succeeded` transition sites** in
  `packages/payment-engine/src/orchestrator.ts`:
  - `runAuthorizeAndPost` — auto-capture at confirm, when
    `nextStatus === 'succeeded'`;
  - `capturePaymentIntent` — manual capture, when `isFinal`.
    Partial captures don't stamp; the PI clears once, in full, on the
    day it finishes capturing (matches the existing one-record-per-PI
    collection of `amount_received`).
- **Window on `coalesce(captured_at, created_at)`** in
  `collectClearingTransactionsForDate`, and carry the same value as
  the record's `occurred_at` (currently `created_at`). Legacy and
  stub rows behave exactly as before; captured rows clear on capture
  day.

## Scope

| File | Change |
|---|---|
| `packages/db/migrations/0032_payment_intents_captured_at.sql` | new |
| `packages/db/src/kysely.ts` | + `captured_at: Date \| null` |
| `packages/payment-engine/src/orchestrator.ts` | stamp at 2 sites |
| `packages/clearing-files/src/index.ts` | window + occurred_at on coalesce |
| `packages/clearing-files/src/index.test.ts` | + occurred_at preference tests |

`payment_intents` is not in the Drizzle schema (only early tables
are), so no `schema/paycore.ts` change — SQL + Kysely mirror only.

## Out of scope

- Backfilling `captured_at` for historical rows.
- Wire shape: `captured_at` is not added to `paymentIntentToWire`.
- Automating settlement-file ingestion; the e2e canary.

## Verify steps

| Check | Expected |
|---|---|
| New occurred_at-preference test red-first | fails before the collect change |
| `pnpm --filter @psp-new/clearing-files exec vitest --run` | green |
| `pnpm typecheck` | 60/60 |
| `pnpm test` | 60/60 |
| Migration idempotency (CI runs migrate twice) | clean |

Honest caveat carried from Phases 33: no local Postgres in the
authoring session, so the SQL windowing itself (the `coalesce` in the
WHERE clause) can't be executed here — the JS-side mapping is
unit-tested, and the migration + query run live on next boot.
