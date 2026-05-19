# Phase 18 — Done

**Date:** 2026-05-19 · **Status:** Freeze toggle + controls editor landed. Plan: `PHASE_18_PLAN.md`.

The portal's `/cards/:id` detail page now has write actions. Admins can
flip cards between `active` and `frozen` and tune the per-card spending
controls overlay (daily limit + MCC blocklist).

## What shipped

- **`apps/portal/src/cards-views.ts`** — `cardDetailPage` now renders
  two new sections:
  - **Status row** in the existing Card table grows a "Freeze" /
    "Unfreeze" button next to the status pill (no button for terminal
    `cancelled` cards).
  - **New "Controls" card** with two inputs: daily limit (minor units)
    and MCC blocklist (comma-separated 4-digit codes). Pre-filled with
    the current per-card overlay; blank = inherit the product defaults.
  - Two private helpers — `freezeToggleForm` and `controlsForm` —
    render the markup. Cancelled cards show an italicized read-only
    message in place of the controls form.
- **`apps/portal/src/index.ts`** — three new POST routes:
  - `POST /cards/:id/freeze` — atomic `UPDATE … SET status='frozen'
    WHERE id=? AND status='active'`. Returns 422 if nothing matched (card
    was already frozen, cancelled, or missing).
  - `POST /cards/:id/unfreeze` — mirror image, `frozen → active`.
  - `POST /cards/:id/controls` — Zod-validates body
    `{daily_limit?, mcc_blocklist?}`; daily limit must be a 0–1B integer;
    MCC entries must match `/^\d{4}$/`. Builds a camelCase
    `{dailyLimit?, mccBlocklist?}` object (matching the
    `@psp-new/issuing` `CardControls` type) and writes it to
    `paycore.cards.controls`. Pre-checks that the card exists and isn't
    `cancelled`.
  - All three redirect 302 back to `/cards/:id` on success.
- **`apps/portal/src/index.ts`** GET `/cards/:id` — added
  `paycore.cards.controls` to the SELECT and threads it through to the
  view as `controls: { dailyLimit?, mccBlocklist? }`.

Zero schema changes. The `paycore.cards.status` enum and `controls`
jsonb column both shipped in Phase 9's `0017_issuing.sql`. Both fit
through existing Kysely types.

## Demo path

```bash
make up && make migrate
pnpm --filter @psp-new/portal user:create   # if not already done
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd

# Browse to /cards in the portal, click the new card.

# Test freeze:
# 1. Click "Freeze" → status pill flips to `frozen`, button becomes "Unfreeze".
# 2. Trigger an auth via the api (POST /v1/payment_intents …) — RC 05.
# 3. Click "Unfreeze" → status flips back, auths approve again.

# Test controls:
# 1. Set daily limit to 1000 ($10 USD). Save.
# 2. Trigger an auth for $20 → RC 61 ("exceeds withdrawal limit").
# 3. Clear daily limit (blank field, save) → auths approve again.
```

The per-card overlay flows through to the issuer-host's existing
`mergeControls(card.default_controls, card.controls)` →
`evaluateAuthControls(...)` chain (Phases 9/10), so no issuer-host
changes were needed.

## Tests

| Suite | Coverage |
|---|---|
| Existing 60-package suite | Green. No behavioural changes to any existing path. |
| `pnpm typecheck` | Green across all 60 packages. |

The portal app's `test` script remains `--passWithNoTests` (same as
Phases 8 and 12). The new routes are thin DB-update handlers + form
markup; live visual verification is the primary acceptance gate.

## Pre-existing bug not fixed here

Phase 9's `0017_issuing.sql` seeds product `default_controls` with
**snake_case** keys (`daily_limit`, `mcc_blocklist`), but `mergeControls`
in `@psp-new/issuing` reads **camelCase** (`dailyLimit`, `mccBlocklist`).
Net effect: product defaults silently never apply at auth time. Per-card
overrides (what Phase 18 writes) do work because they're stored in
camelCase. A future small data migration can rewrite the two seeded
product rows to camelCase — out of scope for Phase 18, flagged here so
the next person to look at controls knows.

## Simplifications vs. real life

These are documented in `PHASE_18_PLAN.md §Out of scope`:

- **No cancellation surface.** `cancelled` is terminal; we don't expose
  it (admin SQL only). The controls form renders read-only for cancelled
  cards for symmetry.
- **No country blocklist / velocity / channel restrictions.** Only the
  two `CardControls` fields exist today.
- **No audit log.** No `card_events` table. Money flow is journaled;
  status + control changes are not.
- **No CSRF tokens.** Same threat model as the existing Phase 8 portal
  forms — session-cookie-only.
- **No `card.frozen` / `card.controls_updated` webhooks.** Consistent
  with the deferred cardholder webhook channel across Phases 9–17.

## What this enables next

Several open items remain on the list. Top picks:

- **Cardholder identity surface** — unlocks deferred webhooks across
  Phases 9–18.
- **Settlement file ingestion** — parse real Visa Base II / MC IPM
  files instead of trusting the ledger balance.
- **Fix the snake_case product-defaults bug** — small one-off data
  migration to rewrite the two seed rows.
- **Auto-top-up rules** — cron over the Phase 11 `loadCard` orchestrator.
- **Per-card `cardholder_stored_value` LIABILITY** — granular replacement
  for the PSP-level clearing.
