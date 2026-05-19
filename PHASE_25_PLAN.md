# Phase 25 — Card-load chargeback / refund (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 24 (`PHASE_24_DONE.md`).

Adds the unwind path for Phase 11 card loads. After Phase 23 gave each
card its own `cardholder_stored_value` LIABILITY, the refund target is
unambiguous: drain the cardholder's `funded` and put the matching
credit back on `stored_value` (or PSP-level clearing for legacy cards).

---

## Scope

- New endpoint: `POST /v1/card_loads/:id/refund`
- Validates: load exists for the calling merchant, status is
  `succeeded`, cardholder's `funded` balance ≥ load amount (no
  partial-refund support for MVP)
- Writes one reverse journal:
  - `cardholder_funded                       −X`
  - `cardholder_stored_value | PSP clearing  +X`  (per-card if set, else PSP-level)
- Flips `card_loads.status` to `'refunded'` (new enum value)
- 422 if any validation fails

Scheme-side cash movement is **not** reversed here — chargeback cash
flow is settled out-of-band via the existing scheme settlement /
adjustment chain (Phases 15/20/21/24). The refund only touches the
cardholder-facing books and the per-card stored value.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0028 migration** | Extend `paycore.card_loads.status` check constraint to include `'refunded'` | `packages/db/migrations/0028_card_loads_refunded_status.sql` |
| **Kysely type** | Add `'refunded'` to the status union | `packages/db/src/kysely.ts` |
| **API route** | `POST /v1/card_loads/:id/refund` | `apps/api/src/routes/v1/cards.ts` (extend) |

Zero new accounts. Zero new helpers. The refund routes through the
existing per-card `stored_value_account_id` (Phase 23) when set, else
falls back to the PSP-level `external_load_clearing`.

---

## API

```
POST /v1/card_loads/:id/refund
Authorization: Bearer sk_test_…

→ 200 OK
{
  "id": "cl_…",
  "object": "card_load",
  "card": "card_…",
  "amount": 5000,
  "currency": "USD",
  "status": "refunded",
  ...
}
```

Errors:
- `404 resource_missing` — load not found for the caller's merchant
- `422 payment_intent_unexpected_state` — load isn't in `succeeded`
  status (reusing existing error code; semantically applies)
- `402 insufficient_funds` — cardholder spent the loaded balance
  already and can't return it (reusing the standard card decline code)

---

## Out of scope (deferred)

- **Partial refunds.** All-or-nothing. A future phase could add an
  `amount` body field similar to the existing PI refund flow.
- **Scheme-side reversal.** A real chargeback flips
  `scheme_receivable` and reverses cash. We rely on the existing
  Phase 15/20/21/24 chain to absorb that via adjustments.
- **Chargeback dispute tracking.** No `paycore.card_disputes` table.
  The status flip + journal is the only record.
- **Cardholder webhooks.** `card_load.refunded` event not emitted
  (consistent with the still-open cardholder webhook delivery work).

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. End-to-end (manual, when compose is up): create load via Phase 11
   endpoint → confirm balances → POST refund → cardholder_funded back
   to zero, stored_value back to zero, status='refunded'.
3. Re-POST refund on the same already-refunded load returns 422.
