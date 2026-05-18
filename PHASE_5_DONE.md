# Phase 5 — Done

**Date:** 2026-05-18 · **Status:** Real ISO 8583 acquirer leg landed. Confirms now travel TCP → simulator → response.

The always-approve stub is gone. A PaymentIntent confirm now genuinely traverses an ISO 8583 wire.

---

## What was built

### `packages/iso8583` — codec from scratch
- **`spec.ts`** — field-type table (n / an / ans / z / b × FIXED / LLVAR / LLLVAR), 24 DEs needed for auth + reversal.
- **`bitmap.ts`** — primary + secondary bitmap encode/decode (16 hex / 32 hex), ASCII variant.
- **`fields.ts`** — per-DE encoder/decoder with length-prefix VAR handling, numeric validation, binary fields as hex pairs.
- **`message.ts`** — `encode(msg) → wire string` + `decode(input) → Iso8583Message`. Idempotent round-trip property tests via fast-check.
- **Tests** — 14 unit tests including round-trip on randomly-generated MTI 0100/0110/0200/0210/0400/0410.

ASCII variant per ADR-0016: numerics as digit chars, LL/LLL prefixes as ASCII digits, binary fields hex-encoded so the whole wire is ASCII (matches the brief's "4-byte ASCII length framing" intent).

### `apps/acquirer-host` — real client
- **`stan.ts`** — STAN allocator with per-day reset (recommend Q2). Wraps at 999999; recycles at UTC midnight. RRN builder `yDDDhhmmss<stan>`.
- **`client.ts`** — `createSchemeClient({ host, port })`: persistent TCP, auto-reconnect, sequential request/response with 15s timeout. Pending queue keyed by send order (simulator responds in order; STAN-keyed map deferred to Phase 6 if we need concurrency).
- **`authorize.ts`** — `POST /internal/v1/authorize`. Body: `{ payment_intent_id, merchant_id, token, amount_minor, currency_numeric }`. Detokenizes via vault (the ONLY raw-PAN handler in the system), builds 0100, awaits 0110, returns `{ approved, response_code, approval_code, rrn, stan }`. PAN never logged.

### `apps/scheme-simulator` — real issuer
- **`issuer.ts`** — `handleAuthRequest(rawWire) → rawWire`. Decodes 0100/0200, applies a BIN policy table:
  - `4000000000000999` → RC 51 (insufficient funds)
  - `4000000000000003` → RC 05 (do not honor)
  - `4000000000000006` → RC 54 (expired)
  - everything else → RC 00 (approved) with synthetic approval code
- TCP server now responds with framed 0110/0210 instead of no-op.

### `packages/payment-engine` extension
- New types: `Authorizer`, `AuthorizeRequest`, `AuthorizeResponse`.
- `runAuthorizeAndPost` accepts an optional `authorizer`. With one, calls it for a real decision and transitions to `failed` with `last_payment_error` on decline. Without one (unit tests), keeps the always-approve fallback.
- `ConfirmPaymentIntentInput` + `CompleteThreeDsInput` carry the authorizer through.

### `apps/api` integration
- `lib/authorizer.ts` — `buildAcquirerAuthorizer({ db, serviceAuth, acquirerHostUrl })`. Wraps the HTTP call to acquirer-host, looks up the token from `paycore.payment_methods`, signs with X-Service-Auth. Maps RC → Stripe-shape `decline_code` (`05` → do_not_honor, `51` → insufficient_funds, `54` → expired_card, etc.).
- `AppContext.authorizer` is constructed at boot; payment-intents.ts route + three-ds.ts callback both pass it through.

### Compose
- `api` gets `ACQUIRER_HOST_URL=http://acquirer-host:8082`.
- `acquirer-host` gets `SERVICE_AUTH_SECRET` + `VAULT_URL` for detokenize.
- `scheme-simulator` package gains `@psp-new/iso8583` workspace dep.

---

## What's deliberately deferred to Phase 6

- **Capture / cancel / refund via 8583** — Phase 5 only wires the auth leg (0100/0110). Capture today still posts the journal entry directly; same for refund (mirror entry). Phase 6 wires 0200/0420 reversal-advice messages.
- **`paycore.acquirer_messages` audit table** — Pino logs capture all wire traffic for Phase 5; the structured table lands in Phase 6.
- **0800 network management heartbeat** — would let the acquirer-host detect dead connections faster. Phase 6.
- **STAN-keyed correlation map** — sequential queue suffices when single-flight; Phase 6 swaps in a `Map<stan, callback>` for concurrent throughput.
- **Clearing files** — generators are a Phase 6 concern; Phase 6 builds the EOD job alongside settlement.

---

## Demo

```bash
make up && make migrate
pnpm merchant:create --name "Acme Inc."     # capture pk/sk

SK=sk_test_…
# Approve path
curl -s http://localhost:8080/v1/payment_methods -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"type":"card","card":{"number":"4111111111111111","exp_month":"12","exp_year":"2030"}}' | jq

curl -s http://localhost:8080/v1/payment_intents -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"amount":1000,"currency":"USD","payment_method":"pm_…","confirm":true}' | jq
# scheme-simulator logs: '0110 RC=00'  → PaymentIntent succeeded

# Decline path — insufficient funds
curl -s http://localhost:8080/v1/payment_methods -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"type":"card","card":{"number":"4000000000000999","exp_month":"12","exp_year":"2030"}}' | jq

curl -s http://localhost:8080/v1/payment_intents -H "Authorization: Bearer $SK" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"amount":1000,"currency":"USD","payment_method":"pm_…","confirm":true}' | jq
# Returns status:"failed", last_payment_error.decline_code:"insufficient_funds"
```

---

ADR-0016 (ASCII codec) + ADR-0017 (acquirer-host authorizer pattern) lands in `DECISIONS.md` in the consolidated Phase 6 pass. Phase 6 plan in `PHASE_6_PLAN.md`.
