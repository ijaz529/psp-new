# Phase 40 — Done

**Date:** 2026-07-29 · **Status:** cardholder endpoints can be scoped
to one card. Plan: `PHASE_40_PLAN.md`.

## What shipped

### Migration `0034_webhook_endpoint_card_scope.sql`

Nullable `webhook_endpoints.card_id` → `paycore.cards(id)`, with check
`card_id is null or cardholder_id is not null` (merchant endpoints
never set it). NULL = unscoped — the status quo for every existing
row.

### Events carry the card

`publishCardholderEvent` gained optional `cardId`, written to the
outbox row's `headers.card_id`. All three emit sites pass it:
`card_load.succeeded` (orchestrator), `card_load.refunded` (api cards
route), `card.frozen`/`card.unfrozen` (portal — the resource is the
card).

### Drainer routing

`apps/outbox-relay/src/drainer.ts` exports a pure
`endpointMatchesEvent(endpoint, event)`:
- event type must be enabled (`*` or exact) — unchanged;
- unscoped endpoint matches any event;
- card-scoped endpoint matches only events carrying its card id — an
  event without one never reaches a scoped endpoint.

`drainOnce` selects `card_id` and filters through it. The matcher is
unit-tested without a DB (5 tests, red-first) — the first non-DB-gated
coverage the drainer has.

### Creation surfaces

- **Cardholder REST** `POST /v1/cardholder/webhook_endpoints`:
  optional `card` (`^card_`), ownership-checked against
  `cards.cardholder_id` (404 `resource_missing` on foreign/unknown).
  `card` echoed in POST response and GET list.
- **Portal**: "Card (optional)" field on the new-endpoint form, same
  ownership check (form error page on foreign card); endpoint detail
  page shows the scope with a link to the card.

### Tests

- 5 pure matcher tests (drainer.test.ts, run without DB).
- 2 DB-gated REST tests: scoped create with an owned card (201, card
  echoed, listed), foreign card → 404. Backed by a new
  `createTestCard` fixture in the harness (two ledger accounts + a
  card on the seeded `prod_strawberry_visa_usd` product).

## Verify

| Check | Result |
|---|---|
| Matcher tests before drainer change | 5 red |
| `pnpm --filter @psp-new/outbox-relay exec vitest --run` | 5 passed, 1 DB-gated skip |
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| DB-gated (migration 0034, REST tests, live fan-out isolation) | **NOT RUN** — no Postgres reachable; add to the live-verification batch |

## What did NOT change

- Merchant endpoint matching — same type-only rules (merchant
  endpoints have NULL card_id, and the matcher treats NULL as
  unscoped).
- Events already in the outbox (no card_id header) — deliverable to
  unscoped endpoints only, by design.
- No re-scoping of existing endpoints (create + disable remain the
  only mutations, as before).

## Open list (Phase 39's list, one item closed)

- ~~Per-card endpoint scoping~~ — closed this phase.
- Merchant route integration tests — broader coverage still open.
- Run against live Postgres and record results: Phase 33 confirm
  test, migrations 0032/0033/**0034**, Phase 37 fan-out demo, Phase 38
  janitor test, Phase 39 portal click-through, **Phase 40 REST tests +
  scoped fan-out**.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  needs a bootable stack.
