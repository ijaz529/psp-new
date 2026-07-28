# Phase 34 — Plan

**Goal:** clearing files carry the real scheme RRN. Today
`collectClearingTransactionsForDate`
(`packages/clearing-files/src/index.ts:154`) synthesizes every RRN via
`deterministicRrn(pi_id)`, with a comment claiming real RRNs live "in
logs only". That's been false since Phase 10: the acquirer's DE 37 RRN
is persisted on `paycore.payment_intents.last_auth_rrn`. Consequence:
every emitted clearing record carries a fabricated RRN that could never
match a real scheme file — reconciliation only passes because it
round-trips our own fiction.

## Scope

- `packages/clearing-files/src/index.ts` —
  `collectClearingTransactionsForDate` selects `last_auth_rrn` and uses
  it as the record RRN. Fallback: when `last_auth_rrn` is NULL (PIs
  approved by the Phase 3 stub path, or pre-Phase-10 rows), keep the
  `deterministicRrn(pi_id)` synthetic so those transactions still clear
  instead of silently dropping out of the file. Update the stale
  comment on `deterministicRrn` to say what it now is: a legacy
  fallback, not the primary source.
- `packages/clearing-files/src/index.test.ts` — new unit tests for
  `collectClearingTransactionsForDate` using the same fake-db pattern
  the file's reconcile/adjust tests already use:
  - a PI row with `last_auth_rrn` set → record carries that RRN
    verbatim (fails red against current code, which ignores the
    column);
  - a PI row with `last_auth_rrn` NULL → record carries the
    deterministic fallback (regression-pins the fallback).

## Out of scope

- The `created_at`-windowing quirk (a PI authorized day N, captured
  day N+2 clears on the wrong date). Real fix is windowing on capture
  time; separate phase — noted, not touched.
- Automating settlement-file ingestion (still CLI-only).
- The `make e2e` payment canary.
- Backfilling synthetic RRNs already written to
  `paycore.clearing_records`.

## Files touched

| File | Change |
|---|---|
| `packages/clearing-files/src/index.ts` | select + prefer `last_auth_rrn` |
| `packages/clearing-files/src/index.test.ts` | + collect tests |

No migrations, no new packages, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `pnpm typecheck` | `Tasks: 60 successful, 60 total` |
| `pnpm test` | `Tasks: 60 successful, 60 total`, incl. new collect tests (pure unit, no DB gate) |
| New test red-first | RRN assertion fails before the index.ts change, passes after |
