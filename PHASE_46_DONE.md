# Phase 46 — Done

**Date:** 2026-11-06 · **Status:** the nightly clearing job is safe to run
more than once a day. Plan: `PHASE_46_PLAN.md`.

## What shipped

### `packages/clearing-files/src/index.ts` — `emitClearingFiles`

Three changes, per (scheme, currency) group:

1. **Look before writing.** A `clearing_files` lookup on
   `(scheme, currency, file_date, format)`; if a row is there the group is
   skipped whole — the file on disk is not touched and nothing is inserted.
2. **One transaction.** The `clearing_files` insert, the `clearing_records`
   insert and the `writeFile` now share a transaction, so a group cannot
   half-land. A failed write rolls the rows back.
3. **The race stays in its group.** `try/catch` per group; a `23505` from a
   concurrent emitter skips that group only. Anything else still propagates
   — previously *every* error escaped the loop and killed the rest of the run.

Also: the lookup and the insert both use `utcStartOfDay(args.fileDate)`, the
same UTC day the filename is built from, so the two can never disagree about
which day a file belongs to. The insert used to pass the raw `fileDate` with
its time component.

### `apps/worker/src/clearing-job.ts`

Logs `already_cut` next to `count`. Without it a re-run reports
`count: 0` and reads as "nothing to clear" when the truth is "everything was
already cleared". The doc comment claiming the unique-index violation is
"a no-op insert violation we swallow" was describing the bug; corrected.

### Tests

| Test | What it pins |
|---|---|
| `skips a group already on record and leaves its file untouched` | the file is byte-identical, no insert, and the *other* group still emits |
| `a duplicate-key race on one group does not abort the others` | per-group containment |
| `propagates a non-duplicate-key failure instead of swallowing it` | the catch is narrow, not a blanket |
| `integration.test.ts` (DB-gated, new file) | the real double-run against Postgres |

The unit tests mock Kysely, so only the integration test proves the
`file_date` lookup actually matches a row stored in a `date` column — the
mechanism the whole fix rests on. All four fail against the old code, the
integration one with the genuine
`duplicate key value violates unique constraint "clearing_files_scheme_date_idx"`.

The three existing mock-db literals in `index.test.ts` needed `selectFrom`
and `transaction`, so they were replaced by one `makeEmitDb()` factory.
That also surfaced an `inserts2` array nothing ever read; deleted.

## The bug, for the record

`emitClearingFiles` wrote the file to disk *before* inserting its row. On a
second run the same UTC day the insert hit the unique index and threw, so:

| | After run 1 | After run 2 (old code) |
|---|---|---|
| `visa_usd_…b2` on disk | 1 record, 7500 | **5 records, 128150** |
| its `clearing_files` row | 1 / 7500 | **still 1 / 7500** |
| `clearing_records` rows | 1 | **still 1** |
| `visa_eur_…b2` | — | **never written** |

A reconciliation would have ingested a file the ledger had no record of, and
an entire currency went missing without an error — `clearing-job.ts` swallowed
the `23505`.

## Verify

| Check | Result |
|---|---|
| New tests red before the fix | 4 failed, 25 passed |
| New tests green after | 29 passed |
| `pnpm exec biome check` on changed files | clean |
| `pnpm typecheck` | 60/60 |
| `pnpm test` | 60/60 |
| `make reset-db && make migrate && make e2e` | canary **11/11** on a fresh DB |

### Live — three nightly runs on one UTC day

Seeded 9 payments, ran `nightly:once`, added a 10th capture *after* the files
were cut, then ran twice more.

| | Run 1 | Run 2 | Run 3 (straggler present) |
|---|---|---|---|
| log | `count: 2, already_cut: 0` | `count: 0, already_cut: 2` | `count: 0, already_cut: 2`, `presentments: 10` |
| `visa_eur_…b2` md5 | `53be31ca…` | `53be31ca…` | `53be31ca…` |
| `visa_usd_…b2` md5 | `bbed387b…` | `bbed387b…` | `bbed387b…` |

Both files byte-identical across all three runs. Final state, disk against
database:

| scheme | currency | `record_count` | `total_amount` | `clearing_records` rows | file trailer |
|---|---|---|---|---|---|
| visa | EUR | 5 | 114900 | 5 | `9010000000005000000000000114900` |
| visa | USD | 4 | 120650 | 4 | `9010000000004000000000000120650` |

Row, record count and Base II trailer agree on both.

## The straggler, and what it means

The 10th payment — captured after the day's file was cut — is **not** in any
clearing file and has no `clearing_records` row:

```
 succeeded_usd | cleared_usd | uncleared_stragglers
             5 |           4 |                    1
```

This is the once-per-day rule working as the schema always intended, and it
is **not** fixed by this phase. Tomorrow's run windows on tomorrow's
`captured_at`, so today's stragglers are picked up by no run, ever. The
money stays uncleared.

Options, for a later phase:

- **(a) Leave it.** Honest for a simulation; the canary already reports the
  skip. Costs nothing, clears nothing.
- **(b) Supplementary files.** What real acquirers do — several presentment
  files per (scheme, currency, day), each with a sequence number, each
  carrying only transactions with no `clearing_records` row yet. Needs a
  migration to relax the unique index and add a sequence column.
- **(c) Widen the collector.** Pick up anything captured before the cut-off
  without a `clearing_records` row, whatever day it landed. No migration,
  but a transaction can then appear in a file dated after its capture day.

**(b)** if this is ever meant to mirror a real clearing cycle; **(a)** if
naming the limit is enough.

## What did NOT change

- No migration, no dependency, no API change.
- The once-per-day rule itself is untouched.
- `newId('outbox_event').replace('oe_', 'cf_')` (and `'cr_'`) is still the
  ad-hoc id pattern `CLAUDE.md` warns against. Pre-existing, left alone to
  keep the diff surgical; `packages/ids` should grow `clearing_file` and
  `clearing_record` kinds.

## Still open

- The straggler question above — the one real gap this phase documents
  rather than closes.
- Nothing is pushed. Six commits now sit on `main` locally (Phase 45's
  three and Phase 46's three).
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
