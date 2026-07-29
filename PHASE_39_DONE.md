# Phase 39 — Done

**Date:** 2026-07-29 · **Status:** cardholders can see and replay
failed webhook deliveries. Plan: `PHASE_39_PLAN.md`.

The worker dead-letters exhausted cardholder deliveries into
`paycore.webhook_dead_letter`, but only merchants had a replay
surface (API routes, Phase-era `/v1/webhook_dead_letter*`).
Cardholders now get a portal page.

## What shipped

### `apps/portal/src/index.ts`

- `GET /cardholder/webhooks/deadletter` — dead letters joined to the
  signed-in cardholder's endpoints (`webhook_endpoints.cardholder_id`
  filter — cross-cardholder isolation by construction), newest first,
  limit 100.
- `POST /cardholder/webhooks/deadletter/:id/replay` — same-join
  ownership check (silent redirect back if not theirs), stamps
  `retried_at`, enqueues the standard `{ eventId, endpointId }`
  delivery job with jobId `replay:<id>:<ts>`, redirects to the list.
  Identical semantics to the merchant API replay.
- Queue is lazy (constructed on first replay, closed in `onClose`) —
  the portal still boots without Redis, mirroring the API's pattern.

### `apps/portal/src/webhooks-views.ts`

`cardholderDeadLetterListPage` — event, endpoint, reason + attempt
count, failed-at, last-replay, and a per-row Replay button. Linked
from the webhooks list page ("Failed deliveries").

### Plumbing

- `apps/portal/package.json`: + `@psp-new/webhook-delivery`,
  `bullmq`, `ioredis` (versions matching apps/api); `pnpm install`
  run.
- `docker-compose.yml`: portal gets `REDIS_URL: redis://redis:6379`.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green (portal has no test suite — unchanged) |
| Live click-through | **NOT RUN** — needs the stack up (same caveat as Phases 33/36–38). The portal has no test scaffolding, so typecheck is the only automated gate; route matching relies on Fastify's static-beats-parametric rule for `/cardholder/webhooks/deadletter` vs `/cardholder/webhooks/:id`. |

## What did NOT change

- Merchant dead-letter flow — API routes untouched; no admin-portal
  UI added.
- No cardholder REST API dead-letter endpoints (`/v1/cardholder/…`).
- Dead letters are never deleted; replay stamps `retried_at` and
  re-enqueues, exactly like the merchant path.

## Open list (Phase 38's list, one item closed)

- ~~Webhook deadletter replay UI for cardholders~~ — closed this
  phase.
- Per-card endpoint scoping.
- Merchant route integration tests — broader coverage still open.
- Run against live Postgres and record results: Phase 33 confirm
  test, migrations 0032/0033, Phase 37 fan-out demo, Phase 38 janitor
  test, Phase 39 portal click-through.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  needs a bootable stack.
