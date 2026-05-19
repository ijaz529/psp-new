# Phase 25 — Done

**Date:** 2026-05-19 · **Status:** Card-load chargeback / refund landed. Plan: `PHASE_25_PLAN.md`.

Adds the unwind path for Phase 11 card loads. Phase 23's per-card
`cardholder_stored_value` LIABILITY made this clean — the refund
target is the same per-card account the load credited, no aggregate
unpicking required.

## What shipped

- **Migration `0028_card_loads_refunded_status.sql`** — extends the
  `paycore.card_loads.status` check constraint to include
  `'refunded'`. Drop + re-add the constraint.
- **Kysely type** — `'succeeded' | 'failed' | 'refunded'` on
  `card_loads.status`.
- **`apps/api/src/routes/v1/cards.ts`** — new route
  `POST /v1/card_loads/:id/refund`:
  - Joins `card_loads ⨝ payment_methods ⨝ cards`, filters on
    `payment_methods.merchant_id` so a caller can only refund their own
    loads (404 if not found).
  - Validates status is `succeeded` (422 `payment_intent_unexpected_state` otherwise).
  - Validates `cardholder_funded.balance ≥ load.amount`
    (422 `amount_too_large` if the cardholder has spent it).
  - Routes the credit leg via the same fallback shape as Phase 17:
    per-card `stored_value_account_id` if set (Phase 23 cards),
    PSP-level `external_load_clearing` otherwise (legacy cards).
  - Single txn posts:
    - `cardholder_funded                     −X`
    - `cardholder_stored_value | PSP clearing +X`
    - Plus `UPDATE card_loads SET status='refunded' WHERE status='succeeded'`
      (the WHERE clause guards against concurrent refunds).
  - Returns the refunded card_load resource.

Zero new accounts. Zero new helpers. No new error codes (reused
`amount_too_large` for the insufficient-balance case — message
explains the situation).

## Demo path

```bash
# Set up a load via Phase 11 (existing path)
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
# Tokenize external Visa, attach as pm_, POST /v1/cards/<card_…>/load

# Refund it
curl -X POST $API/v1/card_loads/<cl_…>/refund \
  -H "Authorization: Bearer sk_test_…"

# → 200 OK with status: 'refunded'
# cardholder_funded balance returns to pre-load value
# cardholder_stored_value (or PSP clearing) balance returns to pre-load value
# scheme-side cash is NOT reversed — that flows through the Phase 15/20/21/24
# adjustment chain out-of-band.

# Re-POST the same refund → 422 payment_intent_unexpected_state
# (status is already 'refunded')

# Try to refund a load whose cardholder already spent the balance:
# pnpm card:load --amount 50 → POST a $50 auth that captures → POST refund
# → 422 amount_too_large ("card has 0 available; refund needs 5000")
```

## Tests

| Suite | Coverage |
|---|---|
| Existing 60-package suite | Green. |
| `pnpm typecheck` | Green across all 60 packages. |

The api app's `test` script is `--passWithNoTests` (matches Phase 11
and 18). The refund logic is thin DB+journal posting — live verification
via the demo path is the primary acceptance gate.

## Simplifications vs. real life

These are documented in `PHASE_25_PLAN.md §Out of scope`:

- **No partial refunds.** All-or-nothing. A future phase can add an
  `amount` body field similar to PI refunds.
- **No scheme-side cash reversal.** Real chargebacks flip
  `scheme_receivable` and reverse cash. We rely on Phase 15/20/21/24
  to absorb that via adjustments out-of-band.
- **No dispute tracking.** No `paycore.card_disputes` table. Status
  flip + journal is the only record.
- **No webhook event.** `card_load.refunded` not emitted; consistent
  with the still-open cardholder webhook delivery.

## What this enables next

Open list:
- **Cardholder webhook delivery** — biggest remaining unblocked item.
- **Cardholder REST API** — `/v1/cardholder/...` endpoints.
- **Auto-top-up rules** — needs cardholder-scoped payment methods.
- **Real Base II / IPM parsing** — largest remaining item.
