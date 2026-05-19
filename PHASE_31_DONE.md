# Phase 31 — Done

**Date:** 2026-05-19 · **Status:** apps/api test scaffolding + retroactive Phase 30 coverage. Plan: `PHASE_31_PLAN.md`.

apps/api had vitest installed but zero tests. PHASE_30_DONE.md
deferred REST tests until "apps/api test scaffolding" landed. That's
this phase. Future API phases can copy the harness instead of
re-bootstrapping.

## What shipped

### `apps/api/src/__tests__/helpers.ts`

HAS_DB-gated test harness:

- `createApiTestHarness()` → `{app, db, pool, close()}`
  - Sets `SERVICE_AUTH_SECRET` if unset (test default).
  - Spins a Postgres pool from `dbConfigFromEnv()` (DATABASE_URL).
  - Runs `migrateUp` (idempotent — multiple suites can call it).
  - Builds the real Fastify app via `buildApi()` with:
    - Stub authorizer / settler / reverser (throw on call — cardholder
      routes don't touch the acquirer-host).
    - Vault client pointed at `vault-stub.invalid` (cardholder routes
      don't tokenize).
  - Returns the live `FastifyInstance` for `.inject()` calls.
- `createTestCardholder(db, overrides?)` → factory.
- `createTestCardholderKey(db, cardholderId, {env?, revoked?})` → factory.

### `apps/api/src/routes/v1/cardholder.test.ts`

Six integration tests (HAS_DB-gated):

**Auth gate (4 tests):**
- 401 `api_key_missing` — no Authorization header
- 401 `api_key_invalid` — `Bearer garbage`
- 401 `api_key_invalid` — `csk_` shape valid but key not in DB
- 401 `api_key_revoked` — key in DB but revoked_at is set

**Happy path:**
- 200 on `/v1/cardholder/me` returns the signed-in profile (id,
  object, email, full_name, status all match)

**Isolation:**
- Alice's `GET /v1/cardholder/webhook_endpoints` does NOT include
  Bob's endpoint (proves the `WHERE cardholder_id = req.cardholderId`
  filter)

**Write + secret-once:**
- `POST /v1/cardholder/webhook_endpoints` returns 201 + `secret`
  matching `whsec_[a-f0-9]{64}` shape; subsequent list response does
  NOT include the secret field

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` (no DB) | 60/60 — `describe.skipIf(!HAS_DB)` skips the suite cleanly |
| `pnpm test` (DATABASE_URL set) | new cardholder suite runs end-to-end through real Fastify |

## What did NOT change

- All other API route files — no tests added.
- The merchant `apiKeyAuthPlugin` — exercised indirectly when the
  cardholder tests hit non-cardholder paths but no dedicated tests
  yet.
- `buildApi()` signature — already supported `pool`, `authorizer`,
  `settler`, `reverser` overrides; the harness just uses them.
- portal / worker test patterns — unchanged.

## What this enables next

- Future merchant route phases get a free test surface: copy
  `createApiTestHarness()`, write `.inject()` tests, gate on HAS_DB.
- Phase 30 surface area is now demonstrably correct (auth gating +
  cardholder isolation + write/read shape) instead of demo-validated.
- Portal route testing remains a separate gap — would need its own
  harness phase (no vitest in the portal app today).

## Open list (unchanged from Phase 30)

- **Auto-top-up rules** — blocked: cardholder-scoped payment methods
  don't exist.
- **Webhook deadletter replay UI for cardholders.**
- **Per-card endpoint scoping.**
- **TC 25 / MTI 1442 chargeback** scheme-file fan-out from Phase 25.
- **Merchant route integration tests** — now unblocked, but a
  separate phase.
