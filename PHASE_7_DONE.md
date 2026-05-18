# Phase 7 — Done

**Date:** 2026-05-18 · **Status:** Risk rules + disputes lifecycle + webhook dead-letter replay landed.

---

## What was built

- **Migration 0015** — `paycore.risk_decisions`, `paycore.disputes`, `paycore.dispute_events`, plus a `paycore.velocity_for_token(...)` SQL function for the rules engine. Grants to `psp_app`.
- **`packages/risk-rules`** — small declarative JSON DSL with exhaustive condition types: `amount_gt` / `amount_lt` / `bin_in` / `cvv_result_in` / `velocity` (per-token window). `evaluate(db, ruleSet, input)` returns `{ outcome, score, triggered, evidence }`. `recordDecision()` persists. Ships a `DEFAULT_RULES` set (amount cap, velocity 5/min, CVV-fail deny, blocked-BIN deny).
- **`packages/disputes`** — `openDispute()` + `transitionDispute()` orchestrators driving the Visa-first state machine (`retrieval_request` → `first_chargeback` → `representment` → `pre_arbitration` → `arbitration` → `won|lost|expired`). `VISA_REASON_CODES` map seeded with 10.4 fraud and 13.x service codes. Emits `dispute.opened/won/lost/expired` events into the outbox.
- **`apps/api`** new routes:
  - `POST /v1/disputes` (open) — auto-detects scheme from the original PaymentIntent's payment_method, validates Visa reason codes.
  - `GET /v1/disputes/:id`
  - `POST /v1/disputes/:id/transition` — guarded by the dispute state machine.
  - `GET /v1/webhook_dead_letter` — list permanently-failed deliveries for the merchant.
  - `POST /v1/webhook_dead_letter/:id/replay` — marks `retried_at`, re-enqueues the delivery job in BullMQ.

## Tests

- `packages/risk-rules/src/index.test.ts` — 7 tests over the condition matrix + `DEFAULT_RULES` end-to-end (velocity-free subset, since velocity needs the DB).
- `packages/disputes/src/index.test.ts` — `VISA_REASON_CODES` includes 10.4 + 13.x and rejects MC codes.

## What's deliberately deferred

- **Risk engine wired into `confirmPaymentIntent`** — the orchestrator doesn't call `evaluate()` yet; that wiring lands in a Phase 7.1 pass alongside the gateway's amount/CVV plumbing.
- **Mastercard reason codes** — map exists in spec but only Visa codes are seeded. Mastercard codes (4837, 4849, 4853) land when we test with MC cards.
- **AVS results** — the simulator doesn't generate AVS yet; rule supports `cvv_result_in` but not AVS. Phase 8+.
- **Reserve holdback math** — `merchants.reserve_basis_points` column exists; the payouts orchestrator doesn't subtract it yet.
- **8583 reversal advice on dispute** — opening a dispute should send a 0420 to the scheme; deferred.

## Demo

```bash
# Create a merchant + run a successful PaymentIntent first, then:
SK=sk_test_…
PI=pi_…

curl -s http://localhost:8080/v1/disputes \
  -H "Authorization: Bearer $SK" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d "{\"payment_intent\":\"$PI\",\"reason_code\":\"visa_10.4\"}" | jq

# List dead-letter (will be empty unless a webhook endpoint is unreachable)
curl -s http://localhost:8080/v1/webhook_dead_letter -H "Authorization: Bearer $SK" | jq
```

Phase 8 plan: portal Next.js conversion + merchant dashboard.
