# Phase 16 — Done

**Date:** 2026-05-19 · **Status:** Partial captures landed. Plan: `PHASE_16_PLAN.md`.

One authorization can now be captured in multiple installments — Stripe-parity
feature for shipping different SKUs over time, hotel partial bookings,
marketplace splits, etc. Cancel after a partial capture reverses only the
uncaptured remainder.

## What shipped

- **Migration `0021_card_auth_holds_captured_amount.sql`** — adds
  `captured_amount BIGINT NOT NULL DEFAULT 0` to `paycore.card_auth_holds`
  with a `CHECK (captured_amount >= 0 AND captured_amount <= amount)`
  constraint. Backfill: existing `resolved_reason='captured'` rows get
  `captured_amount = amount`. `reversed`/`expired` rows stay at 0 (nothing
  was captured).
- **`apps/issuer-host/src/handler.ts`** —
  - `handleCapture` reads DE 4 (capture amount) per ISO 8583, validates
    `0 < amount ≤ remaining` (RC 13 on over-capture), and increments
    `captured_amount`. Only marks `resolved_reason='captured'` when the
    running total reaches `amount`. Per-capture journal externalId uses the
    advice's STAN as a unique suffix (`issuer_capture:${hold.id}:${stan}`).
  - `handleReversal` posts the **uncaptured remainder** (`amount −
    captured_amount`) to funded — partial captures' settled portion stays
    settled.
  - `handleAuth` (0200 path) bumps `captured_amount = amount` immediately
    too (combined auth+settle).
  - Hold lookup switched from `(stan, rrn)` to RRN-only — each advice has
    its own STAN, but DE 37 RRN persists across the transaction lifecycle
    (correct ISO 8583 semantics). The unique constraint
    `card_auth_holds(stan, rrn)` is unchanged because only one hold row
    exists per (original stan, rrn) pair.
- **`apps/acquirer-host/src/advice.ts`** — each 0220/0420 carries a fresh
  STAN via `deps.stan.next()` in DE 11; DE 37 RRN echoes the original
  auth's RRN. Response returns the new STAN so callers can persist a
  per-message audit trail.
- **`packages/payment-engine/src/orchestrator.ts` — `capturePaymentIntent`**
  gains optional `amountToCapture: bigint`. Validates
  `0 < amount ≤ amount_capturable` (throws `parameter_invalid` /
  `amount_too_large` on violation; both codes pre-existed). Settler
  receives the partial amount; merchant capture journal posts the partial
  amount; PI's `amount_received` and `amount_capturable` update; state
  transitions to `succeeded` only when `amount_capturable` hits 0. The
  state machine wasn't extended — the orchestrator just skips the
  transition when the capture is non-final.
- **`packages/payment-engine/src/orchestrator.ts` — `cancelPaymentIntent`**
  passes `amount_capturable` (not the original `amount`) to the reverser
  so post-partial-capture cancellations only reverse the leftover.
- **`apps/api/src/routes/v1/payment-intents.ts`** — capture route body
  accepts optional `amount_to_capture` (Stripe-compat). Omit → captures
  full remaining; specify → that amount.

Zero new accounts. Zero new error codes — `amount_too_large` and
`parameter_invalid` already existed.

## Demo path

```bash
make up && make migrate

# Manual-capture PI for $100
curl -X POST $API/v1/payment_intents \
  -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":10000,"currency":"USD","capture_method":"manual",
       "payment_method":"pm_<external>","confirm":true}'
# → status: requires_capture, amount_capturable: 10000, amount_received: 0

# First partial: $30
curl -X POST $API/v1/payment_intents/<pi_…>/capture \
  -d '{"amount_to_capture": 3000}'
# → status: requires_capture, amount_capturable: 7000, amount_received: 3000

# Second partial: $40
curl -X POST $API/v1/payment_intents/<pi_…>/capture \
  -d '{"amount_to_capture": 4000}'
# → status: requires_capture, amount_capturable: 3000, amount_received: 7000

# Final partial: $30
curl -X POST $API/v1/payment_intents/<pi_…>/capture \
  -d '{"amount_to_capture": 3000}'
# → status: succeeded, amount_capturable: 0, amount_received: 10000

# OR cancel after one partial — reverses the remaining $70
curl -X POST $API/v1/payment_intents/<pi_…>/cancel
# → status: canceled, amount_capturable: 0, amount_received: 3000
#   Issuer hold marked 'reversed'; uncaptured $70 returned to funded.
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/issuer-host/src/handler.test.ts` (extended) | Existing 7 tests updated for the new RRN-only lookup + DE 4 capture amount. Plus 3 new partial-capture tests: (a) three partials summing to original → first two stay open with running `captured_amount`, third marks captured; (b) over-capture → RC 13, no journal posted; (c) 0420 after partial reverses only the uncaptured remainder. |
| `apps/acquirer-host/src/advice.test.ts` (updated) | Assertions now verify DE 11 carries a fresh per-message STAN and DE 37 echoes the original RRN. |
| `apps/worker/src/auth-expiry-job.test.ts` (updated) | Existing seed now passes explicit `captured_amount: 0n` for the new column. |
| Existing 60-package suite | Green. |

`pnpm typecheck` + `pnpm test` both green across all 60 packages.

## ISO 8583 correctness note

This phase quietly fixes a Phase 10 bug: the original 0220 implementation
echoed the original STAN in DE 11, which would have broken on partial
captures (each 0220 would have shared DE 11, violating per-message
uniqueness on the issuer side). The corrected design:

| DE | Original 0100 | 0220 capture #N |
|---|---|---|
| 11 (STAN) | unique per acquirer/day | NEW unique per 0220 |
| 37 (RRN) | unique per transaction | echoed from original 0100 |

This matches real ISO 8583 spec — STAN is per-message, RRN persists across
the transaction lifecycle.

## Simplifications vs. real life

These are documented in `PHASE_16_PLAN.md §Out of scope`:

- **No partial reversal.** Cancel reverses the full remaining. Refunding
  portions of captured amounts is the Phase 3 refund flow (matches Stripe's
  model).
- **No DE 90 (Original Data Elements) population.** The codec declares it
  but we don't populate it. RRN-only lookup is sufficient for our
  closed-loop demo. Real acquirer-issuer interop would set DE 90.
- **No multi-capture audit table.** Each capture's journal entry already
  provides the audit trail (`capture:${pi_id}:${amount_received_pre}`).
  A future phase could materialize them into a proper resource if needed.

## What this enables next

- **Phase 11 acquiring-side deferral closeout** — would heal the Phase 14
  cash drift via the Phase 15 sweeper. Requires re-labeling
  `cardholder_funded` from ASSET → LIABILITY.
- **Cardholder identity surface** — unlocks the deferred cardholder
  webhooks across Phases 9-16.
- **Freeze toggle / controls editor on `/cards/:id`** — write surface on
  the portal.
- **Settlement file ingestion** — parse real Visa Base II / MC IPM files
  instead of trusting the ledger balance.
- **Auto-top-up rules** ("load $50 whenever balance < $10") — straightforward
  cron over the Phase 11 `loadCard` orchestrator.
