# Phase 44 — Plan

**Goal:** the portal nav has linked to `/payouts` and `/disputes` since
Phase 8, and both 404. Give them pages. The dashboard already queries
both tables and renders them (10 most recent each), so the data and
the tables exist; only the list routes are missing.

## Design

### `apps/portal/src/dashboard-views.ts`

- `payoutsListPage({ user, payouts })` and
  `disputesListPage({ user, disputes })`, same shape as
  `merchantsListPage`: `layout()` + one card wrapping the existing
  `payoutsTable` / `disputesTable`.
- `disputesTable` gains an **amount** column. A dispute list without
  the disputed amount is not much use to an operator. The dashboard
  card picks the column up too, which keeps the two views identical.

### `apps/portal/src/index.ts`

- `GET /payouts` — `requireUser`, `paycore.payouts` newest first,
  limit 200 (the `/cards` convention).
- `GET /disputes` — same for `paycore.disputes`.
- Dashboard mapping passes `amount` + `currency` for disputes.

## Out of scope

- Detail pages (`/payouts/:id`, `/disputes/:id`).
- Dispute actions from the portal (representment, evidence upload).
  The merchant API (`POST /v1/disputes/:id/transition`) stays the only
  write path.
- Reason-code descriptions (`VISA_REASON_CODES` lives in
  `@psp-new/disputes`; the portal doesn't depend on it, and a new
  workspace dep isn't worth two strings of copy).
- Filters and pagination beyond the 200 limit.

## Files touched

| File | Change |
|---|---|
| `apps/portal/src/dashboard-views.ts` | + 2 page functions, amount column in `disputesTable` |
| `apps/portal/src/index.ts` | + 2 routes, dispute amount in dashboard mapping |

No migrations, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `pnpm typecheck` / `pnpm test` | 60/60 each |
| `make up`, sign in, click Payouts | 200, the canary payout listed |
| Open a dispute via `POST /v1/disputes`, click Disputes | 200, dispute listed with amount and `first_chargeback` |
| Signed out, GET `/payouts` and `/disputes` | redirect to `/signin`, same as `/merchants` |
