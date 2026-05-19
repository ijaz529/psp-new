# Phase 22 — Done

**Date:** 2026-05-19 · **Status:** Cardholder identity surface landed. Plan: `PHASE_22_PLAN.md`.

Closes the longest-running open item. Cardholders can now set a
password (admin-bootstrapped), sign in to `/cardholder/signin`, and see
only their own cards at `/cardholder/cards` and `/cardholder/cards/:id`.
Admin sessions (Phase 8) and cardholder sessions coexist via distinct
cookies and tables.

## What shipped

- **Migration `0025_cardholder_identity.sql`** —
  `paycore.cardholders.password_hash text` (nullable) +
  `paycore.cardholder_sessions` table mirroring `paycore.portal_sessions`
  shape, with indexes on `(cardholder_id)` and a partial index on
  `(token_hash) where revoked_at is null`. `psp_app` grants included.
- **`@psp-new/portal-auth`** — six new exports paralleling the admin
  helpers:
  - `CARDHOLDER_SESSION_COOKIE = 'strawberry_cardholder_session'`
  - `createCardholderSession(db, cardholderId)` — 30-day expiry (vs
    admin's 7), `chs_*` id prefix.
  - `resolveCardholderSession(db, token)` — joins
    `cardholder_sessions ⨝ cardholders`, gates on
    `status='active' AND revoked_at is null AND expires_at > now()`.
  - `revokeCardholderSession(db, sessionId)`
  - `buildSetCardholderCookie(token)` / `buildClearCardholderCookie()` /
    `readCardholderSessionCookie(header)`
- **`apps/api/cli/cardholder-set-password.ts`** —
  `pnpm cardholder:set-password --email X --password Y`. Looks up the
  cardholder by email, hashes via portal-auth's existing `hashPassword`
  (scrypt N=2^15), writes to `password_hash`.
- **`apps/api/package.json`** — adds `@psp-new/portal-auth` workspace
  dep + `cardholder:set-password` script.
- **`apps/portal/src/index.ts`** — preHandler now branches by URL
  prefix: `/cardholder/*` resolves the cardholder session and redirects
  to `/cardholder/signin` on failure; everything else uses the admin
  session as before. `/cardholder/signin` added to PUBLIC_PATHS. Four
  new routes:
  - `GET /cardholder/signin` — form
  - `POST /cardholder/signin` — verify password, create session, set
    cookie, 302 to `/cardholder/cards`
  - `GET /cardholder/signout` — revoke + clear
  - `GET /cardholder/cards` — list scoped to the signed-in cardholder
  - `GET /cardholder/cards/:id` — detail, 404 if `cardholder_id` doesn't
    match (so cardholder can't peek at someone else's card by id)
  - `requireCardholder(req)` helper mirrors `requireUser`.
- **`apps/portal/src/cards-views.ts`** — `cardsListPage` +
  `cardDetailPage` both gain a `scope?: 'admin' | 'cardholder'` parameter.
  Cardholder scope renders a slim `cardholderLayout` (sign-out-only
  nav), uses `/cardholder/cards` link bases, hides the freeze toggle +
  controls editor (admin-only write actions), and omits the cardholder
  column on the list (it's redundant when scoped). New
  `cardholderSignInPage` export.
- **`apps/portal/src/dashboard-views.ts`** — `BASE_CSS` promoted to an
  export so the cardholder layout can reuse the same stylesheet.

## Tests

| Suite | Coverage |
|---|---|
| `packages/portal-auth/src/index.test.ts` (extended) | +4 cases: cardholder cookie name + 30-day Max-Age, clear cookie, read parses only cardholder cookie ignoring admin, distinct cookie names |
| Existing 60-package suite | Green. |

Total portal-auth: 8 → 12 tests. `pnpm typecheck` + `pnpm test` both
green across all 60 packages.

## Demo path

```bash
make up && make migrate

# Admin creates a cardholder + card (existing Phase 9 path)
pnpm cardholder:create --email demo@example.com --name "Demo"
pnpm card:issue --cardholder <ch_…> --product prod_strawberry_visa_usd
pnpm card:load --card <card_…> --amount 100.00

# Admin sets the cardholder's password
pnpm cardholder:set-password --email demo@example.com --password 'hunter2hunter2'

# Cardholder signs in at /cardholder/signin (separate from admin /signin)
# Browser to http://localhost:3000/cardholder/signin
# → see /cardholder/cards with their cards only
# → click card → detail page with balance + loads + auth holds
# → admin write actions (freeze, controls) are hidden

# Verify isolation:
# - Admin at /dashboard works as before
# - Admin at /cards still shows all cards
# - Cardholder at /dashboard → redirected to /signin (admin signin)
# - Cardholder at /cards/<some-other-cardholder's-card> → admin route, redirects
# - Cardholder at /cardholder/cards/<some-other-cardholder's-card> → 404
```

## Simplifications vs. real life

These are documented in `PHASE_22_PLAN.md §Out of scope`:

- **No sign-up flow.** Admin-created cardholders only; password
  bootstrapped via CLI. `POST /cardholder/sign-up` is a future phase.
- **No magic-link / forgot-password.** Password is the only auth
  factor. Adding magic-link needs email infrastructure.
- **No cardholder webhook delivery.** Phase 22 is the foundation;
  wiring `card.frozen` / `card.loaded` / etc. is a separate phase. The
  cardholder webhook channel needed a real cardholder identity surface,
  which now exists.
- **No cardholder REST API.** Portal HTML only. Future phase if needed.
- **No CSRF tokens.** Same threat model as admin portal.
- **Cardholder portal UX is admin's clone.** Same `cardsListPage` and
  `cardDetailPage` views, just scoped + slim nav. A real cardholder
  portal would have its own brand and IA.
- **Slight code duplication.** The cardholder helpers in portal-auth
  parallel the admin helpers rather than sharing a generic
  parameterized core. A future small refactor can consolidate.

## What this enables next

Multiple deferred items from across Phases 9–18 can now move:

- **Cardholder webhooks** — `card.frozen` / `card.loaded` /
  `card.auth_expired` / `card.controls_updated` / etc. delivery to a
  cardholder-scoped webhook endpoint.
- **Cardholder REST API** — `/v1/cardholder/...` endpoints
  authenticated by a cardholder API key or scoped session token.
- **Cardholder sign-up + magic-link** — first-class user-acquisition
  flow.
- **Per-cardholder branding** — separate hostname / theming for the
  cardholder portal.
- **Forgot password / 2FA / SSO** — usual auth-surface follow-ons.

Other still-open items unrelated to identity: auto-top-up rules,
card-load chargeback/refund, per-card `cardholder_stored_value`
LIABILITY, automatic sweep of `clearing_adjustments`, real Base II/IPM
parsing.
