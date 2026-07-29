# Phase 39 — Plan

**Goal:** cardholders can see and replay their permanently-failed
webhook deliveries in the cardholder portal. Open since Phase 26/27:
merchants got API-level dead-letter replay
(`/v1/webhook_dead_letter*`), the worker dead-letters cardholder
deliveries into the same `paycore.webhook_dead_letter` table, but
cardholders have no way to see or retry them.

## Design

Portal-side (cookie session), mirroring the existing
`/cardholder/webhooks` pages:

- **`GET /cardholder/webhooks/deadletter`** — list dead letters for
  the signed-in cardholder:
  `webhook_dead_letter ⨝ webhook_endpoints` filtered on
  `webhook_endpoints.cardholder_id`, newest first, limit 100. Columns:
  id, event, endpoint, reason, attempts, failed-at, retried-at, and a
  per-row Replay button (form POST). Linked from the webhooks list
  page.
- **`POST /cardholder/webhooks/deadletter/:id/replay`** — ownership
  check via the same join (404 page redirect if not theirs), set
  `retried_at`, enqueue the standard `{ eventId, endpointId }`
  delivery job, redirect back to the list. Identical semantics to the
  merchant API replay route.
- **Queue access**: portal gains `bullmq` + `ioredis` deps and the
  API's lazy-queue pattern (queue constructed on first replay, closed
  in `onClose`) so boots don't require Redis. `docker-compose.yml`
  portal service gets `REDIS_URL: redis://redis:6379`.
- **View**: `cardholderDeadLetterListPage` in `webhooks-views.ts`,
  same layout/pill/table conventions as the existing pages.

## Out of scope

- Merchant dead-letter UI in the admin portal (merchants use the API
  route; unchanged).
- Cardholder REST API dead-letter endpoints (`/v1/cardholder/…`) —
  the open-list item is the portal UI; API surface can follow if ever
  needed.
- Bulk replay, pagination beyond limit 100, deleting dead letters.

## Files touched

| File | Change |
|---|---|
| `apps/portal/package.json` | + bullmq, ioredis |
| `apps/portal/src/index.ts` | 2 routes + lazy queue |
| `apps/portal/src/webhooks-views.ts` | + dead-letter list page, link |
| `docker-compose.yml` | portal REDIS_URL |

## Verify steps

| Check | Expected |
|---|---|
| `pnpm install` then `pnpm typecheck` | 60/60 |
| `pnpm test` | 60/60 (portal has no test suite — unchanged) |
| Live click-through (list, replay, ownership isolation) | deferred to next stack boot — same caveat as Phases 33/36–38; the portal has no test scaffolding, so typecheck is the only automated gate here |
