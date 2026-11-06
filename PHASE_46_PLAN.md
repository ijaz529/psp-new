# Phase 46 — Plan: make nightly clearing safe to re-run

**Date:** 2026-11-06 · **Status:** in progress.

## Goal

Running the nightly clearing job twice in one UTC day must leave the
database and the files on disk agreeing with each other, and must not stop
the groups it has not yet emitted from being emitted.

## The bug

Found live during Phase 45. `emitClearingFiles`
(`packages/clearing-files/src/index.ts:62`) loops over (scheme, currency)
groups and for each one:

1. `writeFile(filePath, body)` — line 91,
2. `insert into paycore.clearing_files` — line 95,
3. `insert into paycore.clearing_records` — line 109.

`clearing_files` has a unique index on
`(scheme, currency, file_date, format)` (migration 0014). On a second run
the same day, step 2 throws `23505` — but the file on disk has **already**
been overwritten at step 1, step 3 never runs, and the throw escapes the
whole `for` loop, so every group after the colliding one is skipped
entirely. `clearing-job.ts:47` then swallows `23505` without logging.

Observed on 2026-11-06, in this order:

| | After run 1 | After run 2 |
|---|---|---|
| `visa_usd_…b2` on disk | 1 record, 7500 | **5 records, 128150** |
| its `clearing_files` row | `record_count 1, total 7500` | **unchanged — still 1 / 7500** |
| `clearing_records` rows | 1 | **still 1** |
| `visa_eur_…b2` | — | **never written; EUR had 5 presentments** |

So the file a reconciliation would ingest disagrees with the ledger's own
record of it, and a whole currency silently went missing. A clean single
run per day is correct: verified the same day, one run emitted
`visa_eur_…b2` (5 records) and `visa_usd_…b2` (4) with DB rows matching
disk.

## The fix

In `emitClearingFiles`, per group:

1. **Look first.** If a `clearing_files` row already exists for
   `(scheme, currency, file_date, format)`, skip the group: do not rewrite
   the file, do not insert. Continue to the next group.
2. **One transaction.** The `clearing_files` insert, the `clearing_records`
   insert and the `writeFile` go in a single transaction, so a group can
   never half-land. A failed write rolls the rows back.
3. **Contain the race.** Wrap each group in `try/catch`; a `23505` from a
   concurrent emitter skips that group only. Anything else still throws.

In `clearing-job.ts`, log honestly when groups were skipped rather than
reporting `count: 0` with no explanation.

### The interpretation this encodes

A clearing file for a given (scheme, currency, date) is **cut once**.
Transactions captured after it is cut do not retroactively enter it. That
is what the unique index from migration 0014 already decided, and it
matches a real Base II submission: once a file goes to the scheme it is
immutable.

**It also means those transactions are never cleared at all** — see
"Domain question" below. This phase does not change that; it stops the
corruption, which is a separate and unambiguous defect.

## Out of scope

- No migration, no new dependency, no API change.
- No change to the once-per-day rule itself (see the domain question).
- Nothing else on the Phase 45 open list.
- `newId('outbox_event').replace('oe_', 'cf_')` at lines 94 and 113 is the
  ad-hoc id pattern `CLAUDE.md` tells us not to use. Pre-existing; left
  alone to keep this diff surgical. Worth its own cleanup.

## Files touched

| File | Change |
|---|---|
| `PHASE_46_PLAN.md` | this doc (commit 1) |
| `packages/clearing-files/src/index.ts` | the fix (commit 2) |
| `packages/clearing-files/src/index.test.ts` | the mocks need `selectFrom` + `transaction`; new skip/isolation cases (commit 2) |
| `packages/clearing-files/src/integration.test.ts` | new, DB-gated: the real double-run (commit 2) |
| `apps/worker/src/clearing-job.ts` | honest logging when groups are skipped (commit 2) |
| `PHASE_46_DONE.md` | write-up (commit 3) |

## Verify steps

Tests first, then the fix.

| # | Step | Pass condition |
|---|---|---|
| 1 | New unit test: an already-emitted group is skipped, its file untouched | red before the fix, green after |
| 2 | New unit test: one group colliding does not abort later groups | red before, green after |
| 3 | New DB-gated test: `emitClearingFiles` twice over a real Postgres | second call emits nothing, rows and disk agree |
| 4 | `pnpm exec biome check` on changed files | clean |
| 5 | `pnpm typecheck` | 60/60 |
| 6 | `pnpm test` | 60/60 |
| 7 | **Live**: seed, run `nightly:once` twice, compare disk to DB | both currencies' files present; `record_count` and `total_amount` match the trailer; no rewrite between runs |
| 8 | `make reset-db && make migrate && make e2e` | canary 11/11 on a fresh DB |

Step 7 matters because the unit tests mock the database: only a real
Postgres proves the `file_date` lookup actually matches a stored `date`
column.

## Domain question for the user — not answered in this phase

A capture that lands after today's file is cut is never cleared. Tomorrow's
run windows on tomorrow's `captured_at`, so today's stragglers are not
picked up by it, or by any later run. Options:

- **(a) Leave it.** Honest for a simulation, and the canary already reports
  the skip. The money stays uncleared.
- **(b) Supplementary files.** What real acquirers do: several presentment
  files per (scheme, currency, day), each with a sequence number, each
  carrying only transactions not already in a `clearing_records` row. Needs
  a migration to relax the unique index and add a sequence column.
- **(c) Widen the window.** Have the collector pick up anything captured
  before the cut-off that has no `clearing_records` row yet, regardless of
  day. Simpler than (b), no migration, but a transaction can then appear in
  a file dated after the day it was captured.

My recommendation is **(b)** if this is ever meant to look like a real
acquirer's clearing cycle, and **(a)** if the simulation's honesty about
its own limits is enough. Either way it is a phase of its own.
