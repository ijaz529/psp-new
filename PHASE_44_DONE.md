# Phase 44 — Done

**Date:** 2026-11-05 · **Status:** the portal's Payouts and Disputes
nav links lead to real pages. Plan: `PHASE_44_PLAN.md`.

## What shipped

### `apps/portal/src/dashboard-views.ts`

- `payoutsListPage` and `disputesListPage`, built like
  `merchantsListPage`: `layout()` plus one card around the existing
  `payoutsTable` / `disputesTable`.
- `disputesTable` has an **amount** column. The dashboard's
  "Recent disputes" card shows it too.
- `PayoutRow` / `DisputeRow` types, shared by the dashboard and the
  list pages.

### `apps/portal/src/index.ts`

- `GET /payouts` and `GET /disputes`: newest first, limit 200 (the
  `/cards` convention). Auth comes from the existing preHandler, so
  neither route is in `PUBLIC_PATHS`.
- The dashboard mapping passes dispute `amount` + `currency`.

## Verify

| Check | Result |
|---|---|
| `pnpm exec biome check` on both files | clean |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| Signed out, `GET /payouts`, `GET /disputes` | 302 → `/signin` |
| Signed in, `/payouts` | 200, the canary payout (72.75 USD, paid) |
| New merchant via `/sign-up`, 45.00 EUR payment, `POST /v1/disputes` `visa_13.1` | dispute 201 `first_chargeback` |
| Signed in, `/disputes` + dashboard | 200, dispute listed with 45.00 EUR |
| `make e2e` (fresh DB, before this phase's code) | canary 11/11 |

## What did NOT change

- Dispute writes stay on the merchant API
  (`POST /v1/disputes`, `POST /v1/disputes/:id/transition`).
- No migrations, no dep changes, no API changes.

## Still open

- No detail pages (`/payouts/:id`, `/disputes/:id`) and no dispute
  actions in the portal.
- Tables with two ULID columns need ~910px. Below that they overflow
  the card (dashboard included); `.card { overflow-x: auto }` is the
  likely one-liner.
- `tsx watch` in the portal container did not pick up host edits on
  macOS; `docker compose restart portal` was needed.
- `make up` reuses old containers' anonymous `/app/node_modules`
  volumes. After a lockfile change, portal and checkout booted without
  `tsx` until the containers were removed (`make down`). `up -V` would
  renew them.
- `make migrate` needs `.env` in the environment (direnv, or
  `set -a; source .env`); it does not load it itself, unlike `make e2e`.

## Open list (carried)

- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- Payouts: `listPayoutCandidates` windows on PI `created_at`;
  reserves; `merchants.payout_schedule` ignored (Phase 43).
