# Phase 10 — Done

**Date:** 2026-05-19 · **Status:** Hold lifecycle landed. Plan: `PHASE_10_PLAN.md`.

The "approve = settle" simplification from Phase 9 is gone. Authorizations now
hold funds; capture (0220) and reversal (0420) flow as separate ISO 8583
messages that resolve the hold against the cardholder ledger.

## What shipped

- **Migration `0018_pi_auth_refs.sql`** — two nullable columns on
  `paycore.payment_intents`: `last_auth_rrn char(12)`, `last_auth_stan char(6)`.
  Set by the orchestrator from the AuthorizeResponse and read by capture +
  cancel to correlate 0220/0420 with the original hold via the existing
  `paycore.card_auth_holds (stan, rrn)` unique constraint. No changes to
  `card_auth_holds` itself — the existing `resolved_reason ∈
  {captured,reversed,expired}` enum already covered all three lifecycle states.
- **`apps/issuer-host`** — `handleIssuerAuth` replaced by `routeIssuerMessage`,
  a four-way MTI dispatcher:
  - `0100` → write hold (`funded -X`, `holds +X`). `resolved_at = NULL`.
  - `0200` → same hold leg PLUS settlement leg (`holds -X`, `settlement +X`) in
    a single transaction. Hold row is created with `resolved_reason='captured'`.
  - `0220` → look up the hold by `(stan, rrn)`, post settlement leg, mark
    `captured`. Idempotent: a duplicate against an already-resolved row returns
    RC 94. Unknown `(stan,rrn)` → RC 25.
  - `0420` → look up the hold, return funds to funded (`holds -X`,
    `funded +X`), mark `reversed`. Same idempotency + lookup semantics.
  `readAvailableBalance` simplified to just `funded.balance` (funds are moved
  out of `funded` at hold time, so funded is the right "available" figure).
- **`@psp-new/iso8583`** — no spec change needed; the MTI union already
  declared `0220 / 0221 / 0420 / 0421 / 0230 / 0430`.
- **`apps/scheme-simulator`** — `handleAuthRequest` widened to accept
  `0220 / 0420`. Strawberry BIN range → forward to issuer-host. External BIN
  → stub auto-acks `0230 / 0430` with RC 00 (no tracked state on this side).
- **`apps/acquirer-host`** — `authorize.ts` now picks MTI by `capture_method`:
  `manual → 0100`, `automatic → 0200` (default preserves Phase 5–9 behaviour).
  New `advice.ts` registers `POST /internal/v1/capture` (sends 0220) and
  `POST /internal/v1/reverse` (sends 0420). Both reuse the original
  `(rrn, stan)` from the api so the issuer-host can correlate.
- **`@psp-new/payment-engine`** — `AuthorizeRequest` gained `captureMethod`.
  `AuthorizeResponse` gained optional `rrn` + `stan` (persisted to the PI in
  the same txn that writes the auth result). New `Settler` and `Reverser`
  port types, modelled on the existing `Authorizer`. `capturePaymentIntent`
  calls `settler(...)` before opening the journal txn; `cancelPaymentIntent`
  calls `reverser(...)` when the PI is in `requires_capture`. Both throw a
  new `acquirer_declined` error on non-`00` RC.
- **`apps/api`** — `buildAcquirerSettler` + `buildAcquirerReverser` factories
  in `lib/authorizer.ts`, wired through `lib/context.ts`, plumbed into the
  capture + cancel routes. No public API surface change — same endpoints,
  same request shape.
- **`apps/api/cli/card-issue.ts`** — `cardholder_holds` per-card account now
  created as `ASSET` (was `LIABILITY`). Semantically matches "funds the
  cardholder owns, currently encumbered".

## End-to-end demo path

```bash
make up && make migrate

# Phase 9 setup
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
pnpm card:load --card <card_…> --amount 100.00

# Manual-capture PI — separate 0100 auth + 0220 capture
curl -X POST $API/v1/payment_intents -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":3000,"currency":"USD","capture_method":"manual",
       "payment_method":"pm_<card>","confirm":true}'
# status: requires_capture; PI carries last_auth_rrn/last_auth_stan now.
# pnpm ledger:balance <funded>  →  70.00   (was 100; -30 moved into holds)
# pnpm ledger:balance <holds>   →  30.00
# pnpm ledger:balance <issuer_settlement:USD>  → 0

curl -X POST $API/v1/payment_intents/<pi_…>/capture
# status: succeeded.
# pnpm ledger:balance <holds>   →   0.00   (resolved)
# pnpm ledger:balance <settle>  →  30.00

# Reversal path — auth then cancel before capture
curl -X POST $API/v1/payment_intents -d '{... "capture_method":"manual" ...}'
curl -X POST $API/v1/payment_intents/<pi_…>/cancel
# status: canceled; holds released; funded restored to pre-auth value.
```

## Tests

| Suite | Coverage |
|---|---|
| `apps/issuer-host/src/handler.test.ts` (NEW) | 7 HAS_DB-gated integration tests: 0100 funded→holds; 0200 both legs in one txn; 0220 captures + settles; 0420 reverses + returns; duplicate 0220 → RC 94; unknown stan/rrn for 0220 and 0420 → RC 25 |
| `apps/acquirer-host/src/advice.test.ts` (NEW) | 2 tests with a fake SchemeClient: POST /capture builds 0220 with echoed DE 11/37, POST /reverse builds 0420 with echoed DE 11/37 |
| `apps/scheme-simulator/src/issuer.test.ts` (extended) | +2: stub auto-acks external 0220 → 0230 RC 00; external 0420 → 0430 RC 00 |
| Existing 23 payment-engine + 17 vault + 10 http-server + … | All still pass — additions are backwards-compatible (optional `settler`/`reverser`, optional `rrn`/`stan`) |

`pnpm typecheck` + `pnpm test` both green across all 60 packages/apps. The 7
issuer-host integration tests are `describe.skipIf(!HAS_DB)` and execute when
the compose stack is up.

## Simplifications vs. real life

These are documented in `PHASE_10_PLAN.md §Out of scope` and worth restating:

- **DE 90 (Original Data Elements)** — real 0220/0420 nest the original DE
  11/37/4 inside DE 90 so the new advice has its own STAN. We pass the
  original STAN/RRN directly in the top-level DE 11/37 because the issuer-host
  looks up the hold by exactly those fields and we don't need DE 90 for
  routing.
- **Partial capture / partial reversal** — capture is full-amount only.
  Multi-capture against one auth is not yet supported on either side.
- **Auth expiry sweep** — `resolved_reason='expired'` is in the enum but no
  cron writes it yet. A future worker walks
  `card_auth_holds where created_at < now() - interval '7 days' and resolved_at is null`.
- **0421 reversal-advice retry semantics** — issuer-host treats each reversal
  as authoritative; real schemes have store-and-forward retry on 0421.
- **External-card capture realism** — the stub-issuer auto-acks 0230/0430
  for non-Strawberry PANs with RC 00. No decline-on-capture paths.
- **`payment_intent.cancel_failed` event** — proposed in the plan but not
  emitted; on `acquirer_declined` the api throws and the PI stays in
  `requires_capture`, which is the right observable behaviour. A dedicated
  failure event can be added if/when the portal needs it.
- **DetokenizeReason** gained a `'reversal'` value (vault-client + vault both
  updated). Existing reasons unchanged.

## What this enables next

- Portal `/cards` page (the other Phase 9 deferral): with holds carrying real
  lifecycle state, the page can show "Available $X · Pending $Y" using
  `funded` and the live `card_auth_holds` rows.
- Partial captures: capture endpoint accepts an `amount_to_capture` <
  `amount_capturable`; the orchestrator can split a single 0100 across multiple
  0220 messages, each with a distinct STAN — `card_auth_holds` already supports
  multiple resolutions per (card, original-RRN) by virtue of the per-advice
  STAN being unique.
- Auth expiry sweeper: small worker on the existing `worker` app that scans
  the partial index `card_auth_holds_open_idx` for stale rows and posts
  `holds → funded` reversal journals locally.
- Real card-load via the acquiring side (cardholder pays $X with a Visa, that
  funds a Strawberry card). With both lifecycles in place the closed-loop
  funding story is the next natural piece.
