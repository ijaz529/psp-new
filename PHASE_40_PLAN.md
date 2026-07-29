# Phase 40 — Plan

**Goal:** cardholder webhook endpoints can be scoped to a single card.
An endpoint with a card scope receives only events about that card;
unscoped endpoints keep receiving everything. Open-list item since
Phase 27 ("per-card endpoint scoping").

## Design

- **Migration `0034_webhook_endpoint_card_scope.sql`** — nullable
  `webhook_endpoints.card_id` referencing `paycore.cards(id)`, plus a
  check constraint `card_id is null or cardholder_id is not null`
  (card scoping is a cardholder-endpoint concept; merchant endpoints
  never set it). NULL = unscoped, the status quo for every existing
  row.
- **Events carry the card**: `publishCardholderEvent` gains optional
  `cardId`, stored in the outbox row's `headers.card_id`. All three
  cardholder-event emit sites pass it:
  - `card_load.succeeded` (orchestrator `loadCard`) — `input.cardId`;
  - `card_load.refunded` (`apps/api` cards route) — `row.card_id`;
  - `card.frozen` / `card.unfrozen` (portal) — `row.id` (the card).
- **Drainer filtering** (`apps/outbox-relay/src/drainer.ts`): select
  `card_id` on candidate endpoints and filter through a new exported
  pure function `endpointMatchesEvent(endpoint, event)`:
  - event-type match as today (`*` or exact);
  - unscoped endpoint (card_id NULL) matches any event;
  - card-scoped endpoint matches only events whose `headers.card_id`
    equals its scope — an event with no card_id never reaches a
    card-scoped endpoint.
  Extracting the matcher makes the routing rules unit-testable
  without a DB (the existing drainer test is DB-gated).
- **Cardholder REST** (`POST /v1/cardholder/webhook_endpoints`):
  optional `card` body field (`^card_`); ownership check against
  `paycore.cards.cardholder_id` (404 `resource_missing` on a foreign
  or unknown card). `card` echoed in the POST response and the GET
  list.
- **Portal**: optional "Card (optional)" field on the new-endpoint
  form with the same ownership check; endpoint detail page shows the
  scope when set.

## Out of scope

- Merchant endpoint scoping (per-PI or otherwise).
- Re-scoping an existing endpoint (create a new one instead — same
  posture as the rest of the endpoint surface, which only supports
  create/disable).
- Backfill/migration of events already in the outbox (headers without
  card_id simply don't match scoped endpoints).

## Files touched

| File | Change |
|---|---|
| `packages/db/migrations/0034_webhook_endpoint_card_scope.sql` | new |
| `packages/db/src/kysely.ts` | + `webhook_endpoints.card_id` |
| `packages/outbox/src/index.ts` | + `cardId` → headers |
| `packages/payment-engine/src/orchestrator.ts` | pass cardId |
| `apps/api/src/routes/v1/cards.ts` | pass cardId |
| `apps/portal/src/index.ts` | pass cardId ×2, form field + check |
| `apps/portal/src/webhooks-views.ts` | form field, detail line |
| `apps/outbox-relay/src/drainer.ts` | matcher + filter |
| `apps/outbox-relay/src/drainer.test.ts` | + pure matcher tests |
| `apps/api/src/routes/v1/cardholder.ts` | optional `card` |
| `apps/api/src/routes/v1/cardholder.test.ts` | + scoped-create tests |

## Verify steps

| Check | Expected |
|---|---|
| Pure matcher tests red-first | fail before drainer change |
| `pnpm typecheck` / `pnpm test` (no DB) | 60/60 each; DB-gated suites skip |
| DB-gated: scoped create (owned card 201 w/ `card`; foreign card 404), drainer fan-out isolation | deferred to next stack boot — same caveat as Phases 33/36–39 |
