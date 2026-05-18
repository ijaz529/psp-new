# Phase 4 — Checkout: Hosted Fields + 3DS2 (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 3 (`PHASE_3_DONE.md`).

> Hosted fields: a tiny JS bundle the merchant embeds, which renders an iframe
> served from the PSP domain. The merchant page never sees the PAN. (This is
> what keeps integrating merchants on PCI SAQ-A.)
> — PROJECT_BRIEF.md §3 Phase 4

This is the customer-facing surface — the part a real cardholder actually
sees when they pay.

---

## Goal

A merchant can:

1. Embed `<script src="https://api.strawberry.dev/v1/hosted-fields.js"></script>`
   on their checkout page.
2. Mount our iframe into a container `<div id="card-element"></div>`.
3. The iframe is served from our `apps/checkout` origin; the merchant page
   **never sees the PAN**.
4. Customer types their card; iframe POSTs to our `/v1/tokens` endpoint and
   returns a `tok_…` token to the merchant page.
5. Merchant page calls their own server, which calls our
   `/v1/payment_intents` to confirm with the token.
6. If 3DS is required: the iframe surfaces the challenge URL; our simulator
   serves a challenge page with an OTP input.
7. After 3DS, the PaymentIntent transitions through `requires_action` →
   `processing` → `succeeded`.

When Phase 4 is done, you can pay end-to-end from a "merchant" demo page,
through a real iframe, through 3DS, with the same `apps/api` + `apps/vault`
backend.

---

## Pieces

### A. `apps/checkout` — hosted-fields iframe origin
- Fastify-served static assets:
  - `/v1/hosted-fields.js` — the merchant-side bundle. Tiny (~10kB). Exposes
    `Strawberry.fields({ container })`. Sets up a sandboxed iframe pointing at
    `apps/checkout`'s `/iframe` route.
  - `/iframe` — the input form HTML rendered inside the iframe. Submits to
    `/v1/tokens` (within our origin), gets back `{ token, bin, last4, scheme }`,
    posts that back to parent window via `postMessage`.
- Strict CSP: `frame-ancestors *` (allows embedding) + `default-src 'self'`.

### B. `POST /v1/tokens` — public tokenization endpoint
- Accepts `pk_test_…` (publishable key) — safe to call from browser.
- Body: `{ card: { number, exp_month, exp_year, cvc } }`.
- Internally: vault.tokenize → returns `{ id: 'tok_…', bin, last4, scheme }`.
- CORS-restricted to the iframe origin.

### C. 3DS2 server simulation
- Implement the carry-through fields (ECI, CAVV, transStatus) per brief Q22.
- Wire-format: simulated, not real AReq/ARes — but the *contract* (frictionless
  vs challenge, fail vs succeed) is realistic.
- Stub Directory Server + ACS as part of `apps/scheme-simulator`.

### D. Scheme-simulator OTP challenge UI
- The OTP challenge page lives at
  `http://localhost:9002/3ds/challenge/:transaction_id` (already on the
  scheme-simulator's HTTP port from Phase 0).
- Two buttons: "Approve" and "Decline". Sends the result back to our 3DS
  server callback.

### E. PaymentIntent flow with 3DS
- When confirming a PaymentIntent whose card BIN is configured as "3DS
  required" in the simulator, the orchestrator transitions
  `requires_confirmation` → `requires_action` and writes a `next_action`
  payload `{ type: 'three_ds_redirect', redirect_url }`.
- After the customer completes 3DS (via the simulator), the callback hits
  `/v1/_internal/three_ds/callback` which transitions
  `requires_action` → `processing` → (auto-capture) → `succeeded`.

### F. Demo merchant page
- A tiny `index.html` at `apps/checkout/public/demo.html` that exercises the
  full flow: pk key → mount iframe → tokenize → confirm via api → render
  outcome.
- Useful both for demos and for the e2e smoke.

---

## Schema changes

Migration `0013_three_ds_sessions.sql`:

```sql
create table paycore.three_ds_sessions (
  id                 text primary key,          -- tds_<ulid>
  merchant_id        text not null,
  payment_intent_id  text not null references paycore.payment_intents(id),
  token_id           text not null,
  scheme             text not null,
  status             text not null check (status in ('pending', 'approved', 'declined', 'expired')),
  eci                text,
  cavv               text,
  trans_status       text,
  redirect_url       text not null,
  expires_at         timestamptz not null,
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
create index three_ds_sessions_intent_idx on paycore.three_ds_sessions (payment_intent_id);
```

Also: add `next_action` jsonb column to `paycore.payment_intents` to expose the
3DS redirect URL to the merchant.

---

## Tests

- Unit: tokenize endpoint accepts only `pk_test_…`; rejects `sk_*`.
- Unit: 3DS state machine transitions (frictionless, challenge-success,
  challenge-fail, timeout).
- Integration (DB-gated):
  - End-to-end: create payment_intent → confirm → expect `requires_action`
    response with redirect_url → simulate customer clicking "Approve" in
    simulator → expect PaymentIntent transitions to `succeeded`.
  - Decline path: simulate "Decline" → expect PaymentIntent transitions to
    `failed` with `three_ds_authentication_failed`.
- Browser (Playwright, new):
  - Load demo.html in a headless browser, fill the iframe, assert the
    token POST happens, assert the parent receives the token.

---

## Estimated scope

| Item | LOC | Time |
|---|---|---|
| `apps/checkout` static + iframe HTML/JS | ~400 | 1.5 days |
| `POST /v1/tokens` endpoint + pk-only auth | ~150 | 0.5 day |
| 3DS state machine + transitions wired into payment-engine | ~250 | 1 day |
| Scheme-simulator OTP UI + 3DS callbacks | ~300 | 1 day |
| `paycore.three_ds_sessions` migration | ~50 | 0.25 day |
| Demo merchant page | ~200 | 0.5 day |
| Tests (unit + integration + Playwright) | ~800 | 1.5 days |
| Docs + ADR-0015 (3DS simulation contract) | ~150 | 0.5 day |

**Total:** ~6.75 days for a solo dev.

---

## Open questions for you

1. **CORS origin for `/v1/tokens`**: do we whitelist merchant origins per-merchant
   (each merchant registers an allowed origin), or open `*` for Phase 4 testing
   and lock down in Phase 8? My recommendation: **per-merchant whitelist**, with
   a sensible test default of `localhost:*` automatically allowed.
2. **3DS challenge mode**: do we offer the merchant control over whether 3DS
   is triggered (request_three_d_secure: 'any' | 'automatic' | 'never')?
   Mirrors Stripe. My recommendation: **add the field but ignore in Phase 4**;
   wire it up in Phase 7 risk rules.
3. **Iframe styling**: locked theme (Strawberry brand) or accept basic style
   overrides from the merchant page via postMessage? My recommendation:
   **locked for Phase 4**; theming in Phase 8.
4. **Playwright in CI**: add as a new GitHub Actions matrix job, or run
   browser tests only locally? My recommendation: **CI**, but allow a marker
   to skip locally with `pnpm test:browser`.

Answer those and I execute Phase 4.
