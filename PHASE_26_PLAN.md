# Phase 26 — Cardholder Webhook Delivery

**Goal.** Cardholder-scoped webhook subscribers. A cardholder can register an
endpoint URL and receive HMAC-signed events about their own cards, reusing
the existing webhook-delivery machinery (signing, retry schedule,
dead-letter, attempt log).

**Non-goal (deferred to Phase 27+).** Cardholder-portal UI for managing
endpoints. Broader event coverage (`card.created`, `card_auth.*`,
`cardholder.updated`). Per-card scoping. Webhook test-send.

## Context

Today, all events fan out to merchant subscribers via:
1. Domain action writes envelope to `paycore.events` + `paycore.outbox`,
   `outbox.headers.merchant_id` set.
2. `apps/outbox-relay/src/drainer.ts` claims unsent outbox rows, looks up
   merchant's `webhook_endpoints` filtered by `enabled_events`, enqueues a
   job per (event, endpoint).
3. `apps/worker/src/webhook-processor.ts` HMAC-signs body via
   `signWebhook()` and POSTs.

The whole pipeline is merchant-keyed. `paycore.events.merchant_id` is
NOT NULL — the constraint that has blocked cardholder events all the way
back to Phase 11.

This phase ships the minimum diff to break that constraint and prove an
end-to-end cardholder delivery, emitting a handful of card-related events
that already exist as state transitions.

## What ships

### 1. Migration `0029_cardholder_webhook_endpoints.sql`

Polymorphic single-table extension (no new endpoint/attempt/dead_letter
tables — keeps query paths singular):

- `paycore.events`:
  - `alter column merchant_id drop not null`
  - `add column cardholder_id text references paycore.cardholders(id)`
  - `add constraint events_owner_check check ((merchant_id is not null)::int + (cardholder_id is not null)::int = 1)`
- `paycore.webhook_endpoints`:
  - same shape: nullable `merchant_id`, new nullable `cardholder_id`,
    same XOR check constraint.
- No changes to `webhook_attempts`, `webhook_dead_letter` (they pivot on
  `endpoint_id`).

Kysely `Database` interface updates in `packages/db/src/kysely.ts`.

### 2. Outbox-relay drainer

`apps/outbox-relay/src/drainer.ts` — extend header-reading branch:

```ts
const headers = row.headers as { merchant_id?: string; cardholder_id?: string } | null;
const ownerKey = headers?.merchant_id
  ? { kind: 'merchant', id: headers.merchant_id }
  : headers?.cardholder_id
    ? { kind: 'cardholder', id: headers.cardholder_id }
    : null;
if (!ownerKey) { /* mark delivered with last_error 'missing owner' */ continue; }

const endpoints = await db
  .selectFrom('paycore.webhook_endpoints')
  .select(['id', 'enabled_events'])
  .where(ownerKey.kind === 'merchant' ? 'merchant_id' : 'cardholder_id', '=', ownerKey.id)
  .where('status', '=', 'enabled')
  .execute();
```

Rest of fan-out logic is identical.

### 3. Event-emission helper

`apps/api/src/lib/wire.ts` already has merchant-keyed emitters. Add a
parallel `emitCardholderOutboxEvent(trx, {cardholderId, envelope})` that
writes to both `paycore.events` (`cardholder_id` set, `merchant_id` null)
and `paycore.outbox` (`headers.cardholder_id` set). Mirror the existing
function's signature.

### 4. Three events emitted

| Event | Triggered from | Data shape |
|---|---|---|
| `card_load.succeeded` | Phase 11 `POST /v1/cards/:id/load` happy path | `{ id, card_id, amount, currency, status: 'succeeded', rrn, stan, created }` |
| `card_load.refunded` | Phase 25 `POST /v1/card_loads/:id/refund` | same shape, status: 'refunded' |
| `card.frozen` / `card.unfrozen` | Phase 18 portal freeze/unfreeze | `{ id, status, last4, scheme }` |

Each emission goes inside the existing DB transaction so the event is
all-or-nothing with the state change.

### 5. CLI provisioning

`apps/api/cli/cardholder-webhook-endpoint.ts`:

```
pnpm cardholder:webhook --cardholder <ch_…> --url <url> --events card_load.*
```

Generates random 32-byte signing secret (hex), prints once (caller stores
it), inserts the row. `enabled_events` accepts comma-separated patterns
including `*` (already supported by drainer).

### 6. Tests

- `apps/outbox-relay/src/drainer.test.ts` — add a `describe.skipIf(!HAS_DB)`
  block: insert cardholder + endpoint + outbox row with
  `headers.cardholder_id`, run `drainOnce`, assert one job enqueued.
- Verify existing merchant tests still pass unmodified.

## Out of scope

- Cardholder-portal UI for endpoint management. CLI-only for now.
- Per-card endpoint filtering (subscribe only to one card's events).
- `card.created`, `card_auth.*`, `cardholder.*` event types — additive,
  defer until UI lands.
- Webhook delivery test-send / replay from portal.
- Rate-limiting or per-endpoint backpressure (existing merchant pipeline
  doesn't have this either).

## Verify steps

1. `pnpm typecheck` green (all 60 packages).
2. `pnpm test` green (all 60 packages, including new drainer test).
3. Manual demo (separate verify, not blocking commit):
   - Run a local mock webhook receiver on `:9876`.
   - Create cardholder, create card via Phase 23, create endpoint via CLI.
   - POST a card load, observe outbox row → job → POST hits mock with
     `webhook-signature` header.
   - POST refund, observe `card_load.refunded` event delivery.
   - Toggle freeze in portal, observe `card.frozen` delivery.

## Files touched (estimate)

- `packages/db/migrations/0029_cardholder_webhook_endpoints.sql` (new)
- `packages/db/src/kysely.ts` (events + webhook_endpoints schema deltas)
- `apps/outbox-relay/src/drainer.ts` (owner-key branch)
- `apps/outbox-relay/src/drainer.test.ts` (cardholder fan-out test)
- `apps/api/src/lib/wire.ts` (emitCardholderOutboxEvent)
- `apps/api/src/routes/v1/cards.ts` (emit on load + refund)
- `apps/portal/src/index.ts` (emit on freeze/unfreeze)
- `apps/api/cli/cardholder-webhook-endpoint.ts` (new)
- `apps/api/package.json` (cardholder:webhook script)
- `PHASE_26_DONE.md` (after impl)
