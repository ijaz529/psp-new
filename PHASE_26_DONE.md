# Phase 26 — Done

**Date:** 2026-05-19 · **Status:** Cardholder webhook delivery shipped end-to-end. Plan: `PHASE_26_PLAN.md`.

The merchant-only events + webhook_endpoints tables are now polymorphic
(each row carries exactly one of merchant_id / cardholder_id). The
existing outbox-relay → BullMQ → webhook-processor pipeline now fans out
to cardholder subscribers when an event carries `headers.cardholder_id`.
Three card-related state transitions emit events through this path
(`card_load.succeeded`, `card_load.refunded`, `card.frozen` /
`card.unfrozen`).

## What shipped

### Migration `0029_cardholder_webhook_endpoints.sql`

- `paycore.events`: nullable `merchant_id`, new nullable `cardholder_id`,
  XOR check constraint.
- `paycore.webhook_endpoints`: same shape.
- New partial indexes on `cardholder_id` for both tables.
- `webhook_attempts` / `webhook_dead_letter` unchanged — they pivot on
  `endpoint_id`.

### Drainer (`apps/outbox-relay/src/drainer.ts`)

Single branch: read `headers.merchant_id` OR `headers.cardholder_id`,
pick the matching column for the `webhook_endpoints` lookup. Filtering
on `enabled_events` + the `status='enabled'` guard are unchanged. Error
message reworded from `missing merchant_id / envelope` to
`missing owner / envelope`.

### `@psp-new/outbox` helper

```ts
publishCardholderEvent(trx, {
  cardholderId, type, data, resourceId?, livemode?, apiVersion?,
})
```

Writes the events row + outbox row in one tx. Mirrors the
orchestrator's private merchant `emitAndPublishEvent`. Lives in
`@psp-new/outbox` so it's reusable across api + portal + worker
without a new package.

Adds `@psp-new/events` to `@psp-new/outbox` deps.

### Events emitted

| Event | Triggered from | Body |
|---|---|---|
| `card_load.succeeded` | `loadCard` in `payment-engine/orchestrator.ts` (inside the existing approve-path tx) | `{id, object:'card_load', card, amount, currency, status, response_code, rrn, stan}` |
| `card_load.refunded` | `POST /v1/card_loads/:id/refund` (inside the existing refund tx) | same shape, status: 'refunded' |
| `card.frozen` | `POST /cards/:id/freeze` (portal) — refactored to wrap the UPDATE in a tx + RETURNING | `{id, object:'card', status, last4}` |
| `card.unfrozen` | `POST /cards/:id/unfreeze` (portal) — same | same shape, status: 'active' |

Each emit is inside the same DB tx as the state change, so events are
all-or-nothing with the business write.

### CLI

```
pnpm cardholder:webhook \
  --cardholder ch_... \
  --url https://example.com/webhook \
  [--events 'card_load.*,card.*'] \
  [--description 'my listener']
```

Generates a `whsec_<64-hex>` secret, inserts the row, prints the secret
once (caller stores it; we never display it again).

### Test

`apps/outbox-relay/src/drainer.test.ts` (HAS_DB-gated):
seeds cardholder + endpoint + outbox row with `headers.cardholder_id`,
runs `drainOnce`, asserts the BullMQ stub got one (event, endpoint) job
and the outbox row is marked delivered.

## Demo path (manual, not automated)

```bash
# 1. Cardholder + signin password (Phase 22).
pnpm cardholder:create --email a@b --name Alice
pnpm cardholder:set-password --cardholder ch_... --password ...

# 2. Issue a card (Phase 9/23).
pnpm card:issue --cardholder ch_... --product prod_strawberry_visa_usd

# 3. Mock receiver:
node -e "require('node:http').createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{console.log(req.headers['webhook-signature']);console.log(b);res.end('ok')})}).listen(9876)" &

# 4. Register endpoint.
pnpm cardholder:webhook --cardholder ch_... --url http://localhost:9876 --events 'card_load.*,card.*'

# 5. Make state happen.
pnpm card:load --merchant m_... --card card_... --amount 5000   # → card_load.succeeded
curl -X POST :3000/v1/card_loads/cl_.../refund -H "Authorization: Bearer sk_..."  # → card_load.refunded
# Sign in to portal as admin → freeze the card → card.frozen / card.unfrozen.

# 6. Wait ~1s for outbox-relay drain + bullmq deliver.
# Mock receiver should print three signed POSTs.
```

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` | 60/60 green |
| Manual demo | Not run in this session — covered above |

## Simplifications vs. real life

Documented in `PHASE_26_PLAN.md §Out of scope`:

- **No cardholder-portal UI** for endpoint management. CLI only. Phase 27.
- **No per-card scoping**. An endpoint registered against a cardholder
  receives events for ALL of that cardholder's cards.
- **Limited event coverage**. `card.created`, `card_auth.*`,
  `cardholder.*` are NOT emitted. Trivial to add when needed; we shipped
  three to prove the pipeline.
- **No retry-from-deadletter UI** for cardholders.
- **No `/v1/cardholder/webhook_endpoints` REST API**. CLI is the
  provisioning surface for now.

## What this enables next

Open list:
- **Cardholder portal `/cardholder/webhooks` UI** — list / create /
  disable endpoints, view recent attempts. Smallest natural follow-on.
- **Cardholder REST API** — `/v1/cardholder/*` endpoints (cards,
  balance, transactions, webhooks). Needs cardholder API keys.
- **Auto-top-up rules** — needs cardholder-scoped payment methods.
- **Real Base II / IPM parsing** — largest remaining unblocked item.
