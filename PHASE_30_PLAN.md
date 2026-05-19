# Phase 30 — Cardholder REST API (`/v1/cardholder/*`)

**Goal.** Cardholder-authenticated REST API for the operations that
previously only existed in the portal UI. Built on a net-new
`csk_<env>_<hex>` API key scheme. Unlocks third-party integrations
against a cardholder (mobile clients, automation, etc.).

## Design decisions (no asks — committing here)

1. **Net-new `paycore.cardholder_api_keys`** — not extending
   `paycore.api_keys`. Reasoning: cleaner schema (no nullable
   `merchant_id`), no kind distinction (cardholders only get secret
   keys), routes never cross-resolve.
2. **Key shape**: `csk_test_<64-hex>` / `csk_live_<64-hex>`.
3. **Storage**: same shape as merchant keys — `prefix` + `sha256_hash`.
   The full key is shown ONCE at create time, then only the prefix
   surfaces.
4. **Bootstrap**: both portal UI (`/cardholder/api-keys`) and CLI
   (`pnpm cardholder:api-key`).
5. **Scope**: a `csk_` key authorizes all reads on the cardholder's
   own resources + webhook-endpoint mgmt. No write operations on cards
   themselves (freeze/unfreeze stays portal-only this phase; can revisit
   in a future phase).

## Migration `0030_cardholder_api_keys.sql`

```sql
create table paycore.cardholder_api_keys (
  id              text primary key,
  cardholder_id   text not null references paycore.cardholders(id),
  env             text not null check (env in ('test','live')),
  prefix          text not null,
  sha256_hash     text not null,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
create index cardholder_api_keys_cardholder_idx
  on paycore.cardholder_api_keys (cardholder_id);
create unique index cardholder_api_keys_hash_idx
  on paycore.cardholder_api_keys (sha256_hash);
```

Kysely type updated in `packages/db/src/kysely.ts`.

## `@psp-new/api-keys` extensions

```ts
export function generateCardholderApiKey(opts: { env: 'test' | 'live' }): {
  id: string;
  prefix: string;     // 'csk_test_<6hex>'
  raw: string;        // 'csk_test_<64hex>' — show ONCE
  sha256Hash: string;
}
```

Mirrors the existing `generateApiKey` shape; surgical addition.

## Auth verifier

New `apps/api/src/lib/cardholder-auth.ts`:
- `resolveCardholderKey(db, rawHeader) → { cardholderId } | null`
- Fastify preHandler that runs on `/v1/cardholder/*`, reads
  `Authorization: Bearer csk_…`, attaches `req.cardholderId` on success
  or returns 401.
- Updates `last_used_at`.

Registered in `apps/api/src/index.ts` (or wherever route plugins boot).
The middleware only fires on paths starting with `/v1/cardholder/`;
existing merchant routes are untouched.

## Routes (`apps/api/src/routes/v1/cardholder.ts`, new file)

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/cardholder/me` | Cardholder profile (id, email, name, status, created) |
| GET | `/v1/cardholder/cards` | List own cards |
| GET | `/v1/cardholder/cards/:id` | Card detail with funded + holds balances |
| GET | `/v1/cardholder/card_loads` | List recent card loads across all their cards (last 50) |
| GET | `/v1/cardholder/webhook_endpoints` | List endpoints |
| POST | `/v1/cardholder/webhook_endpoints` | Create one (returns secret ONCE) |
| POST | `/v1/cardholder/webhook_endpoints/:id/disable` | Soft-disable |

All routes filter on `cardholder_id = req.cardholderId`. No 403 leakage
— missing rows return 404 just like the portal.

## Portal UI (`/cardholder/api-keys`)

Mirror of `/cardholder/webhooks` from Phase 27:
- GET `/cardholder/api-keys` — list (id, prefix, env, created, last used, revoked status)
- GET `/cardholder/api-keys/new` — form (env: test|live)
- POST `/cardholder/api-keys` — create + render the one-time full-key view
- POST `/cardholder/api-keys/:id/revoke` — soft-revoke

Adds an "API keys" link to the cardholder nav.

## CLI

`apps/api/cli/cardholder-api-key.ts`:
```
pnpm cardholder:api-key --cardholder ch_… --env test
```
Generates a key, inserts the row, prints `csk_…` once.

## Tests

- `@psp-new/api-keys`: unit test for `generateCardholderApiKey` shape
  + hash determinism.
- `apps/api/src/lib/cardholder-auth.test.ts` (HAS_DB-gated): create
  cardholder + key, resolve via `resolveCardholderKey`, assert success
  + `last_used_at` updated.
- `apps/api/src/routes/v1/cardholder.test.ts` (HAS_DB-gated): hit
  `/v1/cardholder/me` with a valid `csk_`, assert 200 + body shape;
  hit with garbage, assert 401.

## Out of scope

- Card freeze/unfreeze via REST. Portal-only this phase.
- Card-load creation via REST (cardholders don't auth their own loads —
  merchants do).
- Webhook attempt replay endpoint.
- API rate-limiting beyond what `@psp-new/http-server` provides today.
- Mobile-friendly OAuth flow for cardholder API key issuance.
- Idempotency keys on cardholder writes (only webhook create is a
  write — low-risk).

## Verify

1. `pnpm typecheck` green across all 60 packages.
2. `pnpm test` green.
3. Manual: create cardholder + key via CLI, curl
   `GET /v1/cardholder/me` with the key, see profile; curl a webhook
   create, see one-time secret in response; refresh portal UI, see the
   endpoint listed.

## Files touched

- `packages/db/migrations/0030_cardholder_api_keys.sql` (new)
- `packages/db/src/kysely.ts` (table schema)
- `packages/api-keys/src/index.ts` (generateCardholderApiKey)
- `packages/api-keys/src/index.test.ts` (extend)
- `apps/api/src/lib/cardholder-auth.ts` (new)
- `apps/api/src/lib/cardholder-auth.test.ts` (new)
- `apps/api/src/routes/v1/cardholder.ts` (new)
- `apps/api/src/routes/v1/cardholder.test.ts` (new)
- `apps/api/src/index.ts` (register routes + preHandler)
- `apps/api/cli/cardholder-api-key.ts` (new)
- `apps/api/package.json` (cardholder:api-key script)
- `apps/portal/src/api-keys-views.ts` (new)
- `apps/portal/src/index.ts` (4 new routes + nav link)
- `apps/portal/src/cards-views.ts` (add "API keys" to cardholder nav)
- `PHASE_30_DONE.md`
