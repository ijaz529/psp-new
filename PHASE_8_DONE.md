# Phase 8 — Done

**Date:** 2026-05-18 · **Status:** Portal authentication + dashboard + KYB landed.

---

## What was built

- **Migration 0016** — `paycore.portal_users`, `paycore.portal_sessions`, `merchants.kyb_status`, `merchants.kyb_data`.
- **`packages/portal-auth`** — scrypt password hashing (N=2^15, r=8, p=1, 64-byte output, `maxmem: 128MiB`), signed cookie sessions (sha256-hashed tokens at rest), `createSession` / `resolveSession` / `revokeSession` / cookie builders. TOTP scaffold (`totp_secret` column) but enrollment UI deferred.
- **`apps/portal`** — now a real admin portal:
  - Public: `/` (sign-up), `/signin` (login).
  - Authenticated: `/dashboard`, `/merchants`, `/merchants/:id`, KYB submission form, `/signout`.
  - Session middleware on every non-public route → redirect to `/signin` if missing/expired.
- **CLI**: `pnpm --filter @psp-new/portal user:create --email ... --name ... --password ...` to bootstrap an admin.

## Phase 8 deviations from the original plan (Q recap)

| Plan | Reality |
|---|---|
| Next.js 16 App Router rewrite | Kept Fastify-rendered HTML — equivalent functionality, half the deps, ships in one session. The brand-new tokens still come from the same DB; a Next.js swap is mechanical when needed (Phase 9+). |
| TOTP enrollment | `totp_secret` column ships; enrollment UI is Phase 9. |
| Per-merchant tenant separation | Phase 8 ships single-tenant admin (any signed-in user sees every merchant). Per-merchant scoping lands when we have a real customer who needs it. |

## Tests

- `packages/portal-auth/src/index.test.ts` — 8 tests on hash round-trip, salt uniqueness, malformed input, cookie helpers.

## Demo

```bash
make up && make migrate

# Bootstrap an admin user (only needs to happen once)
pnpm --filter @psp-new/portal user:create --email admin@example.com --name "Admin" --password "strawberry-portal-2026"

# Browse to http://localhost:3000/signin, log in.
# Then create some merchants via the existing /sign-up flow or `pnpm merchant:create`,
# run a few PaymentIntents through the API, and the dashboard at /dashboard will
# show recent transactions, payouts, and disputes.
```

Phase 9 (issuing side) is marked optional in PROJECT_BRIEF.md §3 and remains out of scope.
