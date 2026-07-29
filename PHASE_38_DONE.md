# Phase 38 — Done

**Date:** 2026-07-29 · **Status:** expired idempotency keys are swept.
Plan: `PHASE_38_PLAN.md`.

The idempotency plugin never deletes rows: completed keys replayed
forever, crashed requests left locks that `processExisting` reported
as in-flight forever, and both tables grew without bound. The plugin's
own comment promised "a janitor sweep will remove the row" — now one
exists, covering both `paycore.idempotency_keys` (merchant) and
`paycore.cardholder_idempotency_keys` (cardholder, whose Phase 32
`expires_at` index was built for exactly this).

## What shipped

### `apps/worker/src/idempotency-janitor-job.ts` (new)

`sweepExpiredIdempotencyKeys(deps, asOf?)` — two plain DELETEs
(`expires_at < asOf`, one per table), returns
`{ merchantDeleted, cardholderDeleted }`, logs only when something
was deleted. Idempotent by construction. No batching (MVP volumes;
noted as future work if tables ever get hot).

### `apps/worker/src/index.ts`

Registered on the standard `setInterval` pattern:
`IDEMPOTENCY_JANITOR_INTERVAL_MS`, default 6h, cleared in `onClose`
with the other seven timers. (Interval env vars are intentionally not
in `.env.example` — none of the other sweepers' are.)

### `apps/worker/src/idempotency-janitor-job.test.ts` (new, DB-gated)

Phase 24 test pattern: inserts an expired + a live row in each table
(with real merchant/cardholder parents for the FKs), asserts the
sweep removes exactly the expired rows, and that a second run deletes
zero.

## Verify

| Check | Result |
|---|---|
| `pnpm typecheck` | 60/60 green |
| `pnpm test` (no DB) | 60/60 — new suite skips cleanly (1 test, 1 skipped) |
| DB-gated run | **NOT RUN** — no Postgres reachable (same caveat as Phases 33/36/37); execute on next stack boot |

## What did NOT change

- Plugin semantics: an expired-but-unswept completed row still
  replays, an expired lock still reports `locked`. The sweep is the
  TTL enforcement, exactly as `processExisting`'s comment intends.
- No `expires_at` index added to the merchant table (deferred until
  volumes justify it — the cardholder table has one from Phase 32).

## Open list (Phase 37's list, one item closed)

- Webhook deadletter replay UI for cardholders.
- Per-card endpoint scoping.
- Merchant route integration tests — broader coverage still open.
- ~~Janitor sweep for expired idempotency keys~~ — closed this phase
  (both tables).
- Run against live Postgres and record results: Phase 33 confirm
  test, migrations 0032/0033, Phase 37 fan-out demo, Phase 38 janitor
  test.
- `make e2e` payment canary (the PROJECT_BRIEF success criterion) —
  needs a bootable stack.
