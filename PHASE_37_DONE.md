# Phase 37 — Done

**Date:** 2026-07-29 · **Status:** refunded card loads fan out to the
scheme files. Plan: `PHASE_37_PLAN.md`.

Phase 25's card-load refund flipped status and posted the internal
journal, but the scheme files never learned — every refunded load
left scheme-side cash to be mopped up blindly by the Phase 21/24
adjustment chain. The nightly clearing job now emits chargeback
records: Visa Base II **TC 25**, Mastercard IPM **MTI 1442**.

## What shipped

### Migration `0033_card_load_chargeback_clearing.sql`

- `card_loads.refunded_at timestamptz` (nullable, no backfill) — the
  windowing timestamp Phase 25's bare status flip lacked. Stamped by
  the refund route in the same UPDATE that flips status.
- Drops the `clearing_records.payment_intent_id → payment_intents`
  FK: chargeback records carry the `cl_…` load id in that slot.
  Column name and index unchanged.

### `packages/clearing-files`

- `ClearingTransaction.kind?: 'presentment' | 'chargeback'` —
  optional; absent = presentment, so every pre-Phase-37 caller and
  fixture is untouched.
- `base2.ts`: TC 25 detail records for chargebacks; parser accepts
  TC 05|25 and tags chargebacks with `kind` (presentments parse
  without it, keeping old round-trips byte-equal).
- `ipm.ts`: MTI 1442 messages; parser accepts 1240|1442, same kind
  convention. Stale "one MTI is wired" header comment updated.
- Trailer totals stay **gross** (sum of all record amounts, both
  kinds) — integrity check, not a net; documented in both builders.
- New `collectCardLoadChargebacksForDate(db, date)`:
  `card_loads ⨝ payment_methods`, `status = 'refunded'`,
  `refunded_at` in the UTC day window. Real load `rrn` preferred,
  deterministic fallback when NULL; `occurredAt = refunded_at`.

### `apps/worker/src/clearing-job.ts`

Nightly pass collects presentments + chargebacks and emits them into
the same per-(scheme, currency) files. Log line now reports both
counts.

### `apps/api/src/routes/v1/cards.ts`

Refund route stamps `refunded_at` alongside the status flip.

## Verify

| Check | Result |
|---|---|
| Mixed-file round-trip tests before builder changes | 4 red |
| `pnpm --filter @psp-new/clearing-files exec vitest --run` | 25/25 green |
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |

**Live-DB result (2026-07-29):** migration 0033 applied cleanly and
double-migrate is a no-op. The fan-out demo ran against live
Postgres: seeded a refunded visa load and a refunded mastercard load
(`refunded_at` = yesterday), ran `runNightlyJobs` — the collector
returned 2 chargebacks and emitted `visa_usd_<date>.b2` containing a
TC 25 detail record and `mastercard_usd_<date>.ipm` containing an
MTI 1442 record. Reconciliation/adjustment behavior with mixed files
remains covered by unit tests only insofar as the amounts are
gross-summed.

## What did NOT change

- Reconcile/adjust logic — chargeback records inserted at emit time
  match on (scheme, currency, rrn) on re-ingest exactly like
  presentments; amounts stay positive so file/ledger sums cancel.
- Merchant PI refunds — still ledger-only, no scheme-file
  representment (own phase).
- No dispute lifecycle, no netting, no 1240 reversals.
- Loads refunded before Phase 37 (NULL `refunded_at`) are never
  fanned out.

## Open list (Phase 36's list, one item closed)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- ~~TC 25 / MTI 1442 chargeback scheme-file fan-out~~ — closed this
  phase.
- Merchant route integration tests — broader coverage still open.
- Janitor sweep for expired `paycore.cardholder_idempotency_keys`.
- Run against live Postgres and record results: Phase 33 confirm
  test, migrations 0032/0033, Phase 37 fan-out demo.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  needs a bootable stack.
