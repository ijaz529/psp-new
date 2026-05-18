# Phase 4 — Done

**Date:** 2026-05-18 · **Status:** Hosted-fields iframe + 3DS2 simulation + browser demo landed; Phase 5 plan attached.

A customer can now type a card on a merchant page and pay end-to-end, with
3DS where the BIN policy says so.

---

## What was built

### Schema (`packages/db/migrations/0013`)
- `paycore.three_ds_sessions` — one row per 3DS challenge attempt with the
  carry-through fields (ECI, CAVV, transStatus) that Phase 5 forwards into
  DE 48.43 of the 8583 message.
- `paycore.payment_intents` gains `next_action jsonb` (3DS redirect URL
  surfaced to merchants) and `request_three_d_secure` (`automatic | any | never`).
- `paycore.merchants` gains `allowed_origins text[]` (Phase 8 uses it for CSP
  `frame-ancestors`; Phase 4 ships the column + writes it from CLI/portal).

### `@psp-new/payment-engine` extension
- **`decideThreeDs(bin, scheme, request)`** — pure policy function. Decision
  matrix in `three-ds.ts`:
  - `request=never` → `none`
  - `request=any` → `challenge`
  - `request=automatic` + BIN `400000` → `challenge`
  - `request=automatic` + BIN `555555` → `frictionless`
  - everything else → `none`
- **`makeThreeDsResult({ scheme, outcome })`** — pure: returns Visa/Mastercard
  ECI codes + transStatus + synthetic CAVV.
- **State machine**: added `enter_three_ds_challenge` action that transitions
  `requires_confirmation → requires_action`.
- **`confirmPaymentIntent`**: now branches three ways — frictionless +
  no-3DS take the existing capture path; challenge writes a `three_ds_sessions`
  row + sets `next_action.redirect_url` + transitions PI to `requires_action`.
- **`completeThreeDs(db, { sessionId, outcome })`** — new orchestrator. The
  api hits this from `/v1/_internal/three_ds/callback` after the simulator
  reports the customer's decision. Idempotent (callback retries are safe).

### `apps/scheme-simulator` 3DS surface
- `GET /3ds/challenge/:sessionId` — server-rendered HTML challenge page
  (synthetic OTP shown, Approve / Decline / Attempted buttons).
- `POST /3ds/complete/:sessionId` — POSTs `{ session_id, outcome }` to api's
  `/v1/_internal/three_ds/callback` as a fire-and-forget call, then renders a
  result page to the customer.

### `apps/api` new routes
| Route | Auth | Behaviour |
|---|---|---|
| `POST /v1/tokens` | `pk_*` only | Tokenize via vault. Open CORS for Phase 4. |
| `POST /v1/_internal/three_ds/callback` | none (internal network) | Drives `completeThreeDs()` |

- `confirmPaymentIntent` now passes `bin` + `threeDsRedirectBuilder` so the
  orchestrator can build the simulator URL the customer reaches.
- `AppContext` gains `schemeSimulatorPublicUrl` (env `SCHEME_SIMULATOR_PUBLIC_URL`).
- `@fastify/cors` registered globally with permissive defaults.

### `apps/checkout` (Phase 0 stub → real)
| Path | Purpose |
|---|---|
| `GET /v1/hosted-fields.js` | Merchant-side bundle: `Wirecore.fields({...}).tokenize() → token` |
| `GET /iframe` | Card-input HTML rendered inside the iframe. CSP `frame-ancestors *`. |
| `GET /demo.html` | End-to-end merchant demo page |
| `GET /` | Redirects to `/demo.html` |

The iframe POSTs cross-origin to api's `/v1/tokens` (sk never leaves the
server; the iframe only knows the publishable key). On success it
`postMessage`s back to the parent. Strict origin checks on both sides.

### CLI + Portal updates
- `pnpm merchant:create --allowed-origins "<csv>"` (default: localhost:3000, :7001, :8080).
- Portal `/sign-up` writes the same defaults — Phase 8 portal will expose the field.

### Compose changes
- `checkout` service added at `:7001`.
- `api` gets `SCHEME_SIMULATOR_PUBLIC_URL=http://localhost:9002`.
- `scheme-simulator` gets `API_BASE_URL=http://api:8080`.
- Prometheus scrape config updated.

### Tests
| File | Type | Coverage |
|---|---|---|
| `packages/payment-engine/src/three-ds.test.ts` | unit | decideThreeDs (all 4 modes) + makeThreeDsResult (Visa/MC ECI/transStatus/CAVV) |
| `packages/payment-engine/src/state-machine.test.ts` (updated) | unit | New `enter_three_ds_challenge` transition |
| `tests/browser/hosted-fields.spec.ts` | Playwright | Loads `/demo.html`, fills iframe, asserts token + PI succeeded |

### Docs
- ADR-0015 (3DS contract: simulated wire, real carry-through fields) — `DECISIONS.md`.
- `PHASE_4_DONE.md` (this file).
- `PHASE_5_PLAN.md` (ISO 8583 codec + acquirer-host + scheme-simulator messaging).

---

## What's deliberately deferred

- **AReq/ARes/CReq/CRes JSON wire format** — Phase 4 ships the carry-through
  fields only. Real JSON envelopes layer on without changing the contract.
- **Per-merchant origin whitelist on `/v1/tokens`** — Phase 7 risk wires this
  off `merchant.allowed_origins` (column is in 0013).
- **Iframe theming** — locked default. Phase 8 adds `Wirecore.fields({ style: {...} })`.
- **3DS device fingerprinting** — the brief mentions IP/accept/screen/timezone
  collection. Phase 5 carries it through; Phase 7 risk uses it.
- **AReq method headers** (browserAcceptHeaders, etc.) — not collected today.
  The iframe is wired so we can add them without breaking the surface.

---

## Discovered during the build

1. **Path-A vs Path-B branching in the confirm orchestrator** was cleaner than
   adding a 3DS sub-state. The state machine stays pure; only the orchestrator
   chooses which transitions to apply.
2. **`runAuthorizeAndPost()` helper** factored out of confirm + completeThreeDs.
   Both paths share "stub acquirer → post capture entry → mark succeeded".
3. **Fire-and-forget callback from simulator** keeps the customer-facing page
   responsive even if the api is briefly slow. The PI status will be updated
   asynchronously; the merchant polls or receives a webhook.
4. **postMessage origin checks** on both sides of the iframe boundary. Easy to
   get wrong; we set explicit `targetOrigin` everywhere and reject mismatched
   `e.origin` on receive.
5. **CSP `frame-ancestors *`** is correct for Phase 4. Phase 8 reads
   `merchant.allowed_origins` and constructs a per-iframe-load CSP. Both
   approaches are in the spec.

---

## Demo

After `make up && make migrate`:

```bash
# 1. Create a merchant (CLI or visit http://localhost:3000)
pnpm merchant:create --name "Acme Inc."
# Copy pk_test_... and sk_test_... from the output.

# 2. Open the demo merchant page
open http://localhost:7001/demo.html
# Or: http://localhost:7001/

# 3. Paste pk + sk, click "Mount hosted-fields iframe".
# 4. Type a card:
#      4111 1111 1111 1111  → no 3DS, instant succeeded
#      4000 0000 0000 0010  → 3DS challenge (BIN 400000)
#      5555 5555 5555 4444  → frictionless 3DS (BIN 555555)
# 5. Click Pay.
# 6. If a 3DS challenge popped up, click Approve in the new tab.
# 7. The result panel renders the PaymentIntent JSON.
```

Programmatic:

```bash
PK=pk_test_... ; SK=sk_test_...

# Tokenize via the iframe origin (pk-only):
curl -s http://localhost:8080/v1/tokens \
  -H "Authorization: Bearer $PK" -H "Content-Type: application/json" \
  -d '{"card":{"number":"4000000000000010","exp_month":"12","exp_year":"2030"}}' | jq

# Server-side: create + confirm a PaymentIntent → triggers 3DS:
curl -s http://localhost:8080/v1/payment_intents \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -H "Idempotency-Key: idem_$(uuidgen)" \
  -d '{"amount":1000,"currency":"USD","payment_method":"pm_...","confirm":true}' | jq
# Returns status: "requires_action" + next_action.redirect_url
```

---

## Phase 4 deliverables checklist

| # | Goal | Status |
|---|---|---|
| A | Migration 0013 (three_ds_sessions, next_action, request_three_d_secure, allowed_origins) | ✅ |
| B | 3DS policy + state-machine + completeThreeDs orchestrator | ✅ |
| C | Scheme-simulator: /3ds/challenge UI + /3ds/complete callback | ✅ |
| D | apps/api: /v1/tokens (pk-only) + /v1/_internal/three_ds/callback | ✅ |
| E | apps/checkout: /v1/hosted-fields.js + /iframe + /demo.html | ✅ |
| F | CLI + portal write merchant.allowed_origins | ✅ |
| G | Playwright config + spec for the iframe → token → PI flow | ✅ |
| H | CI: opt-in `browser-tests` job | ✅ |
| Docs | ADR-0015 + PHASE_4_DONE + PHASE_5_PLAN | ✅ |

---

Phase 5 plan: `PHASE_5_PLAN.md` — the real meat. ISO 8583 codec from scratch,
acquirer-host opens a persistent TCP to the simulator, the simulator becomes
an actual issuer with response codes + clearing-file generation.
