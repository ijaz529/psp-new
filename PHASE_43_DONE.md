# Phase 43 — Done

**Date:** 2026-08-11 · **Status:** payouts equal the settlement
liability. Plan: `PHASE_43_PLAN.md`.

Phase 42's canary caught `runPayout` paying **5000** on a payment
whose settlement liability was **7275**. Two independent errors:
refunds were subtracted twice (`createRefund` already decrements
`amount_received`, then the payout subtracted `refunds` again), and
the computation worked in gross amounts while the liability is booked
MDR-net.

## What shipped

### `packages/payouts/src/index.ts`

`net = −(merchant_settlement_liability balance)` — the exact-negation
pattern Phase 24's clearing sweep uses. The two window queries over
`payment_intents` / `refunds` are gone, along with the comment that
had been describing this fix as future work since Phase 6.

The balance is summed from **`ledger.journal_lines`**, not the
`ledger.account_balances` materialized view: the view refreshes on a
5-minute timer and paying out a stale balance moves the wrong amount
of money. Deliberate divergence from the Phase 24 sweep, which can
afford to be a refresh behind.

Two consequences, both wanted:
- The payout now drains the liability to exactly zero — what the
  function's docstring promised all along.
- Payouts are **self-healing**: residue from earlier days (late
  captures, a skipped payout) drains on the merchant's next run.

### `packages/payouts/src/index.test.ts` (new, DB-gated)

First test the payouts package has ever had. Reproduces the canary
scenario from ledger postings (spelled out, so the expected liability
is explicit rather than inherited from `MDR_BASIS_POINTS`): capture
10000, refund 2500 → liability −7275 → payout 7275 → liability 0.
Second test: refund with no capture → positive liability → `skipped`.

### `apps/api/cli/e2e-canary.ts`

The payout step now asserts the exact figure (7275) rather than
merely "> 0", so this can't regress silently.

## Verify

| Check | Result |
|---|---|
| New test before fix | red — `expected 'skipped' to be 'paid'` (the old code read resource tables, not the ledger) |
| `DATABASE_URL=… pnpm --filter @psp-new/payouts exec vitest --run` | 2/2 green |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| `pnpm canary` (live stack) | 11/11 — **payout 7275 = settlement liability** (was 5000) |

## What did NOT change

- The `net <= 0` skip: a merchant whose refunds exceed captures has a
  positive liability balance → negative net → skipped, as before.
- Once-per-day `externalId`, the payout row, the `payout.paid` event.
- `capturePostings` / `refundPostings` — the postings were always
  right; only the payout's reading of them was wrong.

## Still open (unchanged by this phase)

- `listPayoutCandidates` windows on payment-intent `created_at`, so a
  merchant with residual liability but no activity that day isn't
  picked up. The self-healing above only helps merchants who transact
  again.
- Reserves / negative-balance handling (Phase 7 territory).
- `merchants.payout_schedule` is still ignored — everything pays
  daily.

## Open list

- Phase 39 portal click-through (host port 3000 was taken by an
  unrelated process during Phase 42).
- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- README refresh — still says "Phase 0", quickstart omits `make
  migrate`.
