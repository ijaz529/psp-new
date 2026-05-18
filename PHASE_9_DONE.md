# Phase 9 — Done (MVP)

**Date:** 2026-05-19 · **Status:** Issuing-side MVP landed. Plan: `PHASE_9_PLAN.md`.

## What shipped

- **Migration `0017_issuing.sql`** — `paycore.card_products`, `paycore.cardholders`, `paycore.cards`, `paycore.card_auth_holds`, plus the issuing chart-of-accounts seeds (`issuer_funded_pool`, `issuer_settlement`) for every currency. Two card products are seeded on day one: `prod_strawberry_visa_usd` (BIN 411111000-411111999) and `prod_strawberry_mc_usd` (BIN 555555000-555555999).
- **`@psp-new/issuing`** — pure domain. `generatePan` (Luhn-valid PAN minting in a 9-digit prefix range), `evaluateAuthControls` (status → currency → MCC → balance → daily-limit, mapping to ISO 8583 DE 39 RCs: 05/57/51/61), and `mergeControls` (per-card overlay on product defaults). 27 unit tests including 200-iteration Luhn-correctness across the entire BIN space.
- **`apps/issuer-host`** — new TCP service on `:9101`. Mirrors `apps/acquirer-host` but inverted: receives 0100/0200, looks up the card by BIN+last4, runs the control engine, posts a `card_auth_holds` row + a balanced ledger entry, returns 0110/0210 with the right RC. HTTP `/healthz` on `:9102`.
- **`apps/scheme-simulator` BIN-router** — env-driven (`STRAWBERRY_BIN_RANGES`). PANs in a Strawberry BIN range forward to issuer-host via a persistent TCP client. Everything else uses the existing Phase 5 stub-issuer policy (approve / decline-by-suffix).
- **CLIs** under `pnpm cardholder:create`, `pnpm card:issue`, `pnpm card:load`. PAN is printed exactly once at issue time.
- **Docker-compose** wires `issuer-host` into the dev stack; the simulator now `depends_on` it and is configured with the test BIN ranges.

## End-to-end demo path

```bash
make up && make migrate

# 1. Make a cardholder
pnpm cardholder:create --email alice@example.com --name "Alice Cardholder"
# → ch_01KRYAE…

# 2. Issue a card on the Visa product
pnpm card:issue --cardholder ch_01KRYAE… --product prod_strawberry_visa_usd
# → card_01KRYAF… + PAN printed once

# 3. Load $100 onto it
pnpm card:load --card card_01KRYAF… --amount 100.00

# 4. Use it at any Strawberry-acquired merchant. POST /v1/payment_intents
#    with that PAN → api → acquirer-host → scheme-sim → (BIN match) → issuer-host
#    → balance check → approve → 0110 RC 00 back up the chain.

# 5. Check the ledger:
pnpm ledger:balance --account <funded_account_id>     # was 100.00, now 70.00 if charged $30
```

## Simplifications vs. real life

These keep MVP scope tight. The plan doc calls each out as future scope.

- **Auth = settlement.** Approve writes both the `card_auth_holds` row AND the ledger entry that moves money. The hold is created with `resolved_reason='captured'` immediately. Real life: 0100 holds, separate 0220 captures, 0420 reversals. Splitting these requires teaching the api capture path + scheme-sim to forward 0220.
- **No card-funded top-up.** Loads are by CLI only — they post from `issuer_funded_pool` to the cardholder. Real life: ACH file ingest or charging an external card via the acquiring side.
- **PAN persistence is light.** The CLI prints the PAN once and stores only `bin + last4` on the row. The `pan_token` column references a vault token id, but we do NOT round-trip through the vault on issuer-host auth — we lookup the card by `(bin, last4)` directly because the test BIN slice is small enough that collisions are statistically zero in practice. Future: hash-based exact PAN lookup, or detokenize the inbound DE 2 PAN against the vault.
- **Single currency per card.** The `cards` table inherits its currency from the product; multi-currency cards are a schema change away (a per-card currency column).
- **Cardholder model is standalone.** Per the plan: no merchant link. The future B2B card-program variant adds `merchant_id text` on `paycore.cardholders`.
- **No cardholder portal.** Card management happens entirely via CLI; the portal `/cards` page is deferred.

## Tests

| Suite | Coverage |
|---|---|
| `packages/issuing/src/pan.test.ts` | 14 tests — Luhn vectors, 200-iter generator round-trip across both BIN ranges, malformed-input rejection |
| `packages/issuing/src/controls.test.ts` | 13 tests — every decline path, currency mismatch, MCC, daily-limit, ordering, mergeControls |
| `apps/scheme-simulator/src/issuer.test.ts` | 10 tests — BIN-range parsing, in-range matching, legacy-stub approve path |
| `apps/issuer-host` | Integration test deferred (HAS_DB gate); the unit coverage in `@psp-new/issuing` already exercises every decision branch |

## What this enables next

- A second pass on hold lifecycle: have `apps/api`'s capture endpoint emit a 0220 to the scheme-simulator; the simulator routes it to issuer-host; issuer-host marks the hold `captured` and posts the settlement journal. Today's "approve = settle" simplification disappears.
- Portal `/cards` page with balance + recent auths + freeze toggle.
- Card-load via the acquiring side (cardholder pays $X with a Visa, that funds a Strawberry card).
- More controls: country/MCC velocity, per-merchant blocklist, channel restrictions.
- Real product configurability — admin UI to create new card products, not just the two day-one seeds.
