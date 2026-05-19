# Phase 31 — `apps/api` test scaffolding + cardholder REST tests

**Goal.** Retroactively cover the Phase 30 cardholder REST API with
integration tests, AND establish the pattern other API integration
tests can copy. `apps/api/package.json` already has vitest + a vitest
config; what's missing is a test harness and any actual tests.

## Why

PHASE_30_DONE.md noted REST tests were deferred because `apps/api`
has no scaffolding. That defer is the right call for one phase, but
the API has 15+ route files (payment intents, refunds, customers,
webhooks, cards, cardholder, etc.) and they have ZERO direct
integration tests today. Most logic is covered indirectly through
`packages/payment-engine/src/orchestrator.test.ts` but route-level
concerns (auth gating, status codes, response shapes) aren't.

Locking in the harness now means future API phases can add tests
without re-scaffolding.

## Scope

Tight. This phase ONLY ships:

1. **The harness** — `apps/api/src/__tests__/helpers.ts`:
   - Sets `SERVICE_AUTH_SECRET` for context construction.
   - Boots `buildApi()` with a real DB pool (HAS_DB-gated).
   - Runs migrations (re-using `@psp-new/db` migrateUp pattern from
     worker tests).
   - Provides factories: `createCardholder()`, `createCardholderKey()`,
     `revokeCardholderKey()` so tests don't repeat insert boilerplate.
   - Cleanup helper to close the app + pool.

2. **Cardholder route tests** — `apps/api/src/routes/v1/cardholder.test.ts`:
   - `401 api_key_missing` when no Authorization header
   - `401 api_key_invalid` when malformed (`Bearer garbage`)
   - `401 api_key_invalid` when key shape OK but not in DB
   - `401 api_key_revoked` when revoked
   - `200` on `/v1/cardholder/me` with valid key — body shape matches
   - `200` on `/v1/cardholder/cards` returns own cards only — isolation
     proven by inserting a 2nd cardholder's card and asserting it's
     absent from the first cardholder's list

Tests use `fastifyInstance.inject()` — no real network.

## Out of scope

- Tests for the entire merchant API surface. That'd be Phase 32+ work
  copying this harness pattern. This phase only proves Phase 30 routes
  end-to-end.
- Webhook fanout assertions across the BullMQ queue. That'd need a
  fake Redis or a queue stub — too much for one phase.
- Tests for the portal UI routes (`/cardholder/api-keys` etc.). Portal
  has its own `--passWithNoTests` story; can be a parallel phase.
- API key rotation flows (revoke a key, prove no further requests
  work). The revoked-key test in the list above covers the read path;
  rotation UI is portal-only anyway.

## Files

- `apps/api/src/__tests__/helpers.ts` (new)
- `apps/api/src/routes/v1/cardholder.test.ts` (new)
- `apps/api/package.json` — flip `--passWithNoTests` off so a missing
  test file would fail CI in the future. (Wait — that'd break this
  commit if HAS_DB isn't set. Actually: keep `--passWithNoTests` for
  the case where HAS_DB is unset; the test file is `describe.skipIf(!HAS_DB)`
  so on a no-DB run it's empty-but-not-missing, which `vitest run`
  treats as passing. Leave the flag alone.)
- `PHASE_31_DONE.md`

## Verify

1. `pnpm typecheck` green across all 60 packages.
2. `pnpm test` green:
   - Without DB: 60/60 (existing behavior — cardholder.test.ts is
     describe.skipIf(!HAS_DB) so it adds zero tests).
   - With DB (DATABASE_URL set): 60/60 + the new cardholder tests
     run for real.
3. Manual: set `DATABASE_URL`, `SERVICE_AUTH_SECRET`, run
   `pnpm --filter @psp-new/api test`, see green output.
