# Phase 32 — Plan

**Goal:** make the idempotency plugin cardholder-aware so
`POST /v1/cardholder/*` routes can be replayed safely. Today the
plugin assumes every authenticated request carries `req.merchantId`
and throws `internal_error` ("idempotency plugin found no merchant id
on request") on any cardholder-auth'd POST.

## Why this is a bug, not a missing feature

- Phase 30 shipped `POST /v1/cardholder/webhook_endpoints` and
  `POST /v1/cardholder/webhook_endpoints/:id/disable`. Both authenticate
  via `csk_test_…` keys (`cardholderAuthPlugin`), which sets
  `req.cardholderId` and never `req.merchantId`.
- The idempotency plugin runs on every state-changing request unless
  the route opts out. Cardholder routes don't opt out. They hit the
  `merchantId === undefined` branch at
  `packages/idempotency/src/index.ts:68-75` and 500 every time.
- Phase 31 added an integration test for the create-endpoint flow but
  the test doesn't send an `Idempotency-Key` header, so it trips the
  `idempotency_key_missing` 400 path before it ever reaches the
  merchant_id check. Running `pnpm --filter @psp-new/api test` with
  `DATABASE_URL` set today produces:

  ```
  cardholder.test.ts:135  expected 201, received 400
  ```

  The root `pnpm test` reports 60/60 only because every DB-gated suite
  self-skips when `DATABASE_URL` is unset.

## Scope

- New table `paycore.cardholder_idempotency_keys`, structurally
  identical to `paycore.idempotency_keys` but keyed by `(cardholder_id,
  key)` instead of `(merchant_id, key)`. Parallel-table pattern,
  matching Phase 30's `cardholder_api_keys` (and the CLAUDE.md
  "Don't extend merchant code … add a parallel cardholder table" rule).
- Migration `0031_cardholder_idempotency_keys.sql`.
- `packages/db/src/kysely.ts` — add `'paycore.cardholder_idempotency_keys'`
  type alongside the existing one.
- `packages/idempotency/src/index.ts`:
  - In `preHandler` + `onSend`, detect whether the request was
    authenticated as cardholder (`req.cardholderId` set) or merchant
    (`req.merchantId` set). Route reads/writes to the matching table.
  - Merchant code path is unchanged byte-for-byte; the cardholder path
    is a parallel branch.
  - If neither id is set on a POST/PUT/PATCH/DELETE that wasn't opted
    out, keep the existing `internal_error` (now phrased generically as
    "no principal id on request").
- `apps/api/src/routes/v1/cardholder.test.ts`:
  - Add `idempotency-key` header to the existing POST test so it actually
    reaches the route handler.
  - Add one new test: replay the same key + body → 201 with
    `idempotency-replay: true` header and identical body. This catches
    the next regression on the cardholder path.

## Out of scope

- Reworking the merchant-side idempotency table or behavior.
- Polymorphic XOR on `paycore.idempotency_keys`. Considered and
  rejected: the parallel-table pattern is the codebase convention for
  cardholder/merchant splits where the data shape happens to overlap.
- Cardholder-scoped TTLs, rate limiting, or admin tooling for the
  cardholder keys table.
- Merchant integration tests for idempotency (the merchant path is
  already exercised in production-shaped curl flows; no regression
  observed).
- Janitor sweep for expired cardholder keys. The merchant table also
  doesn't have one shipped today; out of scope for this phase.

## Files touched

| File | Change |
|---|---|
| `packages/db/migrations/0031_cardholder_idempotency_keys.sql` | new |
| `packages/db/src/kysely.ts` | + table type |
| `packages/idempotency/src/index.ts` | branch on principal |
| `apps/api/src/routes/v1/cardholder.test.ts` | add header + replay test |

No new packages, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `pnpm typecheck` | `Tasks: 60 successful, 60 total` |
| `pnpm test` (no DB) | `Tasks: 60 successful, 60 total` (DB suites skip) |
| `DATABASE_URL=… pnpm --filter @psp-new/api test --run` | 7/7 (includes new replay test) |
| Manual: `curl -X POST /v1/cardholder/webhook_endpoints -H "Idempotency-Key: …"` | 201, with `secret` |
| Manual: replay same key → `idempotency-replay: true`, same body | passes |
| Manual: same key, different body → 422 `idempotency_key_reused_with_different_body` | passes |
