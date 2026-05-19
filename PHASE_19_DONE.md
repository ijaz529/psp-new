# Phase 19 — Done

**Date:** 2026-05-19 · **Status:** Product-defaults snake_case bug fixed. Plan: `PHASE_19_PLAN.md`.

One migration. Closes a Phase 9 bug that Phase 18's DONE documented as
deferred.

## What shipped

- **Migration `0023_card_products_camelcase_defaults.sql`** — single
  `UPDATE` that rewrites `paycore.card_products.default_controls` for any
  row still carrying snake_case keys (`daily_limit`, `mcc_blocklist`),
  building the JSON fresh with camelCase keys (`dailyLimit`,
  `mccBlocklist`). Idempotent — the WHERE clause filters on snake_case
  key presence, so a re-application matches nothing.

After migrate:
```
prod_strawberry_visa_usd:  {"dailyLimit": 100000, "mccBlocklist": []}
prod_strawberry_mc_usd:    {"dailyLimit": 100000, "mccBlocklist": []}
```

Per-card overrides (`paycore.cards.controls`) are already camelCase from
Phase 18's portal writes; the bug was scoped entirely to the seeded
product defaults.

## Why this matters

`mergeControls` in `@psp-new/issuing` reads camelCase keys. Before this
phase, the product defaults seeded by `0017_issuing.sql` silently never
applied at auth time because the key names didn't match. After Phase 19,
the seeded $1000/day product default actually enforces — an auth for
$1001 against a card with no per-card overlay now returns RC 61
(exceeds withdrawal limit), as Phase 9 originally intended.

## Tests

| Suite | Coverage |
|---|---|
| Existing 60-package suite | Green. No behavioural changes to any code path; only data shape changes. |
| `pnpm typecheck` | Green. |

Existing `packages/issuing/src/controls.test.ts` unit tests already
cover the camelCase read path with hand-constructed objects — those
tests are unaffected. The migration is small enough to self-verify.

## Out of scope

- **A schema-level CHECK constraint** for camelCase keys — overkill for
  two fields. The TypeScript type `CardControls` is the boundary.
- **Backporting the fix to the original `0017` seed** — never edit a
  committed migration. The forward fix in `0023` is the right shape.

## What this enables next

Several items remain open:

- **Cardholder identity surface** — unlocks deferred webhooks across
  Phases 9–18.
- **Settlement file ingestion** — parse real Visa Base II / MC IPM
  files instead of trusting the ledger balance.
- **Auto-top-up rules** — cron over the Phase 11 `loadCard` orchestrator.
- **Card-load chargeback / refund flow** — would unwind the
  Phase 17 acquiring-leg journal.
- **Per-card `cardholder_stored_value` LIABILITY** — granular
  replacement for the PSP-level clearing.
