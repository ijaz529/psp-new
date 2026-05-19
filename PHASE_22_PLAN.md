# Phase 22 — Cardholder identity surface (Plan)

**Status:** Proposed for review · **Predecessor:** Phase 21 (`PHASE_21_DONE.md`).

Closes the longest-running open item. Since Phase 9 every phase has
written "deferred — cardholder webhooks have no identity surface yet."
Phase 22 ships that surface: cardholders can set a password, sign in to
a `/cardholder/*` namespace in the portal, and see only their own cards.

This is foundation, not feature-complete cardholder UX. It unblocks
future phases that need cardholder-scoped state (webhooks, real
cardholder API, magic-link/SSO).

---

## Scope

A second portal session domain alongside the existing admin sessions
from Phase 8. Cardholders have their own:
- Password column on `paycore.cardholders`
- Sessions table (`paycore.cardholder_sessions`)
- Session cookie (`strawberry_cardholder_session`, distinct from admin)
- Sign-in flow at `/cardholder/signin`
- Cards routes at `/cardholder/cards` and `/cardholder/cards/:id`

Admin's existing `/cards` routes stay as-is (all cards, admin view).
The new `/cardholder/cards` shows only the signed-in cardholder's cards.

Bootstrap: admin creates cardholder via existing `pnpm cardholder:create`,
then runs `pnpm cardholder:set-password --email X --password Y`. No
sign-up form, no magic-link. Future phases can layer those on.

---

## Pieces

| Piece | What | Where |
|---|---|---|
| **0025 migration** | `cardholders.password_hash text` (nullable); `paycore.cardholder_sessions` table + indexes | `packages/db/migrations/0025_cardholder_identity.sql` |
| **Kysely types** | New column + table | `packages/db/src/kysely.ts` |
| **`portal-auth`** | Add `createCardholderSession`, `resolveCardholderSession`, `revokeCardholderSession`, `CARDHOLDER_SESSION_COOKIE`, `buildSetCardholderCookie`, `buildClearCardholderCookie`, `readCardholderSessionCookie`. Parallel to admin helpers; share crypto. | `packages/portal-auth/src/index.ts` |
| **CLI** | `pnpm cardholder:set-password --email X --password Y` | `apps/api/cli/cardholder-set-password.ts` |
| **Portal routes** | `GET/POST /cardholder/signin`, `GET /cardholder/signout`, `GET /cardholder/cards`, `GET /cardholder/cards/:id` | `apps/portal/src/index.ts` |
| **Views** | Reuse Phase 12 `cardsListPage` + `cardDetailPage` (admin all-card and cardholder scoped share the same UI; cardholder gets a different nav). | `apps/portal/src/cards-views.ts` (add optional `subtitle`/`scope` to differentiate) |
| **Tests** | Add cardholder session round-trip tests in `portal-auth/src/index.test.ts` | same |

---

## Schema delta (0025)

```sql
-- Password column. Nullable because most existing cardholders won't have one
-- set yet (admin creates them, then optionally sets a password via CLI).
alter table paycore.cardholders
  add column password_hash text;

-- Mirror of paycore.portal_sessions, scoped to cardholders.
create table paycore.cardholder_sessions (
  id              text primary key,
  cardholder_id   text not null references paycore.cardholders(id) on delete cascade,
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index cardholder_sessions_cardholder_idx
  on paycore.cardholder_sessions (cardholder_id);
create index cardholder_sessions_active_idx
  on paycore.cardholder_sessions (token_hash)
  where revoked_at is null;

grant select, insert, update on paycore.cardholder_sessions to psp_app;
```

---

## portal-auth additions

```ts
export const CARDHOLDER_SESSION_COOKIE = 'strawberry_cardholder_session';

export async function createCardholderSession(
  db: Kysely<Database>,
  cardholderId: string,
): Promise<{ token: string; sessionId: string }>;

export async function resolveCardholderSession(
  db: Kysely<Database>,
  token: string,
): Promise<{ cardholder: Database['paycore.cardholders']; sessionId: string } | null>;

export async function revokeCardholderSession(db: Kysely<Database>, sessionId: string): Promise<void>;

export function buildSetCardholderCookie(token: string): string;
export function buildClearCardholderCookie(): string;
export function readCardholderSessionCookie(cookieHeader: string | undefined): string | null;
```

All mirror the existing admin helpers; they're slight duplication for now
(a future refactor can factor into a generic session helper). 30-day
expiry, same as admin.

---

## Portal routing

`preHandler` widens its public-paths set:
```ts
const PUBLIC_PATHS = new Set([
  '/', '/sign-up', '/signin', '/healthz', '/readyz', '/metrics',
  '/cardholder/signin',  // NEW
]);
```

It also tries to resolve a cardholder session if no admin session is
present (so a single shared route guard works). Routes under
`/cardholder/*` use a small `requireCardholder` helper that throws if
the cardholder slot is empty (just like the existing `requireUser` for
admin).

New routes:
- `GET /cardholder/signin` — HTML form
- `POST /cardholder/signin` — verifies password, creates session, sets cookie, 302 to `/cardholder/cards`
- `GET /cardholder/signout` — revokes session, clears cookie, 302 to `/cardholder/signin`
- `GET /cardholder/cards` — list this cardholder's cards (same view shape as admin's `/cards`, filtered on `cardholder_id = signed-in cardholder`)
- `GET /cardholder/cards/:id` — detail page, 404 if `cardholder_id` doesn't match the session

---

## Out of scope (deferred)

- **Cardholder sign-up flow.** Admin-created only; password bootstrapped
  via CLI. A future phase can add `POST /cardholder/sign-up`.
- **Magic-link sign-in.** Password works for the demo; adds email
  sending infrastructure if pursued.
- **Cardholder webhook delivery.** This is the foundation that unblocks
  webhooks, but Phase 22 doesn't actually wire `card.frozen` /
  `card.loaded` / etc. delivery. That's a separate phase.
- **Cardholder API.** No `/v1/cardholder/...` REST surface yet. Portal
  is HTML-only.
- **Cardholder-scoped portal UI polish.** The cardholder uses the same
  `cardsListPage` / `cardDetailPage` as admin; nav is the only
  difference. A real cardholder portal would have its own brand and IA.
- **Password reset / forgot-password.** Admin CLI is the only reset
  path. Future phase.
- **CSRF tokens.** Same threat model as admin portal (no CSRF tokens
  there either). Both pages are session-cookie-guarded.
- **Rate limiting on signin.** No bcrypt-style work factor either —
  the existing portal-auth hashPassword uses scrypt with sensible
  defaults; we just need to not let an attacker hammer the endpoint in
  production.

---

## Verifiable success criteria

1. `pnpm typecheck` + `pnpm test` green across all 60 packages.
2. New portal-auth tests cover: create → resolve → revoke → resolve
   returns null. Mirrors the existing admin session tests.
3. End-to-end (manual): admin signs in to `/dashboard` as before;
   cardholder signs in to `/cardholder/cards`; the two sessions don't
   collide (different cookie names); cardholder cannot access
   `/dashboard` (preHandler redirects to `/signin`); admin can still
   access `/cards`.
4. Cardholder visiting `/cardholder/cards/<some-other-cardholder's-card>`
   gets a 404.
