# Phase 17 — Done

**Date:** 2026-05-19 · **Status:** Card-load acquiring-leg sweeper landed. Plan: `PHASE_17_PLAN.md`.

The Phase 11 acquiring-side deferral is now closed. Every card load via
the `POST /v1/cards/:id/load` endpoint has a complete, balanced accounting
story across five ledger sweepers (Phases 13/14/15/17 + the original
Phase 11 cardholder leg).

## What shipped

- **Migration `0022_card_loads_acquiring_leg.sql`** — seeds an
  `external_load_clearing` LIABILITY account per currency
  (`owner_kind='psp'`), and adds `acquiring_reconciled_at timestamptz`
  (nullable) to `paycore.card_loads`. Partial index
  `card_loads_acquiring_unreconciled_idx (created_at) where
  acquiring_reconciled_at is null and status='succeeded'` makes the sweep
  cheap.
- **`apps/worker/src/card-load-acquiring-job.ts` (NEW)** —
  `reconcileCardLoadAcquiring(deps, asOf?)`. Joins `card_loads ⨝
  payment_methods` for `status='succeeded' AND acquiring_reconciled_at IS
  NULL`, validates `payment_methods.scheme` is a known scheme, then
  per-load txn: 2-leg journal (`scheme_receivable[scheme, currency] +X /
  external_load_clearing[currency] -X`) + sets `acquiring_reconciled_at`.
  Idempotent via `externalId='card_load_acq:${load.id}'`.
- **`apps/worker/src/index.ts`** — fifth sweeper timer (30min cadence,
  `CARD_LOAD_ACQ_INTERVAL_MS`). Cleared in the same `onClose` hook.
- **`apps/worker/src/card-load-acquiring-job.test.ts` (NEW)** —
  HAS_DB-gated: seeds a succeeded card_load (full graph: cardholder + card
  + merchant + payment_method) AND a failed load, runs sweeper, asserts
  ledger balances move correctly, succeeded row marked, failed ignored,
  re-run is no-op.

## How this closes the deferral

After Phase 11 + 14 + 15 + 17 all run for a single card load of `X`:

| Account | Phase 11 | Phase 14 | Phase 15 | Phase 17 | Final |
|---|---|---|---|---|---|
| `cardholder_funded[card]` | +X | — | — | — | **+X** |
| `issuer_funded_pool[ccy]` | −X | +X | — | — | 0 |
| `psp_cash_at_bank[ccy]` | — | −X | +X | — | 0 |
| `scheme_receivable[scheme,ccy]` | — | — | −X | +X | 0 |
| `external_load_clearing[ccy]` | — | — | — | −X | **−X** |

Net: `cardholder_funded +X` (cardholder's available balance) offset by
`external_load_clearing -X` (PSP's running cardholder stored-value
liability). All intermediate accounts net to zero. **Books balance per
load.**

This is the proper double-entry semantic: PSP holds $X cash via Visa
settlement, PSP owes $X to the cardholder via stored value. They cancel.

## Why this is much smaller than the originally-floated refactor

In Phase 15's DONE doc I described this work as a *"`cardholder_funded`
ASSET → LIABILITY refactor"* — touching the CLI, issuer-host, portal,
and every balance-reader. On closer reading that was overscoped. The
real problem was just one missing journal entry per load. Adding a
sweeper to post it is the surgical fix; nothing else needs to change.

The pre-existing convention (positive `cardholder_funded` balance = money
available to the cardholder) is preserved as-is. The portal display, the
issuer-host's `readAvailableBalance`, the CLI `card:load`, and the
issuer-host hold lifecycle all keep working without modification.

## Demo path

```bash
make up && make migrate
docker compose up -d worker

# Issue card + tokenize external Visa + attach as pm_…
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd

# Load via acquiring side (Phase 11)
curl -X POST $API/v1/cards/<card_…>/load \
  -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":5000,"currency":"USD","payment_method":"pm_…"}'

# Speed up all sweepers for the demo
POOL_RECON_INTERVAL_MS=10000 CARD_LOAD_ACQ_INTERVAL_MS=10000 \
  SCHEME_SETTLE_INTERVAL_MS=10000 docker compose restart worker

# Wait ~30s, then inspect — all accounts should net to the final state
pnpm ledger:balance cardholder_funded:USD:issuer:<card_…>   # → +50.00
pnpm ledger:balance issuer_funded_pool:USD:psp               # → 0
pnpm ledger:balance psp_cash_at_bank:USD:psp                 # → 0 (net)
pnpm ledger:balance scheme_receivable:USD:scheme:visa        # → 0 (net)
pnpm ledger:balance external_load_clearing:USD:psp           # → -50.00
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/card-load-acquiring-job.test.ts` (NEW) | HAS_DB-gated: succeeded load reconciled, balances move; failed load ignored; re-run no-op |
| Existing 60-package suite | Green. No behavioural changes to any existing path. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages.

## Simplifications vs. real life

These are documented in `PHASE_17_PLAN.md §Out of scope`:

- **Per-card stored-value account.** We use a PSP-level
  `external_load_clearing` rather than a per-card `cardholder_stored_value`.
  Aggregate-only back-office reporting; per-card granularity is a future
  phase if needed.
- **No interchange / scheme fee netting on loads.** Phase 11's `loadCard`
  doesn't deduct MDR. Real PSPs would net fees from the scheme settlement.
- **CLI loads not reconciled.** The legacy `pnpm card:load` CLI posts
  directly to the ledger without writing a `card_loads` row, so this
  sweeper doesn't touch them. Demo CLI loads continue to grow the pool
  deficit (pre-Phase 14 behavior).
- **No reversal of acquiring reconciliation.** Card loads have no
  void/refund path yet. A future chargeback flow would need to undo the
  acquiring-leg journal.

## What this enables next

- **Per-card `cardholder_stored_value` LIABILITY** — replace the
  PSP-level clearing with a per-card account for granular reporting.
- **Card-load chargeback / refund flow** — `POST /v1/card_loads/:id/refund`
  + an unreconciliation step in this sweeper.
- **Cardholder identity surface** — unlocks the deferred cardholder
  webhooks across Phases 9-17.
- **Freeze toggle / controls editor on `/cards/:id`** — write surface on
  the portal.
- **Settlement file ingestion** — parse real Visa Base II / MC IPM files
  instead of trusting the ledger balance.
