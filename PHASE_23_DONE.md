# Phase 23 — Done

**Date:** 2026-05-19 · **Status:** Per-card cardholder_stored_value LIABILITY landed. Plan: `PHASE_23_PLAN.md`.

Refines Phase 17 accounting. New cards get their own
`cardholder_stored_value` LIABILITY at issue time; the Phase 17
acquiring-leg sweeper routes the credit leg to that per-card account
instead of the PSP-level `external_load_clearing` aggregate. Books
balance per-card, not just in aggregate. Legacy cards (Phase 9–22)
keep using the PSP-level clearing via the sweeper's fallback.

## What shipped

- **Migration `0026_cards_stored_value_account.sql`** — single
  `ALTER paycore.cards ADD COLUMN stored_value_account_id text
  references ledger.accounts(id)`. Nullable: existing cards stay
  NULL and continue using the PSP-level clearing.
- **`apps/api/cli/card-issue.ts`** — creates a 3rd ledger account
  alongside `cardholder_funded` and `cardholder_holds`:
  `cardholder_stored_value` LIABILITY, `owner_kind='issuer'`,
  `owner_id=cardId`. Sets the new column on the cards row. Prints the
  account id in the CLI output.
- **`apps/worker/src/card-load-acquiring-job.ts`** — joins
  `paycore.cards` for `stored_value_account_id` on the unreconciled-loads
  query, then routes the `-X` credit leg conditionally:
  `card.stored_value_account_id ?? pspAccount('external_load_clearing',
  currency)`. The `scheme_receivable +X` leg is identical to Phase 17.
- **`apps/worker/src/card-load-acquiring-job.test.ts`** — new test
  case covering the per-card routing branch: seed a card with
  `stored_value_account_id` set, run the sweeper, assert that
  `scheme_receivable` rose by the load amount, PSP-level clearing
  stayed unchanged, and the per-card stored_value LIABILITY went more
  negative by the load amount.

Zero changes to Phase 11 / Phase 14 / Phase 15 / Phase 18 / Phase 21.
`external_load_clearing` stays as the legacy fallback (no migration
to retire it).

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/card-load-acquiring-job.test.ts` (extended) | +1 case (3 total): per-card routing posts to `cardholder_stored_value`, leaves PSP-level clearing untouched. Existing legacy test still asserts PSP-level fallback. |
| Existing 60-package suite | Green. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages.

## Demo path

```bash
make up && make migrate

# Issue a card under the new regime
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
# CLI output now includes:
#   funded acct:  acct_…
#   holds acct:   acct_…
#   stored value: acct_…   ← new

# Tokenize external Visa, attach as pm, load via /v1/cards/:id/load
# (existing Phase 11 path)

# Sweepers run on cadence (or speed them up via env)
# After Phase 17 sweep:
pnpm ledger:balance <stored-value-acct>  # → -50.00 (LIABILITY, PSP owes cardholder)
pnpm ledger:balance external_load_clearing:USD:psp  # → 0 (untouched)
pnpm ledger:balance <funded-acct>  # → 50.00
# Per-card books: cardholder_funded +50 / cardholder_stored_value -50 = 0 ✓
```

## Simplifications vs. real life

These are documented in `PHASE_23_PLAN.md §Out of scope`:

- **No backfill of historical loads.** Cards issued before Phase 23
  keep their share of the aggregate `external_load_clearing` balance.
  A future migration could walk reconciled `card_loads` per card and
  re-post deltas; the demo doesn't need it.
- **No portal display.** Cardholder UX still shows `cardholder_funded`
  as the available balance; the per-card stored_value LIABILITY is a
  back-office accounting view. Surfacing it would just confuse users.
- **No chargeback/refund unwind path.** Phase 23 only handles the
  forward (load → stored_value) direction. Card-load chargeback (still
  open) would touch this.

## What this enables next

- **Per-card balance-sheet reporting.** With a dedicated LIABILITY
  account per card, an admin report could show each cardholder's
  balance sheet exactly (funded + holds on one side, stored_value on
  the other, summing to zero).
- **Card-load chargeback/refund** — now cleaner to implement because
  the unwind targets a specific per-card LIABILITY, not the aggregate.
- **Cardholder webhook delivery** — same Phase 22 unblock; the per-card
  LIABILITY also makes per-cardholder webhook payloads cleaner (you
  can quote a single account id, not a fraction of an aggregate).

Other still-open: auto-top-up, real Base II/IPM parsing, auto-sweep of
`clearing_adjustments`, cardholder REST API.
