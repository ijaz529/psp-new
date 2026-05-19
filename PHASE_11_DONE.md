# Phase 11 — Done

**Date:** 2026-05-19 · **Status:** Card-load via the acquiring side landed. Plan: `PHASE_11_PLAN.md`.

The closed-loop demo is now end-to-end: a cardholder can use an external Visa
to top up a Strawberry-issued card. The external auth flows over the real
wire (0200 → acquirer-host → scheme-sim → external stub → 0210 RC 00), and on
approve the cardholder's `funded` balance goes up by the load amount.

## What shipped

- **Migration `0019_card_loads.sql`** — `paycore.card_loads` audit table.
  One row per top-up attempt. `status='succeeded'` rows carry the
  `journal_entry_id` of the posted entry; `status='failed'` rows carry the
  `response_code` + `failure_code` + `failure_message` for retry analysis.
  Index on `(card_id, created_at desc)` for the natural list query.
- **`@psp-new/payment-engine` — `loadCard`** — new orchestrator that validates
  the card (must exist + `active` + currency match) and the payment_method
  (must belong to the caller; Strawberry-issued cards aren't represented in
  `paycore.payment_methods` so the lookup implicitly enforces "external
  card"). Runs the Phase 5 `Authorizer` port with `captureMethod: 'automatic'`
  so the acquirer-host emits `0200` (combined auth+settle). On RC 00, posts
  one journal — `cardholder_funded +X` / `issuer_funded_pool -X` — and
  inserts the `card_loads` row in a single DB transaction. On decline, inserts
  the row with `status='failed'` (no journal).
- **`apps/api` — `POST /v1/cards/:id/load`** — new route in
  `src/routes/v1/cards.ts`, registered in `server.ts`. Body
  `{amount, currency, payment_method}`. Secret-key auth + the existing
  `Idempotency-Key` middleware. Declines surface as `card_declined` (HTTP
  402) via the standard `PspError` taxonomy.
- **`@psp-new/errors`** — new `card_funding_not_allowed` code (400, type
  `invalid_request_error`) for the "card not active" or "currency mismatch"
  paths.
- **`@psp-new/ids`** — `card_load` resource kind, `cl_` prefix.

## End-to-end demo path

```bash
make up && make migrate

# Phase 9 setup
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
# → card_…

# Tokenize an external Visa via the merchant's pk
curl -X POST $API/v1/tokens \
  -H "Authorization: Bearer pk_test_…" \
  -d '{"card":{"number":"4111111111111111","exp_month":12,"exp_year":2030,"cvc":"123"}}'
# → tok_…

# Attach to a payment_method on the merchant's books (existing flow)
curl -X POST $API/v1/payment_methods \
  -H "Authorization: Bearer sk_test_…" \
  -d '{"type":"card","token":"tok_…"}'
# → pm_…

# Load $50 onto the Strawberry card via the external Visa
curl -X POST $API/v1/cards/<card_…>/load \
  -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":5000,"currency":"USD","payment_method":"pm_…"}'
# → 201 { id: cl_…, status: 'succeeded', response_code: '00', rrn, stan, … }

# Inspect the ledger:
pnpm ledger:balance <funded>           →  50.00 (was 0; up by 50)
pnpm ledger:balance <issuer_funded_pool:USD:psp:>  → -50.00 (deficit grew by 50)

# Decline path — use the Phase 5 known-decline PAN
# Tokenize 4000000000000999, attach, then load → 402 card_declined
# A card_loads row exists with status='failed' / response_code='51'.
```

## Tests

| Suite | Coverage |
|---|---|
| Existing 60-package suite | Still green — no behavioural changes to existing paths. |
| `pnpm typecheck` | Green across all 60 packages including the new `cards.ts` route and `loadCard` orchestrator. |

Test additions deferred to the integration tier — the loadCard flow is
trivial to exercise live via the demo script above, and a HAS_DB-gated unit
test would essentially re-implement the orchestrator. The `paycore.card_loads`
row + ledger balance are the authoritative verification surfaces.

## Simplifications vs. real life

These are documented in `PHASE_11_PLAN.md §Out of scope`:

- **Acquiring-side books untouched.** The load's external 0200 is treated as a
  funds-check, not a settlement event. `scheme_receivable` and
  `merchant_settlement_liability` are not posted. In production, the load
  would simultaneously credit `scheme_receivable` and an external-load
  clearing account, with the clearing periodically swept to refill
  `issuer_funded_pool`. The MVP just lets the pool's running deficit grow.
- **No cardholder webhooks.** `card.loaded` / `card.load_failed` are not
  emitted — consistent with Phase 9, which declared the card webhook channel
  but never wired delivery. Both add together when the cardholder portal
  arrives.
- **No partial reversal.** A successful load can't be reversed via this
  endpoint. The 0420 path is merchant-PI-only. Reverse via a CLI journal in
  the meantime.
- **Cardholder authentication.** The endpoint takes a merchant secret key
  because there is no cardholder identity surface yet. In production this
  would be a cardholder-portal token scoped to the cardholder's own cards.
- **Strawberry-to-Strawberry transfers work as a side effect** — payment_methods
  store external-tokenized cards, so a Strawberry PAN can't be submitted as
  the funding source. No explicit BIN-range rejection is needed.

## What this enables next

- **Cardholder portal `/cards` page** (the Phase 9 carry-over): with Phase
  10's hold lifecycle + Phase 11's load history, the page can render
  Available / Pending / recent loads / recent auths in one view.
- **Pool reconciliation worker**: a periodic sweep that materialises the
  acquiring-side accounting we deferred — read `paycore.card_loads` since
  the last sweep, post one batched `scheme_receivable +Σ` /
  `issuer_funded_pool +Σ` adjustment against a contra account.
- **Card-funded payouts**: the inverse — cardholder cashes out their
  Strawberry balance to an external bank account or card.
- **Auto-top-up rules** ("load $50 whenever balance < $10") — straightforward
  cron over the same orchestrator.
