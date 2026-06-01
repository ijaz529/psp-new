# Phase 32 — Done

**Date:** 2026-06-01 · **Status:** Cardholder POSTs unblocked. Plan: `PHASE_32_PLAN.md`.

`POST /v1/cardholder/*` previously 500'd with
`idempotency plugin found no merchant id on request`. The plugin now
resolves a polymorphic principal (`merchant` | `cardholder`) and
reads/writes to the table that matches.

## What shipped

### Migration `0031_cardholder_idempotency_keys.sql`

Mirror of `paycore.idempotency_keys` keyed by `cardholder_id`:
- Same columns (`key`, `method`, `path`, `request_hash`,
  `response_status`, `response_body`, `locked_at`, `completed_at`,
  `expires_at`, `created_at`).
- Primary key `(cardholder_id, key)`.
- `expires_at` index for an eventual janitor sweep.

Parallel-table pattern, matching Phase 30's
`paycore.cardholder_api_keys`. No changes to the existing merchant
table or its indexes.

### `@psp-new/idempotency`

- Plugin now resolves a `Principal = { kind: 'merchant'; id } | { kind:
  'cardholder'; id }`. Cardholder wins if both somehow set (defensive).
- Three small helpers (`loadExisting`, `insertFresh`, `writeCompleted`)
  branch on `principal.kind` so the Kysely query is correctly typed
  against the right table. Identical decision tree (`processExisting`)
  on both branches.
- `FastifyRequest` now declares `cardholderId?: string` so the plugin
  can read it without importing from the API app.
- Error wording: `internal_error` reason changed from "no merchant id"
  to "no principal id" — the user-facing payload still surfaces only
  the generic message + `request_id`.

### `@psp-new/db`

Added `'paycore.cardholder_idempotency_keys'` to the Kysely
`Database` interface — same shape as the existing entry, swap
`merchant_id` → `cardholder_id`.

### `apps/api/src/routes/v1/cardholder.test.ts`

- The existing POST test now actually sends an `Idempotency-Key`
  header. Without it, the test was tripping the
  `idempotency_key_missing` 400 path before reaching the route
  handler, which is why the bug wasn't caught earlier.
- New replay test: POST same key + same body → second response is
  201 with `idempotency-replay: true` and the cached body.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` (no DB) | 60/60 — DB-gated suites skip cleanly |
| `DATABASE_URL=… pnpm --filter @psp-new/api test --run` | 8/8 green (was 6/8 before) |
| Live `curl -X POST /v1/cardholder/webhook_endpoints -H "Idempotency-Key:…"` | 201 + `secret` |
| Replay same key + body | 201 + `idempotency-replay: true`, body matches |
| Same key + different body | 422 `idempotency_key_reused_with_different_body` |

## What did NOT change

- Merchant `paycore.idempotency_keys` table — same columns, same
  index, same query path.
- `IdempotencyOptions.resolveMerchantId` — still honored for the
  merchant branch.
- Cardholder route configs — `POST /v1/cardholder/webhook_endpoints*`
  routes were already correctly gated by `requireCardholderKey: true`;
  the plugin just couldn't act on it.
- Error codes (`idempotency_key_missing` / `_invalid` / `_in_use` /
  `_reused_with_different_body`) — same wire shape, same HTTP
  statuses.
- `PHASE_30_DONE.md`'s manual demo recipe was missing an
  `Idempotency-Key` on the POST curl; **that recipe still wouldn't
  work as printed**. The fix is to add the header — adjust future
  demo docs accordingly, but we're not retroactively editing Phase 30.

## Latent bug found while running this phase (not fixed here)

`packages/logger/src/redaction.ts#maskPanDeep` mutates the input
object in place. When Pino calls it via the `formatters.log` hook to
serialize an incoming-request record, it walks `req.headers` and
replaces any string value containing 12+ consecutive digits between
non-alphanumerics with the masked form (`123456******1234`). The
mutation is visible to every plugin that reads `req.headers` AFTER
the request log fires.

Concretely: a test key like `t-${Date.now()}-<random>` has a 13-digit
`Date.now()` between hyphens, which the PAN regex matches. By the
time the idempotency plugin reads `req.headers['idempotency-key']`,
the value is `t-178030******1592-…` — fails the
`/^[A-Za-z0-9_-]{1,255}$/` check, 400 `idempotency_key_invalid`.

Workaround in this phase: tests use `randomUUID()`-based keys, which
have hyphens between hex segments and no 12+ digit runs.

The real fix is to make `maskPanDeep` return a copy instead of
mutating — or to scope its mutation to a serialized clone Pino has
already produced. That's a logger-package phase on its own; flagged
here so the next person picking it up has the repro.

## Open list (Phase 31's list, with one item closed and one new)

- ~~Auto-top-up rules~~ — still blocked by missing cardholder-scoped
  payment methods.
- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- TC 25 / MTI 1442 chargeback scheme-file fan-out from Phase 25.
- Merchant route integration tests (unblocked since Phase 31).
- **NEW:** Fix logger redaction to not mutate request headers in
  place — see "Latent bug" above.
- **NEW:** Janitor sweep for expired
  `paycore.cardholder_idempotency_keys` (symmetric to whatever
  eventually lands for the merchant table).
