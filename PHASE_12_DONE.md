# Phase 12 — Done

**Date:** 2026-05-19 · **Status:** Cardholder portal /cards page landed. Plan: `PHASE_12_PLAN.md`.

The last Phase 9 carry-over is shipped — every issued card is now visible in
the portal, with balance, recent loads (Phase 11), and recent auth holds
(Phase 10) on the detail page.

## What shipped

- **`apps/portal/src/cards-views.ts` (NEW)** — `cardsListPage` +
  `cardDetailPage`. Reuses `layout`, `esc`, `formatAmount`, and `BASE_CSS`
  from `dashboard-views.ts`. Status pills colour-code card status
  (`active`/`frozen`/`cancelled`), load status (`succeeded`/`failed`), and
  hold status (`open`/`captured`/`reversed`/`expired`).
- **`apps/portal/src/index.ts`** — two new routes:
  - `GET /cards` — joins `paycore.cards` ⨝ `paycore.cardholders` ⨝
    `paycore.card_products` ⨝ `ledger.account_balances`, limit 200, ordered
    by `cards.created_at desc`. Renders the list.
  - `GET /cards/:id` — loads the card row, then runs four parallel queries
    (funded balance, holds balance, last 20 loads, last 20 auth holds).
    Renders the detail page. 404 falls back to the sign-in page with a
    `'card not found'` message (matches the existing `/merchants/:id`
    pattern).
- **`apps/portal/src/dashboard-views.ts`** — `<a href="/cards">Cards</a>`
  added to the signed-in nav. `esc` and `formatAmount` promoted to exports so
  `cards-views.ts` can import them.

Zero schema changes, zero new packages, zero new dependencies. All queries
use existing tables (`paycore.cards`, `paycore.cardholders`,
`paycore.card_products`, `paycore.card_loads`, `paycore.card_auth_holds`,
`ledger.account_balances`).

## Demo path

```bash
make up && make migrate

# Seed a portal user (Phase 8)
pnpm --filter @psp-new/portal user:create

# Issue + load a card (Phases 9, 10, 11)
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
pnpm card:load --card <card_…> --amount 100.00

# Optionally: trigger an auth via the api so the holds table has a row
curl -X POST $API/v1/payment_intents -H "Authorization: Bearer sk_test_…" \
  -d '{"amount":3000,"currency":"USD","capture_method":"manual",
       "payment_method":"pm_<external>","confirm":true}'

# Open the portal
pnpm --filter @psp-new/portal dev
# Browse to http://localhost:8083/signin → sign in → click "Cards" in the nav
# Click any card row → see balance + recent loads + recent auth holds
```

## Tests

| Suite | Coverage |
|---|---|
| Existing 60-package suite | Green. The portal app's `test` script is `--passWithNoTests` (no Phase 8 tests either), so Phase 12 follows suit. |
| `pnpm typecheck` | Green across all 60 packages. |

Live visual verification is the primary acceptance gate — the page is a thin
view layer over Kysely queries against shipped tables, and the test surface
for HTML rendering would essentially re-implement the templates.

## Simplifications vs. real life

These are documented in `PHASE_12_PLAN.md §Out of scope`:

- **Admin auth.** Every logged-in portal user sees every card. A real
  cardholder portal would scope by cardholder identity (email magic-link or
  similar) — that's its own phase.
- **Read-only.** No freeze toggle, no controls editor, no
  trigger-load-from-portal form. The detail page is for visibility.
- **No pagination.** List capped at 200 cards; detail's loads and auth holds
  capped at 20 each. Demo-sized.
- **No tests.** Matches the rest of the portal app's Phase 8 cadence.
- **No Phase 9 swap to Next.js** — the portal's package.json still promises
  "Phase 9+ swaps to Next.js"; that swap hasn't happened and Phase 12 stays
  with the existing Fastify HTML for consistency.

## What this enables next

The Phase 9 deferral list is now empty. Natural next pieces, in rough order:

- **Pool reconciliation worker** (carried over from Phase 11) — periodic
  sweep that materialises the acquiring-side accounting we deferred, so
  `issuer_funded_pool`'s running deficit stops growing.
- **Freeze toggle / controls editor** on `/cards/:id` — straightforward
  POST endpoints + form, gated on the same admin session.
- **Cardholder identity surface** — email magic-link sign-in, scoping
  `/cards` to the signed-in cardholder's cards. Foundation for any future
  cardholder-facing flows.
- **Partial captures** (carried over from Phase 10) — capture endpoint
  accepts `amount_to_capture` < `amount_capturable`; orchestrator splits one
  auth across multiple 0220s. The hold table's per-advice STAN uniqueness
  already supports this shape.
- **Auth-expiry sweeper** (carried over from Phase 10) — `worker` job that
  walks the partial index `card_auth_holds_open_idx` for stale rows and
  posts the local reversal.
