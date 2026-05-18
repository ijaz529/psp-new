# Phase 6 — Done

**Date:** 2026-05-18 · **Status:** EOD clearing files + merchant payouts + materialized-view refresh wired into the worker.

---

## What was built

- **Migration 0014** — `merchants.reserve_basis_points`, `merchants.payout_schedule`, `clearing_files`, `clearing_records`, `payouts`. Grants to `psp_app`.
- **`packages/clearing-files`** — `emitClearingFiles({ db, transactions, fileDate })` groups by `(scheme, currency)`, writes Visa Base II-like + Mastercard IPM-like CSVs to disk, inserts `clearing_files` + `clearing_records` rows. Unique index on `(scheme, currency, file_date, format)` makes the EOD job idempotent. `collectClearingTransactionsForDate(db, date)` reads succeeded PIs for the day.
- **`packages/payouts`** — `runPayout({ db, merchantId, currency, scheduledFor })` orchestrator: sums captures − refunds for the window, posts a 2-line journal entry (`merchant_settlement_liability` ↑ +net, `psp_cash_at_bank` ↓ −net — simulated instant bank rail), inserts `paycore.payouts` with status `paid`, emits `payout.paid` event into the outbox. Uses a deterministic `external_id` on the journal entry so re-runs hit the unique-index constraint instead of double-paying.
- **`apps/worker`** registers two interval-based jobs at boot:
  - `runNightlyJobs` (default every 24h) — emits clearing files for yesterday's transactions, then runs payouts for every `(merchant, currency)` that had activity.
  - `refreshAccountBalances` (default every 5min) — `REFRESH MATERIALIZED VIEW CONCURRENTLY ledger.account_balances`; falls back to non-concurrent on the first refresh.
- **Worker** still subscribes to the webhook-delivery queue from Phase 3.

## Tests

- `packages/clearing-files/src/index.test.ts` — grouping + CSV format (Visa header vs MC IPM header), record counts, total amounts. DB calls mocked.
- Payouts: integration test deferred to Phase 7+ (needs full compose stack to exercise; the orchestrator is straightforward enough that the unit-mocked test gives diminishing returns).

## What's deliberately deferred to Phase 7

- **Settlement ingestion** — once we've emitted clearing files, real-world flow is the scheme returns a settlement file we ingest + reconcile. Phase 7 wires the reconciliation against `@psp-new/ledger.reconcile()`.
- **Reserve holdback math** — `reserve_basis_points` column is in the merchants table; the math (compute reserve, post to `refund_reserve` account, exclude from payout) lands in Phase 7 alongside the risk engine.
- **8583 reversals on cancel/refund** — Phase 5's auth path is wired; capture/cancel/refund still post journal entries directly. Phase 7 wires the 0420 reversal-advice messages.
- **Acquirer-message audit table** — Phase 5 logs to Pino only; Phase 7 adds the structured table.
- **Per-currency payout cycles** — uniform `daily` for Phase 6.

## Demo

```bash
# After running some PaymentIntents, kick the nightly manually:
NIGHTLY_INTERVAL_MS=2000 BALANCE_REFRESH_MS=2000 docker compose up worker
# Wait a few seconds; check the data-exports/clearing/ dir on the worker container
# and the paycore.payouts table.

psql $DATABASE_URL -c 'select * from paycore.payouts order by created_at desc limit 5'
psql $DATABASE_URL -c 'select scheme, currency, record_count, total_amount, path from paycore.clearing_files'
```

Phase 7 plan: `PHASE_7_PLAN.md`.
