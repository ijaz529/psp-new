# Phase 47 — Done

**Date:** 2026-11-06 · **Status:** a day can hold several clearing files, so
nothing stays uncleared. Plan: `PHASE_47_PLAN.md`.

## What shipped

### Migration 0035

`paycore.clearing_files` gains `sequence int not null default 1` with a
`>= 1` check. The unique index `(scheme, currency, file_date, format)`
becomes `(scheme, currency, file_date, format, sequence)`. Existing rows
take sequence 1 from the default, so nothing already emitted moves.

### `packages/clearing-files/src/index.ts`

- **Both collectors exclude what has already cleared.**
  `collectClearingTransactionsForDate` and
  `collectCardLoadChargebacksForDate` gained a `not exists` against
  `paycore.clearing_records`. This is the part that makes a re-run offer
  the stragglers instead of re-offering the whole day.
- **`emitClearingFiles` cuts the next sequence** — `max(sequence) + 1`, or
  1 — in place of Phase 46's "skip the group". The transaction and the
  per-group duplicate-key containment are unchanged. A file already cut is
  still never rewritten.
- Filenames carry the sequence: `visa_usd_20261106_001.b2`.
- `EmittedClearingFile` gained `sequence`.

### `apps/worker`

- `clearing-job.ts` logs the sequences it cut (`visa_usd#2`), replacing
  Phase 46's `already_cut`, which is now always 0.
- `nightly:once --date YYYY-MM-DD`. The scheduled job windows on yesterday
  and nothing else, so without this a day the worker was down for could
  never be swept — its transactions have no record and no run would offer
  them again.

## Verify

| Check | Result |
|---|---|
| New tests red before the change | 13 failed |
| New tests green after | 31 passed (29 unit + 2 DB-gated) |
| Migration applied, then applied again | clean both times |
| `pnpm exec biome check` on changed files | clean |
| `pnpm typecheck` | 60/60 |
| `pnpm test` on a fresh DB, `--force` | **60/60** |
| `make reset-db && make migrate && make e2e` | canary **11/11** |
| `--date` targets the right window, rejects bad input | both confirmed |

### Live — the exact gap Phase 46 left open

Seeded 9 payments, ran `nightly:once`, added a capture *after* the files
were cut, ran again.

| | Run 1 | Run 2 |
|---|---|---|
| log | `count: 2` | `count: 1`, `files: ["visa_usd#2"]` |
| presentments offered | 9 | **1** — the collector excluded the nine already cleared |
| files on disk | `visa_eur_…_001.b2`, `visa_usd_…_001.b2` | plus `visa_usd_…_002.b2` |
| `visa_usd_…_001.b2` | — | byte-identical |

Final state:

| currency | sequence | `record_count` | `total_amount` | record rows | trailer |
|---|---|---|---|---|---|
| EUR | 1 | 5 | 114900 | 5 | `9010000000005000000000000114900` |
| USD | 1 | 4 | 120650 | 4 | `9010000000004000000000000120650` |
| USD | 2 | 1 | 3300 | 1 | `9010000000001000000000000003300` |

```
 succeeded | cleared | uncleared
        10 |      10 |         0
```

Phase 46 left that last column at 1. It is now 0.

## Out of scope, but it blocked the gate

**`apps/issuer-host`'s integration suite has been red whenever it actually
ran, and `pnpm test` was reporting 60/60 by replaying a turbo cache.**

This phase's edit to `packages/db/src/kysely.ts` changed `@psp-new/db`'s
hash, which invalidated the cache key of every package depending on it —
including `issuer-host` — so the suite executed for the first time in a
while and failed 8 of 10. Proved it was not this phase's doing: with every
Phase 47 change stashed, a fresh database and `turbo run test --force`,
it fails identically.

Two causes, both in the test:

1. `handler.ts:354 readAvailableBalance` reads `ledger.account_balances`, a
   **materialized** view that production refreshes on a periodic job. The
   fixture funds the card with `postJournal` and never refreshed, so the
   handler saw a zero balance and declined everything **RC 51**. `bal()`
   now refreshes before reading, and a `beforeEach` refreshes before each
   authorization.
2. Every test used a fixed `(stan, rrn)`, which `card_auth_holds` has a
   unique index on, so a second run against the same database collided.
   RRNs now carry a per-run prefix.

`pnpm test` is now genuinely 60/60 with `--force` on a fresh database.

This is the same class of fix the worker integration suite already had;
`issuer-host` never got it.

## Known limits

- **The suite is still single-use per database.** `handler.test.ts` uses a
  fixed PAN, and the handler matches cards on `bin + last4`
  (`handler.ts:294`), so a second run finds the *previous* run's card and
  its empty accounts. Run 1 on a fresh database is green; run 2 is not.
  Fixing it means a per-run last4, and is worth doing with the lookup
  itself.
- **An authorization decision reads a 5-minute-stale materialized view.**
  That is the same hazard Phase 43 deliberately removed from payouts
  ("staleness is unacceptable in a money-moving path") and it is still
  present in the issuer's auth path. An issuer can approve spending that
  the ledger says is not there. Not touched here.
- The scheduled nightly still only windows on yesterday; `--date` is the
  operator's remedy, not an automatic sweep.
- `newId('outbox_event').replace('oe_', 'cf_')` is still the ad-hoc id
  pattern `CLAUDE.md` warns against. Pre-existing, untouched again.

## Still open

- The two issuer-host items above.
- Nothing is pushed. Nine commits now sit on `main` locally.
- `PORTAL_DEMO_PASSWORD` was echoed into a terminal during Phase 45 and
  should still be rotated.

## Open list (carried)

- Map Fastify's empty-JSON-body error to 400 (Phase 41 finding).
- Vault-in-harness for tokens/payment-method/3DS test breadth.
- CI job that runs `make e2e` against compose.
- Payouts: `listPayoutCandidates` windows on PI `created_at`; reserves;
  `merchants.payout_schedule` ignored (Phase 43).
- Portal detail pages for payouts and disputes; dispute actions.
- `packages/risk-rules` written but wired into nothing.
