# Phase 24 — Done

**Date:** 2026-05-19 · **Status:** clearing_adjustments auto-sweep landed. Plan: `PHASE_24_PLAN.md`.

Completes the Phase 21 chain. The leftover `clearing_adjustments`
LIABILITY balance — what's left after Phase 15 settles the matching
scheme_receivable — now drains daily into a new `adjustment_revenue`
REVENUE account. Books resolve cleanly per discrepancy without
operator intervention.

## What shipped

- **Migration `0027_adjustment_revenue.sql`** — seeds an
  `adjustment_revenue` REVENUE account per currency (`owner_kind='psp'`).
- **`apps/worker/src/clearing-adjustments-sweep-job.ts` (NEW)** —
  `sweepClearingAdjustments(deps, asOf?)`. Scans
  `ledger.account_balances` for `clearing_adjustments` rows with
  non-zero balance, then per-currency txn posts the exact negation:
  - `clearing_adjustments  +delta`  (drains to 0)
  - `adjustment_revenue    −delta`  (recognizes as revenue)
  where `delta = −current_balance`. Works for both negative (typical
  — clearing recorded a "we owe" delta) and positive (rare — expense
  case).
- **`apps/worker/src/index.ts`** — sixth sweeper timer (24h cadence,
  `CLEARING_SWEEP_INTERVAL_MS`).
- **`apps/worker/src/clearing-adjustments-sweep-job.test.ts` (NEW)** —
  HAS_DB-gated: seed a Phase-21-shaped adjustment, run sweep, assert
  clearing drains and adjustment_revenue moves by the offsetting
  amount. Re-run same UTC day is a unique-violation no-op.

Zero changes to Phase 21 logic. The clearing_adjustments account stays
as the in-flight holding; Phase 24 just drains it on the daily tick.

## Accounting trace (worked example)

Starting state: all zeros.

| Step | Journal posted | scheme_receivable | clearing_adjustments | psp_cash_at_bank | adjustment_revenue |
|---|---|---|---|---|---|
| (Phase 21) | scheme_receivable +5500 / clearing_adjustments −5500 | +5500 | −5500 | 0 | 0 |
| (Phase 15) | scheme_receivable −5500 / psp_cash_at_bank +5500 | 0 | −5500 | +5500 | 0 |
| **Phase 24** | clearing_adjustments +5500 / adjustment_revenue −5500 | 0 | 0 | +5500 | −5500 |

Final: cash gained $5500; revenue earned $5500. Assets = revenue +
equity. Per-discrepancy books resolve cleanly.

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/clearing-adjustments-sweep-job.test.ts` (NEW) | 1 HAS_DB-gated case: seed → sweep → assert balances move correctly → re-run is no-op |
| Existing 60-package suite | Green. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages.

## What this enables next

The Phase 20 → 21 → 24 clearing pipeline is now end-to-end automated
for delta resolution. Remaining open items:

- **Cardholder webhook delivery** — still the biggest unblocked item
  since Phase 22.
- **Cardholder REST API** — `/v1/cardholder/...` endpoints.
- **Auto-top-up rules** — would benefit from cardholder-scoped payment
  methods (small schema change).
- **Card-load chargeback/refund** — would benefit from per-card
  stored_value (Phase 23 already done).
- **Real Base II / IPM parsing** — the largest remaining item.
