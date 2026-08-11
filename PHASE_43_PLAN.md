# Phase 43 — Plan

**Goal:** pay merchants what the ledger says they are owed. Phase 42's
canary caught `runPayout` paying 5000 on a payment whose settlement
liability was 7275 — wrong twice over.

## The bug, in numbers

Canary run: PI 10000 USD captured, then 2500 refunded (MDR 300 bps).

| Event | scheme_receivable | settlement_liability | mdr_revenue |
|---|---|---|---|
| capture 10000 | +10000 | −9700 | −300 |
| refund 2500 | −2500 | +2425 | +75 |
| **balance** | | **−7275** | |

The merchant is owed **7275**. `runPayout` computed:

```
grossNet   = Σ payment_intents.amount_received  = 7500   ← already refund-decremented
refundsNet = Σ refunds.amount                   = 2500
net        = 7500 − 2500                        = 5000   ← paid
```

Two independent errors:
1. **Double-netting.** `createRefund` already decrements
   `amount_received` (orchestrator), so subtracting `refunds` again
   removes the refund twice.
2. **MDR ignored.** The computation works in gross transaction
   amounts, but the liability is booked MDR-net. Even without the
   refund bug it would pay 7500 against a 7275 liability.

Net effect: the settlement liability is never drained, and the amount
paid is arbitrary with respect to the books. The function's own
docstring already says what it should do — "Post journal entry that
zeroes the settlement_liability" — and the inline comment says the
computation should read the ledger instead. Phase 43 does that.

## Design

`net = −(settlement_liability balance)` — the exact-negation pattern
Phase 24's clearing sweep uses. The existing posting
(`settlementLiability +net`, `psp_cash_at_bank −net`) then drains the
liability to exactly zero, which is what the docstring promises.

Read the balance by **summing `ledger.journal_lines`** for the
account, NOT `ledger.account_balances`. The latter is a materialized
view refreshed on a 5-minute timer; paying out a stale balance is a
correctness hazard in a money-moving path (and the same staleness
already bit the worker's live-DB tests). Deliberate divergence from
Phase 24 — noted in the DONE.

Consequences, both wanted:
- Payouts become **self-healing**: residue from earlier days (late
  captures, a previously skipped payout) drains on the next run for
  that merchant/currency.
- MDR is inherently respected — it was never in the liability.

Unchanged: the `net <= 0` skip (a merchant whose refunds exceed
captures has a positive liability balance → negative net → skip, as
today), the once-per-day `externalId`, the payout row, the
`payout.paid` event.

## Scope

| File | Change |
|---|---|
| `packages/payouts/src/index.ts` | net from ledger balance; drop the two window queries + stale comment |
| `packages/payouts/src/index.test.ts` | new, DB-gated |

## Out of scope

- `listPayoutCandidates` still windows on PI `created_at`, so a
  merchant with residual liability but no activity that day isn't
  picked up. Pre-existing; the self-healing above only helps
  merchants who transact again. Noted, not fixed.
- Reserves / negative-balance handling (Phase 7 territory, per the
  existing comment).
- Payout scheduling (`payout_schedule` column is still ignored).

## Verify steps

| Check | Expected |
|---|---|
| New test red-first | asserts 7275; fails at 5000 before the fix |
| `DATABASE_URL=… pnpm --filter @psp-new/payouts exec vitest --run` | green |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| `pnpm canary` (stack up) | still 11/11, payout now equals the liability |
