# Phase 30 — Done

**Date:** 2026-05-19 · **Status:** Cardholder REST API shipped end-to-end. Plan: `PHASE_30_PLAN.md`.

`/v1/cardholder/*` is live, authenticated by `csk_<env>_<hex>` API
keys. Cardholders can now do via REST what was portal-UI-only after
phases 22 (signin), 27 (webhooks UI). Key management is self-serve
through the portal (and CLI as bootstrap).

## What shipped

### Migration `0030_cardholder_api_keys.sql`

New `paycore.cardholder_api_keys` parallel to the merchant
`paycore.api_keys`:
- `prefix` + `sha256_hash` for O(1) hash-lookup auth.
- `env` check (`test`|`live`).
- Unique index on `sha256_hash`.
- Cardholder-scoped index for list queries.
- No `kind` column — cardholders only get secret keys.

### `@psp-new/api-keys`

- `generateCardholderApiKey({env}) → {id, raw, prefix, sha256Hash, env}`
- `parseCardholderApiKeyFormat(raw) → {env} | null`
- Key shape: `csk_test_<43 base64url chars>` / `csk_live_…`.
- Prefix: `csk_test_<6>` = 13 chars.
- Reuses existing `hashApiKey` so storage/lookup is identical to
  merchant keys.

### `@psp-new/ids`

New resource kind `cardholder_api_key` → prefix `chak_`.

### `apps/api/src/lib/cardholder-auth.ts`

New Fastify plugin (`cardholderAuthPlugin`), registered alongside
`apiKeyAuthPlugin`:

- Preflight: only acts when route config has
  `requireCardholderKey: true`. Existing merchant routes untouched.
- Reads `Authorization: Bearer csk_…`, hashes, looks up in
  `paycore.cardholder_api_keys`, attaches `req.cardholderId` +
  `req.cardholderApiKeyId`.
- Touches `last_used_at` async (best-effort, errors swallowed).
- Throws the same error codes the merchant plugin uses
  (`api_key_missing` / `api_key_invalid` / `api_key_revoked`).

Plus `getCardholderId(req)` helper mirroring `getMerchantId`.

### `apps/api/src/routes/v1/cardholder.ts`

Seven routes, all gated by
`config: { skipApiKey: true, requireCardholderKey: true }`:

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/cardholder/me` | profile |
| GET | `/v1/cardholder/cards` | list cards (with `available` balance) |
| GET | `/v1/cardholder/cards/:id` | detail (funded + holds balances) |
| GET | `/v1/cardholder/card_loads` | last 50 loads across all cards |
| GET | `/v1/cardholder/webhook_endpoints` | list endpoints |
| POST | `/v1/cardholder/webhook_endpoints` | create + return `secret` ONCE |
| POST | `/v1/cardholder/webhook_endpoints/:id/disable` | soft-disable |

All `WHERE cardholder_id = req.cardholderId`. No URL can reach another
cardholder's data.

### CLI

```
pnpm cardholder:api-key --cardholder ch_… [--env test|live]
```
Generates, inserts, prints `csk_…` once.

### Portal UI

`/cardholder/api-keys` (added to cardholder nav):
- `GET /cardholder/api-keys` — list (id, prefix, env, created, last used, revoke button)
- `GET /cardholder/api-keys/new` — form (env select)
- `POST /cardholder/api-keys` — create + render the one-time full-key view
- `POST /cardholder/api-keys/:id/revoke` — soft-revoke

Mirror of the Phase 27 webhooks UI shape.

### Tests

`@psp-new/api-keys` extended (4 new tests, all unit):
- `csk_<env>_<hex>` shape + `chak_` id prefix + 64-hex SHA-256
- `hashApiKey` round-trips deterministically against `generateCardholderApiKey`
- `parseCardholderApiKeyFormat('csk_live_…')` returns `{env:'live'}`
- Merchant-style keys rejected by `parseCardholderApiKeyFormat`

15/15 in api-keys, 60/60 across all packages.

REST integration tests deferred — apps/api has no test scaffolding
today (`--passWithNoTests`). Adding Fastify-inject scaffolding is
a separate phase. See "Manual demo" below.

## Manual demo

```bash
# 1. Cardholder + password (phase 22).
pnpm cardholder:create --email a@b --name Alice
pnpm cardholder:set-password --cardholder ch_… --password ...

# 2. Provision an API key.
pnpm cardholder:api-key --cardholder ch_… --env test
# → copy the printed csk_test_…

# 3. Start the api.
pnpm --filter @psp-new/api dev

# 4. Hit the API.
curl :3000/v1/cardholder/me \
  -H "Authorization: Bearer csk_test_…"
# → 200 {id, object:'cardholder', email, ...}

curl :3000/v1/cardholder/cards \
  -H "Authorization: Bearer csk_test_…"
# → {object:'list', data:[…]}

# 5. Create a webhook endpoint via REST.
curl -X POST :3000/v1/cardholder/webhook_endpoints \
  -H "Authorization: Bearer csk_test_…" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.test/wh","enabled_events":["card_load.*"]}'
# → 201 {id, secret, ...} — secret shown ONCE

# 6. Portal: sign in as cardholder → /cardholder/api-keys → revoke.
```

## What did NOT change

- Existing merchant `sk_`/`pk_` routes — unchanged.
- Webhook delivery infra (Phase 26) — already cardholder-aware.
- Card freeze/unfreeze (portal-only this phase; can revisit if a use
  case emerges).
- Idempotency plugin — runs as before, cardholder routes don't write
  much besides webhook endpoint create.

## Out of scope

- **Card freeze/unfreeze via REST.** Portal-only this phase.
- **Card-load creation via REST.** Merchants own that endpoint.
- **Webhook attempt replay endpoint** for cardholders.
- **Per-resource rate limiting.** http-server defaults apply.
- **Mobile-friendly OAuth flow** for cardholder API key issuance.
- **REST integration tests.** Need apps/api test scaffolding first.

## What this enables next

Open list:
- **Auto-top-up rules** — still blocked: needs cardholder-scoped
  payment methods (cards today only know about merchant-owned PMs).
- **Webhook deadletter replay UI for cardholders** — symmetric to
  merchant side.
- **Per-card endpoint scoping** — current model is per-cardholder.
- **TC 25 / MTI 1442 chargeback records** — Phase 25 card-load
  refunds could fan out to scheme files.
- **apps/api test scaffolding** — would unlock REST integration tests
  for the new cardholder routes (and existing merchant routes).
