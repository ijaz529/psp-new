# Phase 16 — Partial captures (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 15 (`PHASE_15_DONE.md`).

Stripe-parity feature: one authorization can be captured in multiple
installments. Real merchants need this for shipping different SKUs at
different times, hotel partial bookings, marketplace payouts, etc. The
foundation is already there — Phase 10 introduced the hold lifecycle; this
phase teaches the system that one hold can have N captures.

---

## End-to-end goal

```
Phase 10 today:                       Phase 16:
─────────────                         ─────────────
0100 auth   →  hold (amount=100)      0100 auth   →  hold (amount=100, captured=0)
0220 capture→  hold marked captured   0220 capture(30) → captured=30, OPEN
                                       0220 capture(40) → captured=70, OPEN
                                       0220 capture(30) → captured=100, MARKED CAPTURED

                                      OR:
                                       0220 capture(60) → captured=60, OPEN
                                       0420 reversal    → reverses 40 (the remaining),
                                                          marks REVERSED
```

PI semantics (Stripe-compatible):
- `amount_capturable` decrements per capture; `amount_received` increments.
- `status` stays `requires_capture` until `amount_capturable == 0`, then
  `succeeded`.
- `cancel` after partial capture reverses the remaining, leaves
  `amount_received` intact, status → `canceled`.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0021 migration** | Add `captured_amount BIGINT NOT NULL DEFAULT 0` to `paycore.card_auth_holds`; backfill existing `resolved_reason='captured'` rows | `packages/db/migrations/0021_card_auth_holds_captured_amount.sql` |
| **Kysely type** | New column | `packages/db/src/kysely.ts` |
| **issuer-host** | `handleCapture` looks up hold by RRN (drop stan match); validates capture amount ≤ remaining; posts journal for partial amount with per-capture stan suffix in `externalId`; marks `captured` only when `captured_amount == amount`. `handleAuth` for 0200 ALSO bumps `captured_amount = amount` (immediate settlement). `handleReversal` posts `remaining = amount - captured_amount` to funded. | `apps/issuer-host/src/handler.ts` |
| **acquirer-host** | `advice.ts`: generate fresh STAN per 0220/0420 via `deps.stan.next()`; keep `body.original_rrn` in DE 37 (ISO 8583: RRN persists across lifecycle, STAN is per-message). Return new stan in the response so the api can store per-capture. | `apps/acquirer-host/src/advice.ts` |
| **payment-engine** | `CapturePaymentIntentInput.amountToCapture?: bigint`. Validate ≤ `amount_capturable`; throw `amount_too_large` on over-capture. Settler receives the partial amount. Merchant capture journal posts the partial amount. PI fields updated; status → `succeeded` only if new `amount_capturable == 0`. | `packages/payment-engine/src/orchestrator.ts` |
| **api** | `POST /v1/payment_intents/:id/capture` body gains optional `amount_to_capture: number.int.positive`. | `apps/api/src/routes/v1/payment-intents.ts` |
| **Tests** | Extend `apps/issuer-host/src/handler.test.ts` with partial-capture cases | same |

---

## ISO 8583 correctness note

The original Phase 10 implementation echoed the original STAN in 0220's
DE 11. That worked for 1:1 capture but is wrong for partial captures
(every 0220 would have the same DE 11, breaking per-message uniqueness on
the issuer side). The correct ISO 8583 design:

| DE | Original 0100 | 0220 capture #N |
|---|---|---|
| 11 (STAN) | unique per acquirer/day | NEW unique per 0220 |
| 37 (RRN) | unique per transaction | echoed from original 0100 (persists across lifecycle) |

Issuer-side hold lookup keys on RRN. Per-capture journal externalId keys
on the new STAN. The unique constraint on `card_auth_holds(stan, rrn)`
still holds — only one hold row exists per (original stan, rrn).

---

## Schema delta (0021)

```sql
alter table paycore.card_auth_holds
  add column captured_amount bigint not null default 0
  check (captured_amount >= 0 and captured_amount <= amount);

update paycore.card_auth_holds
  set captured_amount = amount
  where resolved_reason = 'captured';
```

The CHECK constraint enforces 0 ≤ captured ≤ amount at the DB level. The
backfill brings existing `captured` rows up to date — `reversed` and
`expired` rows keep `captured_amount = 0` since nothing was captured.

---

## Error codes

Reuses existing `amount_too_large` (already in the codes taxonomy from
Phase 3 for capture). No new codes needed.

On the issuer-host side: an over-capture (DE 4 > remaining) returns RC 13
("invalid amount").

---

## State machine

`requires_capture` + `capture` action → `succeeded` stays as-is in the
state machine. For partial captures, the orchestrator decides:
- If new `amount_capturable == 0`: call `transitionPaymentIntent` → succeeded
- Else: skip the transition, write `status='requires_capture'` directly (no
  state change, just field updates).

No state machine change needed.

---

## Out of scope (deferred)

- **Partial reversal.** Cancel after partial capture reverses the FULL
  remaining. Refunding portions of already-captured amounts is the Phase 3
  refund flow — Stripe's model too.
- **DE 90 (Original Data Elements) population.** The codec declares DE 90
  but we don't populate it. RRN-only lookup is sufficient for our
  closed-loop demo. Real acquirer-issuer interop would set DE 90.
- **Time limits on subsequent captures.** Real schemes give merchants 7
  days from auth to capture. The Phase 13 auth-expiry sweeper enforces this
  at the hold level — if a partially-captured hold goes stale, the
  remaining auto-expires. No new code.
- **Multi-capture audit table** (`paycore.captures`). The journal entries
  for each capture already provide the audit trail. A future phase could
  materialize them into a proper resource if needed.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. Extended `apps/issuer-host/src/handler.test.ts` (HAS_DB-gated):
   - Two partial 0220s summing to original → first stays open with
     `captured_amount` partial; second marks the hold `captured`.
   - 0220 with amount > remaining → RC 13, no state change.
   - 0420 after a partial 0220 reverses ONLY the remaining; hold marked
     `reversed`; funded balance restored by the unreversed remainder.
3. End-to-end demo (when compose is up):
   - Manual-capture PI for $100 → confirm → status `requires_capture`,
     `amount_capturable=100`.
   - Capture $30 → status `requires_capture`, `amount_capturable=70`,
     `amount_received=30`.
   - Capture $70 → status `succeeded`, `amount_capturable=0`,
     `amount_received=100`.
   - Same flow with cancel after $30 capture → status `canceled`,
     `amount_received=30`, `amount_capturable=0`; issuer-side hold marked
     `reversed` with the unreversed $70 returning to funded.
4. Stripe-compat: omitting `amount_to_capture` captures the full
   `amount_capturable` (existing behavior preserved).
