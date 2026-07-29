# Phase 38 — Plan

**Goal:** janitor sweep for expired idempotency keys — both
`paycore.idempotency_keys` (merchant) and
`paycore.cardholder_idempotency_keys` (cardholder). Open since Phase
32, which shipped the cardholder table with an `expires_at` index "for
an eventual janitor sweep"; the merchant table never had one either.

The plugin already depends on this existing:
`processExisting` (`packages/idempotency/src/index.ts:263`) treats an
expired locked row as still-locked and says "a janitor sweep will
remove the row". Completed rows replay forever while the row exists —
the TTL is only real once something deletes expired rows. Today
nothing does; both tables grow without bound and stale locks are
never freed.

## Design

- **`apps/worker/src/idempotency-janitor-job.ts`** — new job,
  following the Phase 24 sweep shape:
  - `sweepExpiredIdempotencyKeys(deps, asOf = new Date())` deletes
    rows with `expires_at < asOf` from each table (two plain
    DELETEs — no batching; MVP row volumes don't warrant subquery
    batch loops, and the delete is index-assisted on the cardholder
    table).
  - Returns `{ merchantDeleted, cardholderDeleted }`; logs one line.
  - Correct-by-construction idempotent: a second run deletes nothing.
- **`apps/worker/src/index.ts`** — `setInterval` registration, env
  `IDEMPOTENCY_JANITOR_INTERVAL_MS`, default 6h — same pattern as
  the other sweepers, cleared in the existing `onClose` hook.
- **`apps/worker/src/idempotency-janitor-job.test.ts`** — DB-gated
  integration test (Phase 24 test pattern): insert expired + live
  rows in both tables, run the sweep, assert expired rows are gone
  and live rows survive; second run deletes zero.

## Out of scope

- Batched/LIMITed deletes; a `pg_cron` or BullMQ-repeatable variant.
- Changing plugin semantics (expired-completed rows still replay
  until swept — that stays as-is; the sweep is what enforces TTL).
- The merchant `expires_at` index (the merchant table predates the
  cardholder one and has no index on `expires_at`; adding one is a
  one-line migration but the table also serves the hot request path —
  defer until row volumes justify it, noted in DONE).

## Files touched

| File | Change |
|---|---|
| `apps/worker/src/idempotency-janitor-job.ts` | new |
| `apps/worker/src/idempotency-janitor-job.test.ts` | new, DB-gated |
| `apps/worker/src/index.ts` | register interval |

No migrations, no new packages, no dep changes.

## Verify steps

| Check | Expected |
|---|---|
| `pnpm typecheck` | 60/60 |
| `pnpm test` (no DB) | 60/60 — new suite skips cleanly |
| `DATABASE_URL=… pnpm --filter @psp-new/worker exec vitest --run idempotency-janitor` | green — deferred to next stack boot (no local Postgres; same caveat as Phases 33/36/37) |
