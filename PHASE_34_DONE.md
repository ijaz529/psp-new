# Phase 34 — Done

**Date:** 2026-07-28 · **Status:** clearing files carry the real RRN.
Plan: `PHASE_34_PLAN.md`.

`collectClearingTransactionsForDate` synthesized every clearing-record
RRN from a hash of the PI id, under a comment claiming real RRNs lived
"in logs only" — stale since Phase 10 persisted the acquirer's DE 37
RRN on `paycore.payment_intents.last_auth_rrn`. Emitted files could
therefore never match a real scheme file; reconciliation passed only
because it round-tripped our own synthetic values.

## What shipped

### `packages/clearing-files/src/index.ts`

- `collectClearingTransactionsForDate` now selects `last_auth_rrn` and
  uses it as the record RRN.
- `deterministicRrn(pi_id)` demoted to a documented legacy fallback,
  applied only when `last_auth_rrn` is NULL (stub-approved or
  pre-Phase-10 PIs) so those transactions still clear rather than
  silently dropping out of the file.

### `packages/clearing-files/src/index.test.ts`

Two new unit tests for `collectClearingTransactionsForDate` (pure —
same fake-db chain pattern as the file's reconcile/adjust tests):
- `last_auth_rrn` present → carried verbatim. Red before the fix
  (collector ignored the column), green after.
- `last_auth_rrn` NULL → 12-digit deterministic fallback, stable
  across calls.

## Verify

| Check | Result |
|---|---|
| New verbatim-RRN test before fix | red (`expected '601201000042'`) |
| `pnpm --filter @psp-new/clearing-files exec vitest --run` | 19/19 green |
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |

## What did NOT change

- File formats (Base II / IPM builders and parsers) — the RRN field
  was always carried; only its source changed.
- `reconcileClearingFile` / `postClearingAdjustments` — they match on
  whatever RRN the records carry, so they now match on real RRNs with
  no code change.
- Existing `paycore.clearing_records` rows with synthetic RRNs — no
  backfill (out of scope per plan).
- The `created_at`-windowing quirk (PI captured days after creation
  clears on the wrong date) — noted in the plan, untouched.

## Open list (Phase 33's list, one item closed)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- TC 25 / MTI 1442 chargeback scheme-file fan-out from Phase 25.
- Merchant route integration tests — broader coverage still open.
- Fix logger redaction to not mutate request headers in place.
- Janitor sweep for expired `paycore.cardholder_idempotency_keys`.
- Run the Phase 33 DB-gated confirm test against a live Postgres and
  record the result.
- ~~Clearing files use synthetic RRNs~~ — closed this phase. Follow-on
  candidates: window clearing collection on capture time instead of
  `created_at`, then the `make e2e` payment canary.
