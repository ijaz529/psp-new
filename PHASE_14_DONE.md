# Phase 14 — Done

**Date:** 2026-05-19 · **Status:** Pool reconciliation worker landed. Plan: `PHASE_14_PLAN.md`.

The Phase 11 deferral that left `issuer_funded_pool` drifting more negative
on every load is now closed. A periodic worker sweeps unreconciled
`paycore.card_loads` rows and posts a 2-leg journal that refills the pool.

## What shipped

- **Migration `0020_card_loads_reconciliation.sql`** — `paycore.card_loads`
  gets `reconciled_at timestamptz` (nullable). Partial index
  `card_loads_unreconciled_idx (created_at) where reconciled_at is null and
  status = 'succeeded'` narrows the sweep to exactly the rows that need work
  (failed loads never posted a journal in the first place, so they don't
  need reconciliation).
- **`apps/worker/src/pool-reconciliation-job.ts` (NEW)** —
  `reconcileCardLoads(deps, asOf?)`. Selects unreconciled succeeded loads,
  then per-row transaction: post a 2-leg journal
  (`issuer_funded_pool +X / psp_cash_at_bank -X`) using the existing
  `pspAccount` helper, then `update card_loads set reconciled_at = asOf
  where id = ? and reconciled_at is null`. Idempotency rides
  `externalId = 'card_load_recon:${load.id}'` on the journal; second pass
  also fails the `reconciled_at IS NULL` SELECT predicate.
- **`apps/worker/src/index.ts`** — `setInterval` wiring next to the Phase
  13 auth-expiry timer. Default cadence 1h, env-overridable via
  `POOL_RECON_INTERVAL_MS`. Cleared in the same `onClose` hook.
- **`apps/worker/src/pool-reconciliation-job.test.ts` (NEW)** —
  HAS_DB-gated integration test, two cases:
  - Seeds a succeeded load AND a failed load → run sweeper → pool returned
    to pre-load balance, `psp_cash_at_bank` drained by the load amount,
    succeeded row's `reconciled_at` non-null, failed row untouched.
  - Re-run is a clean no-op (scanned: 0, reconciled: 0).

Zero new ledger accounts. Both `issuer_funded_pool` and `psp_cash_at_bank`
were seeded by Phase 9's `0017` migration and Phase 6's chart-of-accounts
respectively. Both legs use the existing `pspAccount(code, currency)`
deterministic id helper.

## Demo path

```bash
make up && make migrate

# Seed via Phase 11 path
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd

# Tokenize an external Visa, attach as a payment_method, then load
curl -X POST $API/v1/tokens   -H "Authorization: Bearer pk_test_…" \
  -d '{"card":{"number":"4111111111111111","exp_month":12,"exp_year":2030,"cvc":"123"}}'
curl -X POST $API/v1/payment_methods -H "Authorization: Bearer sk_test_…" \
  -d '{"type":"card","token":"tok_…"}'
curl -X POST $API/v1/cards/<card_…>/load -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":5000,"currency":"USD","payment_method":"pm_…"}'

# Inspect the pool deficit pre-reconciliation
pnpm ledger:balance issuer_funded_pool:USD:psp     # → -50.00 (just drained by the load)
pnpm ledger:balance psp_cash_at_bank:USD:psp        # → 0.00

# Speed up the sweep for the demo
POOL_RECON_INTERVAL_MS=10000 docker compose restart worker

# Wait ~10s and check again
pnpm ledger:balance issuer_funded_pool:USD:psp     # → 0.00  (refilled)
pnpm ledger:balance psp_cash_at_bank:USD:psp        # → -50.00 (PSP cash funded the pool)
psql -c "select id, status, reconciled_at from paycore.card_loads order by created_at desc limit 5"
# → succeeded row's reconciled_at is now non-null
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/pool-reconciliation-job.test.ts` (NEW) | 2 HAS_DB-gated cases: (a) succeeded reconciled + failed ignored + ledger balances correct; (b) re-run is no-op |
| Existing 60-package suite | Green. No behavioural changes to any existing path. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages. The new
tests are `describe.skipIf(!HAS_DB)` and execute when the compose stack is
up — matches the issuer-host, auth-expiry, and ledger integration suites.

## Simplifications vs. real life

These are documented in `PHASE_14_PLAN.md §Out of scope`:

- **Scheme settlement → `psp_cash_at_bank` inflow not modeled.** In
  production, the cash PSP uses to refill the pool would itself come from
  scheme settlement files for the original card-load 0200s. Phase 11
  deferred acquiring-side accounting; Phase 14 refills the pool but doesn't
  model the settlement-cash inflow. `psp_cash_at_bank` continues to drift
  negative the same way it does for Phase 6 merchant payouts.
- **Per-row journals, not batched.** Per-row is fine for the demo volume.
  Production would batch into one per `(currency, day)`.
- **No reversal of reconciliation if the card_load is later voided.** Card
  loads have no void/refund path yet (Phase 11 §Out of scope), so this is
  moot.
- **No `card_load.reconciled` webhook.** Same answer as every other
  cardholder webhook: deferred until cardholder identity surface exists.
- **No distributed leader election.** Single-worker `setInterval` is fine
  for dev. BullMQ repeatable + advisory lock is the production shape.

## What this enables next

- **Scheme settlement worker** — the natural follow-on. A periodic sweep
  that takes the simulated scheme settlement and posts the offsetting
  `psp_cash_at_bank +X` inflow. After this, the cash drift this phase
  introduces actually heals.
- **Partial captures** (still open from Phase 10) — orthogonal feature
  work.
- **Cardholder identity surface** — unlocks the deferred cardholder
  webhooks across Phases 9-14.
- **Freeze toggle / controls editor on `/cards/:id`** — write surface on
  the portal.
