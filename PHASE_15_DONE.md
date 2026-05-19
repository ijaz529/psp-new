# Phase 15 — Done

**Date:** 2026-05-19 · **Status:** Scheme settlement worker landed. Plan: `PHASE_15_PLAN.md`.

Schemes now "settle" daily on the PSP's books — positive
`scheme_receivable[scheme, currency]` balances drain into
`psp_cash_at_bank[currency]`. This closes the Phase 6 payout cash drift.

## Honest scope reminder

Phase 15 heals **the Phase 6 payout cash drift**, not the Phase 14 pool
reconciliation drift. The latter requires closing Phase 11's acquiring-side
deferral first (cardholder_funded is mislabeled ASSET; should be
LIABILITY). See `PHASE_15_PLAN.md §Honest scope` for the table.

## What shipped

- **`apps/worker/src/scheme-settlement-job.ts` (NEW)** —
  `settleSchemeReceivables(deps, asOf?)`. Joins `ledger.account_balances`
  and `ledger.accounts` for rows where `code='scheme_receivable'` and
  `balance > 0`. Validates the owner_id is a known scheme (visa /
  mastercard / amex), then per-combo transaction: 2-leg journal
  (`scheme_receivable -balance / psp_cash_at_bank +balance`). Idempotency
  rides `externalId = 'scheme_settle:${yyyymmdd}:${scheme}:${currency}'` —
  re-running on the same UTC day hits the unique constraint and is
  swallowed.
- **`apps/worker/src/index.ts`** — fourth sweeper timer next to the
  existing nightly + balance + auth-expiry + pool-recon timers. Default
  cadence 24h (Visa/MC T+1 net-settlement), env-overridable via
  `SCHEME_SETTLE_INTERVAL_MS`. Cleared in the same `onClose` hook.
- **`apps/worker/src/scheme-settlement-job.test.ts` (NEW)** —
  HAS_DB-gated, two cases:
  - Seed a `scheme_receivable[visa, USD] = +5000` via a mock capture
    journal → run sweeper → receivable goes to 0, `psp_cash_at_bank[USD]`
    credited by 5000. Re-run same UTC day is a no-op.
  - On a different UTC day, zero-balance schemes are not processed
    (`settled === scanned`).

Zero schema changes, zero new accounts. Both `scheme_receivable` (per
scheme×currency) and `psp_cash_at_bank` (per currency) were seeded in
Phase 6's `0009_chart_of_accounts.sql`. Used the existing `schemeAccount`
and `pspAccount` deterministic-id helpers from `@psp-new/ledger`.

## Demo path

```bash
make up && make migrate
docker compose up -d worker

# Drive some merchant captures (Phase 3-5) so scheme_receivable accumulates
for i in $(seq 1 3); do
  curl -X POST $API/v1/payment_intents -H "Authorization: Bearer sk_test_…" \
    -d '{"amount":2000,"currency":"USD","capture_method":"automatic",
         "payment_method":"pm_<external>","confirm":true}'
done

pnpm ledger:balance scheme_receivable:USD:scheme:visa    # → 60.00 (3 × $20)
pnpm ledger:balance psp_cash_at_bank:USD:psp             # → some negative drift

# Speed up the sweep for the demo
SCHEME_SETTLE_INTERVAL_MS=10000 docker compose restart worker
# Wait ~10s
pnpm ledger:balance scheme_receivable:USD:scheme:visa    # → 0.00 (settled)
pnpm ledger:balance psp_cash_at_bank:USD:psp             # → drift + 60.00

# Idempotency check (same day, second sweep)
docker compose restart worker
sleep 10
# scheme_receivable stays 0; psp_cash_at_bank unchanged (no double-settle)
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/worker/src/scheme-settlement-job.test.ts` (NEW) | 2 HAS_DB-gated cases: (a) +5000 receivable drained to cash, re-run same day is no-op; (b) zero-balance schemes not processed |
| Existing 60-package suite | Green. No behavioural changes to any existing path. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages. The two
new tests skip without `DATABASE_URL` (matches Phases 10, 13, 14).

## Simplifications vs. real life

These are documented in `PHASE_15_PLAN.md §Out of scope`:

- **Phase 14 cash drift not healed.** Already covered above.
- **No T+N settlement windows.** We settle "current balance" without
  date-cutoff filtering. Real schemes settle T+1 / T+2 / T+3 windows of
  captures. A future phase can read the capture dates Phase 6 clearing
  files already record.
- **No interchange / scheme fee netting.** Real settlements deduct fees
  from the receivable. We settle 100% gross.
- **No per-scheme schedules.** Amex settles differently from Visa/MC. We
  use one cadence for all schemes.
- **No multi-currency FX.** Each (scheme, currency) settles into the same
  currency's cash account — no conversion to a reporting currency.
- **No clearing-file ingestion.** Phase 6 emits files; we don't parse
  incoming ones. The sweeper trusts the ledger balance directly.

## What this enables next

- **Phase 11 acquiring-side deferral closeout** — the natural follow-on
  that fully heals the Phase 14 cash drift. Requires re-labeling
  `cardholder_funded` from ASSET → LIABILITY across the issuer-host,
  CLI, and balance-reading paths, then refactoring the Phase 11 load
  journal to post the proper `scheme_receivable +X / cardholder_funded
  −X` (sum=0) shape. Once that lands, this same Phase 15 sweeper
  automatically heals the load-side drift too.
- **Settlement file ingestion** — parse real Visa Base II / MC IPM files
  instead of trusting the ledger balance. Phase 6 has the emit side.
- **Partial captures** (still open from Phase 10).
- **Cardholder identity surface** — unlocks the deferred cardholder
  webhooks across Phases 9-14.
